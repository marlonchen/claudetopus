"use strict";

// The matching normalization (article-format.md, Matching) that excerpts and
// the ballot check share: NFKC, default-ignorable code points removed, curly
// quotes to straight, en and em dashes (every Pd dash and the minus sign) to
// `-`, whitespace collapsed. ballot-check applies it to one line at a time;
// joining pdftotext hyphenated line breaks belongs to excerpt matching.

// Letters, marks and decimal digits: a whole-word or phrase match may not touch one.
const WORD = /[\p{L}\p{M}\p{Nd}]/u;

const normalizeLine = (text) =>
  text
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[\p{Pd}−]/gu, "-")
    .replace(/\s+/gu, " ")
    .trim();

// The code point that starts at UTF-16 index `i`, or ends just before it.
const pointAt = (s, i) => (i < s.length ? String.fromCodePoint(s.codePointAt(i)) : "");
const pointBefore = (s, i) => {
  if (i === 0) return "";
  const low = s.charCodeAt(i - 1);
  return i >= 2 && low >= 0xdc00 && low <= 0xdfff ? s.slice(i - 2, i) : s[i - 1];
};

// Start offsets of `needle` in `hay` within [from, to) that sit on boundaries
// `edge` allows: no `edge` character touches either end of a needle that
// starts or ends with one. The privacy matcher passes its own edge class.
const occurrences = (hay, needle, edge = WORD, from = 0, to = hay.length) => {
  const found = [];
  if (!needle) return found;
  const startsWord = edge.test(pointAt(needle, 0));
  const endsWord = edge.test(pointBefore(needle, needle.length));
  for (let i = hay.indexOf(needle, from); i !== -1 && i + needle.length <= to; ) {
    const clearBefore = !startsWord || !edge.test(pointBefore(hay, i));
    const clearAfter = !endsWord || !edge.test(pointAt(hay, i + needle.length));
    if (clearBefore && clearAfter) found.push(i);
    i = hay.indexOf(needle, i + 1);
  }
  return found;
};

// Whole-word starts: no letter or digit touches either end.
const wholeWords = (hay, needle, from, to) => occurrences(hay, needle, WORD, from, to);

module.exports = { WORD, normalizeLine, occurrences, wholeWords };
