"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { dropContests, scanPage } = require("../scripts/lib/page-scan");

// Seam 2: publish's privacy scan (SKILL.md steps 6.2-6.3) on hand-built
// answers and pages, for the spellings and markup that would be slow to plant
// through a data repo. publish-scan.test.js runs the command itself.

const VALUES = {
  "ballot-id": ["xx-exampleton-1"],
  "private-string": ["Springfield Township", "Pct 12", "Mary-Jane Lane", "Oct 19 Ward"],
  address: ["123 Elm Street Apt 4, Springfield, XX 99999", "123 Elm Street"],
  zip: ["99999"],
  label: ["addr-mom"],
  title: ["Question 1: Springfield Township Library Levy"],
  key: ["k3yV4lue0123456789"],
};

// ready()'s answer for a contest whose claims are { text, excerpt, source },
// each its own claim on lines 2n+1 and 2n+2, keyed k<n>, citing s<n>.md.
const answer = (claims) => ({
  ready: true,
  claims: claims.map((c, n) => ({
    claim: { text: c.text, excerpt: c.excerpt, line: 2 * n + 1, excerptLine: 2 * n + 2 },
    key: `k${n}`,
    snapshot: c.snapshot ?? `s${n}.md`,
  })),
  readSnapshot: (rel) => ({
    fields: { source: claims.find((c, n) => (c.snapshot ?? `s${n}.md`) === rel)?.source },
  }),
});
const CLEAN = {
  text: "Jane Example taught school for twelve years.",
  excerpt: "Jane Example taught school for twelve years.",
  source: "Example News",
};
const drops = (claims, values = VALUES) =>
  dropContests(["c"], new Map([["c", answer(claims)]]), values);

describe("publish scan: claims, excerpts and source names (step 6.2)", () => {
  it("drops a contest whose claim or excerpt holds a private value, by line and key", () => {
    const found = drops([
      CLEAN,
      { ...CLEAN, text: "Jane Example spoke at the Pct 12 meeting." },
      { ...CLEAN, excerpt: "She spoke in Springfield\nTownship." },
    ]);
    assert.deepStrictEqual(found.lines, [
      "articles/c.md:3 private-match k1",
      "articles/c.md:6 private-match k2",
    ]);
    assert.deepStrictEqual([...found.dropped], [["c", ["private-match"]]]);
  });

  it("finds a phrase a pdftotext break hyphenated, in either form", () => {
    for (const excerpt of [
      "She grew up in Spring-field Township.",
      "She grew up in Spring‐field Township.",
      "She lives on MaryJane Lane.",
      "She lives on Mary-Jane Lane.",
    ]) {
      assert.deepStrictEqual(drops([{ ...CLEAN, excerpt }]).lines, [
        "articles/c.md:2 private-match k0",
      ]);
    }
    // Any dash, and an invisible character beside it, reads as the break's hyphen.
    for (const dash of ["\u2012", "\u2013", "\u2014", "\u2212", "\ufe63", "\uff0d", "\u2e3a"]) {
      const excerpt = `She grew up in Spring${dash}field Township.`;
      assert.deepStrictEqual(
        drops([{ ...CLEAN, excerpt }]).lines,
        ["articles/c.md:2 private-match k0"],
        excerpt,
      );
    }
    for (const hidden of ["\u00ad-", "-\u200b", "-\u2060", "-\u034f", "\u200d-"]) {
      const excerpt = `She grew up in Spring${hidden}field Township.`;
      assert.deepStrictEqual(
        drops([{ ...CLEAN, excerpt }]).lines,
        ["articles/c.md:2 private-match k0"],
        excerpt,
      );
    }
    // A break hyphen beside a hyphen standing for a space, and a value typed with a dash.
    for (const [excerpt, values] of [
      ["She grew up in Spring-field-Township.", VALUES],
      ["She grew up in Spring- field Township.", VALUES],
      ["She lives on MaryJane Lane.", { ...VALUES, "private-string": ["Mary\u2013Jane Lane"] }],
    ]) {
      assert.deepStrictEqual(
        drops([{ ...CLEAN, excerpt }], values).lines,
        ["articles/c.md:2 private-match k0"],
        excerpt,
      );
    }
    // A hyphen beside a digit is never joined, and a space is no hyphen.
    for (const excerpt of ["She saw a spring field in the township.", "Pct-1-2 voted."]) {
      assert.deepStrictEqual(drops([{ ...CLEAN, excerpt }]).lines, [], excerpt);
    }
  });

  it("drops each claim citing a snapshot whose source name matches", () => {
    const gazette = { ...CLEAN, snapshot: "g.md", source: "Springfield-Township Gazette" };
    const found = drops([CLEAN, gazette, { ...gazette, text: "Jane Example ran twice." }]);
    assert.deepStrictEqual(found.lines, [
      "articles/c.md:3 private-source k1",
      "articles/c.md:5 private-source k2",
    ]);
    assert.deepStrictEqual([...found.dropped], [["c", ["private-source"]]]);
  });

  it("drops a claim holding markup the page may not: a script, a link or a key", () => {
    for (const text of [
      "Jane Example posted <script>x</script> online.",
      'Jane Example linked <a href="https://x.example/">it</a>.',
      "Jane Example linked <img src=x>.",
      "See https://x.example/?api_key=1 for more.",
      "Her site is k3yV4lue0123456789.",
    ]) {
      assert.deepStrictEqual(
        drops([{ ...CLEAN, text }]).lines,
        ["articles/c.md:1 private-match k0"],
        text,
      );
    }
  });

  it("scans only ready contests, and reports each in ballot order", () => {
    const leak = { ...CLEAN, text: "Jane Example lives at 123 Elm Street." };
    const answers = new Map([
      ["b", answer([leak])],
      ["a", { ...answer([leak]), ready: false }],
      ["c", answer([{ ...CLEAN, snapshot: "notes.md", source: "addr-mom notes" }])],
    ]);
    const found = dropContests(["a", "b", "c"], answers, VALUES);
    assert.deepStrictEqual(found.lines, [
      "articles/b.md:1 private-match k0",
      "articles/c.md:1 private-source k0",
    ]);
    assert.deepStrictEqual([...found.dropped.keys()], ["b", "c"]);
  });
});

// A page as page.js lays it out, around `body`.
const pageOf = (body) =>
  `<!doctype html>\n<html><head><style>\n:root{}\n</style></head><body>\n${body}\n</body></html>\n`;
const LINKS = ["https://news.example.com/jane"];
const codes = (html, { links = LINKS, values = VALUES } = {}) =>
  scanPage(html, values, { links }).map((m) => `${m.line} ${m.code}`);

describe("publish scan: the rendered page (step 6.3)", () => {
  it("passes a page with only receipt links and anchors", () => {
    const body = `<a href="#ballot">Ballot</a><a class="link" href="https://news.example.com/jane">Original page</a>`;
    assert.deepStrictEqual(codes(pageOf(body)), []);
  });

  it("skips only the generated dates for digit runs, never the same text elsewhere", () => {
    const body = [
      `<div class="meta">Updated Oct 19, 2026</div>`,
      `<div class="note">News<br>The quote above was saved on Oct 19, 2026 from this source.</div>`,
      `<p>Oct 19, 2026 was the day.</p>`,
      `<div class="meta">Updated 99999</div>`,
    ].join("\n");
    assert.deepStrictEqual(codes(pageOf(body)), ["7 private-string", "8 private-zip"]);
  });

  it("refuses every value class in all three forms, by line", () => {
    const body = [
      `<a href="#xx-exampleton-1">x</a>`,
      `<p>XX_EXAMPLETON_1 and addr&#45;mom</p>`,
      `<p>Question 1: Springfield Township Library Levy</p>`,
      `<p>123&nbsp;Elm Street</p>`,
      `<p>k3yV4lue0123456789</p>`,
    ].join("\n");
    assert.deepStrictEqual(codes(pageOf(body)), [
      "5 private-ballot-id",
      "6 private-ballot-id",
      "6 private-label",
      "7 private-string",
      "7 private-title",
      "8 private-address",
      "9 private-key",
    ]);
  });

  it("refuses a script, an external src or href, and a key parameter", () => {
    const body = [
      "<SCRIPT>x</SCRIPT>",
      '<a href="https://evil.example/">x</a>',
      "<img src=x>",
      '<a href="https://news.example.com/jane?api_key=1">x</a>',
      "<p>?a=1&amp;TOKEN=2</p>",
      '<a href="https://news.example.com/jane#ballot">x</a>',
      "<p>&lt;img src=x&gt;</p>",
    ].join("\n");
    assert.deepStrictEqual(codes(pageOf(body)), [
      "5 page-script",
      "6 page-link",
      "7 page-link",
      "8 private-key",
      "8 page-link",
      "9 private-key",
      "10 page-link",
      "11 page-link",
    ]);
  });

  it("gives each match's span for --show", () => {
    const html = pageOf("<p>near Pct 12 and pct-12</p>");
    const [match] = scanPage(html, VALUES, { links: [] });
    assert.deepStrictEqual(
      match.spans.map(([start, end]) => html.slice(start, end)),
      ["Pct 12", "pct-12"],
    );
  });
});
