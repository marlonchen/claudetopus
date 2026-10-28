"use strict";

// The two-direction match of ballot.yaml against the sample ballot's body
// (ballot-format.md, Ballot check). Each raw line is normalized on its own,
// then the non-empty lines are joined with single spaces, so a title or a
// candidate entry may wrap. Titles are placed in ballot.yaml order, each after
// the previous one; a contest's Vote for phrase and names are searched for only
// between its title and the next placed title. A line is accounted for when
// every letter and digit on it is inside a matched span, when it equals an
// ignored_lines entry, or when it is made up wholly of private_strings entries.

const { Failure } = require("./output");
const { WORD, normalizeLine, wholeWords } = require("./normalize");
const { privateForm } = require("./privacy");

const NUMBER_WORDS = [
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
];
// A Vote for phrase that gives a count; a phrase with none ("Vote for the
// candidate of your choice") is no Vote for line.
const VOTE_FOR = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{Nd}])vote for:? (?:(?:not more than|no more than|up to) )?([0-9]+|${NUMBER_WORDS.join("|")})(?![\\p{L}\\p{Nd}-])`,
  "giu",
);

const countOf = (m) => {
  const word = NUMBER_WORDS.indexOf(m[1].toLowerCase());
  return word === -1 ? Number(m[1]) : word + 1;
};

// The count the first Vote for phrase in `text` gives, or null when there is none.
const voteForCount = (text) => {
  const m = [...text.matchAll(VOTE_FOR)][0];
  return m ? countOf(m) : null;
};

// A name run into a longer word by a hyphen or apostrophe ("Mary Smith" in
// "Mary Smith-Jones") still matches, but is not the name the entry gives, so a
// missing party after it reads as name-not-found.
const GLUED = /^['-][\p{L}\p{M}\p{Nd}]/u;

const madeOfEntries = (line, entries) => {
  let rest = privateForm(line);
  for (const entry of entries) {
    for (const i of wholeWords(rest, entry).reverse()) {
      rest = `${rest.slice(0, i)} ${rest.slice(i + entry.length)}`;
    }
  }
  return !WORD.test(rest);
};

// `body`: the snapshot body; `firstLine`: the file line number of its first
// line; `contests`: [{ title, at, type, vote_for, entries: [{ name, party, at,
// printed, official }] }], where `at` is a ballot.yaml location. Returns
// { failures, spans: [text] in ballot order, unaccounted: [{ line, text }] }.
const matchBallot = ({ body, firstLine, contests, privateStrings, ignoredLines }) => {
  const raw = body.split("\n");
  const norm = raw.map(normalizeLine);
  let joined = "";
  const lineRange = norm.map((text) => {
    if (!text) return null;
    if (joined) joined += " ";
    const start = joined.length;
    joined += text;
    return [start, joined.length];
  });
  const failures = [];
  const spans = [];

  // Titles, in ballot.yaml order.
  let pos = 0;
  const placed = [];
  for (const contest of contests) {
    const i = wholeWords(joined, contest.title, pos)[0];
    if (i === undefined) {
      failures.push(new Failure(contest.at, "title-not-found", "title"));
      continue;
    }
    pos = i + contest.title.length;
    spans.push([i, pos]);
    placed.push({ contest, title: [i, pos] });
  }

  for (const [n, { contest, title }] of placed.entries()) {
    const region = [title[1], placed[n + 1]?.title[0] ?? joined.length];

    // The first Vote for phrase that starts a line, or follows the title with
    // nothing but punctuation between ("7th District (Vote for 1)"). With none,
    // the contest elects one.
    if (contest.vote_for !== undefined) {
      let phrase = null;
      VOTE_FOR.lastIndex = region[0];
      for (let m = VOTE_FOR.exec(joined); m && m.index < region[1]; m = VOTE_FOR.exec(joined)) {
        if (m.index + m[0].length > region[1]) break;
        const line = lineRange.find((range) => range && range[0] <= m.index && m.index < range[1]);
        if (!WORD.test(joined.slice(Math.max(line[0], region[0]), m.index))) {
          phrase = m;
          break;
        }
      }
      if (phrase) {
        spans.push([phrase.index, phrase.index + phrase[0].length]);
        if (countOf(phrase) !== contest.vote_for)
          failures.push(new Failure(contest.at, "vote-for-mismatch", "vote_for"));
      } else if (contest.vote_for !== 1) {
        failures.push(new Failure(contest.at, "vote-for-not-found", "vote_for"));
      }
    }

    // Longer names first, so "John Smith" never takes "John Smith Jr."'s line.
    const entries = contest.entries
      .filter((entry) => entry.printed)
      .sort((a, b) => b.name.length - a.name.length);
    for (const entry of entries) {
      const within = entry.official ? [title[0], region[1]] : region;
      // An official's name may sit inside its own title, never inside another span.
      const free = (s, e) =>
        !spans.some(([a, b]) => (a !== title[0] || b !== title[1]) && s < b && a < e);
      let found = null;
      let named = false;
      for (const i of wholeWords(joined, entry.name, within[0], within[1])) {
        const end = i + entry.name.length;
        if (!free(i, end)) continue;
        if (!GLUED.test(joined.slice(end, end + 2))) named = true;
        if (!entry.party) {
          found = [i, end];
          break;
        }
        let j = end;
        while (j < within[1] && !WORD.test(joined[j])) j++;
        if (j > end && wholeWords(joined, entry.party, j, within[1])[0] === j) {
          let k = j + entry.party.length;
          while (k < within[1] && /[)\]]/.test(joined[k])) k++;
          found = [i, k];
          break;
        }
      }
      if (found) spans.push(found);
      else if (named) failures.push(new Failure(entry.at, "party-not-found", "party"));
      else failures.push(new Failure(entry.at, "name-not-found", "name"));
    }
  }

  // Official to listed: every letter and digit of a line inside a span.
  const covered = new Uint8Array(joined.length);
  for (const [s, e] of spans) covered.fill(1, s, e);
  const ignored = new Set(ignoredLines.map(normalizeLine));
  const entries = privateStrings
    .map(privateForm)
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const unaccounted = [];
  for (const [j, range] of lineRange.entries()) {
    if (!range) continue;
    let all = true;
    for (let i = range[0]; i < range[1] && all; i++) {
      if (!covered[i] && WORD.test(joined[i])) all = false;
    }
    if (all || ignored.has(norm[j]) || madeOfEntries(norm[j], entries)) continue;
    unaccounted.push({ line: firstLine + j, text: raw[j] });
  }

  return {
    failures,
    spans: spans.sort((a, b) => a[0] - b[0]).map(([s, e]) => joined.slice(s, e)),
    unaccounted,
  };
};

module.exports = { matchBallot, voteForCount };
