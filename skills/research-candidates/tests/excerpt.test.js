"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { bodyText, findExcerpt } = require("../scripts/lib/normalize");

// Seam 2: excerpt matching (article-format.md, Matching), the edge cases that
// would be slow through the check CLI.

const found = (body, excerpt) => findExcerpt(bodyText(body), excerpt);

describe("article-format.md, Matching: both sides normalized the same way", () => {
  it("finds an excerpt across ligatures, odd spaces, curly quotes and dashes", () => {
    const body =
      "She said \u201cwe will ﬁx the roads\u201d\u00a0\u2014 and won 61\u2009% of the vote.";
    assert.ok(found(body, 'She said "we will fix the roads" - and won 61 % of the vote.'));
  });

  it("drops default-ignorable characters on both sides", () => {
    assert.ok(found("Spring\u00adfield Town\u200bship board", "Springfield Township board"));
    assert.ok(found("Springfield Township board", "Spring\u200bfield Township board"));
  });

  it("collapses whitespace and line breaks that are not hyphen breaks", () => {
    assert.ok(
      found("voted for the\n   school   budget\n\nin 2024", "voted for the school budget in 2024"),
    );
  });

  it("is case-sensitive", () => {
    assert.ok(!found("voted for the school budget", "Voted for the school budget"));
  });
});

describe("article-format.md, Matching: pdftotext hyphenated line breaks", () => {
  const body = "chair of the Spring-\nfield Township board since 2019";

  it("accepts the joined form", () => {
    assert.ok(found(body, "chair of the Springfield Township board"));
  });

  it("accepts the unjoined form, hyphen kept and line break dropped", () => {
    assert.ok(found(body, "chair of the Spring-field Township board"));
  });

  it("never accepts a split form the privacy scan would read as two words", () => {
    assert.ok(!found(body, "chair of the Spring- field Township board"));
    assert.ok(!found(body, "chair of the Spring field Township board"));
  });

  it("lets each break take its own form", () => {
    const two = "a long-\nterm plan for Spring-\nfield roads";
    assert.ok(found(two, "a long-term plan for Springfield roads"));
    assert.ok(found(two, "a longterm plan for Spring-field roads"));
  });

  it("reads a soft hyphen or U+2010 at a line end as a break, with trailing spaces", () => {
    assert.ok(found("the Spring\u00ad  \nfield board", "the Springfield board"));
    assert.ok(found("the Spring\u2010\n   field board", "the Springfield board"));
    assert.ok(found("the Spring\u2011\nfield board", "the Spring-field board"));
  });

  it("never joins a dash, or a line not starting with a letter or digit", () => {
    assert.ok(!found("the Spring\u2014\nfield board", "the Springfield board"));
    assert.ok(!found("the Spring-\n(field) board", "the Spring-(field) board"));
  });

  it("reads a break with a digit on either side unjoined only", () => {
    for (const [body, unjoined, joined] of [
      [
        "served from 2014-\n2022 on the board",
        "served from 2014-2022 on",
        "served from 20142022 on",
      ],
      [
        "closed route 9-\n10 for repairs",
        "closed route 9-10 for repairs",
        "closed route 910 for repairs",
      ],
      [
        "the Spring-\n2 board for this year",
        "the Spring-2 board for this",
        "the Spring2 board for this",
      ],
      ["the Pct\u00ad\n12 polling place", "the Pct-12 polling place", "the Pct12 polling place"],
    ]) {
      assert.ok(found(body, unjoined), unjoined);
      assert.ok(!found(body, joined), joined);
      assert.ok(!found(body, unjoined.replace("-", "- ")), "an excerpt is never joined");
    }
  });

  it("still finds a break when a hidden character sits beside the hyphen or the line end", () => {
    for (const body of [
      "chair of the Spring-\u200b\nfield Township board",
      "chair of the Spring-\n\u200bfield Township board",
      "chair of the Spring\u200b-\nfield Township board",
    ]) {
      assert.ok(found(body, "chair of the Springfield Township board"));
      assert.ok(!found(body, "chair of the Spring- field Township board"));
    }
  });

  it("never makes a break from text an excerpt holds: an excerpt is one line", () => {
    assert.ok(!found("the Springfield board", "the Spring-\nfield board"));
  });
});

describe("article-format.md, Matching: word boundaries", () => {
  it("refuses an excerpt that starts or ends inside a word", () => {
    assert.ok(
      !found("He was unfit for office, the board found.", "fit for office, the board found."),
    );
    assert.ok(
      !found("He was unfit for office, the boards found.", "He was unfit for office, the board"),
    );
  });

  it("allows punctuation and hyphens as boundaries", () => {
    assert.ok(found("(He was unfit for office.)", "He was unfit for office"));
    assert.ok(found("the Spring-\nfield board", "field board"));
    assert.ok(found("a non-partisan seat on the board", "partisan seat on the board"));
  });

  it("finds a later occurrence when an earlier one is mid-word", () => {
    assert.ok(found("unfit for office; fit for office today", "fit for office today"));
  });
});
