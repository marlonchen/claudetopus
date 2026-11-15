"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const { git, makeDataRepo } = require("./harness");

// Git exports GIT_DIR and its other local variables to a hook, and inside a
// worktree they name the worktree's directory in the shared repository. The
// pre-commit hook runs these tests, so a harness that passed them on would
// init and add remotes there instead of in its temp data repo: on 2026-11-11
// that set core.bare on the main checkout (ticket 61).

describe("the harness under a git hook's environment", () => {
  it("makeDataRepo leaves the repository GIT_DIR names unchanged", () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hook-"));
    const main = path.join(scratch, "main");
    git(scratch, "init", "-q", main);
    git(
      main,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    git(main, "worktree", "add", "-q", path.join(scratch, "wt"));
    const config = path.join(main, ".git", "config");
    const before = fs.readFileSync(config, "utf8");
    const gitDir = path.join(main, ".git", "worktrees", "wt");
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = gitDir;
    process.env.GIT_INDEX_FILE = path.join(gitDir, "index");
    let data;
    try {
      data = makeDataRepo();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    try {
      const after = fs.readFileSync(config, "utf8");
      assert.equal(after, before);
      assert.match(after, /bare = false/);
      assert.doesNotMatch(after, /\[remote/);
      assert.ok(fs.existsSync(path.join(data.root, ".git", "config")));
      assert.equal(
        git(data.root, "remote", "get-url", "origin").trim(),
        "https://github.com/me/elections.git",
      );
    } finally {
      data?.cleanup();
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
