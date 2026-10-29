"use strict";

// publish <election>/<ballot-id>
//
// Step 6 (SKILL.md), through its render: the ballot gate refuses the whole
// publish, the contest gate decides each contest with review-list's `ready`,
// and the page is rendered to site/index.html (page.md). Output is `location
// code [key]` lines only (Rule 5).

const fs = require("node:fs");
const path = require("node:path");
const { ballotGate } = require("./ballot-gate");
const { ID_PATTERN, LEDGER } = require("./constants");
const { readContests } = require("./coverage");
const { readYamlDocument } = require("./data-files");
const { SKILL_DIR, load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { Failure, Failures, runCommand } = require("./output");
const { FONT_FACES, renderPage } = require("./page");
const { ready } = require("./review-list");
const { isSnapshotPath } = require("./snapshot-hash");
const { today } = require("./snapshot-file");
const { withLock } = require("./snapshot-store");

const SITE = "site/index.html";

const parseArgs = (argv) => {
  if (argv.length !== 1 || argv[0].startsWith("--")) throw new Failure("-", "usage");
  parseBallot(argv[0]);
  return { ballot: argv[0] };
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

// Write the page through a temporary file, so a reader never sees half of it.
const writeSite = (ballotDir, html) => {
  const dir = path.join(ballotDir, "site");
  const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (stat && !stat.isDirectory()) throw new Failure("site", "site-invalid");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(ballotDir, SITE);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, html);
  fs.renameSync(tmp, file);
};

const publish = (root, ballot, ballotDir) => {
  // Loaded first, so a missing install is one deps-missing.
  load("yaml");
  const displayName = readDisplayName(root);
  ballotGate(root, ballot, ballotDir);
  const data = readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS();
  const contests = readContests(ballotDir);
  const ids = data.contests.map((c) => c.id).filter((id) => ID_PATTERN.test(id));
  // Once, for every contest, under the ballot lock (review-list.md).
  const answers = ready(ballotDir, ids);
  const lines = ids.map((id) => {
    const { ready: isReady, reasons } = answers.get(id);
    return isReady ? `articles/${id}.md ready` : `articles/${id}.md not-ready ${reasons.join(",")}`;
  });
  // A review file missing next to its baseline refuses: review-list rebuilds it.
  const missing = ids.filter((id) => answers.get(id).reasons.includes("review-missing"));
  if (missing.length)
    throw new Failures(missing.map((id) => new Failure(`review/${id}.md`, "review-missing").line));
  const html = renderPage({
    ballot: data,
    contests,
    answers,
    displayName,
    updated: today(),
    archives: readArchives(ballotDir),
    writeInList: hasWriteInList(ballotDir),
    fonts: FONT_FACES.map((f) => ({
      ...f,
      data: fs.readFileSync(path.join(SKILL_DIR, "fonts", f.file)),
    })),
  });
  writeSite(ballotDir, html);
  return [...lines, `${SITE} written`];
};

const main = (argv) =>
  runCommand(async () => {
    const { ballot } = parseArgs(argv);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    // Under the ballot lock, so a save or log line written now is never half seen.
    return withLock(ballotDir, () => publish(root, ballot, ballotDir));
  });

module.exports = { main };
