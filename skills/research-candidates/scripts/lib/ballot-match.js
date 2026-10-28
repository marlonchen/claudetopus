"use strict";

// The two-direction match of ballot.yaml against the sample ballot's body
// (ballot-format.md, Ballot check). Each raw line is normalized on its own,
// then the non-empty lines are joined with single spaces, so a title or a
// candidate entry may wrap. Titles are placed in ballot.yaml order, each after
// the previous one; a contest's names are searched for only between its title
// and the next placed title. A line is accounted for when every letter and
// digit on it is inside a matched span, when it equals an ignored_lines entry,
// or when it is made up wholly of private_strings entries.

const { Failure } = require("./output");
const { WORD, normalizeLine, wholeWords } = require("./normalize");

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
const VOTE_FOR = new RegExp(
  `^vote for (?:(?:not more than|no more than|up to) )?([0-9]+|${NUMBER_WORDS.join("|")})(?![\\p{L}\\p{Nd}-])`,
  "iu",
);

// The count a "Vote for" line gives, or null when it starts so but gives none.
const voteForCount = (line) => {
  const m = VOTE_FOR.exec(line);
  if (!m) return null;
  const word = NUMBER_WORDS.indexOf(m[1].toLowerCase());
  return word === -1 ? Number(m[1]) : word + 1;
};

// Private-string accounting compares case-folded text with the publish scan's
// separators read as spaces, so "BS 0412" is made up of the entry BS-0412.
const privateFold = (text) =>
  normalizeLine(text)
    .toLowerCase()
    .replace(/[-_/.+=:,;~&]/g, " ")
    .replace(/ +/g, " ")
    .trim();

const madeOfEntries = (line, entries) => {
  let rest = privateFold(line);
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

    if (contest.vote_for !== undefined) {
      const line = norm.find(
        (text, j) =>
          lineRange[j] &&
          lineRange[j][0] >= region[0] &&
          lineRange[j][0] < region[1] &&
          /^vote for\b/i.test(text),
      );
      if (line === undefined)
        failures.push(new Failure(contest.at, "vote-for-not-found", "vote_for"));
      else if (voteForCount(line) !== contest.vote_for) {
        failures.push(new Failure(contest.at, "vote-for-mismatch", "vote_for"));
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
        named = true;
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
    .map(privateFold)
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
