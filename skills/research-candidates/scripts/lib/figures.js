"use strict";

// The figure check (article-format.md, Figures): each figure in a claim's text
// is copied from that claim's own excerpt, never rounded or rescaled. A figure
// is a run of digits with its decimal point and thousands commas, any letters
// or `%` written right after it (12B, 7th, 5M, 61%), and a scale or percent
// word after one space or hyphen (5 million, 5-million, 5 bn). A scale or
// percent word with no digits before it is a figure too, with the number words
// right before it (two million, half a million, thousands). Both sides are
// normalized as excerpts are, then compared as text, ignoring case, a space
// before `%`, and whether a hyphen or a space joins the words.

const { normalizeLine } = require("./normalize");

const SCALE =
  "(?:thousand|hundred|million|billion|trillion|dozen)s?|percent|per cent|pct|bn|mn|mm|mil|tn|[kmb]";
const FIGURE = new RegExp(
  `\\.?\\p{Nd}+(?:[.,]\\p{Nd}+)*[\\p{L}\\p{M}]*(?: ?%|[ -](?:${SCALE})(?![\\p{L}\\p{M}\\p{Nd}]))?`,
  "giu",
);
const WORD_SCALE = "(?:thousand|hundred|million|billion|trillion|dozen)s?|percent|per cent";
const NUMBER_WORD =
  "a|an|half|quarter|few|several|one|two|three|four|five|six|seven|eight|nine|ten|eleven|" +
  "twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|" +
  "forty|fifty|sixty|seventy|eighty|ninety";
const PHRASE = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{Nd}])(?:(?:${NUMBER_WORD}|${WORD_SCALE})(?: and | |-))*(?:${WORD_SCALE})(?![\\p{L}\\p{M}\\p{Nd}])`,
  "giu",
);

// Each figure in `text`, written one way: lower case, no space before `%`, a
// space for a hyphen. Digit figures are taken out before phrases are read, so
// the scale word of "5 million" is never read again on its own.
const figures = (text) => {
  const line = normalizeLine(text);
  const written = [...line.matchAll(FIGURE)].map((m) => m[0].replace(" %", "%"));
  const worded = line.replace(FIGURE, " | ").match(PHRASE) ?? [];
  return [...written, ...worded].map((figure) => figure.toLowerCase().replaceAll("-", " "));
};

// Is every figure in the claim text one of its excerpt's figures?
const figuresBacked = (text, excerpt) => {
  const quoted = new Set(figures(excerpt));
  return figures(text).every((figure) => quoted.has(figure));
};

module.exports = { figuresBacked };
