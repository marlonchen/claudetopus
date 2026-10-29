"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { figuresBacked } = require("../scripts/lib/figures");

// Seam 2: figure matching (article-format.md, Figures), the edge cases that
// would be slow through the check CLI. Each row is [claim, excerpt].

const passes = (rows) => {
  for (const [claim, excerpt] of rows)
    assert.ok(figuresBacked(claim, excerpt), `${claim} ← ${excerpt}`);
};
const fails = (rows) => {
  for (const [claim, excerpt] of rows)
    assert.ok(!figuresBacked(claim, excerpt), `${claim} ← ${excerpt}`);
};

describe("article-format.md, Figures: each claimed figure is copied from its own excerpt", () => {
  it("passes a figure written as the excerpt writes it", () => {
    passes([
      ["Raised $1,220,000.55", "receipts: $1,220,000.55"],
      ["Raised $1.2 million", "raised $1.2 Million in all"],
      ["Raised $3M", "raised $3M in all"],
      ["Won 61% of the vote", "won 61 % of the vote"],
      ["A $5-million grant", "a $5 million grant"],
      ["A .5% raise", "a .5% raise"],
      ["Served from 2014 to 2022", "served from 2014-2022"],
      ["Voted for H.R. 1234", "Yea on H.R. 1234"],
      ["Sponsored SB1047", "sponsored SB1047"],
    ]);
  });

  it("never rounds or rescales a figure", () => {
    fails([
      ["Raised $1.22 million", "receipts: 1220000.55"],
      ["Raised $1,220,000", "receipts: 1220000.55"],
      ["Raised $1220000.55", "receipts: 1,220,000.55"],
      ["Raised $1 million", "raised $500,000 in all"],
      ["Raised $1 million", "raised $1,004,000 in all"],
      ["Raised $3M", "raised 3,000,000 in all"],
      ["Raised $1,200,000", "raised $1.2 million"],
      ["Won 61% of the vote", "won 61.4% of the vote"],
      ["A .5% raise", "a 0.5% raise"],
    ]);
  });

  it("copies a scale or percent word with its number, however it is spelled", () => {
    const excerpt = "5 people, 1.5 hours, 2 terms";
    fails(
      ["$5 B", "$5 bn", "$5 k", "$1.5 M", "$5MM", "$5mn", "$5 mil", "2 millions", "$5-million"]
        .concat(["5 per cent", "5 percent", "5%", "5 thousand", "$5 trillion"])
        .map((claim) => [claim, excerpt]),
    );
    fails([
      ["Raised $5", "raised $5 million"],
      ["Won 61 votes", "won 61% of the votes"],
      ["Won 50 percent", "won 50% of the vote"],
    ]);
  });

  it("reads letters written right after a number as part of it", () => {
    passes([
      ["Represents District 12B", "represents District 12B since 2019"],
      ["Will expand H-1B visas", "I will expand H-1B visas"],
      ["Won in the 7th District in 1990", "won in the 7th District in 1990"],
      ["Lives at 5 M Street", "lives at 5 M Street"],
    ]);
    fails([
      ["Represents District 12B", "represents District 12"],
      ["Represents District 12", "represents District 12B"],
    ]);
  });

  it("reads every figure: years, counts and numbers in names, each on its own", () => {
    fails([
      ["Served from 2014 to 2023", "served from 2014-2022"],
      ["Voted for H.R. 1235", "Yea on H.R. 1234"],
      ["Voted 52 times", "voted 51 times"],
      ["Raised $5,000 and spent $9,000", "raised $5,000, spent $8,000"],
    ]);
    passes([["Served two terms", "served from 2014 to 2022"]]);
  });

  it("reads a scale or percent word with no digits as a figure, with its number words", () => {
    passes([
      ["Raised half a million", "raised half a million dollars"],
      ["Raised twenty-five thousand", "raised twenty five thousand"],
      ["Raised one hundred and fifty thousand", "one hundred and fifty thousand dollars"],
      ["Says: will create thousands of jobs", "will create thousands of jobs"],
      ["Raised $2.5 million and two million more", "$2.5 million and two million more"],
    ]);
    fails([
      ["Raised two million dollars", "raised $500,000"],
      ["Raised half a million", "raised a million"],
      ["Raised five million", "raised $5 million"],
      ["Raised $5 million", "raised five million"],
      ["Says: will create thousands of jobs", "will create jobs"],
      ["Won fifty percent", "won 50%"],
      ["Raised a dozen", "raised 12"],
    ]);
    // Number words with no scale word are not figures.
    passes([["Served twenty terms", "served two terms"]]);
  });

  it("reads digits as normalized, so fullwidth digits count", () => {
    passes([
      ["Raised $１,000", "raised 1,000"],
      ["Raised $2½ million", "raised $2½ million"],
    ]);
    // A superscript or fraction breaks its figure rather than folding into digits.
    fails([
      ["A budget of $10⁶", "district 106"],
      ["A budget of $106", "a budget of 10⁶"],
      ["Raised $2½ million", "raised 21 and 2 million"],
    ]);
    fails([
      ["Raised $２,000", "raised 1,000"],
      ["Lost ٥٠٠ votes", "lost 500 votes"],
      ["Lost 500 votes", "lost ٥٠٠ votes"],
    ]);
  });
});
