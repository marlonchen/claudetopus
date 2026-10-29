"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT } = require("./harness");
const { fetchSnapshot, repo } = require("./fetch-snapshot-fixture");

// fetch-snapshot --searched (snapshot-format.md, Search log), run as a
// subprocess against a temp data repo (seam 1).

const LOG = `${BALLOT}/search-log/us-house-07.tsv`;

const searched = (data, contest, subject, item) =>
  fetchSnapshot(data, ["--searched", BALLOT, contest, subject, item]);

// The local date, as the script writes it.
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// A log with each date a run begun on `before` could write (that day, or
// today if it ran past midnight) read as <today>.
const undated = (text, before) =>
  text.replace(/\t([0-9]{4}-[0-9]{2}-[0-9]{2})\n/g, (line, date) =>
    date === before || date === today() ? "\t<today>\n" : line,
  );

const MEASURE_BALLOT = DEFAULT_BALLOT.replace("contest_count: 2", "contest_count: 3").concat(
  `  - id: question-1
    type: measure
    jurisdiction: XX Exampleton County
    search_terms: library levy
    title: "Question 1: Library Levy"
`,
);

describe("fetch-snapshot --searched: logging a checklist item", () => {
  it("appends one line per run, with the contest, subject, item and today's date", async () => {
    const data = repo();
    const before = today();
    const first = await searched(data, "us-house-07", "jane-example", "4");
    assert.strictEqual(first.stdout, "search-log/us-house-07.tsv logged\n");
    assert.strictEqual(first.status, 0);
    await searched(data, "us-house-07", "jane-example", "4");
    const line = "us-house-07\tjane-example\t4\t<today>\n";
    assert.strictEqual(undated(data.read(LOG), before), line + line);
  });

  it("logs a retention official under its id, item 7, and a measure under _race, item 6", async () => {
    const data = repo({ ballot: MEASURE_BALLOT });
    const before = today();
    assert.strictEqual(
      (await searched(data, "supreme-court-retention-a", "pat-example", "7")).status,
      0,
    );
    assert.strictEqual((await searched(data, "question-1", "_race", "6")).status, 0);
    assert.strictEqual(
      undated(data.read(`${BALLOT}/search-log/supreme-court-retention-a.tsv`), before),
      "supreme-court-retention-a\tpat-example\t7\t<today>\n",
    );
    assert.strictEqual(
      undated(data.read(`${BALLOT}/search-log/question-1.tsv`), before),
      "question-1\t_race\t6\t<today>\n",
    );
  });
});

describe("fetch-snapshot --searched: refusals write no line", () => {
  // Each refusal prints its one line, exits 1 and leaves the contest's log absent.
  const refuses = async (data, args, line, log = LOG) => {
    const result = await fetchSnapshot(data, args);
    assert.strictEqual(result.stdout, `${line}\n`);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(data.exists(log), false, "a line was written");
  };

  it("refuses a subject the contest does not list, without echoing a malformed one", async () => {
    const data = repo({ ballot: MEASURE_BALLOT });
    const run = (contest, subject) => ["--searched", BALLOT, contest, subject, "4"];
    await refuses(
      data,
      run("us-house-07", "pat-example"),
      "us-house-07/pat-example unknown-subject",
    );
    await refuses(data, run("us-house-07", "_race"), "us-house-07/_race unknown-subject");
    await refuses(data, run("us-house-07", "Precinct 12"), "us-house-07/- unknown-subject");
    await refuses(
      data,
      ["--searched", BALLOT, "question-1", "jane-example", "6"],
      "question-1/jane-example unknown-subject",
      `${BALLOT}/search-log/question-1.tsv`,
    );
  });

  it("refuses an item the contest's type does not use", async () => {
    const data = repo({ ballot: MEASURE_BALLOT });
    for (const item of ["6", "7", "0", "05", "x", ""]) {
      await refuses(
        data,
        ["--searched", BALLOT, "us-house-07", "jane-example", item],
        "us-house-07/jane-example bad-item",
      );
    }
    await refuses(
      data,
      ["--searched", BALLOT, "question-1", "_race", "5"],
      "question-1/_race bad-item",
      `${BALLOT}/search-log/question-1.tsv`,
    );
    await refuses(
      data,
      ["--searched", BALLOT, "supreme-court-retention-a", "pat-example", "1"],
      "supreme-court-retention-a/pat-example bad-item",
      `${BALLOT}/search-log/supreme-court-retention-a.tsv`,
    );
  });

  it("refuses an unknown contest, a bad ballot and a wrong argument count", async () => {
    const data = repo();
    await refuses(
      data,
      ["--searched", BALLOT, "us-senate", "jane-example", "4"],
      `${BALLOT}/ballot.yaml unknown-contest`,
      `${BALLOT}/search-log/us-senate.tsv`,
    );
    await refuses(
      data,
      ["--searched", "xx-exampleton-1", "us-house-07", "jane-example", "4"],
      "- bad-ballot",
    );
    await refuses(data, ["--searched", BALLOT, "us-house-07", "jane-example"], "- usage");
    await refuses(data, ["--searched", BALLOT, "us-house-07", "jane-example", "4", "x"], "- usage");
    await refuses(data, ["--searched", BALLOT, "us-house-07", "--ballot", "4"], "- usage");
  });

  it("refuses to append to a log whose last line has no newline", async () => {
    const data = repo();
    data.write(LOG, "us-house-07\tjane-example\t4\t2026-10-01");
    const result = await searched(data, "us-house-07", "jane-example", "5");
    assert.strictEqual(result.stdout, "search-log/us-house-07.tsv search-log-invalid\n");
    assert.strictEqual(result.status, 1);
    assert.strictEqual(data.read(LOG), "us-house-07\tjane-example\t4\t2026-10-01");
  });

  it("refuses a log coverage would fail, and one that is not a regular file", async () => {
    const outside = (data) => data.file("outside.tsv");
    // Each case: what it plants, and a check that nothing was written.
    const cases = [
      ["a CRLF line", (data) => data.write(LOG, "us-house-07\tjane-example\t4\t2026-10-01\r\n")],
      [
        "another contest's line",
        (data) => data.write(LOG, "us-senate\tjane-example\t4\t2026-10-01\n"),
      ],
      ["a directory", (data) => fs.mkdirSync(data.file(LOG), { recursive: true })],
      [
        "a symlink",
        (data) => {
          data.write("outside.tsv", "");
          fs.mkdirSync(data.file(`${BALLOT}/search-log`));
          fs.symlinkSync(outside(data), data.file(LOG));
        },
      ],
      ["search-log/ as a file", (data) => data.write(`${BALLOT}/search-log`, "")],
    ];
    for (const [what, plant] of cases) {
      const data = repo();
      plant(data);
      const kept = (rel) => (fs.lstatSync(data.file(rel)).isFile() ? data.read(rel) : null);
      const before = [LOG, `${BALLOT}/search-log`].map((rel) => data.exists(rel) && kept(rel));
      const result = await searched(data, "us-house-07", "jane-example", "5");
      assert.strictEqual(result.stdout, "search-log/us-house-07.tsv search-log-invalid\n", what);
      assert.strictEqual(result.status, 1, what);
      const after = [LOG, `${BALLOT}/search-log`].map((rel) => data.exists(rel) && kept(rel));
      assert.deepStrictEqual(after, before, what);
      if (what === "a symlink")
        assert.strictEqual(fs.readFileSync(outside(data), "utf8"), "", what);
    }
  });

  it("checks Rule 8 before it writes", async () => {
    const data = repo({ publish: false });
    await refuses(
      data,
      ["--searched", BALLOT, "us-house-07", "jane-example", "4"],
      "publish.yaml guard-no-publish-yaml",
    );
  });
});
