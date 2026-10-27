"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const { depsDir } = require("../scripts/lib/deps");
const { BALLOT, git, runCli } = require("./harness");
const { COUNTY_PAGE, PLAIN, fetchSnapshot, fetchVia, repo } = require("./fetch-snapshot-fixture");

// fetch-snapshot's Rule 8 repo guard and its pinned dependencies.

describe("a pinned install stays its git tree", () => {
  // The skill-pin gate refuses any file under the installed skill that its
  // tree lacks, so running a command must not leave one (no node_modules).
  const skillDir = path.join(__dirname, "..");
  // Every file git does not track, ignored or not: the gate refuses both kinds.
  const untracked = () =>
    git(skillDir, "ls-files", "--others", "--exclude=.DS_Store", ".").split("\n").filter(Boolean);

  it("sees a stray file whether or not .gitignore covers it", () => {
    const stray = path.join(skillDir, "zz-stray-probe.txt");
    fs.writeFileSync(stray, "x");
    try {
      assert.ok(untracked().includes("zz-stray-probe.txt"));
    } finally {
      fs.rmSync(stray);
    }
  });

  it("loads its dependencies from outside the skill directory", async () => {
    assert.ok(path.relative(skillDir, depsDir()).startsWith(".."));
    const before = untracked();
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(untracked(), before);
  });
});

describe("deps.js: the npm dependencies load only from the install-deps cache", () => {
  // Value: protects=a missing dependency install reports deps-missing pointing at install-deps; fails_when=load() rethrows MODULE_NOT_FOUND as internal-error or resolves modules from elsewhere; why_new=every other test runs with deps installed; seam=none; no_claim=a partly installed cache
  it("answers deps-missing, naming install-deps, before fetching anything", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
      { RESEARCH_CANDIDATES_DEPS: data.file(".no-deps") },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "scripts/install-deps deps-missing\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(result.seen, []);
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  it("loads no dependency from outside the install-deps cache, even through NODE_PATH", async () => {
    const data = repo();
    data.write("np/yaml/package.json", '{"name":"yaml","main":"i.js"}');
    data.write("np/yaml/i.js", "module.exports = {};");
    data.write(".empty-deps/package.json", "{}");
    data.write(".empty-deps/node_modules/.keep", "");
    const result = await fetchVia(data, routes, PLAIN, {
      RESEARCH_CANDIDATES_DEPS: data.file(".empty-deps"),
      NODE_PATH: data.file("np"),
    });
    assert.equal(result.stdout, "scripts/install-deps deps-missing\n");
    assert.deepEqual(result.seen, []);
  });

  it("finds its dependencies through a symlinked cache path", async () => {
    const data = repo();
    const link = data.file("deps-link");
    fs.symlinkSync(depsDir(), link);
    const result = await fetchVia(data, routes, PLAIN, { RESEARCH_CANDIDATES_DEPS: link });
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
  });
});

describe("Rule 8: the repo guard refuses to write outside a private data repo", () => {
  it("refuses without publish.yaml", async () => {
    const data = repo({ publish: false });
    const result = await fetchVia(data, {}, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "publish.yaml guard-no-publish-yaml\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
    assert.deepEqual(result.seen, []);
  });

  it("refuses in a clone of the skill's source repo", async () => {
    const data = repo();
    data.write("skills/research-candidates/SKILL.md", "---\nname: research-candidates\n---\n");
    const result = await fetchSnapshot(data, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "skills/research-candidates/SKILL.md guard-skill-source-clone\n");
  });

  it("refuses when run from below the repo's top level", async () => {
    const data = repo();
    data.write("sub/publish.yaml", "branch: main\n");
    const result = await runCli("fetch-snapshot", PLAIN, {
      cwd: data.file("sub"),
      env: data.env,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ". guard-not-repo-root\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
  });

  // Value: protects=a project root outside any git repo is refused, since its remotes cannot be checked; fails_when=guardRepo treats a failed `git remote` as no remotes and lets the run write; why_new=every other guard test runs inside a git repo; seam=none; no_claim=a git repo with no remotes
  it("refuses outside a git repo", async () => {
    const data = repo();
    fs.rmSync(data.file(".git"), { recursive: true, force: true });
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ". guard-not-git-repo\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
    assert.deepEqual(result.seen, []);
  });

  const refusesRemote = (name, options, code) =>
    it(name, async () => {
      const data = repo(options);
      const result = await fetchVia(data, {}, PLAIN);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, code);
      assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
      assert.deepEqual(result.seen, []);
    });

  refusesRemote(
    "refuses a public remote",
    { gh: { "me/elections": { visibility: "PUBLIC", id: 42 } } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "refuses a remote whose fork-network root is the skill's source repo, by id",
    {
      remotes: { origin: ["git@github.com:Me/Renamed-Fork.git"] },
      gh: { "me/renamed-fork": { visibility: "PRIVATE", id: 7, sourceId: 1373776339 } },
    },
    "remote:origin guard-skill-source-remote\n",
  );
  refusesRemote(
    "counts a remote that is not on GitHub as public",
    { remotes: { origin: ["https://gitlab.com/me/elections.git"] } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "counts a gh error as public",
    { gh: {} },
    "remote:origin guard-remote-not-private\n",
  );
  it("asks gh once about each distinct URL, however many times the remote lists it", async () => {
    const data = repo({ pushUrls: { origin: ["https://github.com/me/elections.git"] } });
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(data.ghCalls(), ["me/elections"]);
  });

  refusesRemote(
    "counts an unread visibility as public",
    { gh: { "me/elections": { visibility: "", id: 42 } } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "checks every push URL as well as the fetch URL",
    {
      pushUrls: { origin: ["https://github.com/me/elections-mirror"] },
      gh: {
        "me/elections": { visibility: "PRIVATE", id: 42 },
        "me/elections-mirror": { visibility: "PUBLIC", id: 43 },
      },
    },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "checks every remote, not only origin",
    {
      remotes: {
        origin: ["https://github.com/me/elections.git"],
        backup: ["ssh://git@github.com/me/backup.git"],
      },
      gh: {
        "me/elections": { visibility: "PRIVATE", id: 42 },
        "me/backup": { visibility: "INTERNAL", id: 44 },
      },
    },
    "remote:backup guard-remote-not-private\n",
  );
});
