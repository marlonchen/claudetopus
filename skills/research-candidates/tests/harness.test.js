"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { describe, it } = require("node:test");
const { BALLOT, git, installSkill, makeDataRepo, runCli, runInTty } = require("./harness");
const { pagesSetup } = require("./publish-fixture");

// Git exports GIT_DIR and its other local variables to a hook, and inside a
// worktree they name the worktree's directory in the shared repository. The
// pre-commit hook runs these tests, so a harness that passed them on would
// init and add remotes there instead of in its temp data repo: on 2026-11-11
// that set core.bare on the main checkout (ticket 61). A direct `node --test`
// from a hook or `git rebase --exec` gets them too, so the helpers strip them
// themselves.

// A git first on PATH that logs the two variables it was started with, then
// runs the real git from the rest of PATH.
const LOGGING_GIT = `#!/bin/sh
echo "GIT_DIR=\${GIT_DIR-} GIT_INDEX_FILE=\${GIT_INDEX_FILE-}" >> "$GIT_STUB_LOG"
PATH=\${PATH#*:} exec git "$@"
`;

describe("the harness under a git hook's environment", () => {
  it("leaves the repository GIT_DIR and GIT_INDEX_FILE name unchanged", async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hook-"));
    const main = path.join(scratch, "main");
    git(scratch, "init", "-q", main);
    fs.writeFileSync(path.join(main, "file.txt"), "x\n");
    git(main, "add", "file.txt");
    git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "x");
    git(main, "worktree", "add", "-q", path.join(scratch, "wt"));
    const gitDir = path.join(main, ".git", "worktrees", "wt");
    const index = path.join(gitDir, "index");
    const config = path.join(main, ".git", "config");
    const state = () => ({
      config: fs.readFileSync(config, "utf8"),
      refs: git(main, "for-each-ref"),
      index: fs.readFileSync(index),
    });
    const before = state();
    const stub = fs.mkdtempSync(path.join(os.tmpdir(), "rc-git-"));
    fs.writeFileSync(path.join(stub, "git"), LOGGING_GIT);
    fs.chmodSync(path.join(stub, "git"), 0o755);
    const log = path.join(stub, "git.log");
    fs.writeFileSync(log, "");

    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE };
    process.env.GIT_DIR = gitDir;
    process.env.GIT_INDEX_FILE = index;
    let data;
    let pages;
    let remote;
    try {
      data = makeDataRepo();
      installSkill(data);
      pages = pagesSetup(data, { seed: { "seed.txt": "seeded\n" } });
      pages.git("status");
      remote = pages.remoteFile("seed.txt");
      // ballot-check runs git (check-attr) before anything it could fail on.
      const env = {
        ...data.env,
        PATH: `${stub}${path.delimiter}${data.env.PATH}`,
        GIT_STUB_LOG: log,
      };
      await runCli("ballot-check", [BALLOT], { cwd: data.root, env });
      await runInTty("ballot-check", [BALLOT], { cwd: data.root, env });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    try {
      const after = state();
      assert.equal(after.config, before.config);
      assert.match(after.config, /bare = false/);
      assert.doesNotMatch(after.config, /\[remote/);
      assert.equal(after.refs, before.refs);
      assert.ok(after.index.equals(before.index), "the worktree's index changed");
      assert.ok(fs.existsSync(path.join(data.root, ".git", "config")));
      assert.equal(
        git(data.root, "remote", "get-url", "origin").trim(),
        "https://github.com/me/elections.git",
      );
      assert.equal(remote, "seeded\n");
      const calls = fs.readFileSync(log, "utf8").split("\n").filter(Boolean);
      assert.ok(calls.length >= 2, "ballot-check ran no git");
      for (const call of calls) assert.equal(call, "GIT_DIR= GIT_INDEX_FILE=");
    } finally {
      data?.cleanup();
      pages?.cleanup();
      fs.rmSync(stub, { recursive: true, force: true });
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
