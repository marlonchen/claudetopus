"use strict";

// The data repo's PreToolUse hook (README.md, Data-repo settings). Claude Code
// pipes it each Bash call, file write and edit the model is about to make, as
// JSON; it exits 2 to refuse one, printing only `<tool> <code>` (Rule 5). It
// backs the terminal guard (terminal.js), which a child process can get past
// on its own: it refuses
//   - researcher-only-mode: --ballot, --show or --keep-short, in a command
//     or in a file the model writes (a script it could run later);
//   - terminal-guard-bypass: a command or file naming CLAUDECODE, a command
//     that empties the environment, or one that runs under a pseudo-terminal;
//   - script-only-file: a command naming ballot.ledger, snapshots.sha256 or
//     downloads/, which only scripts and the researcher write (the Edit denies
//     cover the file tools).
// Quotes and backslashes are dropped before matching, so `--bal''lot` reads
// as --ballot. A command that builds the flag at run time, from a variable or
// an encoding, still gets past it: this narrows what a hostile session can do
// unseen, and the ledger and manifest remain checks against mistakes, not
// proof against such a session. Anything it cannot read is refused.

const path = require("node:path");

const RESEARCHER_MODE = /(^|[^\w-])--(ballot|show|keep-short)(?![\w-])/;
const GUARD_VARIABLE = /CLAUDECODE/i;
// env -i, env --ignore-environment, env - (an empty environment drops CLAUDECODE).
const ENV_WIPE = /(^|[^\w-])env\s+(-\w*i\b|--ignore-environment\b|-(\s|$))/;
// Python's pty module and its kin, anywhere in the command.
const PTY_LIBRARY = /\b(pty|openpty|forkpty|node-pty)\b/;
// Commands that run a program on a new pseudo-terminal.
const PTY_COMMANDS = new Set(["script", "expect", "unbuffer", "socat"]);
// Words that run the next word as the command.
const WRAPPERS = new Set(["env", "exec", "nohup", "sudo", "time", "command", "nice", "xargs"]);
const SCRIPT_ONLY = /ballot\.ledger|snapshots\.sha256|(^|[^\w.-])downloads\//;
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

// The refusal code for one tool call, or null to let it run.
const refusal = (input) => {
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
