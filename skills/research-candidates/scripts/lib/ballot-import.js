"use strict";

// fetch-snapshot --ballot <election>/<ballot-id> <role> <url>
// fetch-snapshot --ballot --file <election>/<ballot-id> <role> <path> <url>
//
// Step 2, researcher only: save the official sample ballot or a companion
// document as sources/_ballot/<role>.md (snapshot-format.md). A county lookup
// URL may carry the address in its query, so this mode runs only at the
// researcher's own terminal, shows the URL and role and asks first, requires a
// T1 host on every hop, and records the URL with its query and fragment
// dropped. A private value in the URL's path is refused, since dropping it
// would not keep it from being sent: the researcher downloads the file into
// downloads/ and saves it with --file instead, whose URL is recorded only as
// its origin. File names come from the role, never the source's own name,
// which can carry a precinct. Nothing in this mode is written to
// unfetchable.md. Every saved snapshot gets a ballot.ledger line, written
// after its manifest line and before the file lands.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN } = require("./constants");
const { loadPrivateValues, loadTiers } = require("./data-files");
const { fetchPage, isHttp, spellings } = require("./fetch-page");
const { htmlToText } = require("./html-text");
const { Failure, runCommand } = require("./output");
const { pdfFileText, pdfText } = require("./pdf-text");
const { refusalCode, scan } = require("./privacy");
const { guardRepo } = require("./repo-guard");
const { URL_CLASSES, snapshotText, today } = require("./snapshot-file");
const { appendLine, checkLog, recover, save, withLock } = require("./snapshot-store");
const { confirm, requireTerminal } = require("./terminal");
const { matchUrl } = require("./tiers");

const WHERE = "_ballot";
const ROLES = ["sample_ballot", "candidate_list", "pamphlet", "write_in_list", "withdrawal_notice"];
const LEDGER = "ballot.ledger";

const parseArgs = (argv) => {
  const file = argv[1] === "--file";
  const rest = argv.slice(file ? 2 : 1);
  if (rest.length !== (file ? 4 : 3) || rest.some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [ballot, role] = rest;
  const [election, ballotId, extra] = ballot.split("/");
  if (extra !== undefined || !ELECTION_PATTERN.test(election ?? "")) {
    throw new Failure("-", "bad-ballot");
  }
  if (!BALLOT_ID_PATTERN.test(ballotId ?? "")) throw new Failure("-", "bad-ballot");
  if (!ROLES.includes(role)) throw new Failure("-", "bad-role");
  const given = rest[rest.length - 1];
  let url;
  try {
    url = new URL(given);
  } catch {
    throw new Failure("-", "bad-url");
  }
  if (!isHttp(url) || url.username || url.password) throw new Failure("-", "bad-url");
  return { ballot, role, given, url, file: file ? rest[2] : null };
};

// The file to import: a regular file under downloads/ (after symlinks are
// resolved), PDF or HTML by both its extension and its first bytes.
const checkFile = (root, file) => {
  const downloads = path.join(root, "downloads");
  let real;
  let top;
  try {
    real = fs.realpathSync(path.resolve(root, file));
    top = fs.realpathSync(downloads);
  } catch {
    throw new Failure(WHERE, "file-not-in-downloads");
  }
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Failure(WHERE, "file-not-in-downloads");
  }
  if (!fs.statSync(real).isFile()) throw new Failure(WHERE, "bad-file");
  const ext = path.extname(real).toLowerCase();
  const pdf = fs.readFileSync(real).subarray(0, 5).toString("latin1") === "%PDF-";
  if (ext === ".pdf" && pdf) return { path: real, method: "pdf" };
  if ((ext === ".html" || ext === ".htm") && !pdf) return { path: real, method: "html" };
  throw new Failure(WHERE, "bad-file");
};

// Text up to its query or fragment: what --ballot sends that the record drops
// is allowed to hold a private value, the rest is not.
const beforeQuery = (text) => text.split(/[?#]/)[0];

const main = (argv) =>
  runCommand(async () => {
    // Before anything is read, so no private text reaches a session.
    requireTerminal();
    const root = process.cwd();
    const args = parseArgs(argv);
    guardRepo(root);
    const ballotDir = path.join(root, args.ballot);
    if (!fs.statSync(ballotDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Failure(args.ballot, "unknown-ballot");
    }
    withLock(ballotDir, () => recover(ballotDir));

    const values = loadPrivateValues(root, args.ballot);
    const findPrivate = (texts, classes) =>
      refusalCode(texts.flatMap((text) => scan(text, values, classes)));
    // A URL is checked whole for API keys and up to its query for the rest;
    // a refusal there points to --file. A --file URL is recorded only as its
    // origin, which is checked for everything.
    const checkPrivate = (texts) => {
      const key = findPrivate(texts, ["key"]);
      if (key) throw new Failure(WHERE, key);
      const code = findPrivate(texts.map(beforeQuery), URL_CLASSES);
      if (code) throw new Failure(WHERE, code, undefined, "use-ballot-file");
    };
    const origin = new URL(`${args.url.origin}/`);
    if (args.file) {
      const code = findPrivate(spellings(origin, origin.href), URL_CLASSES);
      if (code) throw new Failure(WHERE, code);
    } else {
      checkPrivate(spellings(args.url, args.given));
    }

    const entries = loadTiers(root);
    const first = matchUrl(entries, args.file ? origin : args.url);
    if (!first) throw new Failure(WHERE, "domain-not-in-tiers");
    if (first.tier !== "T1") throw new Failure(WHERE, "not-t1");
    const file = args.file ? checkFile(root, args.file) : null;

    const asked = file
      ? `Save ${path.relative(root, file.path)} as ${args.role}, from ${origin.href}? [y/N] `
      : `Fetch ${args.given} as ${args.role}? [y/N] `;
    if (!(await confirm(asked))) throw new Failure(WHERE, "not-confirmed");

    let method;
    let text;
    let url;
    let tiers;
    let query;
    if (file) {
      method = file.method;
      text =
        method === "pdf"
          ? pdfFileText(file.path, WHERE)
          : htmlToText(fs.readFileSync(file.path, "utf8"));
      url = origin;
      tiers = first;
      query = false;
    } else {
      const page = await fetchPage(entries, args.url, checkPrivate, { pdf: true, t1: true });
      if (page.refused) throw new Failure(WHERE, page.refused.code);
      method = page.pdf ? "pdf" : "html";
      text = page.pdf ? pdfText(page.pdf, WHERE) : htmlToText(page.html);
      url = new URL(page.url.href);
      url.search = "";
      url.hash = "";
      tiers = page.tiers;
      query = [args.url, ...page.hops].some((hop) => hop.search !== "");
    }
    if (!text) throw new Failure(WHERE, "no-readable-text");

    const fileText = snapshotText(
      {
        source: tiers.source,
        url: url.href,
        fetched: today(),
        method,
        tier: tiers.tier,
        statements_only: tiers.statements_only,
        subject: "_ballot",
        owner: tiers.owner,
        role: args.role,
      },
      text,
    );
    const ledgerLine = (rel) =>
      [rel, args.role, file ? "file" : "url", query ? "query" : "none", today()].join("\t");
    const ledger = path.join(ballotDir, LEDGER);
    const rel = withLock(ballotDir, () => {
      checkLog(ledger, "ledger-invalid");
      return save(ballotDir, "_ballot", args.role.replaceAll("_", "-"), fileText, (saved) =>
        appendLine(ledger, `${ledgerLine(saved)}\n`),
      );
    });
    return [`${rel} saved`];
  });

module.exports = { main };
