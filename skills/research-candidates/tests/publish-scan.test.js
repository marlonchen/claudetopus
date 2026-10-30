"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
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

const SKILL_DIR = path.join(__dirname, "..");
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

  it("skips the embedded fonts, checked byte for byte, for ZIPs", async () => {
    // A ZIP that stands alone in a bundled font's base64 text.
    const zip = fs
      .readdirSync(path.join(SKILL_DIR, "fonts"))
      .filter((f) => f.endsWith(".woff2"))
      .map((f) => fs.readFileSync(path.join(SKILL_DIR, "fonts", f)).toString("base64"))
      .map((b64) => /(?<![0-9])[0-9]{5}(?![0-9])/.exec(b64)?.[0])
      .find(Boolean);
    assert.ok(zip, "no bundled font holds a standalone 5-digit run");
    const data = await setup();
    data.write(
      "addresses.yaml",
      `addr-mom:\n  address: 123 Elm Street Apt 4, Springfield, XX ${zip}\n  street: 123 Elm Street\n  ballot: ${BALLOT}\n`,
    );
    const result = await publish(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.match(data.read(SITE), new RegExp(`(?<![0-9])${zip}(?![0-9])`));
  });
});
