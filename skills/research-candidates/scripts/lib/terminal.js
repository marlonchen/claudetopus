"use strict";

// The terminal guard (Rule 5): modes that print or prompt with private text
// (`--ballot`, `--show`) run only in the researcher's own terminal. They
// refuse when stdout or stdin is not a TTY or CLAUDECODE is set at all, which
// stops a plain Bash call from the session and its `!` prefix. Both are
// things a child process controls, so a command that unsets CLAUDECODE and
// runs under a pseudo-terminal gets past this check alone; the data repo's
// deny rules and its PreToolUse hook (session-guard.js) refuse those commands.

const readline = require("node:readline");
const { Failure } = require("./output");

const requireTerminal = () => {
  if (Object.hasOwn(process.env, "CLAUDECODE") || !process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Failure("-", "not-a-terminal");
  }
};

// Ask a yes/no question at the terminal; only y or yes is a yes.
const confirm = async (question) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => {
      rl.question(question, resolve);
      // Ctrl-D: no answer is a no.
      rl.on("close", () => resolve(""));
    });
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
};

// Control and format characters would act on the researcher's terminal, or
// reorder what it shows (U+202E); show them as U+FFFD.
const printable = (text) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "\ufffd");

module.exports = { confirm, printable, requireTerminal };
