"use strict";

// The data repo's PreToolUse hook (README.md, Data-repo settings). Claude Code
// pipes it each Bash call, file write and edit the model is about to make, as
// JSON; it exits 2 to refuse one, printing only `<tool> <code>` (Rule 5). It
// backs the terminal guard (terminal.js), which a child process can get past
// on its own: it refuses
//   - researcher-only-mode: --ballot, --show, --keep-short, --push or
//     --device-check, in a command or in a file the model writes (a script it
//     could run later);
//   - terminal-guard-bypass: a command or file naming CLAUDECODE, a command
//     that empties the environment, or one that runs under a pseudo-terminal;
//   - script-only-file: a command naming ballot.ledger, snapshots.sha256,
//     published.log or downloads/, which only scripts and the researcher
//     write (the Edit denies cover the file tools).
// Quotes and backslashes are dropped before matching, so `--bal''lot` reads
// as --ballot. A command that builds the flag at run time, from a variable or
// an encoding, still gets past it: this narrows what a hostile session can do
// unseen, and the ledger and manifest remain checks against mistakes, not
// proof against such a session. Anything it cannot read is refused.
//
// It also holds the three agents of Rule 7 to their limits, as each agent's
// own definition (agents/) runs it on every call that agent makes:
//   - agent-tool-denied: a tool the agent's definition does not give it;
//   - agent-command-denied: a discovery Bash call that is not exactly one
//     discovery-fetch command, its URL single-quoted;
//   - agent-path-denied: a compile or neutrality read, Glob, Grep or write
//     outside its allow list, a link out of it included;
// and the main session's launch of discovery:
//   - discovery-prompt-invalid: a prompt that is not one token discovery-bind
//     bound, so nothing else the session holds reaches the agent.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN, ID_PATTERN } = require("./constants");

const RESEARCHER_MODE = /(^|[^\w-])--(ballot|show|keep-short|push|device-check)(?![\w-])/;
const GUARD_VARIABLE = /CLAUDECODE/i;
// env -i, env --ignore-environment, env - (an empty environment drops CLAUDECODE).
const ENV_WIPE = /(^|[^\w-])env\s+(-\w*i\b|--ignore-environment\b|-(\s|$))/;
// Python's pty module and its kin, anywhere in the command.
const PTY_LIBRARY = /\b(pty|openpty|forkpty|node-pty)\b/;
// Commands that run a program on a new pseudo-terminal.
const PTY_COMMANDS = new Set(["script", "expect", "unbuffer", "socat"]);
// Words that run the next word as the command.
const WRAPPERS = new Set(["env", "exec", "nohup", "sudo", "time", "command", "nice", "xargs"]);
const SCRIPT_ONLY = /ballot\.ledger|snapshots\.sha256|published\.log|(^|[^\w.-])downloads\//;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// The text as the shell would mostly read it: $'...' and "..." quoting,
// quotes and backslashes removed.
const unquote = (text) => text.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");

// The command word of each simple command, after assignments, wrappers and
// their flags.
const commandWords = (command) =>
  command
    .split(/\$\(|[;&|()\n`]/)
    .map((segment) => {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      let i = 0;
      while (
        i < words.length &&
        (/^\w+=/.test(words[i]) ||
          words[i].startsWith("-") ||
          WRAPPERS.has(path.basename(words[i])))
      ) {
        i++;
      }
      return words[i] ? path.basename(words[i]) : null;
    })
    .filter(Boolean);

// Every string in a tool input, however nested (MultiEdit's edits).
const strings = (value) => {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

const SKILL = ".claude/skills/research-candidates";
const DISCOVERY = "research-candidates-discovery";
const COMPILE = "research-candidates-compile";
const NEUTRALITY = "research-candidates-neutrality";
const AGENT_TOOLS = {
  [DISCOVERY]: ["Bash", "WebSearch"],
  [COMPILE]: ["Read", "Glob", "Grep", "Write", "Edit"],
  [NEUTRALITY]: ["Read", "Glob", "Grep", "Write"],
};
const TOKEN = /^[0-9a-f]{32}$/;
// discovery-fetch <token> --brief | --searched <subject> <item> | <subject> <name> '<url>'
// (discovery.js), and nothing else: no second command, and a URL in single
// quotes, inside which the shell expands nothing.
const WORD = "[a-z0-9_][a-z0-9_-]*";
const FETCH_COMMAND = new RegExp(
  `^node ${SKILL}/scripts/discovery-fetch [0-9a-f]{32} ` +
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
const place = (root, cwd, given) => {
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

// The companion snapshots on ballot-view.md's read: lines (ballot-format.md).
const readLines = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, "ballot-view.md"), "utf8");
  } catch {
    return new Set();
  }
  return new Set(
    text
      .split("\n")
      .filter((line) => line.startsWith("read: "))
      .map((line) => line.slice("read: ".length)),
  );
};

const isName = (name, suffix) =>
  name?.endsWith(suffix) && ID_PATTERN.test(name.slice(0, -suffix.length));

// SKILL.md Rule 7's allow lists, over a place.
const READS = {
  [COMPILE]: ({ ballotDir, parts }) => {
    const [top, contest = "", , extra] = parts;
    if (top === "articles") return true;
    if (parts.length === 1) return top === "ballot.yaml" || top === "ballot-view.md";
    if (top !== "sources") return false;
    if (ID_PATTERN.test(contest)) return true;
    return (
      contest === "_ballot" && extra === undefined && readLines(ballotDir).has(parts.join("/"))
    );
  },
  [NEUTRALITY]: ({ parts }) =>
    parts[0] === "articles" ||
    (parts.length === 2 && parts[0] === "review" && isName(parts[1], ".neutrality.md")),
};
const WRITES = {
  [COMPILE]: ({ parts }) =>
    parts.length === 2 && parts[0] === "articles" && isName(parts[1], ".md"),
  [NEUTRALITY]: ({ parts }) =>
    parts.length === 2 && parts[0] === "review" && isName(parts[1], ".neutrality.md"),
};

// A Glob pattern or Grep glob that stays under the path it is given.
const relativePattern = (pattern) =>
  pattern === undefined ||
  (typeof pattern === "string" &&
    !path.isAbsolute(pattern) &&
    !pattern.startsWith("~") &&
    !pattern.split(/[\\/]/).includes(".."));

// The refusal code for a call one of Rule 7's agents makes, or null.
const agentRefusal = (agent, tool, toolInput, root, cwd) => {
  if (!AGENT_TOOLS[agent].includes(tool)) return "agent-tool-denied";
  if (agent === DISCOVERY) {
    if (tool !== "Bash") return null;
    return FETCH_COMMAND.test(toolInput.command.trim()) ? null : "agent-command-denied";
  }
  const where = (given) => place(root, cwd, given);
  const readable = (given) => {
    const at = where(given);
    return Boolean(at && (at.references || READS[agent](at)));
  };
  let allowed;
  if (tool === "Read") allowed = readable(toolInput.file_path);
  else if (tool === "Glob")
    allowed = relativePattern(toolInput.pattern) && readable(toolInput.path);
  else if (tool === "Grep") allowed = relativePattern(toolInput.glob) && readable(toolInput.path);
  else {
    const at = where(toolInput.file_path);
    allowed = Boolean(at && !at.references && WRITES[agent](at));
  }
  return allowed ? null : "agent-path-denied";
};

// The main session may start discovery only with a prompt that is a token
// discovery-bind bound (discovery.js).
const launchRefusal = (toolInput, root) => {
  if (toolInput.subagent_type !== DISCOVERY) return null;
  const token = typeof toolInput.prompt === "string" ? toolInput.prompt.trim() : "";
  const bound =
    TOKEN.test(token) &&
    fs.lstatSync(path.join(root, ".discovery", token), { throwIfNoEntry: false })?.isFile();
  return bound ? null : "discovery-prompt-invalid";
};

// The refusal code for one tool call, or null to let it run.
const refusal = (input) => {
  const code = sessionRefusal(input);
  if (code) return code;
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (typeof root !== "string" || root === "") return "hook-input-invalid";
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : root;
  if (Object.hasOwn(AGENT_TOOLS, input.agent_type ?? "")) {
    return agentRefusal(input.agent_type, input.tool_name, input.tool_input, root, cwd);
  }
  if (input.tool_name === "Agent" || input.tool_name === "Task") {
    return launchRefusal(input.tool_input, root);
  }
  return null;
};

// The refusals that hold for every caller, the main session's and each agent's.
const sessionRefusal = (input) => {
  const tool = input?.tool_name;
  const toolInput = input?.tool_input;
  if (typeof tool !== "string" || !toolInput || typeof toolInput !== "object") {
    return "hook-input-invalid";
  }
  if (tool === "Bash") {
    if (typeof toolInput.command !== "string") return "hook-input-invalid";
    const command = unquote(toolInput.command);
    if (RESEARCHER_MODE.test(command)) return "researcher-only-mode";
    if (GUARD_VARIABLE.test(command) || ENV_WIPE.test(command) || PTY_LIBRARY.test(command)) {
      return "terminal-guard-bypass";
    }
    if (commandWords(command).some((word) => PTY_COMMANDS.has(word))) {
      return "terminal-guard-bypass";
    }
    if (SCRIPT_ONLY.test(command)) return "script-only-file";
    return null;
  }
  if (FILE_TOOLS.has(tool)) {
    const text = unquote(strings(toolInput).join("\n"));
    if (RESEARCHER_MODE.test(text)) return "researcher-only-mode";
    if (GUARD_VARIABLE.test(text)) return "terminal-guard-bypass";
  }
  return null;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const main = async () => {
  let input;
  let code;
  try {
    input = JSON.parse(await readStdin());
    code = refusal(input);
  } catch {
    code = "hook-input-invalid";
  }
  if (!code) return;
  const tool = typeof input?.tool_name === "string" ? input.tool_name : "-";
  process.stderr.write(`${/^\w+$/.test(tool) ? tool : "-"} ${code}\n`);
  process.exitCode = 2;
};

module.exports = { main, refusal };
