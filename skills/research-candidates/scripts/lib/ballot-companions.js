"use strict";

// ballot-check's rules for the companion documents and the people they vouch
// for (ballot-format.md, Companion documents, Party names, Write-ins and
// Withdrawals). Companions are the _ballot snapshots the compile agent reads
// whole, so none may come from a query URL, and a retired one vouches for
// nothing. A personalized one fetched without a query is the researcher's to
// spot and retire (ADR 0009). Failures name the field, never the text (Rule 5).

const { PARTY_FULL_WORDS, PARTY_JOINING_WORDS } = require("./constants");
const { Failure } = require("./output");
const { bodyText, findExcerpt, normalizeLine } = require("./normalize");

// Each part between spaces or hyphens: a hyphen joins words
// (Democratic-Farmer-Labor), so each part is read as a word. A dotted word
// on the full-word list (U.S.) is never read as an abbreviation.
const words = (text) =>
  normalizeLine(text)
    .split(/[\s-]+/)
    .filter((w) => w && !PARTY_FULL_WORDS.includes(w));
const hasLetter = (word) => /\p{L}/u.test(word);
const inCapitals = (word) => hasLetter(word) && !/\p{Ll}/u.test(word);
const dotted = (word) => /[./]/.test(word);
// Under 4 letters and no connecting word (and, no, non): DEM, Dem, Law.
const isShort = (word) =>
  hasLetter(word) &&
  !PARTY_JOINING_WORDS.includes(word.toLowerCase()) &&
  [...word.matchAll(/\p{L}/gu)].length < 4;

// A printed party with any word in capitals, holding a period or slash, or short.
const isAbbreviated = (party) => words(party).some((w) => inCapitals(w) || dotted(w) || isShort(w));

// A party_name written as an abbreviation: a word holding a period or slash,
// or, in a name with a lowercase letter, a word in capitals (`DFL Party`). A
// name wholly in capitals is copied as an official source writes it.
const isAbbreviatedName = (name) => {
  const parts = words(name);
  if (parts.some(dotted)) return true;
  return /\p{Ll}/u.test(name) && parts.some(inCapitals);
};

// `text` is in `snapshot`'s body, matched as an excerpt (article-format.md,
// Matching), case kept or folded.
const holds = (snapshot, text, { anyCase = false } = {}) => {
  const key = anyCase ? "folded" : "matched";
  snapshot[key] ??= bodyText(anyCase ? snapshot.body.toLowerCase() : snapshot.body);
  return findExcerpt(snapshot[key], anyCase ? text.toLowerCase() : text);
};

// A companion fetched from a URL with a query. `companions`: [{ path, query }].
const checkCompanions = (companions) =>
  companions
    .filter((companion) => companion.query === "query")
    .map((companion) => new Failure(companion.path, "companion-query"));

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
    // In any case: a county prints one name in its own case (BO BAKER, Bo Baker).
    if (Object.hasOwn(vouched, c.status) && typeof c.name === "string") {
      const [sources, code] = vouched[c.status];
      if (!sources.some((s) => holds(s, c.name, { anyCase: true })))
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
    // The printed words with a short one (DEM as Dem): only the case is the
    // researcher's, so only a companion spelling it in that case vouches.
    const sameWords =
      normalizeLine(c.partyName).toLowerCase() === normalizeLine(c.party).toLowerCase();
    const plain = !sameWords || !words(c.partyName).some(isShort);
    const sources = plain && sample ? [sample, ...companions] : companions;
    if (!sources.some((s) => holds(s, c.partyName, { anyCase: plain })))
      failures.push(new Failure(c.at.party_name, "party-name-not-found", "party_name"));
  }
  return failures;
};

module.exports = { checkCompanions, checkPeople, isAbbreviated, isAbbreviatedName };
