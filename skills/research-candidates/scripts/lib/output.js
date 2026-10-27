"use strict";

// Every command reports only `location code [key]` lines (Rule 5): never a
// matched or quoted value, never a URL. A Failure carries one such line up to
// the command, which prints it and exits non-zero.

class Failure extends Error {
  constructor(location, code, key) {
    super(`${location} ${code}`);
    this.location = location;
    this.code = code;
    this.key = key;
  }

  get line() {
    return [this.location, this.code, this.key].filter(Boolean).join(" ");
  }
}

const report = (lines) => {
  for (const line of lines) process.stdout.write(`${line}\n`);
};

// Run a command body. Failures print their line; anything else is a bug, so
// it prints a fixed code and the stack goes to stderr only.
const runCommand = async (body) => {
  try {
    const lines = await body();
    report(lines);
    process.exitCode = 0;
  } catch (error) {
    if (error instanceof Failure) {
      report([error.line]);
    } else {
      report(["- internal-error"]);
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  }
};

module.exports = { Failure, runCommand };
