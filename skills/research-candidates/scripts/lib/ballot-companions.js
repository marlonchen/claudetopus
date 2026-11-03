"use strict";

// ballot-check's rules for the companion documents and the people they vouch
// for (ballot-format.md, Companion documents, Party names, Write-ins and
// Withdrawals). Companions are the _ballot snapshots the compile agent reads
// whole, so none may come from a query URL or hold a voter's address, and a
// retired one vouches for nothing. Failures name the field or the class,
// never the text (Rule 5).

const { addressValues } = require("./data-files");
const { Failure } = require("./output");
const { bodyText, findExcerpt, normalizeLine } = require("./normalize");
const { CLASSES, scan } = require("./privacy");

// An address, street line or label; county-wide documents fail the scan's
// ZIP, title and place-name checks by nature.
const COMPANION_CLASSES = ["address", "label"];

// Each part between spaces or hyphens: a hyphen joins words
// (Democratic-Farmer-Labor), so each part is read as a word.
const words = (text) =>
  normalizeLine(text)
    .split(/[\s-]+/)
    .filter(Boolean);
const hasLetter = (word) => /\p{L}/u.test(word);
const inCapitals = (word) => hasLetter(word) && !/\p{Ll}/u.test(word);
const dotted = (word) => /[./]/.test(word);

// A printed party with any word in capitals or holding a period or slash.
const isAbbreviated = (party) => words(party).some((w) => inCapitals(w) || dotted(w));

// A party_name written as an abbreviation: a word holding a period or slash,
// or, in a name with a lowercase letter, a word in capitals (`DFL Party`). A
// name wholly in capitals is copied as an official source writes it.
const isAbbreviatedName = (name) => {
  const parts = words(name);
  if (parts.some(dotted)) return true;
  return /\p{Ll}/u.test(name) && parts.some(inCapitals);
};

// The sample ballot vouches for its own printed party only when every word
// has 4 or more letters (GREEN PARTY as Green Party, never DEM as Dem).
const longWords = (name) =>
  words(name)
    .filter(hasLetter)
    .every((w) => [...w.matchAll(/\p{L}/gu)].length >= 4);

// `text` is in `snapshot`'s body, matched as an excerpt (article-format.md,
// Matching), case kept or folded.
const holds = (snapshot, text, { anyCase = false } = {}) => {
  const key = anyCase ? "folded" : "matched";
  snapshot[key] ??= bodyText(anyCase ? snapshot.body.toLowerCase() : snapshot.body);
  return findExcerpt(snapshot[key], anyCase ? text.toLowerCase() : text);
};

// A query fetch, or a voter's address, street line or label in the body.
// `companions`: [{ path, query, body, firstLine }].
const checkCompanions = (companions, addresses) => {
  const failures = [];
  const values = addressValues(addresses ?? []);
  for (const companion of companions) {
    if (companion.query === "query") failures.push(new Failure(companion.path, "companion-query"));
    for (const m of scan(companion.body, values, COMPANION_CLASSES)) {
      const line = companion.firstLine + m.line - 1;
      failures.push(new Failure(`${companion.path}:${line}`, CLASSES[m.class]));
    }
  }
  return failures;
};

// `candidates`: [{ name, status, party, partyName, at: { name, party,
// party_name } }] as ballot.yaml gives them; `sample` the authoritative sample
// ballot or null; `companions` those not retired, with their `role`.
const checkPeople = ({ candidates, sample, companions }) => {
  const failures = [];
  const ofRole = (role) => companions.filter((c) => c.role === role);
  const vouched = {
    certified_write_in: [ofRole("write_in_list"), "write-in-not-found"],
    withdrawn_still_printed: [ofRole("withdrawal_notice"), "withdrawal-not-found"],
  };
  for (const c of candidates) {
    if (Object.hasOwn(vouched, c.status) && typeof c.name === "string") {
      const [sources, code] = vouched[c.status];
      if (!sources.some((s) => holds(s, c.name)))
        failures.push(new Failure(c.at.name, code, "name"));
    }
    if (typeof c.party !== "string") continue;
    if (typeof c.partyName !== "string") {
      if (isAbbreviated(c.party))
        failures.push(new Failure(c.at.party, "party-abbreviated", "party"));
      continue;
    }
    if (isAbbreviatedName(c.partyName)) {
      failures.push(new Failure(c.at.party_name, "party-name-abbreviated", "party_name"));
      continue;
    }
    const sameWords =
      normalizeLine(c.partyName).toLowerCase() === normalizeLine(c.party).toLowerCase();
    const fromSample = sample && (!sameWords || longWords(c.partyName)) ? [sample] : [];
    if (![...fromSample, ...companions].some((s) => holds(s, c.partyName, { anyCase: true })))
      failures.push(new Failure(c.at.party_name, "party-name-not-found", "party_name"));
  }
  return failures;
};

module.exports = { checkCompanions, checkPeople, isAbbreviated, isAbbreviatedName };
