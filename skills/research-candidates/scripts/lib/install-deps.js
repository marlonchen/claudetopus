"use strict";

// Install the skill's npm dependencies from its committed lockfile into the
// cache directory lib/deps.js reads, never into the skill directory. `npm ci`
// checks every package against the lockfile's integrity hashes, and
// --ignore-scripts keeps package install scripts from running. The install
// goes to a temp directory renamed into place, so an interrupted run never
// leaves a half-installed directory that looks complete.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { SKILL_DIR, depsDir } = require("./deps");

const main = () => {
  const dir = depsDir();
  if (fs.existsSync(path.join(dir, "node_modules"))) {
    process.stdout.write(`${dir} installed\n`);
    return;
  }
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const file of ["package.json", "package-lock.json"]) {
    fs.copyFileSync(path.join(SKILL_DIR, file), path.join(tmp, file));
  }
  const npm = spawnSync(
    "npm",
    ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"],
    { cwd: tmp, stdio: "inherit" },
  );
  if (npm.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    process.stdout.write(`${dir} npm-ci-failed\n`);
    process.exitCode = 1;
    return;
  }
  try {
    fs.renameSync(tmp, dir);
  } catch (error) {
    // Another install finished first; its copy is the same lockfile's.
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(path.join(dir, "node_modules"))) throw error;
  }
  process.stdout.write(`${dir} installed\n`);
};

module.exports = { main };
