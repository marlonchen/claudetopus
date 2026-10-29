"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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

  it("refuses an edit git is told to skip, and a staged manifest change", async () => {
    const data = await setup();
    const rel = `${BALLOT}/search-log/us-house-07.tsv`;
    git(data.root, "update-index", "--skip-worktree", rel);
    data.write(rel, `${data.read(rel)}us-house-07\tjane-example\t6\t2026-10-21\n`);
    // A mode change keeps every manifest line, so only the gate sees it.
    git(data.root, "update-index", "--chmod=+x", `${BALLOT}/snapshots.sha256`);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      "snapshots.sha256 uncommitted",
      "search-log uncommitted",
    ]);
    assert.ok(!data.exists(SITE));
  });

  it("refuses an area that is a symlink or is named in another case", async () => {
    const data = await setup();
    const tiers = data.read("tiers.yaml");
    data.write("tiers-real.yaml", tiers);
    fs.rmSync(path.join(data.root, "tiers.yaml"));
    fs.symlinkSync("tiers-real.yaml", path.join(data.root, "tiers.yaml"));
    // Through another name, as a case-insensitive filesystem needs.
    git(data.root, "mv", `${BALLOT}/review`, `${BALLOT}/review-renamed`);
    git(data.root, "mv", `${BALLOT}/review-renamed`, `${BALLOT}/Review`);
    commit(data);
    const result = await publish(data);
    assert.ok(lines(result).includes("review area-invalid"), result.stdout);
    assert.ok(lines(result).includes("tiers.yaml area-invalid"), result.stdout);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
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

  it("checks every commit, those on a merged branch included", async () => {
    const data = await setup();
    const log = `${BALLOT}/search-log/us-house-07.tsv`;
    const full = data.read(log);
    git(data.root, "checkout", "-q", "-b", "side");
    data.write(log, full.replace(/[^\n]*\n$/, ""));
    commit(data);
    const lost = head(data);
    data.write(log, full);
    commit(data);
    git(data.root, "checkout", "-q", "-");
    const who = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
    git(data.root, ...who, "merge", "-q", "--no-ff", "-m", "merge side", "side");
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`search-log/us-house-07.tsv history-lost-line ${lost}`]);
  });
});

// Commit a merge of `branch` into the current branch whose files are `files`
// (path to text), or the current branch's where not given.
const merge = (data, branch, files = {}) => {
  const who = ["-c", "user.name=t", "-c", "user.email=t@example.com"];
  git(data.root, ...who, "merge", "-q", "--no-ff", "--no-commit", "-s", "ours", branch);
  for (const [rel, text] of Object.entries(files)) data.write(rel, text);
  commit(data, `merge ${branch}`);
  return head(data);
};

describe("publish: ballot gate, merges", () => {
  it("refuses a merge that drops lines only its second parent had", async () => {
    const data = await setup();
    const log = `${BALLOT}/search-log/us-house-07.tsv`;
    data.write(ACCEPTED, `${K1}\n`);
    commit(data);
    // A second machine's work, then a pull resolved with "keep mine".
    git(data.root, "checkout", "-q", "-b", "side");
    data.write(ACCEPTED, `${K1}\n${K2}\n`);
    data.write(log, `${data.read(log)}us-house-07\tjane-example\t6\t2026-10-21\n`);
    commit(data);
    git(data.root, "checkout", "-q", "-");
    data.write(ACCEPTED, `${K1}\n${K3}\n`);
    commit(data);
    const merged = merge(data, "side");
    const result = await publish(data);
    // Path order within a commit.
    assert.deepStrictEqual(lines(result), [
      `review/us-house-07.accepted history-lost-line ${merged}`,
      `search-log/us-house-07.tsv history-lost-line ${merged}`,
    ]);
    assert.ok(!data.exists(SITE));
  });

  it("refuses a merge that changes a manifest line from its second parent", async () => {
    const data = await setup();
    const manifest = `${BALLOT}/snapshots.sha256`;
    const rel = "sources/us-house-07/jane-example/later.md";
    const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
    const original = "Jane Example said one thing.\n";
    const main = git(data.root, "rev-parse", "--abbrev-ref", "HEAD").trim();
    git(data.root, "checkout", "-q", "-b", "side");
    data.write("notes.txt", "side\n");
    commit(data);
    // Saved on main after side branched, so side's manifest lacks its line.
    git(data.root, "checkout", "-q", main);
    data.write(manifest, `${data.read(manifest)}${sha(original)}  ${rel}\n`);
    data.write(`${BALLOT}/${rel}`, original);
    commit(data);
    // Merged into side, the snapshot edited and its line rewritten to match.
    git(data.root, "checkout", "-q", "side");
    const edited = "Jane Example said another thing.\n";
    const merged = merge(data, main, {
      [manifest]: `${data.read(manifest)}${sha(edited)}  ${rel}\n`,
      [`${BALLOT}/${rel}`]: edited,
    });
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`snapshots.sha256 history-lost-line ${merged}`]);
  });

  it("lets a merge take a parent's baseline, never one that matches none", async () => {
    const data = await setup();
    const main = git(data.root, "rev-parse", "--abbrev-ref", "HEAD").trim();
    // An edited claim, a reset and a new first run on another branch, merged as they are.
    git(data.root, "checkout", "-q", "-b", "side");
    const article = `${BALLOT}/articles/us-house-07.md`;
    data.write(article, data.read(article).replace("for twelve years.", "for twelve years"));
    for (const ext of ["baseline", "md", "neutrality.md"])
      git(data.root, "rm", "-q", `${BALLOT}/review/us-house-07.${ext}`);
    commit(data, "reset review us-house-07");
    await review(data, "us-house-07");
    commit(data);
    git(data.root, "checkout", "-q", main);
    const before = data.read(BASELINE);
    git(
      data.root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "merge",
      "-q",
      "--no-ff",
      "-m",
      "merge side",
      "side",
    );
    assert.notStrictEqual(data.read(BASELINE), before);
    const taken = await publish(data);
    assert.strictEqual(taken.status, 0, taken.stdout);
    // A merge whose baseline is neither side's changes it.
    git(data.root, "checkout", "-q", "-b", "other", "HEAD~1");
    data.write("notes.txt", "other\n");
    commit(data);
    git(data.root, "checkout", "-q", main);
    const changed = merge(data, "other", { [BASELINE]: `${data.read(BASELINE)}${K1}\n` });
    assert.deepStrictEqual(lines(await publish(data)), [
      `review/us-house-07.baseline baseline-changed ${changed}`,
    ]);
  });

  it("passes a merge that keeps the lines both sides appended", async () => {
    const data = await setup();
    data.write(ACCEPTED, `${K1}\n`);
    commit(data);
    git(data.root, "checkout", "-q", "-b", "side");
    data.write(ACCEPTED, `${K1}\n${K2}\n`);
    commit(data);
    git(data.root, "checkout", "-q", "-");
    data.write(ACCEPTED, `${K1}\n${K3}\n`);
    commit(data);
    merge(data, "side", { [ACCEPTED]: `${K1}\n${K3}\n${K2}\n` });
    const result = await publish(data);
    assert.strictEqual(result.status, 0, result.stdout);
  });
});

describe("publish: ballot gate, history it cannot misread", () => {
  it("still checks a commit whose message holds a byte git's output could split on", async () => {
    const data = await setup();
    const log = `${BALLOT}/search-log/us-house-07.tsv`;
    const full = data.read(log);
    data.write(log, full.replace(/[^\n]*\n$/, ""));
    commit(data, "tidy\x01up");
    const lost = head(data);
    data.write(log, full);
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`search-log/us-house-07.tsv history-lost-line ${lost}`]);
  });

  it("refuses a shallow clone, whose oldest commit hides the history before it", async () => {
    const data = await setup();
    data.write("notes.txt", "later\n");
    commit(data, "later");
    data.write(".git/shallow", `${git(data.root, "rev-parse", "HEAD~1").trim()}\n`);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [". history-shallow"]);
    assert.ok(!data.exists(SITE));
  });

  it("names a file history lost by its area unless it is a contest's", async () => {
    const data = await setup();
    const planted = `${BALLOT}/review/precinct-12.accepted`;
    data.write(planted, `${K1}\n`);
    commit(data);
    git(data.root, "rm", "-q", planted);
    commit(data);
    const lost = head(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`review history-lost-line ${lost}`]);
    assert.doesNotMatch(result.stdout, /precinct-12/);
  });

  it("does not count a mode change as a changed baseline", async () => {
    const data = await setup();
    fs.chmodSync(path.join(data.root, BASELINE), 0o755);
    git(data.root, "update-index", "--chmod=+x", BASELINE);
    commit(data);
    const result = await publish(data);
    assert.strictEqual(result.status, 0, result.stdout);
  });
});

describe("publish: ballot gate, reset commits", () => {
  it("exempts only removing that contest's .accepted and baseline", async () => {
    // An in-place baseline edit is not a reset, whatever the commit says.
    const edited = await setup();
    edited.write(BASELINE, `${edited.read(BASELINE)}${K1}\n`);
    commit(edited, "reset review us-house-07");
    const changed = head(edited);
    assert.deepStrictEqual(lines(await publish(edited)), [
      `review/us-house-07.baseline baseline-changed ${changed}`,
    ]);

    // Removing .accepted in that contest's reset passes; in another's, it is a lost line.
    for (const [contest, refused] of [
      ["us-house-07", false],
      ["school-director", true],
    ]) {
      const data = await setup();
      data.write(ACCEPTED, `${K1}\n${K2}\n`);
      commit(data);
      git(data.root, "rm", "-q", ACCEPTED);
      commit(data, `reset review ${contest}`);
      const reset = head(data);
      const result = await publish(data);
      assert.strictEqual(
        lines(result).includes(`review/us-house-07.accepted history-lost-line ${reset}`),
        refused,
        result.stdout,
      );
    }
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

  it("removes the page an earlier publish wrote when a later one is refused", async () => {
    const data = await setup();
    assert.strictEqual((await publish(data)).status, 0);
    assert.ok(data.exists(SITE));
    const bio = `${BALLOT}/${JANE_BIO}`;
    data.write(bio, `${data.read(bio)}An added line.\n`);
    commit(data);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`${JANE_BIO} snapshot-hash`]);
    assert.ok(!data.exists(SITE));
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
