"use strict";

// The Rule 7 agents' binding and the discovery agent's fetch tool (SKILL.md
// Rule 7, step 4).
//
// agent-bind <election>/<ballot-id> <contest>
//   The main session's: once ballot-check passes, binds the contest to a new
//   random token (bindings.js) and prints it. Each of the contest's agents is
//   started with it: it is discovery's whole prompt, and the first line of
//   compile's and neutrality's, and session-guard holds each agent to the
//   contest its token names.
//
// discovery-fetch <token> --brief
// discovery-fetch <token> <subject> <name> '<url>'
// discovery-fetch <token> --searched <subject> <item>
//   The discovery agent's only command (session-guard holds it to these three
//   forms and its own token). --brief prints what the agent may search with:
//   the contest id, type, office type, jurisdiction, a measure's search_terms,
//   the checklist items its type runs, the candidate or official ids and
//   names, and the hosts in tiers.yaml, rerunning ballot-check first. The
//   other two are fetch-snapshot's plain fetch and --searched with the bound
//   ballot and contest filled in, so the agent never gives either, and every
//   other mode (--ballot, --file, --keep-short, --archive) is out of reach.

const path = require("node:path");
const { check: checkBallot } = require("./ballot-check");
const { bindContest, readBinding } = require("./bindings");
const { BINDING_TOKEN, CHECKLIST_ITEMS, ID_PATTERN } = require("./constants");
const { loadPrivateValues, loadTiers, readYamlDocument } = require("./data-files");
const { openBallot, parseBallot } = require("./fetch-common");
const fetchSnapshot = require("./fetch-snapshot").main;
const { Failure, Failures, runCommand } = require("./output");
const { withLock } = require("./snapshot-store");

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
const contestEntry = (root, ballot, contest) => {
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
    contestEntry(root, ballot, contest);
    return [`${contest} bound ${bindContest(root, ballot, contest)}`];
  });

// { ballot, contest } bound to `token`: usage for a token that is not one,
// unknown-token for one agent-bind never bound.
const bound = (root, token) => {
  if (!BINDING_TOKEN.test(token ?? "")) throw new Failure("-", "usage");
  const binding = readBinding(root, token);
  if (!binding) throw new Failure("-", "unknown-token");
  return binding;
};

const brief = (root, { ballot, contest }) => {
  const ballotDir = openBallot(root, ballot);
  requireBallotCheck(root, ballot, ballotDir);
  const entry = contestEntry(root, ballot, contest);
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
  const hosts = loadTiers(root, loadPrivateValues(root, ballot), ballot).map((e) => e.parsed.host);
  for (const host of new Set(hosts)) lines.push(`domain: ${host}`);
  return lines;
};

// A command that fails with `failure` before it runs.
const fail = (failure) =>
  runCommand(async () => {
    throw failure;
  });

const fetch = (argv) => {
  const root = process.cwd();
  let binding;
  try {
    binding = bound(root, argv[0]);
  } catch (error) {
    return fail(error);
  }
  const { ballot, contest } = binding;
  const rest = argv.slice(1);
  if (rest.length === 1 && rest[0] === "--brief") {
    return runCommand(async () => brief(root, binding));
  }
  const flagged = rest.slice(1).some((arg) => arg.startsWith("--"));
  if (rest.length === 3 && rest[0] === "--searched" && !flagged) {
    return fetchSnapshot(["--searched", ballot, contest, rest[1], rest[2]]);
  }
  if (rest.length === 3 && !rest[0].startsWith("--") && !flagged) {
    return fetchSnapshot([ballot, contest, ...rest]);
  }
  return fail(new Failure("-", "usage"));
};

module.exports = { bind, fetch };
