"use strict";

// The figure check (article-format.md, Figures): each figure in a claim's text
// is copied from that claim's own excerpt, never rounded or rescaled. A figure
// is a run of digits with its decimal point and thousands commas, any letters
// or `%` written right after it (12B, 7th, 5M, 61%), and a scale or percent
// word after one space or hyphen (5 million, 5-million, 5 bn). Both sides are
// normalized as excerpts are, then compared as text, ignoring case, a space
// before `%`, and whether a hyphen or a space comes before the scale word.

const { normalizeLine } = require("./normalize");

const SCALE =
  "(?:thousand|hundred|million|billion|trillion|dozen)s?|percent|per cent|pct|bn|mn|mm|mil|tn|[kmb]";
const FIGURE = new RegExp(
  `\\.?\\p{Nd}+(?:[.,]\\p{Nd}+)*[\\p{L}\\p{M}]*(?: ?%|[ -](?:${SCALE})(?![\\p{L}\\p{M}\\p{Nd}]))?`,
  "giu",
);

// Each figure in `text`, written one way: lower case, no space before `%`, a
// space before a scale word.
const figures = (text) =>
  [...normalizeLine(text).matchAll(FIGURE)].map((m) =>
    m[0].toLowerCase().replace(" %", "%").replace("-", " "),
  );

// Is every figure in the claim text one of its excerpt's figures?
const figuresBacked = (text, excerpt) => {
  const quoted = new Set(figures(excerpt));
  return figures(text).every((figure) => quoted.has(figure));
};

module.exports = { figuresBacked };
