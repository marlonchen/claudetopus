"use strict";

// The matching normalization (article-format.md, Matching) that excerpts and
// the ballot check share: NFKC, default-ignorable code points removed, curly
// quotes to straight, en and em dashes (every Pd dash and the minus sign) to
// `-`, whitespace collapsed. ballot-check applies it to one line at a time;
// excerpt matching also reads pdftotext hyphenated line breaks in a snapshot
// body both joined and unjoined (bodyText, findExcerpt).

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

// A hyphenated line break: after NFKC (U+2011 reads as U+2010), a letter or
// digit and a hyphen end the line, trailing spaces aside, and the next line
// starts with a letter or digit, leading spaces aside. Found in each line after
// NFKC and with every default-ignorable but the soft hyphen removed, so a
// hidden character next to the hyphen neither makes nor hides a break, and
// before any other fold.
const BREAK_END = /([\p{L}\p{Nd}])\p{M}*([-\u2010\u00ad])[ \t]*$/u;
const BREAK_NEXT = /^[ \t]*([\p{L}\p{Nd}])/u;
const LETTER = /\p{L}/u;

// A snapshot body as excerpts are matched against it: { text, breaks }, the
// lines normalized and joined by single spaces, except that a hyphen break
// keeps its hyphen as `-` with no space after. `breaks` holds the index of
// each such hyphen between two letters, which findExcerpt may read or skip;
// a break with a digit on either side is read unjoined only, so a range
// (`2014-` `2022`) never fuses into one number.
const bodyLines = (body) =>
  body
    .split(/\r?\n/)
    .map((line) =>
      line.normalize("NFKC").replace(/(?!\u00ad)\p{Default_Ignorable_Code_Point}/gu, ""),
    );
const bodyText = (body) => {
  const lines = bodyLines(body);
  let text = "";
  const breaks = new Set();
  let glued = false;
  for (const [i, line] of lines.entries()) {
    const end = BREAK_END.exec(line);
    const next = end && BREAK_NEXT.exec(lines[i + 1] ?? "");
    const isBreak = Boolean(next);
    // The hyphen and the spaces after it go; the letter or digit before it stays.
    const part = normalizeLine(
      isBreak ? line.slice(0, end.index + end[0].lastIndexOf(end[2])) : line,
    );
    if (part) {
      if (text && !glued) text += " ";
      text += part;
      glued = false;
    }
    if (isBreak) {
      if (LETTER.test(end[1]) && LETTER.test(next[1])) breaks.add(text.length);
      text += "-";
      glued = true;
    }
  }
  return { text, breaks };
};

// An api snapshot's body, or one of its records, as excerpts are matched
// against it: bodyText without hyphen breaks, since an API line never wraps and
// a value ending in a hyphen (`SMITH-`) must not join the next key.
const recordText = (body) => ({
  text: bodyLines(body).map(normalizeLine).filter(Boolean).join(" "),
  breaks: new Set(),
});

// True when `excerpt`, normalized, is in `body` (from bodyText) on word
// boundaries, reading each break between two letters joined or unjoined on
// its own. The excerpt is one line and is never joined itself.
const findExcerpt = ({ text, breaks }, excerpt) => {
  const e = normalizeLine(excerpt);
  if (!e) return false;
  const startsWord = WORD.test(pointAt(e, 0));
  const endsWord = WORD.test(pointBefore(e, e.length));
  // Match e[j..] at text[i..]; at a break, take the hyphen or skip it.
  const from = (i, j) => {
    while (j < e.length) {
      if (breaks.has(i)) {
        if (e[j] === "-" && from(i + 1, j + 1)) return true;
        i++;
        continue;
      }
      if (text[i] !== e[j]) return false;
      i++;
      j++;
    }
    return !endsWord || !WORD.test(pointAt(text, i));
  };
  for (let i = text.indexOf(e[0]); i !== -1; i = text.indexOf(e[0], i + 1)) {
    if (startsWord && WORD.test(pointBefore(text, i))) continue;
    if (from(i, 0)) return true;
  }
  return false;
};

module.exports = {
  WORD,
  bodyText,
  findExcerpt,
  normalizeLine,
  occurrences,
  recordText,
  wholeWords,
};
