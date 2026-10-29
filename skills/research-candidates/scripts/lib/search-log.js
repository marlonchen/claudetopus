"use strict";

// The per-contest search log (snapshot-format.md, Search log):
// search-log/<contest>.tsv, one `<contest>	<subject>	<item>	<searched>`
// line per checklist item the discovery agent ran. fetch-snapshot --searched
// appends to it; coverage reads it (coverage.js).
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
const parseArgs = (argv) => {
  if (argv.length !== 5 || argv.slice(1).some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [, ballot, contest, subject, item] = argv;
  parseBallot(ballot);
  return { ballot, contest, subject, item };
};

// A subject the contest lists: a candidate or official id, or _race for a
// measure. A malformed subject is never echoed: it is the agent's text (Rule 5).
const checkTarget = (root, { ballot, contest, subject, item }) => {
  if (!ID_PATTERN.test(contest)) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  if (subject !== "_race" && !ID_PATTERN.test(subject)) {
    throw new Failure(`${contest}/-`, "unknown-subject");
  }
  const listed = loadBallot(root, ballot).contests.get(contest);
  if (!listed) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  const known = listed.type === "measure" ? subject === "_race" : listed.subjects.has(subject);
  if (!known) throw new Failure(`${contest}/${subject}`, "unknown-subject");
  if (!(CHECKLIST_ITEMS[listed.type] ?? []).includes(item)) {
    throw new Failure(`${contest}/${subject}`, "bad-item");
  }
};

const main = (argv) =>
  runCommand(async () => {
    const root = process.cwd();
    const args = parseArgs(argv);
    const ballotDir = openBallot(root, args.ballot);
    checkTarget(root, args);
    const rel = logPath(args.contest);
    const file = path.join(ballotDir, rel);
    withLock(ballotDir, () => {
      const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
      if (text && !text.endsWith("\n")) throw new Failure(rel, "search-log-invalid");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      appendLine(file, `${args.contest}\t${args.subject}\t${args.item}\t${today()}\n`);
    });
    return [`${rel} logged`];
  });

module.exports = { logPath, main };
