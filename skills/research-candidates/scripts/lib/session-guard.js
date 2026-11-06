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
//     published.log, downloads/ or .bindings/, which only scripts, hooks and
//     the researcher write (the Edit denies cover the file tools);
//   - claude-cli-denied: a command running the claude CLI, which could start
//     an agent (claude --agent) past the launch check below;
//   - agent-message-denied: any SendMessage, which would reach a Rule 7 agent
//     with text other than its token;
//   - private-file-denied: a command, file write, Read or Grep naming
//     addresses.yaml or private.yaml, which only scripts read, or a Grep from
//     a directory that holds either (Rule 5). A glob or a recursive shell
//     search names neither, so it still gets past this.
// Quotes and backslashes are dropped before matching, so `--bal''lot` reads
// as --ballot. A command that builds the flag at run time, from a variable or
// an encoding, still gets past it: this narrows what a hostile session can do
// unseen, and the ledger and manifest remain checks against mistakes, not
// proof against such a session. Anything it cannot read is refused.
//
// Run with an agent's name (session-guard research-candidates-compile), as each
// agent's definition in agents/ runs it, it also holds that agent to its Rule 7
// limits; run plain, as the data repo's settings run it, it also checks the
// main session's launch of each agent, and on SubagentStart hands the launch's
// token to the agent that started (agent-guard.js, bindings.js).

const fs = require("node:fs");
const path = require("node:path");
const { agentRefusal, isAgent, launchRefusal } = require("./agent-guard");
const { startAgent } = require("./bindings");

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
const SCRIPT_ONLY =
  /ballot\.ledger|snapshots\.sha256|published\.log|(^|[^\w.-])downloads\/|(^|[^\w.-])\.bindings\b/;
// The claude CLI, by any path (claude, ~/.local/bin/claude, npx @anthropic-ai/claude-code).
const CLAUDE_CLI = new Set(["claude", "claude-code"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
// Any case, since a case-insensitive filesystem opens the file under any.
const PRIVATE_FILE = /addresses\.yaml|private\.yaml/i;
const PRIVATE_FILE_TOOLS = new Set(["Bash", "Read", "Grep", ...FILE_TOOLS]);
// addresses.yaml is at the root and private.yaml two levels under it, in
// <election>/<ballot-id>/, so a Grep any deeper reaches neither.
const PRIVATE_FILE_DEPTH = 2;

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

// True when a Grep from `given` would read a directory that holds a private file.
const grepReachesPrivateFile = (given, root, cwd) => {
  const start = path.resolve(cwd, given ?? ".");
  if (!fs.statSync(start, { throwIfNoEntry: false })?.isDirectory()) return false;
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(start));
  const up = relative.split(path.sep)[0] === "..";
  // Above the root, or beside it: only a start that holds the root reaches it.
  if (up) return !relative.split(path.sep).some((part) => part !== "..");
  return relative === "" || relative.split(path.sep).length <= PRIVATE_FILE_DEPTH;
};

// The main session's refusal for a call that could read or write a private
// file. A Rule 7 agent's allow list already covers these (agent-guard.js).
const privateFileRefusal = (input, root, cwd) => {
  const tool = input.tool_name;
  if (!PRIVATE_FILE_TOOLS.has(tool)) return null;
  if (PRIVATE_FILE.test(unquote(strings(input.tool_input).join("\n")))) {
    return "private-file-denied";
  }
  if (tool === "Grep" && grepReachesPrivateFile(input.tool_input.path, root, cwd)) {
    return "private-file-denied";
  }
  return null;
};

// The refusal code for one tool call, or null to let it run. `agent` is the
// agent whose definition ran the hook, or undefined for the settings hook.
const refusal = (input, agent) => {
  const code = sessionRefusal(input);
  if (code) return code;
  const root = projectRoot(input);
  if (root === null) return "hook-input-invalid";
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : root;
  if (agent !== undefined) {
    return isAgent(agent) ? agentRefusal(agent, input, root, cwd) : "hook-input-invalid";
  }
  const privateFile = privateFileRefusal(input, root, cwd);
  if (privateFile) return privateFile;
  if (input.tool_name === "Agent" || input.tool_name === "Task") {
    return launchRefusal(input.tool_input, root);
  }
  return null;
};

const projectRoot = (input) => {
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  return typeof root === "string" && root !== "" ? root : null;
};

// SubagentStart: give a Rule 7 agent the token of the launch that started it.
const subagentStart = (input) => {
  const root = projectRoot(input);
  if (root === null) throw new Error("no project root");
  if (isAgent(input.agent_type)) startAgent(root, input.agent_type, input.agent_id);
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
    const words = command.split(/[\s;&|()`$<>]+/).filter(Boolean);
    if (words.some((word) => CLAUDE_CLI.has(path.basename(word)))) return "claude-cli-denied";
    return null;
  }
  if (tool === "SendMessage") return "agent-message-denied";
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

const main = async (argv) => {
  let input;
  let code;
  try {
    if (argv.length > 1) throw new Error("usage");
    input = JSON.parse(await readStdin());
    if (input?.hook_event_name === "SubagentStart" && argv.length === 0) {
      subagentStart(input);
      return;
    }
    code = refusal(input, argv[0]);
  } catch {
    code = "hook-input-invalid";
  }
  if (!code) return;
  const tool = typeof input?.tool_name === "string" ? input.tool_name : "-";
  process.stderr.write(`${/^\w+$/.test(tool) ? tool : "-"} ${code}\n`);
  process.exitCode = 2;
};

module.exports = { main, refusal };
