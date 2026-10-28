"use strict";

// Parsers for the data files fetch-snapshot and ballot-check read: ballot.yaml
// (only the ids fetch-snapshot needs; ballot-check validates the rest),
// tiers.yaml, and the private values in private.yaml and addresses.yaml.
// Failures are located by file and, where there is one, the entry's line,
// never by a private value.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN, KEY_ENV } = require("./constants");
const { load } = require("./deps");
const { Failure } = require("./output");
const { CLASSES, scan } = require("./privacy");
const { TIER_RANK, conflicts, parseMatch } = require("./tiers");

// Parse a YAML file into a document, refusing any parse error or warning;
// `text` is what was parsed.
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
  return { doc, lineCounter, text };
};

const isDir = (p) => fs.statSync(p, { throwIfNoEntry: false })?.isDirectory() ?? false;

// Every directory under an <election> directory in the data repo, as
// { ballot: relative path, valid: whether its name is a ballot id }.
const ballotEntries = (root) => {
  const entries = [];
  for (const election of fs.readdirSync(root).sort()) {
    if (!ELECTION_PATTERN.test(election) || !isDir(path.join(root, election))) continue;
    for (const id of fs.readdirSync(path.join(root, election)).sort()) {
      if (id.startsWith(".") || !isDir(path.join(root, election, id))) continue;
      entries.push({ ballot: `${election}/${id}`, valid: BALLOT_ID_PATTERN.test(id) });
    }
  }
  return entries;
};

// Every <election>/<ballot-id> directory in the data repo, as relative paths.
const ballotDirs = (root) =>
  ballotEntries(root)
    .filter((entry) => entry.valid)
    .map((entry) => entry.ballot);

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

// The classes a tiers.yaml match or source may not hold (ballot-format.md, Tiers).
const TIERS_CLASSES = ["address", "zip", "label", "private-string"];

// Every tiers.yaml match or source that holds a private value, as Failures
// located by the entry's line and keyed by the field: `values` are this
// ballot's (loadPrivateValues), and every other ballot's private_strings are
// added. A failure in another ballot's private.yaml is located `-`.
const tiersPrivacy = (root, ballot, values) => {
  const failures = [];
  const strings = [...(values["private-string"] ?? [])];
  for (const other of ballotDirs(root)) {
    if (other === ballot || !fs.existsSync(path.join(root, other, "private.yaml"))) continue;
    try {
      strings.push(...loadPrivate(root, other, "-").private_strings);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      failures.push(error);
    }
  }
  const all = { ...values, "private-string": strings };
  const { doc, lineCounter } = readYamlDocument(path.join(root, "tiers.yaml"), "tiers.yaml");
  const YAML = load("yaml");
  for (const item of YAML.isSeq(doc.contents) ? doc.contents.items : []) {
    for (const key of ["match", "source"]) {
      const node = YAML.isMap(item) ? item.get(key, true) : null;
      if (!YAML.isScalar(node) || typeof node.value !== "string") continue;
      const at = `tiers.yaml:${lineCounter.linePos(node.range[0]).line}`;
      const classes = new Set(scan(node.value, all, TIERS_CLASSES).map((m) => m.class));
      for (const cls of TIERS_CLASSES) {
        if (classes.has(cls)) failures.push(new Failure(at, CLASSES[cls], key));
      }
    }
  }
  return failures;
};

// tiers.yaml entries, each { match, parsed, tier, statements_only, owner, source }.
// Refuses the whole file on any bad entry (source-tiers.md), and on a match or
// source holding a private value of `ballot` (`values`) or any other ballot.
const loadTiers = (root, ballot, values) => {
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
  const [leak] = tiersPrivacy(root, ballot, values);
  if (leak) throw leak;
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
    return { at, label, address, street, zips: zips.map((m) => m[0]) };
  });
};

// The privacy matcher's address, zip and label values from loadAddresses.
const addressValues = (addresses) => ({
  address: addresses.flatMap((a) => [a.address, a.street]),
  zip: addresses.flatMap((a) => a.zips),
  label: addresses.map((a) => a.label),
});

// private.yaml: lists of strings under private_strings and ignored_lines, no
// other key. A failure is located by the file alone: a stray key can be the
// private text itself (Rule 5).
const loadPrivate = (root, ballot, location) => {
  const data = readYamlDocument(path.join(root, ballot, "private.yaml"), location).doc.toJS();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Failure(location, "private-invalid");
  }
  const lists = { private_strings: [], ignored_lines: [] };
  for (const [key, value] of Object.entries(data)) {
    const list = value ?? [];
    if (
      !Object.hasOwn(lists, key) ||
      !Array.isArray(list) ||
      list.some((s) => typeof s !== "string")
    ) {
      throw new Failure(location, "private-invalid");
    }
    lists[key] = list;
  }
  return lists;
};

// The values the privacy matcher checks for one ballot (SKILL.md step 6.3),
// by class: the ballot id and its private_strings, every address, street
// line, label and ZIP in addresses.yaml, and the API key values set in the
// environment. No script prints any of them (Rule 5).
const loadPrivateValues = (root, ballot) => ({
  "ballot-id": [ballot.split("/")[1]],
  "private-string": loadPrivate(root, ballot, `${ballot}/private.yaml`).private_strings,
  ...addressValues(loadAddresses(root)),
  key: KEY_ENV.map((name) => process.env[name]).filter(Boolean),
});

module.exports = {
  addressValues,
  ballotDirs,
  ballotEntries,
  isDir,
  loadAddresses,
  loadBallot,
  loadPrivate,
  loadPrivateValues,
  loadTiers,
  readYamlDocument,
  tiersPrivacy,
};
