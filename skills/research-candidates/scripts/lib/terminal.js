"use strict";

// The terminal guard (Rule 5): modes that print or prompt with private text
// (`--ballot`, later `--show`) run only in the researcher's own terminal. They
// refuse when stdout or stdin is not a TTY or CLAUDECODE is set at all, so
// neither a Bash call from the session nor its `!` prefix can run them. The
// data repo's settings deny them to every Bash call as well.

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

module.exports = { confirm, requireTerminal };
