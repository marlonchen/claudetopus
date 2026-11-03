"use strict";

// The limits session-guard holds the three agents of SKILL.md Rule 7 to.
// Each agent's definition (agents/) runs session-guard with its own name on
// every call it makes, and the call's `agent_type` must be that name, so a
// call that does not say which agent made it is refused, never let through.
// Each agent is held to the one contest of the token it was started with
// (bindings.js), looked up by the `agent_id` its calls carry:
//   - agent-type-mismatch: the call's agent_type is not the definition's agent;
//   - agent-tool-denied: a tool the agent's definition does not give it;
//   - agent-unbound: an agent no launch session-guard let through started;
//   - agent-command-denied: a discovery Bash call that is not exactly one
//     discovery-fetch command with its own token, its URL single-quoted;
//   - agent-path-denied: a compile or neutrality read, Glob, Grep or write
//     outside its contest's allow list, a link or a `..` out of it included;
//     the compile agent's list takes the companions on ballot-view.md's
//     `read:` lines only while that view still agrees with what it was
//     checked against (companionReadable).
// The main session's launch of each agent is checked too:
//   - agent-prompt-invalid: a prompt that is not a token agent-bind bound
//     (discovery's whole prompt; the first line of the others'), so nothing
//     else the session holds reaches discovery;
//   - agent-launch-pending: a second launch of an agent while the first has
//     not started, which could leave each with the other's token;
//   - agent-isolation-denied: a launch into a worktree or another machine,
//     where these hooks may not run.

const fs = require("node:fs");
const path = require("node:path");
const { agentBinding, pendingLaunch, readBinding, recordLaunch } = require("./bindings");
const { COMPANION_ROLES, VIEW } = require("./constants");
const { load } = require("./deps");
const { FRONT_MATTER } = require("./snapshot-file");
const { sha256 } = require("./snapshot-store");

const SKILL = ".claude/skills/research-candidates";
const DISCOVERY = "research-candidates-discovery";
const COMPILE = "research-candidates-compile";
const NEUTRALITY = "research-candidates-neutrality";
const AGENT_TOOLS = {
  [DISCOVERY]: ["Bash", "WebSearch"],
  [COMPILE]: ["Read", "Glob", "Grep", "Write", "Edit"],
  [NEUTRALITY]: ["Read", "Glob", "Grep", "Write"],
};
// discovery-fetch <token> --brief | --searched <subject> <item> | <subject> <name> '<url>'
// (discovery.js), and nothing else: no second command, and a URL in single
// quotes, inside which the shell expands nothing. The token is the agent's own.
const WORD = "[a-z0-9_][a-z0-9_-]*";
const FETCH_COMMAND = new RegExp(
  `^node ${SKILL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/scripts/discovery-fetch (\\S+) ` +
    `(--brief|--searched ${WORD} [0-9]+|${WORD} ${WORD} '[^'\\s]+')$`,
);

// The real path of `p`, links resolved in every part that exists, or null
// when a part is a link to nothing, which a write would follow out of any list.
const realPath = (p) => {
  const tail = [];
  let at = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...tail);
    } catch {
      if (fs.lstatSync(at, { throwIfNoEntry: false })) return null;
      if (path.dirname(at) === at) return p;
      tail.unshift(path.basename(at));
      at = path.dirname(at);
    }
  }
};
const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}${path.sep}`);

// Where `given` lies: { references } for the skill's references, or { parts },
// its path parts under the `ballot` directory; null anywhere else, and for any
// path with a `..` part.
const locate = (root, cwd, given, ballot) => {
  if (typeof given !== "string" || given === "" || given.split(/[\\/]/).includes("..")) {
    return null;
  }
  const real = realPath(path.resolve(cwd, given));
  if (real === null) return null;
  const references = realPath(path.join(root, SKILL, "references"));
  if (references !== null && within(real, references)) return { references: true };
  const ballotDir = realPath(path.join(root, ballot));
  if (ballotDir === null || real === ballotDir || !within(real, ballotDir)) return null;
  return { parts: path.relative(ballotDir, real).split(path.sep) };
};

const isFile = (parts, dir, name) => parts.length === 2 && parts[0] === dir && parts[1] === name;

// May the compile agent open the _ballot snapshot at `parts`? Only one on a
// `read:` line of a regular-file ballot-view.md whose `sha256:` lines still
// agree with ballot.yaml and the sample ballot it links, never that link's
// target, a snapshot whose role is not a companion's (a sample ballot,
// superseded or not) or a companion ballot.yaml retires (ballot-format.md,
// Ballot view). Anything it cannot read is refused.
const companionReadable = (ballotDir, parts) => {
  if (parts.length !== 3 || parts[0] !== "sources" || parts[1] !== "_ballot") return false;
  const rel = parts.join("/");
  try {
    const view = path.join(ballotDir, VIEW);
    if (!fs.lstatSync(view).isFile()) return false;
    let link = null;
    const reads = new Set();
    const hashes = new Map();
    for (const line of fs.readFileSync(view, "utf8").split("\n")) {
      const m = /^(link|read): (.+)$/.exec(line) ?? /^sha256: ([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (m?.[1] === "link") link ??= m[2];
      else if (m?.[1] === "read") reads.add(m[2]);
      else if (m) hashes.set(m[2], m[1]);
    }
    if (!link?.startsWith("sources/_ballot/") || rel === link || !reads.has(rel)) return false;
    const read = (file) => {
      const p = path.join(ballotDir, file);
      return fs.lstatSync(p).isFile() ? fs.readFileSync(p) : null;
    };
    const ballotYaml = read("ballot.yaml");
    const sample = read(link);
    if (!ballotYaml || !sample) return false;
    if (hashes.get("ballot.yaml") !== sha256(ballotYaml) || hashes.get(link) !== sha256(sample))
      return false;
    const YAML = load("yaml");
    const front = FRONT_MATTER.exec(read(rel)?.toString("utf8") ?? "");
    if (!front || !COMPANION_ROLES.includes(YAML.parse(front[1] ?? "")?.role)) return false;
    const retired = YAML.parse(ballotYaml.toString("utf8"))?.retired_companions;
    return !(Array.isArray(retired) && retired.includes(rel));
  } catch {
    return false;
  }
};

// SKILL.md Rule 7's allow lists, over a located path's parts, the contest
// and the ballot directory.
const READS = {
  [COMPILE]: (parts, contest, ballotDir) =>
    parts[0] === "articles" ||
    (parts.length === 1 && (parts[0] === "ballot.yaml" || parts[0] === "ballot-view.md")) ||
    (parts[0] === "sources" && parts[1] === contest) ||
    companionReadable(ballotDir, parts),
  [NEUTRALITY]: (parts, contest) =>
    parts[0] === "articles" || isFile(parts, "review", `${contest}.neutrality.md`),
};
const WRITES = {
  [COMPILE]: (parts, contest) => isFile(parts, "articles", `${contest}.md`),
  [NEUTRALITY]: (parts, contest) => isFile(parts, "review", `${contest}.neutrality.md`),
};

// A Glob pattern or Grep glob that stays under the path it is given: no
// absolute or home path, no `..` part, and no braces, which could spell one.
const relativePattern = (pattern) =>
  pattern === undefined ||
  (typeof pattern === "string" &&
    !path.isAbsolute(pattern) &&
    !pattern.startsWith("~") &&
    !/[{}]/.test(pattern) &&
    !pattern.split(/[\\/]/).includes(".."));

// Each file tool's check: the input fields it reads, and whether it writes.
// Glob and Grep are checked by the path they start from only: Claude Code
// runs them through ripgrep without --follow, so a link under that path is
// listed but never walked or searched.
const FILE_CHECKS = {
  Read: (input, readable) => readable(input.file_path),
  Glob: (input, readable) => relativePattern(input.pattern) && readable(input.path),
  Grep: (input, readable) => relativePattern(input.glob) && readable(input.path),
  Write: (input, _readable, writable) => writable(input.file_path),
  Edit: (input, _readable, writable) => writable(input.file_path),
};

// The refusal code for a call `agent`'s definition ran the hook on, or null.
const agentRefusal = (agent, input, root, cwd) => {
  if (input.agent_type !== agent) return "agent-type-mismatch";
  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (!AGENT_TOOLS[agent].includes(tool)) return "agent-tool-denied";
  const binding = agentBinding(root, agent, input.agent_id);
  if (!binding) return "agent-unbound";
  if (agent === DISCOVERY) {
    if (tool !== "Bash") return null;
    const m = FETCH_COMMAND.exec(toolInput.command.trim());
    return m?.[1] === binding.token ? null : "agent-command-denied";
  }
  const { ballot, contest } = binding;
  const readable = (given) => {
    const at = locate(root, cwd, given, ballot);
    return Boolean(
      at && (at.references || READS[agent](at.parts, contest, path.join(root, ballot))),
    );
  };
  const writable = (given) => {
    const at = locate(root, cwd, given, ballot);
    return Boolean(at && !at.references && WRITES[agent](at.parts, contest));
  };
  return FILE_CHECKS[tool](toolInput, readable, writable) ? null : "agent-path-denied";
};

const isAgent = (name) => typeof name === "string" && Object.hasOwn(AGENT_TOOLS, name);

// The main session may start a Rule 7 agent only with a token agent-bind
// bound, which it records for SubagentStart to hand to the agent.
const launchRefusal = (toolInput, root, now = Date.now()) => {
  const agent = toolInput.subagent_type;
  if (!isAgent(agent)) return null;
  if (toolInput.isolation !== undefined) return "agent-isolation-denied";
  const prompt = typeof toolInput.prompt === "string" ? toolInput.prompt : "";
  const token = (agent === DISCOVERY ? prompt : prompt.split("\n")[0]).trim();
  if (!readBinding(root, token)) return "agent-prompt-invalid";
  if (pendingLaunch(root, agent, now)) return "agent-launch-pending";
  recordLaunch(root, agent, token, now);
  return null;
};

module.exports = { AGENT_TOOLS, agentRefusal, isAgent, launchRefusal };
