"use strict";

// The per-contest search log (snapshot-format.md, Search log):
// search-log/<contest>.tsv, one `<contest>	<subject>	<item>	<searched>`
// line per checklist item the discovery agent ran. fetch-snapshot --searched
// appends to it; coverage reads it (coverage.js). Both judge it with
// readSearchLog, so the writer never appends to a log coverage would fail.
//
// fetch-snapshot --searched <election>/<ballot-id> <contest> <subject> <item>

const fs = require("node:fs");
const path = require("node:path");
const { CHECKLIST_ITEMS, ID_PATTERN } = require("./constants");
const { loadBallot } = require("./data-files");
const { openBallot, parseBallot } = require("./fetch-common");
const { Failure, runCommand } = require("./output");
const { today } = require("./snapshot-file");
const { appendLine, withLock } = require("./snapshot-store");

const logPath = (contest) => `search-log/${contest}.tsv`;

const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

// Is `date` a real YYYY-MM-DD date?
const isDate = (date) => {
  const m = DATE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

// The contest's log as { logged, latest, faults }: logged holds
// `<subject>\t<item>` for each well-formed line, and latest the latest date of
// one (null with none); faults are locations, the log line of each line
// that does not split into the four fields, does not end in a newline, names
// another contest, or has a malformed subject, item or date, and the log when
// it, or search-log/, is not a regular file or directory (a symlink is
// neither). A missing log has no lines. Each caller gives faults its code.
const readSearchLog = (ballotDir, contest, type) => {
  const rel = logPath(contest);
  const logged = new Set();
  const lstat = (p) => fs.lstatSync(path.join(ballotDir, p), { throwIfNoEntry: false });
  const dir = lstat("search-log");
  // undefined when there is no log; null when search-log/ is not a directory.
  const file = dir && (dir.isDirectory() ? lstat(rel) : null);
  if (file === undefined) return { logged, latest: null, faults: [] };
  if (!file?.isFile()) return { logged, latest: null, faults: [rel] };
  const faults = [];
  let latest = null;
  const lines = fs.readFileSync(path.join(ballotDir, rel), "utf8").split("\n");
  const unended = lines.pop();
  if (unended !== "") lines.push(null);
  for (const [i, line] of lines.entries()) {
    const fields = line?.split("\t") ?? [];
    const [logContest, subject, item, date] = fields;
    const wellFormed =
      fields.length === 4 &&
      logContest === contest &&
      (subject === "_race" || ID_PATTERN.test(subject)) &&
      CHECKLIST_ITEMS[type].includes(item) &&
      isDate(date);
    if (!wellFormed) {
      faults.push(`${rel}:${i + 1}`);
      continue;
    }
    logged.add(`${subject}\t${item}`);
    if (latest === null || date > latest) latest = date;
  }
  return { logged, latest, faults };
};

const parseArgs = (argv) => {
  if (argv.length !== 5 || argv.slice(1).some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [, ballot, contest, subject, item] = argv;
  parseBallot(ballot);
  return { ballot, contest, subject, item };
};

// The contest's type, when it lists the subject (a candidate or official id,
// or _race for a measure) and its type uses the item. A malformed subject is
// never echoed: it is the agent's text (Rule 5).
const checkTarget = (root, { ballot, contest, subject, item }) => {
  if (!ID_PATTERN.test(contest)) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  if (subject !== "_race" && !ID_PATTERN.test(subject)) {
    throw new Failure(`${contest}/-`, "unknown-subject");
  }
  const listed = loadBallot(root, ballot).contests.get(contest);
  if (!listed) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  const known = listed.type === "measure" ? subject === "_race" : listed.subjects.has(subject);
  if (!known) throw new Failure(`${contest}/${subject}`, "unknown-subject");
  if (
    !Object.hasOwn(CHECKLIST_ITEMS, listed.type) ||
    !CHECKLIST_ITEMS[listed.type].includes(item)
  ) {
    throw new Failure(`${contest}/${subject}`, "bad-item");
  }
  return listed.type;
};

const main = (argv) =>
  runCommand(async () => {
    const root = process.cwd();
    const args = parseArgs(argv);
    const ballotDir = openBallot(root, args.ballot);
    const type = checkTarget(root, args);
    const rel = logPath(args.contest);
    const file = path.join(ballotDir, rel);
    withLock(ballotDir, () => {
      if (readSearchLog(ballotDir, args.contest, type).faults.length) {
        throw new Failure(rel, "search-log-invalid");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      appendLine(file, `${args.contest}\t${args.subject}\t${args.item}\t${today()}\n`);
    });
    return [`${rel} logged`];
  });

module.exports = { main, readSearchLog };
