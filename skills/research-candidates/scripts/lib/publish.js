"use strict";

// publish [--show] <election>/<ballot-id>
//
// Step 6 (SKILL.md), through its privacy scan: the ballot gate refuses the
// whole publish, the contest gate decides each contest with review-list's
// `ready`, a claim, excerpt or source name that holds private text drops its
// contest, and the page is rendered, scanned and only then written to
// site/index.html (page.md). Output is `location code [key]` lines only (Rule
// 5); `--show`, researcher only, adds the text each page refusal matched.

const fs = require("node:fs");
const path = require("node:path");
const { ballotGate } = require("./ballot-gate");
const { ID_PATTERN, LEDGER } = require("./constants");
const { contestsOf } = require("./coverage");
const { hiddenTitles, loadPrivateValues, readYamlDocument } = require("./data-files");
const { SKILL_DIR, load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { Failure, Failures, runCommand } = require("./output");
const { FONT_FACES, receiptLinks, renderPage } = require("./page");
const { dropContests, scanPage } = require("./page-scan");
const { ready } = require("./review-list");
const { isSnapshotPath } = require("./snapshot-hash");
const { today } = require("./snapshot-file");
const { withLock, writeSynced } = require("./snapshot-store");
const { printable, requireTerminal } = require("./terminal");

const SITE = "site/index.html";

const parseArgs = (argv) => {
  const show = argv[0] === "--show";
  const rest = show ? argv.slice(1) : argv;
  if (rest.length !== 1 || rest[0].startsWith("--")) throw new Failure("-", "usage");
  parseBallot(rest[0]);
  return { show, ballot: rest[0] };
};

// publish.yaml's display_name, the name the trust header shows.
const readDisplayName = (root) => {
  const data = readYamlDocument(path.join(root, "publish.yaml"), "publish.yaml").doc.toJS();
  const name = data?.display_name;
  if (typeof name !== "string" || name.trim() === "")
    throw new Failure("publish.yaml", "publish-invalid", "display_name");
  return name;
};

// archives.tsv as a Map from snapshot path to its 14-digit Wayback capture
// time (snapshot-format.md, Saved copies); a later line for a path wins. Any
// other line, or a last line with no newline, fails archives-invalid.
const ARCHIVE_LINE = /^(sources\/[^\t]+)\t([0-9]{14})$/;
const readArchives = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, "archives.tsv"), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  const lines = text.split("\n");
  const unended = lines.pop();
  if (unended !== "") throw new Failure(`archives.tsv:${lines.length + 1}`, "archives-invalid");
  const archives = new Map();
  for (const [i, line] of lines.entries()) {
    const m = ARCHIVE_LINE.exec(line);
    if (!m || !isSnapshotPath(m[1])) throw new Failure(`archives.tsv:${i + 1}`, "archives-invalid");
    archives.set(m[1], m[2]);
  }
  return archives;
};

// Does the ballot have a certified write-in list: a ledger line with role
// write_in_list whose snapshot is still there? ballot-check, which has passed,
// checks each ledger line against its snapshot's role.
const hasWriteInList = (ballotDir) => {
  let text = "";
  try {
    text = fs.readFileSync(path.join(ballotDir, LEDGER), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return text.split("\n").some((line) => {
    const [rel, role] = line.split("\t");
    return role === "write_in_list" && fs.existsSync(path.join(ballotDir, rel));
  });
};

// site/, or site-invalid when something other than a directory is there.
const siteDir = (ballotDir) => {
  const dir = path.join(ballotDir, "site");
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Failure("site", "site-invalid");
  return dir;
};

// Write the page through a synced temporary file, so a reader never sees
// half of it, even after a power loss.
const writeSite = (ballotDir, html) => {
  const dir = siteDir(ballotDir);
  fs.mkdirSync(dir, { recursive: true });
  // A write a crash cut short is never left beside the page.
  for (const name of fs.readdirSync(dir))
    if (name.startsWith("index.html.tmp-")) fs.rmSync(path.join(dir, name), { force: true });
  const file = path.join(ballotDir, SITE);
  const tmp = `${file}.tmp-${process.pid}`;
  writeSynced(tmp, html, "w");
  fs.renameSync(tmp, file);
};

// How much page text `--show` prints on each side of a match.
const CONTEXT = 40;

// A page refusal's report line and, with `show`, each matched text in its
// context, one indented line each, with control characters replaced.
const refusalLines = (html, { line, code, spans }, show) => {
  const at = line === null ? SITE : `${SITE}:${line}`;
  const shown = show
    ? spans.map(([start, end]) => {
        const before = html.slice(Math.max(0, start - CONTEXT), start);
        const after = html.slice(end, end + CONTEXT);
        return `    ${printable(`${before}[${html.slice(start, end)}]${after}`)}`;
      })
    : [];
  return [`${at} ${code}`, ...new Set(shown)];
};

// The gates, the scan, then the page: refuses with Failures, or returns the
// drop and contest lines and `site/index.html written`. `refresh` keeps the
// ballot lock fresh; `show` adds each page refusal's matched text.
const publish = (root, ballot, ballotDir, refresh, show) => {
  // A page from an earlier run never outlives a refused one.
  fs.rmSync(path.join(siteDir(ballotDir), "index.html"), { force: true });
  // Loaded first, so a missing install is one deps-missing.
  load("yaml");
  const displayName = readDisplayName(root);
  ballotGate(root, ballot, ballotDir, refresh);
  // Read once: the page shows the contests ready judged.
  const data = readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS();
  const contests = contestsOf(data);
  const ids = data.contests.map((c) => c.id).filter((id) => ID_PATTERN.test(id));
  // Once, for every contest, under the ballot lock (review-list.md).
  const answers = ready(ballotDir, ids, { contests, manifestVerified: true });
  refresh();
  // A review file missing next to its baseline refuses: review-list rebuilds it.
  const missing = ids.filter((id) => answers.get(id).reasons.includes("review-missing"));
  if (missing.length)
    throw new Failures(missing.map((id) => new Failure(`review/${id}.md`, "review-missing").line));
  // Step 6.2: a contest whose claims, excerpts or source names hold private
  // text is not ready (SKILL.md step 6.3).
  const values = { ...loadPrivateValues(root, ballot), title: hiddenTitles(data) };
  const drops = dropContests(ids, answers, values);
  const shown = new Map(answers);
  for (const [id, reasons] of drops.dropped) shown.set(id, { ready: false, reasons });
  const contestLines = ids.map((id) => {
    const { ready: isReady, reasons } = shown.get(id);
    return isReady ? `articles/${id}.md ready` : `articles/${id}.md not-ready ${reasons.join(",")}`;
  });
  const archives = readArchives(ballotDir);
  const fonts = FONT_FACES.map((f) => ({
    ...f,
    data: fs.readFileSync(path.join(SKILL_DIR, "fonts", f.file)),
  }));
  const html = renderPage({
    ballot: data,
    contests,
    answers: shown,
    displayName,
    updated: today(),
    archives,
    writeInList: hasWriteInList(ballotDir),
    fonts,
  });
  // Step 6.3: any match left on the page refuses all of it, and no page is written.
  const refusals = scanPage(html, values, { fonts, links: receiptLinks(shown, archives) });
  const report = [...drops.lines, ...contestLines];
  if (refusals.length)
    throw new Failures([...report, ...refusals.flatMap((r) => refusalLines(html, r, show))]);
  // Only while the lock is still this run's.
  refresh();
  writeSite(ballotDir, html);
  return [...report, `${SITE} written`];
};

const main = (argv) =>
  runCommand(async () => {
    // Before anything is read, so no private text reaches a session.
    if (argv[0] === "--show") requireTerminal();
    const { show, ballot } = parseArgs(argv);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    // Under the ballot lock, so a save or log line written now is never half seen.
    return withLock(ballotDir, (refresh) => publish(root, ballot, ballotDir, refresh, show));
  });

module.exports = { main };
