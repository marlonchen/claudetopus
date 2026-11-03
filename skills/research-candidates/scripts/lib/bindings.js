"use strict";

// agent-bind's tokens and the agents they are bound to (SKILL.md Rule 7), all
// under .bindings/ at the project root, which only scripts and hooks write:
//   .bindings/<token>              `<election>/<ballot-id> <contest>`: the contest
//                                  agent-bind bound, once ballot-check passed;
//   .bindings/launch/<agent>       `<token> <ms>`: a launch session-guard let
//                                  through, until its agent starts;
//   .bindings/agents/<agent_id>    `<agent> <token>`: the token a started agent
//                                  was launched with, which its own hook reads.
// A hook on an agent's calls cannot see the prompt it was started with, so
// the launch check records the token and SubagentStart hands it to the
// agent_id Claude Code gives the agent. A file that is not a regular file, or
// does not hold what it should, binds nothing.
// Loaded by session-guard on every call, so it needs only node's own modules.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  BALLOT_ID_PATTERN,
  BINDINGS,
  BINDING_TOKEN,
  ELECTION_PATTERN,
  ID_PATTERN,
} = require("./constants");

// A recorded launch blocks another of the same agent for this long, so two
// launches at once cannot trade tokens; an older one is taken to have failed.
const LAUNCH_WINDOW_MS = 120_000;
const AGENT_ID = /^[\w-]{1,64}$/;

// The text of a regular file under .bindings/, or null.
const readFile = (root, ...parts) => {
  const file = path.join(root, BINDINGS, ...parts);
  if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  return fs.readFileSync(file, "utf8");
};

const writeFile = (root, parts, text, flag = "w") => {
  const file = path.join(root, BINDINGS, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag });
};

// Bind `contest` of `ballot` to a new token, and return it.
const bindContest = (root, ballot, contest) => {
  const token = crypto.randomBytes(16).toString("hex");
  writeFile(root, [token], `${ballot} ${contest}\n`, "wx");
  return token;
};

// { ballot, contest } bound to `token`, or null.
const readBinding = (root, token) => {
  if (typeof token !== "string" || !BINDING_TOKEN.test(token)) return null;
  const m = /^(([^/\s]+)\/([^/\s]+)) (\S+)\n$/.exec(readFile(root, token) ?? "");
  if (!m || !ELECTION_PATTERN.test(m[2]) || !BALLOT_ID_PATTERN.test(m[3])) return null;
  if (!ID_PATTERN.test(m[4])) return null;
  return { ballot: m[1], contest: m[4] };
};

// The token of `agent`'s launch still waiting for its agent to start, or null.
const pendingLaunch = (root, agent, now = Date.now()) => {
  const m = /^([0-9a-f]{32}) ([0-9]+)\n$/.exec(readFile(root, "launch", agent) ?? "");
  return m && now - Number(m[2]) < LAUNCH_WINDOW_MS ? m[1] : null;
};

const recordLaunch = (root, agent, token, now = Date.now()) =>
  writeFile(root, ["launch", agent], `${token} ${now}\n`);

// SubagentStart: hand `agent`'s recorded launch, however old, to `agentId`.
const startAgent = (root, agent, agentId) => {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return;
  const m = /^([0-9a-f]{32}) [0-9]+\n$/.exec(readFile(root, "launch", agent) ?? "");
  if (!m) return;
  fs.rmSync(path.join(root, BINDINGS, "launch", agent));
  writeFile(root, ["agents", agentId], `${agent} ${m[1]}\n`);
};

// { token, ballot, contest } the agent `agentId` was started with, if it is
// `agent`, or null.
const agentBinding = (root, agent, agentId) => {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) return null;
  const m = /^(\S+) ([0-9a-f]{32})\n$/.exec(readFile(root, "agents", agentId) ?? "");
  if (!m || m[1] !== agent) return null;
  const binding = readBinding(root, m[2]);
  return binding && { token: m[2], ...binding };
};

module.exports = {
  LAUNCH_WINDOW_MS,
  agentBinding,
  bindContest,
  pendingLaunch,
  readBinding,
  recordLaunch,
  startAgent,
};
