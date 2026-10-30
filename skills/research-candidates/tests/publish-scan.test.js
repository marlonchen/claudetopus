"use strict";

const assert = require("node:assert");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, runCli, runInTty } = require("./harness");
const {
  claim,
  houseArticle,
  lines,
  page,
  publish,
  repos,
  setup,
  snapshot,
  text,
} = require("./publish-fixture");

// publish's privacy scan (SKILL.md steps 6.2-6.3), run as a subprocess against
// a temp data repo with real git (seam 1): drops of a contest, refusals of the
// whole page, and `--show`. page-scan.test.js covers the spellings.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SITE = `${BALLOT}/site/index.html`;
const MEETING = "sources/us-house-07/jane-example/meeting.md";
const OTHERS = [
  "articles/school-director.md not-ready file-missing",
  "articles/supreme-court-retention-a.md not-ready file-missing",
  "articles/question-1.md not-ready file-missing",
];

// A House contest whose Background claim cites a meeting snapshot: `body` is
// the snapshot's text and the excerpt, `text` the claim; `fields` override
// the snapshot's source or url.
const meetingSetup = ({ body, claimText = body, ...fields }) =>
  setup({
    house: houseArticle({ background: claim(claimText, "T2", MEETING, body) }),
    snapshots: {
      [MEETING]: snapshot({
        subject: "jane-example",
        url: "https://news.example.com/meeting",
        body,
        ...fields,
      }),
    },
  });

// The House article's line holding `needle`, and review-list's key for each line.
const lineOf = (data, needle) =>
  data
    .read(`${BALLOT}/articles/us-house-07.md`)
    .split("\n")
    .findIndex((l) => l.includes(needle)) + 1;
const keyAt = async (data, line) => {
  const keys = await runCli("review-list", ["--keys", BALLOT, "us-house-07"], {
    cwd: data.root,
    env: data.env,
  });
  const found = keys.stdout
    .split("\n")
    .find((l) => l.startsWith(`articles/us-house-07.md:${line} `));
  assert.ok(found, keys.stdout);
  return found.split(" ")[2];
};

describe("publish scan: a match in a contest's research drops only that contest", () => {
  it("drops a contest whose claim and excerpt hold a private string, and renders it not ready", async () => {
    const body = "Jane Example spoke at the Precinct 12 polling place meeting.";
    const data = await meetingSetup({
      body,
      claimText: "Jane Example spoke at the Precinct 12 meeting.",
    });
    const at = lineOf(data, "- Jane Example spoke");
    const key = await keyAt(data, at);
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      `articles/us-house-07.md:${at} private-match ${key}`,
      `articles/us-house-07.md:${at + 1} private-match ${key}`,
      "articles/us-house-07.md not-ready private-match",
      ...OTHERS,
      "site/index.html written",
    ]);
    assert.strictEqual(result.status, 0);
    const house = page(data).getElementById("us-house-07");
    assert.match(text(house), /Not ready yet/);
    assert.doesNotMatch(data.read(SITE), /Precinct|polling/i);
  });

  it("drops a contest whose excerpt quotes a private string split by a hyphen break", async () => {
    const body = "Jane Example grew up in Spring-field Township and still lives there.";
    const data = await meetingSetup({ body, claimText: "Jane Example grew up nearby." });
    const at = lineOf(data, "- Jane Example grew up nearby.");
    const result = await publish(data);
    assert.deepStrictEqual(lines(result).slice(0, 2), [
      `articles/us-house-07.md:${at + 1} private-match ${await keyAt(data, at)}`,
      "articles/us-house-07.md not-ready private-match",
    ]);
    assert.strictEqual(result.status, 0);
  });

  it("drops each contest citing a snapshot whose source name holds a private string", async () => {
    const body = "Jane Example spoke at the library board meeting in March.";
    const data = await meetingSetup({ body, source: "Springfield Township Gazette" });
    const at = lineOf(data, "- Jane Example spoke");
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [
      `articles/us-house-07.md:${at} private-source ${await keyAt(data, at)}`,
      "articles/us-house-07.md not-ready private-source",
      ...OTHERS,
      "site/index.html written",
    ]);
    assert.doesNotMatch(data.read(SITE), /Gazette|Springfield/);
  });
});

describe("publish scan: any other match refuses the whole page", () => {
  const leakSetup = () =>
    meetingSetup({
      body: "Jane Example spoke at the library board meeting in March.",
      url: "https://news.example.com/precinct-12/meeting",
    });

  it("refuses a receipt link holding a private string, by page line and class, and writes no page", async () => {
    const data = await leakSetup();
    // An earlier page never outlives a refused one.
    data.write(SITE, "<!doctype html>old");
    const result = await publish(data);
    const out = lines(result);
    assert.deepStrictEqual(out.slice(0, 4), ["articles/us-house-07.md ready", ...OTHERS]);
    assert.strictEqual(out.length, 5, result.stdout);
    assert.match(out[4], /^site\/index\.html:[0-9]+ private-string$/);
    assert.strictEqual(result.status, 1);
    assert.ok(!data.exists(SITE));
    assert.doesNotMatch(result.stdout, /precinct/i);
  });

  it("refuses the printed title of a contest that has a display_title", async () => {
    const data = await meetingSetup({
      body: "Jane Example spoke at the library board meeting in March.",
      url: "https://news.example.com/question-1-springfield-township-library-levy",
    });
    const result = await publish(data);
    const refused = lines(result).filter((l) => l.startsWith("site/index.html"));
    assert.deepStrictEqual(
      refused.map((l) => l.split(" ")[1]),
      ["private-string", "private-title"],
      result.stdout,
    );
    assert.strictEqual(result.status, 1);
  });

  it("shows the matched text only to --show in a terminal", async () => {
    const data = await leakSetup();
    const piped = await publish(data, ["--show", BALLOT]);
    assert.deepStrictEqual(lines(piped), ["- not-a-terminal"]);
    assert.strictEqual(piped.status, 1);
    const shown = await runInTty("publish", ["--show", BALLOT], { cwd: data.root, env: data.env });
    const out = lines(shown);
    const at = out.findIndex((l) => /^site\/index\.html:[0-9]+ private-string$/.test(l));
    assert.ok(at > 0, shown.stdout);
    assert.match(out[at + 1], /^ {4}.*news\.example\.com\/\[precinct-12\]\/meeting/);
    assert.strictEqual(shown.status, 1);
    assert.ok(!data.exists(SITE));
  });

  it("keeps any ballot's private strings and id off the page, not only this one's", async () => {
    // The page is public: privacy is the family's against the public (SKILL.md step 6.3).
    const OTHER = "2026-general/xx-exampleton-2/private.yaml";
    const body = "Jane Example spoke at the Lakeside Village library board meeting.";
    const dropped = await meetingSetup({ body });
    dropped.write(OTHER, "private_strings:\n  - Lakeside Village\n");
    const at = lineOf(dropped, "- Jane Example spoke");
    const key = await keyAt(dropped, at);
    assert.deepStrictEqual(lines(await publish(dropped)).slice(0, 3), [
      `articles/us-house-07.md:${at} private-match ${key}`,
      `articles/us-house-07.md:${at + 1} private-match ${key}`,
      "articles/us-house-07.md not-ready private-match",
    ]);
    const refused = await meetingSetup({
      body: "Jane Example spoke at the library board meeting in March.",
      url: "https://news.example.com/xx-exampleton-2/meeting",
    });
    refused.write(OTHER, "private_strings: []\n");
    const result = await publish(refused);
    assert.match(lines(result).at(-1), /^site\/index\.html:[0-9]+ private-ballot-id$/);
    assert.strictEqual(result.status, 1);
    assert.doesNotMatch(result.stdout, /exampleton-2|Lakeside/i);
  });
});
