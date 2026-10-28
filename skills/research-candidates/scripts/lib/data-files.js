"use strict";

// Parsers for the data files fetch-snapshot reads: ballot.yaml (only the ids
// it needs; ballot-check validates the rest), tiers.yaml, and the private
// values in private.yaml and addresses.yaml. Failures are located by file and,
// where there is one, the entry's line, never by a private value.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN, KEY_ENV } = require("./constants");
const { load } = require("./deps");
const { Failure } = require("./output");
const { TIER_RANK, conflicts, parseMatch } = require("./tiers");

// Parse a YAML file into a document, refusing any parse error or warning.
const readYamlDocument = (file, location) => {
  const YAML = load("yaml");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new Failure(location, "file-missing");
  }
  const lineCounter = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter, uniqueKeys: true });
  if (doc.errors.length || doc.warnings.length) throw new Failure(location, "yaml-invalid");
  return { doc, lineCounter };
};

const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

// Every <election>/<ballot-id> directory in the data repo, as relative paths.
const ballotDirs = (root) => {
  const dirs = [];
  for (const election of fs.readdirSync(root).sort()) {
    if (!ELECTION_PATTERN.test(election) || !isDir(path.join(root, election))) continue;
    for (const id of fs.readdirSync(path.join(root, election)).sort()) {
      if (BALLOT_ID_PATTERN.test(id) && isDir(path.join(root, election, id))) {
        dirs.push(`${election}/${id}`);
      }
    }
  }
  return dirs;
};

// { contests: Map<contest id, { type, subjects: Set<id> }>, people: Set<id> }
// from <ballot>/ballot.yaml. Subjects are the contest's candidate or official ids.
const loadBallot = (root, ballot, location = `${ballot}/ballot.yaml`) => {
  const data = readYamlDocument(path.join(root, ballot, "ballot.yaml"), location).doc.toJS();
  if (!data || !Array.isArray(data.contests)) throw new Failure(location, "ballot-invalid");
  const contests = new Map();
  const people = new Set();
  for (const contest of data.contests) {
    if (!contest || typeof contest.id !== "string") throw new Failure(location, "ballot-invalid");
    const subjects = new Set();
    for (const candidate of Array.isArray(contest.candidates) ? contest.candidates : []) {
      if (typeof candidate?.id === "string") subjects.add(candidate.id);
    }
    if (typeof contest.official?.id === "string") subjects.add(contest.official.id);
    for (const id of subjects) people.add(id);
    contests.set(contest.id, { type: contest.type, subjects });
  }
  return { contests, people };
};

// tiers.yaml entries, each { match, parsed, tier, statements_only, owner, source }.
// Refuses the whole file on any bad entry (source-tiers.md).
const loadTiers = (root) => {
  const { doc, lineCounter } = readYamlDocument(path.join(root, "tiers.yaml"), "tiers.yaml");
  if (!load("yaml").isSeq(doc.contents)) {
    throw new Failure("tiers.yaml", "tiers-invalid");
  }
  const people = new Set();
  for (const ballot of ballotDirs(root)) {
    if (!fs.existsSync(path.join(root, ballot, "ballot.yaml"))) continue;
    // Another ballot's id never reaches this run's output, so its failures are unlocated.
    for (const id of loadBallot(root, ballot, "-").people) people.add(id);
  }
  const entries = doc.contents.items.map((node) => {
    const at = `tiers.yaml:${lineCounter.linePos(node.range[0]).line}`;
    const entry = node.toJSON?.();
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Failure(at, "tiers-invalid");
    }
    const parsed = parseMatch(entry.match);
    if (!parsed || !Object.hasOwn(TIER_RANK, entry.tier)) throw new Failure(at, "tiers-invalid");
    if (entry.statements_only !== undefined && typeof entry.statements_only !== "boolean") {
      throw new Failure(at, "tiers-invalid");
    }
    if (entry.tier === "T4" && entry.statements_only !== true) {
      throw new Failure(at, "tiers-statements-only");
    }
    if (typeof entry.owner !== "string" || entry.owner === "") {
      throw new Failure(at, "tiers-no-owner");
    }
    if (typeof entry.source !== "string" || entry.source.trim() === "") {
      throw new Failure(at, "tiers-no-source");
    }
    if (entry.owner !== "third-party") {
      if (entry.tier !== "T4" || entry.statements_only !== true) {
        throw new Failure(at, "tiers-owner-not-statements");
      }
      if (!people.has(entry.owner)) throw new Failure(at, "tiers-unknown-owner");
    }
    return {
      at,
      match: entry.match,
      parsed,
      tier: entry.tier,
      statements_only: entry.statements_only === true,
      owner: entry.owner,
      source: entry.source,
    };
  });
  // Located at the later entry of the pair.
  for (const [i, entry] of entries.entries()) {
    if (entries.slice(0, i).some((earlier) => conflicts(earlier.parsed, entry.parsed))) {
      throw new Failure(entry.at, "tiers-overlap");
    }
  }
  return entries.map(({ at, ...entry }) => entry);
};

// addresses.yaml: { <label>: { address, street, ballot } }. The street line is
// the researcher's own, since URLs often spell it without the unit; the ZIPs
// are the address's standalone 5-digit tokens.
const loadAddresses = (root) => {
  const { doc, lineCounter } = readYamlDocument(
    path.join(root, "addresses.yaml"),
    "addresses.yaml",
  );
  const YAML = load("yaml");
  if (!YAML.isMap(doc.contents)) throw new Failure("addresses.yaml", "addresses-invalid");
  return doc.contents.items.map((pair) => {
    const at = `addresses.yaml:${lineCounter.linePos(pair.key?.range?.[0] ?? 0).line}`;
    const label = YAML.isScalar(pair.key) ? pair.key.value : null;
    const entry = pair.value?.toJSON?.();
    if (typeof label !== "string" || label.trim() === "" || !entry || typeof entry !== "object") {
      throw new Failure(at, "addresses-invalid");
    }
    const { address, street, ballot } = entry;
    if ([address, street].some((value) => typeof value !== "string" || value.trim() === "")) {
      throw new Failure(at, "addresses-invalid");
    }
    if (ballot !== undefined && ballot !== null && typeof ballot !== "string") {
      throw new Failure(at, "addresses-invalid");
    }
    const zips = [...address.normalize("NFKC").matchAll(/(?<![0-9])[0-9]{5}(?![0-9])/g)];
    return { label, address, street, zips: zips.map((m) => m[0]) };
  });
};

// The values the privacy matcher checks for one ballot (SKILL.md step 6.3),
// by class: the ballot id and its private_strings, every address, street
// line, label and ZIP in addresses.yaml, and the API key values set in the
// environment. No script prints any of them (Rule 5).
const loadPrivateValues = (root, ballot) => {
  const location = `${ballot}/private.yaml`;
  const data = readYamlDocument(path.join(root, ballot, "private.yaml"), location).doc.toJS();
  const strings = data?.private_strings ?? [];
  if (!data || typeof data !== "object" || !Array.isArray(strings)) {
    throw new Failure(location, "private-invalid");
  }
  if (strings.some((s) => typeof s !== "string")) throw new Failure(location, "private-invalid");
  const addresses = loadAddresses(root);
  return {
    "ballot-id": [ballot.split("/")[1]],
    "private-string": strings,
    address: addresses.flatMap((a) => [a.address, a.street]),
    zip: addresses.flatMap((a) => a.zips),
    label: addresses.map((a) => a.label),
    key: KEY_ENV.map((name) => process.env[name]).filter(Boolean),
  };
};

module.exports = { ballotDirs, isDir, loadBallot, loadPrivateValues, loadTiers, readYamlDocument };
