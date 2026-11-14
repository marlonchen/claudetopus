"use strict";

const assert = require("node:assert");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT, makeDataRepo, runCli } = require("./harness");

// ballot.yaml's one contest model (data-files.js): every reader judges a
// contest by the same rules, so what ballot-check passes is what coverage and
// fetch-snapshot read. Each ballot below is fed to every reader, run as a
// subprocess against a temp data repo (seam 1). ballot-check locates the
// fault by line; every other reader fails the file as a whole.

const repos = [];
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const edit = (from, to) => {
  assert.ok(DEFAULT_BALLOT.includes(from), `${from} is not in the ballot`);
  return DEFAULT_BALLOT.replace(from, to);
};

// The 1-based line of the first line of `ballot` that holds `text`.
const lineOf = (ballot, text) => ballot.split("\n").findIndex((l) => l.includes(text)) + 1;

// A fetch that gets past the ballot reaches a closed local port, never the web.
const run = (data, script, args) =>
  runCli(script, args, {
    cwd: data.root,
    env: { ...data.env, RESEARCH_CANDIDATES_TEST_HTTP_TARGET: "127.0.0.1:9" },
  });

// The other readers, each given a target ballot.yaml lists when valid. A
// passing coverage needs an article; any article will do, since the ballot
// fails first.
const READERS = [
  ["coverage", [BALLOT, "us-house-07"], "ballot.yaml ballot-invalid"],
  [
    "fetch-snapshot",
    [BALLOT, "us-house-07", "john-sample", "bio", "https://county.example.gov/"],
    `${BALLOT}/ballot.yaml ballot-invalid`,
  ],
  [
    "fetch-snapshot",
    ["--searched", BALLOT, "us-house-07", "john-sample", "1"],
    `${BALLOT}/ballot.yaml ballot-invalid`,
  ],
];

// Feed `ballot` to every reader: ballot-check reports `located`, each other
// reader fails ballot-invalid, and none writes anything.
const everyReaderFails = async (ballot, located) => {
  const data = makeDataRepo({ ballot });
  repos.push(data);
  data.write(`${BALLOT}/articles/us-house-07.md`, "# us-house-07\n");
  const checked = await run(data, "ballot-check", [BALLOT]);
  assert.strictEqual(checked.status, 1);
  assert.ok(checked.stdout.split("\n").includes(located), `${located} not in\n${checked.stdout}`);
  for (const [script, args, expected] of READERS) {
    const result = await run(data, script, args);
    assert.strictEqual(result.stdout, `${expected}\n`, `${script} ${args[0]}`);
    assert.strictEqual(result.status, 1, `${script} ${args[0]}`);
  }
  assert.ok(!data.exists(`${BALLOT}/search-log/us-house-07.tsv`), "a search log was written");
  assert.ok(!data.exists(`${BALLOT}/sources/us-house-07`), "a snapshot was saved");
};

describe("contest model: the PR #16 divergences agree in every reader", () => {
  it("fails a whitespace-only name", async () => {
    const ballot = edit("name: John Sample", 'name: "   "');
    await everyReaderFails(
      ballot,
      `ballot.yaml:${lineOf(ballot, 'name: "   "')} ballot-invalid name`,
    );
  });

  it("fails a not_researched entry given twice", async () => {
    const ballot = edit(
      "    vote_for: 1\n",
      "    vote_for: 1\n    not_researched: [Money, Money]\n",
    );
    await everyReaderFails(
      ballot,
      `ballot.yaml:${lineOf(ballot, "not_researched")} not-researched-invalid not_researched`,
    );
  });

  it("fails a candidate or official id that is not an id", async () => {
    const candidate = edit("id: jane-example", "id: Jane_Example");
    await everyReaderFails(
      candidate,
      `ballot.yaml:${lineOf(candidate, "Jane_Example")} id-invalid id`,
    );
    const official = edit("id: pat-example", "id: Pat Example");
    await everyReaderFails(
      official,
      `ballot.yaml:${lineOf(official, "id: Pat Example")} id-invalid id`,
    );
  });

  it("fails a contest with no type", async () => {
    const ballot = edit("    type: candidate\n", "");
    await everyReaderFails(
      ballot,
      `ballot.yaml:${lineOf(ballot, "- id: us-house-07")} ballot-invalid type`,
    );
  });
});
