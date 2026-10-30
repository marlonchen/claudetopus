"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, git, runCli } = require("./harness");
const { pagesSetup, publishPush, repos, setup } = require("./publish-fixture");

// publish --push and --device-check (SKILL.md steps 6.4-6.6), run on a
// pseudo-terminal as the researcher runs them, against a temp data repo and a
// Pages clone whose origin is a local bare repo reached through a stub ssh,
// with real git and the stub gh (seam 1).

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SITE = `${BALLOT}/site/index.html`;
const RECORD = `${BALLOT}/published.log`;
const PAGE = "k3x9qa/index.html";
const URL_LINE = /^https:\/\/me\.github\.io\/ballots\/k3x9qa\/$/m;

// The last line the run printed.
const last = (result) => result.stdout.trim().split("\n").at(-1);

// The Pages clone has no change, staged or not, and no untracked file.
const clean = (pages) => assert.strictEqual(pages.git("status", "--porcelain"), "");

// A data repo whose House contest is ready, a Pages repo for it, and one
// earlier publish of its page, so the slug is recorded and its folder exists.
const published = async (options) => {
  const data = await setup();
  const pages = pagesSetup(data, options);
  const first = await publishPush(data);
  assert.strictEqual(first.status, 0, first.stdout);
  return { data, pages };
};

// Change the name in the trust header, so the next page differs.
const rename = (data, name) =>
  data.write(
    "publish.yaml",
    data.read("publish.yaml").replace(/^display_name: .*$/m, `display_name: ${name}`),
  );

describe("publish --push: the push", () => {
  it("pushes the scanned page, alone, to <slug>/index.html and only then gives the URL", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const result = await publishPush(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.strictEqual(pages.remoteFile(PAGE), data.read(SITE));
    assert.strictEqual(
      pages.git("log", "-1", "--format=%s", "origin/main").trim(),
      "publish k3x9qa",
    );
    assert.deepStrictEqual(
      pages.git("show", "--name-only", "--format=", "origin/main").split("\n").filter(Boolean),
      [PAGE],
    );
    assert.match(last(result), URL_LINE);
    assert.ok(result.stdout.indexOf(`${PAGE} pushed`) < result.stdout.search(URL_LINE));
    assert.strictEqual(data.read(RECORD), "k3x9qa\n");
    clean(pages);
  });

  it("shows the diff, the contest list, the size and what becomes public before asking", async () => {
    const data = await setup();
    pagesSetup(data);
    const out = (await publishPush(data)).stdout;
    const ask = out.indexOf("Commit k3x9qa/index.html and push it to me/ballots main? [y/N] ");
    for (const shown of [
      `+++ b/${PAGE}`,
      "  Representative in Congress, 7th District: ready",
      "  Question 1: Not ready yet",
      `${PAGE}: ${fs.statSync(data.file(SITE)).size} bytes`,
      "the contest list and the candidate order",
      "the display name Sam",
      "author Sam <sam@users.noreply.github.com>",
    ]) {
      const at = out.indexOf(shown);
      assert.ok(at >= 0 && at < ask, `not shown before the question: ${shown}`);
    }
    // The page shows display_title; the hidden printed title never reaches the terminal.
    assert.doesNotMatch(out, /Springfield/);
  });

  it("warns when the page is over the 1MB budget, and only then", async () => {
    const data = await setup();
    pagesSetup(data);
    const warning = "Warning: the page is over its 1MB budget (page.md).";
    const small = await publishPush(data, { answers: ["n"] });
    assert.ok(!small.stdout.includes(warning));
    // A trust-header name long enough to carry the page past 1MB.
    rename(data, `Sam${" and Sam".repeat(140000)}`);
    const big = await publishPush(data, { answers: ["n"] });
    assert.ok(fs.statSync(data.file(SITE)).size > 1024 * 1024);
    assert.ok(big.stdout.includes(warning), big.stdout.slice(-400));
  });

  it("prints the device check before a slug's first publish and waits for its yes", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const result = await publishPush(data, { answers: ["n"] });
    assert.match(result.stdout, /1\. iPhone Safari at the largest text size\./);
    assert.match(result.stdout, /5\. Dark mode on both phones\./);
    assert.strictEqual(last(result), "device-check not-confirmed");
    assert.strictEqual(result.status, 1);
    assert.strictEqual(pages.remoteFile(PAGE), null);
    assert.ok(!fs.existsSync(path.join(pages.dir, "k3x9qa")));
    assert.ok(!data.exists(RECORD));
    clean(pages);
  });

  it("republishes with one question and no device check, and --device-check asks it again", async () => {
    const { data, pages } = await published();
    rename(data, "Sam and Alex");
    // A second question would get no answer, and the run would be killed.
    const again = await publishPush(data, { answers: ["y"] });
    assert.strictEqual(again.status, 0, again.stdout);
    assert.doesNotMatch(again.stdout, /Device check/);
    assert.match(again.stdout, /^\+.*Made by Sam and Alex/m);
    assert.strictEqual(pages.remoteFile(PAGE), data.read(SITE));
    assert.strictEqual(data.read(RECORD), "k3x9qa\n");

    rename(data, "Sam");
    const checked = await publishPush(data, { args: ["--device-check", BALLOT] });
    assert.strictEqual(checked.status, 0, checked.stdout);
    assert.match(checked.stdout, /Device check/);
    assert.match(last(checked), URL_LINE);
  });

  it("commits and pushes nothing on a no, and leaves the Pages clone as it was", async () => {
    const { data, pages } = await published();
    const before = pages.git("rev-parse", "HEAD");
    rename(data, "Alex");
    const result = await publishPush(data, { answers: ["n"] });
    assert.strictEqual(last(result), `${PAGE} not-confirmed`);
    assert.strictEqual(result.status, 1);
    assert.doesNotMatch(result.stdout, URL_LINE);
    assert.strictEqual(pages.git("rev-parse", "HEAD"), before);
    assert.notStrictEqual(pages.remoteFile(PAGE), data.read(SITE));
    clean(pages);
  });

  it("pushes HEAD to origin's branch even when git is set to push elsewhere", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    pages.git("remote", "add", "mirror", "git@github.com:me/mirror.git");
    pages.git("config", "remote.pushDefault", "mirror");
    pages.git("config", "push.default", "nothing");
    const gh = JSON.parse(fs.readFileSync(data.env.GH_STUB_FILE, "utf8"));
    gh["me/mirror"] = { visibility: "PUBLIC", id: 78 };
    fs.writeFileSync(data.env.GH_STUB_FILE, JSON.stringify(gh));
    const result = await publishPush(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.strictEqual(pages.remoteFile(PAGE), data.read(SITE));
  });

  it("reports a rejected push without the URL and leaves the commit, which the next run refuses", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const hook = path.join(pages.bare, "hooks", "pre-receive");
    fs.writeFileSync(hook, "#!/bin/sh\nexit 1\n");
    fs.chmodSync(hook, 0o755);
    const result = await publishPush(data);
    assert.strictEqual(last(result), `${PAGE} push-rejected`);
    assert.strictEqual(result.status, 1);
    assert.doesNotMatch(result.stdout, URL_LINE);
    assert.strictEqual(pages.git("log", "-1", "--format=%s").trim(), "publish k3x9qa");
    assert.strictEqual(data.read(RECORD), "k3x9qa\n");
    fs.rmSync(hook);
    const next = await publishPush(data);
    assert.strictEqual(last(next), "pages_dir pages-not-at-origin");
  });
});

describe("publish --push: researcher only", () => {
  it("refuses in the session, before it reads anything", async () => {
    const data = await setup();
    pagesSetup(data);
    for (const mode of ["--push", "--device-check"]) {
      const result = await runCli("publish", [mode, BALLOT], { cwd: data.root, env: data.env });
      assert.deepStrictEqual(result.stdout, "- not-a-terminal\n");
      assert.strictEqual(result.status, 1);
      assert.ok(!data.exists(SITE));
    }
  });
});

describe("publish --push: the slug's record", () => {
  it("refuses a <slug>/index.html this ballot never published, and writes nothing there", async () => {
    const data = await setup();
    const other = "<!doctype html>another family's page";
    const pages = pagesSetup(data, { seed: { [PAGE]: other } });
    const result = await publishPush(data);
    assert.strictEqual(last(result), `${PAGE} slug-unrecorded`);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(pages.remoteFile(PAGE), other);
    assert.strictEqual(fs.readFileSync(path.join(pages.dir, PAGE), "utf8"), other);
    assert.ok(!data.exists(RECORD));
  });

  it("refuses a slug folder that is a link, never writing through it", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const outside = fs.mkdtempSync(path.join(path.dirname(pages.dir), "outside-"));
    fs.symlinkSync(outside, path.join(pages.dir, "k3x9qa"));
    pages.git("add", "k3x9qa");
    pages.git("commit", "-qm", "link");
    pages.git("push", "-q", "origin", "HEAD:refs/heads/main");
    const result = await publishPush(data);
    assert.strictEqual(last(result), `${PAGE} pages-slug-invalid`);
    assert.deepStrictEqual(fs.readdirSync(outside), []);
  });
});

describe("publish --push: the Pages repo (step 6.4)", () => {
  // Refused before any fetch: the stub ssh served nothing.
  const refusedBeforeFetch = async (data, pages, line) => {
    const before = pages.sshCalls().length;
    const result = await publishPush(data);
    assert.strictEqual(last(result), line, result.stdout);
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(pages.sshCalls().slice(before), []);
    assert.doesNotMatch(result.stdout, /\[y\/N\]/);
  };
  const setPublishYaml = (data, key, value) =>
    data.write(
      "publish.yaml",
      data.read("publish.yaml").replace(new RegExp(`^${key}: .*$`, "m"), `${key}: ${value}`),
    );

  it("refuses publish.yaml Pages fields that are missing or malformed", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const yaml = data.read("publish.yaml");
    for (const [key, value] of [
      ["pages_repo", "me"],
      ["pages_repo", "me/ballots.git"],
      ["branch", "-main"],
      ["branch", "a..b"],
    ]) {
      setPublishYaml(data, key, value);
      await refusedBeforeFetch(data, pages, `publish.yaml publish-invalid ${key}`);
      data.write("publish.yaml", yaml);
    }
    data.write("publish.yaml", yaml.replace(/^pages_dir: .*\n/m, ""));
    await refusedBeforeFetch(data, pages, "publish.yaml publish-invalid pages_dir");
  });

  it("expands ~ in pages_dir and refuses one that is not a repo's top level", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const home = path.dirname(pages.dir);
    // The installed dependencies stay where HOME found them.
    const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
    const env = { ...data.env, HOME: home, XDG_CACHE_HOME: cache };
    setPublishYaml(data, "pages_dir", "~/clone");
    const ok = await publishPush({ ...data, env });
    assert.strictEqual(ok.status, 0, ok.stdout);
    fs.mkdirSync(path.join(pages.dir, "sub"));
    setPublishYaml(data, "pages_dir", path.join(pages.dir, "sub"));
    await refusedBeforeFetch(data, pages, "pages_dir pages-not-repo");
    setPublishYaml(data, "pages_dir", path.join(home, "missing"));
    await refusedBeforeFetch(data, pages, "pages_dir pages-not-repo");
  });

  it("refuses the data repo itself, or a repo that shares a commit with it", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    setPublishYaml(data, "pages_dir", data.root);
    await refusedBeforeFetch(data, pages, "pages_dir pages-is-data-repo");
    const copy = path.join(path.dirname(pages.dir), "data-copy");
    git(path.dirname(copy), "clone", "-q", data.root, copy);
    git(copy, "remote", "set-url", "origin", "git@github.com:me/ballots.git");
    setPublishYaml(data, "pages_dir", copy);
    await refusedBeforeFetch(data, pages, "pages_dir pages-shares-history");
  });

  it("refuses an origin with any fetch or push URL that is not pages_repo", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    pages.git("remote", "set-url", "--add", "--push", "origin", "git@github.com:me/other.git");
    await refusedBeforeFetch(data, pages, "pages_dir:remote:origin pages-wrong-origin");
    pages.git("config", "--unset-all", "remote.origin.pushurl");
    pages.git("remote", "rename", "origin", "upstream");
    await refusedBeforeFetch(data, pages, "pages_dir:remote:origin pages-wrong-origin");
  });

  it("refuses a pages_repo or remote whose fork-network root is the skill's source repo, or unread", async () => {
    const data = await setup();
    const pages = pagesSetup(data, { gh: { visibility: "PUBLIC", id: 5, sourceId: 1373776339 } });
    await refusedBeforeFetch(data, pages, "publish.yaml pages-skill-source pages_repo");
    const gh = JSON.parse(fs.readFileSync(data.env.GH_STUB_FILE, "utf8"));
    gh["me/ballots"] = { visibility: "PUBLIC", id: 77 };
    gh["me/fork"] = { visibility: "PUBLIC", id: 9, sourceId: 1373776339 };
    fs.writeFileSync(data.env.GH_STUB_FILE, JSON.stringify(gh));
    pages.git("remote", "add", "fork", "https://github.com/ME/Fork.git");
    await refusedBeforeFetch(data, pages, "pages_dir:remote:fork pages-skill-source");
    pages.git("remote", "set-url", "fork", "https://example.com/fork.git");
    await refusedBeforeFetch(data, pages, "pages_dir:remote:fork pages-root-unread");
    pages.git("remote", "remove", "fork");
    gh["me/ballots"] = { fail: true };
    fs.writeFileSync(data.env.GH_STUB_FILE, JSON.stringify(gh));
    await refusedBeforeFetch(data, pages, "publish.yaml pages-root-unread pages_repo");
  });

  it("refuses a worktree holding a skills/*/SKILL.md, the wrong branch, or a dirty tree", async () => {
    const data = await setup();
    const pages = pagesSetup(data, { seed: { "skills/x/SKILL.md": "---\nname: x\n---\n" } });
    await refusedBeforeFetch(data, pages, "pages_dir pages-holds-skill");
    pages.git("rm", "-q", "-r", "skills");
    pages.git("commit", "-qm", "drop skill");
    pages.git("push", "-q", "origin", "HEAD:refs/heads/main");
    pages.git("checkout", "-q", "-b", "other");
    await refusedBeforeFetch(data, pages, "pages_dir pages-wrong-branch");
    pages.git("checkout", "-q", "main");
    fs.writeFileSync(path.join(pages.dir, "notes.txt"), "x");
    await refusedBeforeFetch(data, pages, "pages_dir pages-dirty");
    fs.rmSync(path.join(pages.dir, "notes.txt"));
    const ok = await publishPush(data);
    assert.strictEqual(ok.status, 0, ok.stdout);
  });

  it("after one fetch, refuses a skill on origin/<branch> or the remote's default branch", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    pages.pushRemote(
      { "skills/x/SKILL.md": "---\nname: x\n---\n" },
      { branch: "gh-pages", head: true },
    );
    const onDefault = await publishPush(data);
    assert.strictEqual(last(onDefault), "pages_dir pages-holds-skill origin/HEAD");
    git(pages.bare, "symbolic-ref", "HEAD", "refs/heads/main");
    pages.pushRemote({ "skills/y/SKILL.md": "---\nname: y\n---\n" });
    const onBranch = await publishPush(data);
    assert.strictEqual(last(onBranch), "pages_dir pages-holds-skill origin/main");
    assert.strictEqual(pages.remoteFile(PAGE), null);
  });

  it("refuses a clone whose HEAD is not origin/<branch>", async () => {
    const { data, pages } = await published();
    pages.pushRemote({ "README.md": "pages\n" });
    const result = await publishPush(data);
    assert.strictEqual(last(result), "pages_dir pages-not-at-origin");
    assert.doesNotMatch(result.stdout, /\[y\/N\]/);
  });

  it("refuses while another run holds the Pages lock, and takes over one whose run is gone", async () => {
    const data = await setup();
    const pages = pagesSetup(data);
    const lock = path.join(pages.dir, ".git", "research-candidates-publish.lock");
    fs.writeFileSync(lock, `${process.pid}\n`);
    await refusedBeforeFetch(data, pages, "pages_dir pages-locked");
    assert.ok(fs.existsSync(lock));
    fs.writeFileSync(lock, "999999999\n");
    const result = await publishPush(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.ok(!fs.existsSync(lock));
  });

  it("refuses a copy git would stage as other bytes, and unstages it", async () => {
    const data = await setup();
    const pages = pagesSetup(data, { seed: { ".gitattributes": "*.html filter=upper\n" } });
    pages.git("config", "filter.upper.clean", "tr a-z A-Z");
    const result = await publishPush(data);
    assert.strictEqual(last(result), `${PAGE} copy-mismatch`);
    assert.doesNotMatch(result.stdout, /\[y\/N\]/);
    clean(pages);
  });
});
