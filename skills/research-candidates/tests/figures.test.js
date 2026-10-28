"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { figuresBacked } = require("../scripts/lib/figures");

// Seam 2: figure matching (article-format.md, Figures), the edge cases that
// would be slow through the check CLI.

describe("article-format.md, Figures: each claimed figure is in its own excerpt", () => {
  it("passes the rule's worked examples", () => {
    assert.ok(figuresBacked("Raised $1.22 million", "receipts: 1220000.55"));
    assert.ok(figuresBacked("Raised $1,220,001", "receipts: 1220000.55"));
  });

  it("rounds half-up to the decimals the claim shows", () => {
    assert.ok(!figuresBacked("Raised $1,220,000", "receipts: 1220000.55"));
    assert.ok(!figuresBacked("Raised $1.23 million", "receipts: 1220000.55"));
    assert.ok(figuresBacked("Raised $12.5K", "raised 12450 in all"));
    assert.ok(!figuresBacked("Raised $12.4K", "raised 12450 in all"));
  });

  it("never stretches a figure more than 1%, however it rounds", () => {
    assert.ok(!figuresBacked("Raised $1 million", "raised $500,000 in all"));
    assert.ok(!figuresBacked("Raised $2 billion", "raised 1.5 billion in all"));
    assert.ok(!figuresBacked("Raised $3M", "raised 2,500,000 in all"));
    assert.ok(figuresBacked("Raised $1 million", "raised $1,004,000 in all"));
    assert.ok(figuresBacked("Raised $2.5M", "raised $2.5 million in all"));
  });

  it("reads K, M, million and billion as multipliers on either side", () => {
    assert.ok(figuresBacked("Raised $1,200,000", "raised $1.2 million"));
    assert.ok(figuresBacked("Raised $1.2 Million", "raised $1.2M"));
    assert.ok(figuresBacked("A $3 billion budget", "a 3,000,000,000 budget"));
    assert.ok(!figuresBacked("Raised $5 thousand", "raised 5000"), "thousand is no multiplier");
  });

  it("never reads a spaced or wordy letter as a multiplier", () => {
    assert.ok(figuresBacked("Lives at 5 M Street", "lives at 5 M Street"));
    assert.ok(figuresBacked("Owns 5 Mustangs", "owns 5 Mustangs"));
  });

  it("matches a percentage only with a percentage", () => {
    assert.ok(figuresBacked("Won 61% of the vote", "won 61 % of the vote"));
    assert.ok(figuresBacked("Won 61% of the vote", "won 61.4% of the vote"));
    assert.ok(!figuresBacked("Won 61% of the vote", "won 61 of the 100 votes"));
    assert.ok(!figuresBacked("Won 61 votes", "won 61% of the votes"));
  });

  it("reads every figure: years, counts, numbers in names and ranges", () => {
    assert.ok(figuresBacked("Served from 2014 to 2022", "served from 2014-2022"));
    assert.ok(!figuresBacked("Served from 2014 to 2023", "served from 2014-2022"));
    assert.ok(figuresBacked("Voted for H.R. 1234", "Yea on H.R. 1234"));
    assert.ok(!figuresBacked("Voted for H.R. 1235", "Yea on H.R. 1234"));
    assert.ok(!figuresBacked("Voted 52 times", "voted 51 times"));
    assert.ok(figuresBacked("Served two terms", "served from 2014 to 2022"));
  });

  it("matches each figure on its own, not just one of them", () => {
    assert.ok(!figuresBacked("Raised $5,000 and spent $9,000", "raised $5,000, spent $8,000"));
  });

  it("reads digits as normalized, so fullwidth digits count", () => {
    assert.ok(figuresBacked("Raised $１,000", "raised 1000"));
    assert.ok(!figuresBacked("Raised $２,000", "raised 1000"));
  });
});
