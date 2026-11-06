"use strict";

// The data repo's PreToolUse hook (README.md, Data-repo settings). Claude Code
// pipes it each Bash or Monitor command, Read, Grep, file write, edit, agent
// launch and message the model is about to make, as JSON; it exits 2 to refuse
// one, printing only `<tool> <code>` (Rule 5). It
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
//     addresses.yaml or private.yaml, which only scripts read, or a Grep or a
//     recursive shell search from a directory that holds either (Rule 5). A
//     shell glob or git's output names neither, so each still gets past this:
//     data-repo-gitattributes keeps both files out of git's output;
//   - session-file-denied: the same calls from the main session alone, for
//     sources/_ballot/, downloads/ and unfetchable.md, or a Grep or a
//     recursive shell search from sources/;
//   - agent-type-denied: any call from a subagent that is not a Rule 7 agent,
//     however it started (a skill's fork, a workflow).
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
const os = require("node:os");
const path = require("node:path");
const { agentRefusal, isAgent, launchRefusal } = require("./agent-guard");
const { startAgent } = require("./bindings");

const RESEARCHER_MODE = /(^|[^\w-])--(ballot|show|keep-short|push|device-check)(?![\w-])/;
// Each runs a shell command, and hands the hook its own tool_name.
const SHELL_TOOLS = new Set(["Bash", "Monitor"]);
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
// The input a call can name a file in. A Bash description or a Grep pattern
// reads nothing, so neither counts; everything a file tool writes does, since
// it could be a script to run later.
const namedIn = (tool, input) => {
  if (SHELL_TOOLS.has(tool)) return [input.command];
  if (tool === "Read") return [input.file_path];
  if (tool === "Grep") return [input.path, input.glob];
  return FILE_TOOLS.has(tool) ? [input] : [];
};
// addresses.yaml is at the root and private.yaml two levels under it, in
// <election>/<ballot-id>/, so a search any deeper reaches neither.
const PRIVATE_FILE_DEPTH = 2;
// What the main session has no use for: text that can name or locate the
// voter, and the log of attacker-chosen URLs.
const SESSION_FILE = /(^|[^\w-])_ballot([^\w-]|$)|unfetchable\.md|(^|[^\w.-])downloads\//i;
// Commands that search a whole tree unasked, and the greps that do when told to.
const TREE_SEARCHES = new Set(["rg", "ugrep", "ug", "ag", "ack"]);
const GREPS = new Set(["grep", "egrep", "fgrep"]);
const GREP_RECURSIVE = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive|--dereference-recursive)$/;
// A pattern given by flag, so that a grep's first operand is a path.
const GREP_PATTERN_FLAG = /^(-[a-zA-Z]*[ef]|--regexp(=|$)|--file(=|$))/;
// A find that hands what it finds to a command, anywhere in the command line,
// since find's own parentheses and ; split it into simple commands.
const FIND_READS = /\s-(exec|execdir|ok|okdir)\s|\bxargs\b/;

// The text as the shell would mostly read it: $'...' and "..." quoting,
// quotes and backslashes removed.
const unquote = (text) => text.replace(/\$(?=['"])/g, "").replace(/['"\\]/g, "");

// Each simple command's words, from its command word on, after assignments,
// wrappers and their flags.
const simpleCommands = (command) =>
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
      return words.slice(i);
    })
    .filter((words) => words.length > 0);
const commandWords = (command) => simpleCommands(command).map(([word]) => path.basename(word));

// Every string in a tool input, however nested (MultiEdit's edits).
const strings = (value) => {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
};

// `given` from `cwd`, a leading ~ as the shell and Claude Code's tools read it.
const startPath = (given, cwd) =>
  path.resolve(
    cwd,
    given === "~" || given.startsWith("~/") ? os.homedir() + given.slice(1) : given,
  );

// A directory's path parts under the root; native realpath, since the plain
// one keeps a path's case.
const partsUnderRoot = (directory, root) =>
  path.relative(fs.realpathSync.native(root), fs.realpathSync.native(directory)).split(path.sep);

// True when a search from `given` would read a directory that holds a private
// file. Anything it cannot place is refused, as a search from it would find
// nothing anyway.
const reachesPrivateFile = (given, root, cwd) => {
  const start = startPath(given, cwd);
  const found = fs.statSync(start, { throwIfNoEntry: false });
  if (!found) return true;
  if (!found.isDirectory()) return false;
  const parts = partsUnderRoot(start, root);
  // Above the root, or beside it: only a start that holds the root reaches it.
  if (parts[0] === "..") return parts.every((part) => part === "..");
  // A hidden directory (.claude, .bindings) is no election.
  return !parts[0].startsWith(".") && parts.length <= PRIVATE_FILE_DEPTH;
};

// What a simple command searches a whole tree from: its operands, for the
// caller to sort paths from the rest, or null when it is no such search.
const treeSearchOperands = ([word, ...args], command) => {
  const name = path.basename(word);
  // rg --files lists names and reads no file.
  if (args.includes("--files")) return null;
  const find = name === "find" && FIND_READS.test(command);
  const grep = GREPS.has(name) && args.some((arg) => GREP_RECURSIVE.test(arg));
  if (!find && !grep && !TREE_SEARCHES.has(name)) return null;
  const operands = args.filter((arg) => !arg.startsWith("-"));
  if (!find && !args.some((arg) => GREP_PATTERN_FLAG.test(arg))) operands.shift();
  return operands;
};

// True when a search from `given` is a ballot's sources/ directory, which holds
// sources/_ballot/ two levels below any private file.
const reachesBallotSources = (given, root, cwd) => {
  const start = startPath(given, cwd);
  if (!fs.statSync(start, { throwIfNoEntry: false })?.isDirectory()) return false;
  const parts = partsUnderRoot(start, root);
  return parts.length === 3 && parts[2] === "sources";
};

// True when a command runs a recursive search from a start `reaches` accepts.
// Its operands that exist are its starts. With none it searches where it runs,
// since a bare word may be a flag's value (rg -t yaml Elm), unless it was given
// a path, which reads nothing if it is not there.
const shellSearchReaches = (reaches, command, root, cwd) =>
  simpleCommands(command).some((words) => {
    const operands = treeSearchOperands(words, command);
    if (!operands) return false;
    const starts = operands.filter((operand) => fs.existsSync(startPath(operand, cwd)));
    if (starts.length === 0 && operands.some((operand) => operand.includes("/"))) return false;
    return (starts.length ? starts : ["."]).some((s) => reaches(s, root, cwd));
  });

// True when a Grep, or a recursive search in a shell command, starts where
// `reaches` accepts.
const searchReaches = (reaches, input, root, cwd) => {
  const tool = input.tool_name;
  const toolInput = input.tool_input;
  if (tool === "Grep") return reaches(toolInput.path ?? ".", root, cwd);
  return (
    SHELL_TOOLS.has(tool) && shellSearchReaches(reaches, unquote(toolInput.command), root, cwd)
  );
};

// The text of a call that can name a file, as the shell would mostly read it.
const namedText = (input) =>
  unquote(strings(namedIn(input.tool_name, input.tool_input)).join("\n"));

// The main session's refusal for a call that could read or write a private
// file. refusal() has already refused every subagent but the Rule 7 agents,
// whose own hook holds each to its allow list (agent-guard.js).
const privateFileRefusal = (input, root, cwd) => {
  if (PRIVATE_FILE.test(namedText(input))) return "private-file-denied";
  return searchReaches(reachesPrivateFile, input, root, cwd) ? "private-file-denied" : null;
};

// The main session's refusal for a call that could read a file only a script
// or a Rule 7 agent reads. The compile agent reads _ballot companions, and
// refusal() has already let the Rule 7 agents through.
const sessionFileRefusal = (input, root, cwd) => {
  if (SESSION_FILE.test(namedText(input))) return "session-file-denied";
  return searchReaches(reachesBallotSources, input, root, cwd) ? "session-file-denied" : null;
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
  // The settings hook runs inside every subagent too. One that no launch below
  // saw (a skill's fork, a workflow) holds no token and no allow list.
  if (input.agent_id !== undefined) return isAgent(input.agent_type) ? null : "agent-type-denied";
  const fileCode = privateFileRefusal(input, root, cwd) ?? sessionFileRefusal(input, root, cwd);
  if (fileCode) return fileCode;
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
  if (SHELL_TOOLS.has(tool)) {
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
