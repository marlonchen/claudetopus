"use strict";

// The discovery agent's fetch tool (SKILL.md Rule 7, step 4.1).
//
// discovery-bind <election>/<ballot-id> <contest>
//   The main session's: once ballot-check passes, binds the contest to a new
//   random token, kept in .discovery/<token>, and prints it. The token is the
//   discovery agent's whole prompt, so nothing else the session holds reaches it.
//
// discovery-fetch <token> --brief
// discovery-fetch <token> <subject> <name> <url>
// discovery-fetch <token> --searched <subject> <item>
//   The agent's only command (session-guard holds it to these three forms).
//   --brief prints what the agent may search with: the contest id, type,
//   office type, jurisdiction, a measure's search_terms, the checklist items
//   its type runs, the candidate or official ids and names, and the hosts in
//   tiers.yaml, rerunning ballot-check first. The other two are fetch-snapshot's
//   plain fetch and --searched with the bound ballot and contest filled in, so
//   the agent never gives either, and every other mode (--ballot, --file,
//   --keep-short) is out of reach.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { check: checkBallot } = require("./ballot-check");
const { CHECKLIST_ITEMS, ID_PATTERN } = require("./constants");
const { loadPrivateValues, loadTiers, readYamlDocument } = require("./data-files");
const { openBallot, parseBallot } = require("./fetch-common");
const fetchSnapshot = require("./fetch-snapshot").main;
const { Failure, Failures, runCommand } = require("./output");
const { withLock } = require("./snapshot-store");

const BINDINGS = ".discovery";
const TOKEN = /^[0-9a-f]{32}$/;

// ballot-check, under the ballot lock as ballot-check runs it; its own lines
// say why it failed, so only the code is printed here.
const requireBallotCheck = (root, ballot, ballotDir) => {
  try {
    withLock(ballotDir, () => checkBallot(root, ballot, ballotDir, /* show */ false));
  } catch (error) {
    if (!(error instanceof Failures || error instanceof Failure)) throw error;
    throw new Failure(`${ballot}/ballot.yaml`, "ballot-check-failed");
  }
};

// The contest entry of ballot.yaml, as typed (ballot-check has passed it).
const readContest = (root, ballot, contest) => {
  const location = `${ballot}/ballot.yaml`;
  const data = readYamlDocument(path.join(root, ballot, "ballot.yaml"), location).doc.toJS();
  const found = data.contests.find((c) => c.id === contest);
  if (!found) throw new Failure(location, "unknown-contest");
  return found;
};

const bind = (argv) =>
  runCommand(async () => {
    if (argv.length !== 2 || argv.some((arg) => arg.startsWith("--"))) {
      throw new Failure("-", "usage");
    }
    const [ballot, contest] = argv;
    parseBallot(ballot);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    if (!ID_PATTERN.test(contest)) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
    requireBallotCheck(root, ballot, ballotDir);
    readContest(root, ballot, contest);
    const token = crypto.randomBytes(16).toString("hex");
    fs.mkdirSync(path.join(root, BINDINGS), { recursive: true });
    fs.writeFileSync(path.join(root, BINDINGS, token), `${ballot} ${contest}\n`, { flag: "wx" });
    return [`${contest} bound ${token}`];
  });

// { ballot, contest } bound to `token`, or unknown-token. A binding that is not
// a regular file, or does not hold one ballot and contest, is no binding.
const readBinding = (root, token) => {
  if (!TOKEN.test(token ?? "")) throw new Failure("-", "usage");
  const file = path.join(root, BINDINGS, token);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  const m = stat?.isFile() && /^(\S+) (\S+)\n$/.exec(fs.readFileSync(file, "utf8"));
  if (!m || !ID_PATTERN.test(m[2])) throw new Failure("-", "unknown-token");
  parseBallot(m[1]);
  return { ballot: m[1], contest: m[2] };
};

const brief = (root, { ballot, contest }) => {
  const ballotDir = openBallot(root, ballot);
  requireBallotCheck(root, ballot, ballotDir);
  const entry = readContest(root, ballot, contest);
  const lines = [`contest: ${contest}`, `type: ${entry.type}`];
  if (entry.office_type) lines.push(`office_type: ${entry.office_type}`);
  lines.push(`jurisdiction: ${entry.jurisdiction}`);
  if (entry.search_terms) lines.push(`search_terms: ${entry.search_terms}`);
  lines.push(`items: ${CHECKLIST_ITEMS[entry.type].join(" ")}`);
  for (const candidate of entry.candidates ?? []) {
    lines.push(`candidate: ${candidate.id} ${candidate.name}`);
  }
  if (entry.official) lines.push(`official: ${entry.official.id} ${entry.official.name}`);
  if (entry.type === "measure") lines.push("subject: _race");
  const hosts = loadTiers(root, ballot, loadPrivateValues(root, ballot)).map((e) => e.parsed.host);
  for (const host of new Set(hosts)) lines.push(`domain: ${host}`);
  return lines;
};

const fetch = (argv) => {
  const root = process.cwd();
  let binding;
  try {
    binding = readBinding(root, argv[0]);
  } catch (error) {
    return runCommand(async () => {
      throw error;
    });
  }
  const { ballot, contest } = binding;
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0] === "--brief") {
    return runCommand(async () => brief(root, binding));
  }
  if (rest.length === 3 && rest[0] === "--searched") {
    return fetchSnapshot(["--searched", ballot, contest, rest[1], rest[2]]);
  }
  if (rest.length === 3 && !rest.some((arg) => arg.startsWith("--"))) {
    return fetchSnapshot([ballot, contest, ...rest]);
  }
  return runCommand(async () => {
    throw new Failure("-", "usage");
  });
};

module.exports = { bind, fetch };
