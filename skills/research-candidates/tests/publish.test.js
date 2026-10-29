"use strict";

const assert = require("node:assert");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, git } = require("./harness");
const {
  JANE_BIO,
  commit,
  lines,
  page,
  publish,
  repos,
  review,
  setup,
  text,
} = require("./publish-fixture");

// publish (SKILL.md step 6.1-6.2, page.md), run as a subprocess against a temp
// data repo with real git (seam 1). The privacy scan and the push are later
// steps; this covers the gates and the render to site/index.html.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SITE = `${BALLOT}/site/index.html`;

describe("publish: ballot gate", () => {
  it("refuses the whole publish when ballot-check fails", async () => {
    const data = await setup();
    const yaml = `${BALLOT}/ballot.yaml`;
    data.write(yaml, data.read(yaml).replace("contest_count: 4", "contest_count: 5"));
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), ["ballot.yaml ballot-check-failed"]);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
  });

  it("refuses a snapshot that no longer matches its manifest line", async () => {
    const data = await setup();
    const bio = `${BALLOT}/${JANE_BIO}`;
    data.write(bio, `${data.read(bio)}An added line.\n`);
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`${JANE_BIO} snapshot-hash`]);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
  });
});

describe("publish: ballot gate, committed research", () => {
  it("refuses a change that is staged, untracked or ignored, naming only where it is", async () => {
    const data = await setup();
    data.write(".gitignore", "*.private-notes\n");
    commit(data, "ignore notes");
    // Ignored, so plain `git status` would not show it.
    data.write(`${BALLOT}/review/precinct-12.private-notes`, "x\n");
    // Staged but not committed.
    data.write("tiers.yaml", `# reviewed\n${data.read("tiers.yaml")}`);
    git(data.root, "add", "tiers.yaml");
    // Untracked.
    data.write(`${BALLOT}/search-log/us-house-08.tsv`, "");
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      "review uncommitted",
      "tiers.yaml uncommitted",
      "search-log uncommitted",
    ]);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
  });

  it("refuses an edit git is told to assume unchanged", async () => {
    const data = await setup();
    const rel = `${BALLOT}/review/us-house-07.md`;
    git(data.root, "update-index", "--assume-unchanged", rel);
    data.write(rel, `${data.read(rel)}\n`);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), ["review uncommitted"]);
  });
});

// review-list.md, Accepted keys; SKILL.md step 6.1: append-only files only grow.
const K1 = "11111111111111111111111111111111";
const K2 = "22222222222222222222222222222222";
const K3 = "33333333333333333333333333333333";
const ACCEPTED = `${BALLOT}/review/us-house-07.accepted`;
const BASELINE = `${BALLOT}/review/us-house-07.baseline`;
const head = (data) => git(data.root, "rev-parse", "HEAD").trim();

describe("publish: ballot gate, history", () => {
  it("refuses an .accepted that lost a line in an earlier commit", async () => {
    const data = await setup();
    data.write(ACCEPTED, `${K1}\n${K2}\n`);
    commit(data);
    data.write(ACCEPTED, `${K1}\n`);
    commit(data);
    const lost = head(data);
    data.write(ACCEPTED, `${K1}\n${K3}\n`);
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      `review/us-house-07.accepted history-lost-line ${lost}`,
    ]);
    assert.ok(!data.exists(SITE));
  });

  it("lets the next append drop a torn last line of .accepted", async () => {
    const data = await setup();
    data.write(ACCEPTED, `${K1}\n2222`);
    commit(data);
    data.write(ACCEPTED, `${K1}\n${K3}\n`);
    commit(data);
    const result = await publish(data);
    assert.strictEqual(result.status, 0, result.stdout);
  });

  it("refuses a baseline changed outside a reset commit, and allows one reset", async () => {
    const data = await setup();
    const first = data.read(BASELINE);
    data.write(BASELINE, `${first}${K1}\n`);
    commit(data);
    const changed = head(data);
    const refused = await publish(data);
    assert.deepStrictEqual(lines(refused), [
      `review/us-house-07.baseline baseline-changed ${changed}`,
    ]);

    // The same change, made by a reset and a new first run, passes.
    const reset = await setup();
    for (const ext of ["baseline", "md", "neutrality.md"])
      git(reset.root, "rm", "-q", `${BALLOT}/review/us-house-07.${ext}`);
    commit(reset, "reset review us-house-07");
    await review(reset, "us-house-07");
    commit(reset);
    const passed = await publish(reset);
    assert.strictEqual(passed.status, 0, passed.stdout);
  });

  it("refuses a manifest or search log whose commit lost a line of the one before", async () => {
    const data = await setup();
    const manifest = `${BALLOT}/snapshots.sha256`;
    const log = `${BALLOT}/search-log/us-house-07.tsv`;
    const full = { manifest: data.read(manifest), log: data.read(log) };
    // The last line dropped from each, then appended again.
    const dropLast = (text) => text.replace(/[^\n]*\n$/, "");
    data.write(manifest, dropLast(full.manifest));
    data.write(log, dropLast(full.log));
    commit(data);
    const lost = head(data);
    data.write(manifest, full.manifest);
    data.write(log, full.log);
    commit(data);
    const result = await publish(data);
    // In commit order, then path order within a commit.
    assert.deepStrictEqual(lines(result), [
      `search-log/us-house-07.tsv history-lost-line ${lost}`,
      `snapshots.sha256 history-lost-line ${lost}`,
    ]);
  });
});

describe("publish: contest gate", () => {
  it("renders a ready contest in full and every other contest as Not ready yet", async () => {
    const data = await setup();
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      "articles/us-house-07.md ready",
      "articles/school-director.md not-ready file-missing",
      "articles/supreme-court-retention-a.md not-ready file-missing",
      "articles/question-1.md not-ready file-missing",
      "site/index.html written",
    ]);
    assert.strictEqual(result.status, 0);
    const doc = page(data);
    const house = doc.getElementById("us-house-07");
    assert.match(text(house), /Jane Example taught school in Exampleton for twelve years\./);
    const retention = doc.getElementById("supreme-court-retention-a");
    assert.match(text(retention), /Not ready yet\. Every candidate gets the same research/);
    assert.strictEqual(retention.querySelectorAll("h2, blockquote").length, 0);
  });

  it("shows a contest with an edited claim as Not ready yet until it is accepted", async () => {
    const data = await setup();
    const rel = `${BALLOT}/articles/us-house-07.md`;
    // The claim line comes before its excerpt, so only the claim changes.
    data.write(rel, data.read(rel).replace("for twelve years.", "for twelve years"));
    commit(data);
    const result = await publish(data);
    assert.strictEqual(lines(result)[0], "articles/us-house-07.md not-ready unaccepted");
    assert.strictEqual(result.status, 0);
    const house = page(data).getElementById("us-house-07");
    assert.match(text(house), /Not ready yet\./);
    assert.doesNotMatch(text(house), /taught school/);
  });

  it("refuses when a review file is missing next to its baseline", async () => {
    const data = await setup();
    git(data.root, "rm", "-q", `${BALLOT}/review/us-house-07.md`);
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), ["review/us-house-07.md review-missing"]);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
  });
});
