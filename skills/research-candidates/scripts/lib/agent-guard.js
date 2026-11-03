"use strict";

// The limits session-guard holds the three agents of SKILL.md Rule 7 to.
// Each agent's definition (agents/) runs session-guard with its own name on
// every call it makes, and the call's `agent_type` must be that name, so a
// call that does not say which agent made it is refused, never let through.
//   - agent-type-mismatch: the call's agent_type is not the definition's agent;
//   - agent-tool-denied: a tool the agent's definition does not give it;
//   - agent-command-denied: a discovery Bash call that is not exactly one
//     discovery-fetch command, its URL single-quoted;
//   - agent-path-denied: a compile or neutrality read, Glob, Grep or write
//     outside its allow list, a link or a `..` out of it included.
// The allow lists are per ballot directory: which contest an agent works on
// is in its prompt, which a hook cannot see. The main session's launch of
// discovery is checked too:
//   - discovery-prompt-invalid: a prompt that is not one token discovery-bind
//     bound, so nothing else the session holds reaches the agent.

const fs = require("node:fs");
const path = require("node:path");
const {
  BALLOT_ID_PATTERN,
  DISCOVERY_BINDINGS,
  DISCOVERY_TOKEN,
  ELECTION_PATTERN,
  ID_PATTERN,
} = require("./constants");

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
// quotes, inside which the shell expands nothing.
const WORD = "[a-z0-9_][a-z0-9_-]*";
const FETCH_COMMAND = new RegExp(
  `^node ${SKILL}/scripts/discovery-fetch ${DISCOVERY_TOKEN.source.slice(1, -1)} ` +
    `(--brief|--searched ${WORD} [0-9]+|${WORD} ${WORD} '[^'\\s]+')$`,
);

// The real path of `p`: links resolved in every part that exists.
const realPath = (p) => {
  const tail = [];
  let at = p;
  for (;;) {
    try {
      return path.join(fs.realpathSync(at), ...tail);
    } catch {
      if (path.dirname(at) === at) return p;
      tail.unshift(path.basename(at));
      at = path.dirname(at);
    }
  }
};
const within = (inner, outer) => inner === outer || inner.startsWith(`${outer}${path.sep}`);

// Where `given` lies: { references } for the skill's references, or
// { ballotDir, parts }, its path parts under an <election>/<ballot-id>
// directory; null anywhere else, and for any path with a `..` part.
const locate = (root, cwd, given) => {
  if (typeof given !== "string" || given === "" || given.split(/[\\/]/).includes("..")) {
    return null;
  }
  const real = realPath(path.resolve(cwd, given));
  if (within(real, realPath(path.join(root, SKILL, "references")))) return { references: true };
  const realRoot = realPath(root);
  if (!within(real, realRoot)) return null;
  const [election, ballotId, ...parts] = path.relative(realRoot, real).split(path.sep);
  if (!ELECTION_PATTERN.test(election ?? "") || !BALLOT_ID_PATTERN.test(ballotId ?? "")) {
    return null;
  }
  if (!parts.length) return null;
  return { ballotDir: path.join(realRoot, election, ballotId), parts };
};

// The companion snapshots on ballot-view.md's read: lines (ballot-format.md),
// from its header only, so a span below it can never name one.
const companionReads = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, "ballot-view.md"), "utf8");
  } catch {
    return new Set();
  }
  const reads = new Set();
  for (const line of text.split("\n")) {
    const m = /^(link|read|sha256): (.*)$/.exec(line);
    if (!m) break;
    if (m[1] === "read") reads.add(m[2]);
  }
  return reads;
};

// Is `name` an id followed by `suffix` (`us-house-07.neutrality.md`)?
const isIdFile = (name, suffix) =>
  name?.endsWith(suffix) && ID_PATTERN.test(name.slice(0, -suffix.length));

// SKILL.md Rule 7's allow lists, over a located path.
const READS = {
  [COMPILE]: ({ ballotDir, parts }) => {
    const [top, contest = "", , extra] = parts;
    if (top === "articles") return true;
    if (parts.length === 1) return top === "ballot.yaml" || top === "ballot-view.md";
    if (top !== "sources") return false;
    if (ID_PATTERN.test(contest)) return true;
    return (
      contest === "_ballot" && extra === undefined && companionReads(ballotDir).has(parts.join("/"))
    );
  },
  [NEUTRALITY]: ({ parts }) =>
    parts[0] === "articles" ||
    (parts.length === 2 && parts[0] === "review" && isIdFile(parts[1], ".neutrality.md")),
};
const WRITES = {
  [COMPILE]: ({ parts }) =>
    parts.length === 2 && parts[0] === "articles" && isIdFile(parts[1], ".md"),
  [NEUTRALITY]: ({ parts }) =>
    parts.length === 2 && parts[0] === "review" && isIdFile(parts[1], ".neutrality.md"),
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
  if (agent === DISCOVERY) {
    if (tool !== "Bash") return null;
    return FETCH_COMMAND.test(toolInput.command.trim()) ? null : "agent-command-denied";
  }
  const readable = (given) => {
    const at = locate(root, cwd, given);
    return Boolean(at && (at.references || READS[agent](at)));
  };
  const writable = (given) => {
    const at = locate(root, cwd, given);
    return Boolean(at && !at.references && WRITES[agent](at));
  };
  return FILE_CHECKS[tool](toolInput, readable, writable) ? null : "agent-path-denied";
};

// The main session may start discovery only with a prompt that is a token
// discovery-bind bound (discovery.js).
const launchRefusal = (toolInput, root) => {
  if (toolInput.subagent_type !== DISCOVERY) return null;
  const token = typeof toolInput.prompt === "string" ? toolInput.prompt.trim() : "";
  const bound =
    DISCOVERY_TOKEN.test(token) &&
    fs.lstatSync(path.join(root, DISCOVERY_BINDINGS, token), { throwIfNoEntry: false })?.isFile();
  return bound ? null : "discovery-prompt-invalid";
};

const isAgent = (name) => Object.hasOwn(AGENT_TOOLS, name);

module.exports = { agentRefusal, isAgent, launchRefusal };
