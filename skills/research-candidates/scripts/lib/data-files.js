"use strict";

// Parsers for the data files the scripts read: ballot.yaml's contests (the
// one contest model every script reads, which ballot-check validates against)
// and the printed titles check needs, tiers.yaml, and the private values in
// private.yaml.
// Failures are located by file and, where there is one, the entry's line,
// never by a private value.

const fs = require("node:fs");
const path = require("node:path");
const {
  BALLOT_ID_PATTERN,
  ELECTION_PATTERN,
  ID_PATTERN,
  KEY_ENV,
  OFFICE_TYPES,
  SECTIONS,
  STATUSES,
  WITHDRAWN_SECTIONS,
} = require("./constants");
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

// sections.md: the section a contest's not_researched never names.
const ON_BALLOT = SECTIONS.candidate[0];
// The sections each contest type's not_researched may name, and what `all`
// names: every section but On the ballot.
const DEFERRABLE = Object.fromEntries(
  Object.entries(SECTIONS).map(([type, names]) => [type, names.filter((n) => n !== ON_BALLOT)]),
);

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// ballot.yaml's contests (`data`, the file as read), each judged by the rules
// every script shares (ballot-format.md): its id, type, office_type and
// not_researched, and each candidate's or the official's id, name and status.
// Each fault goes to `report(keys, code)`, `keys` the path from the file's root
// to the field at fault, which ballot-check locates by line; ballot-check adds
// the rest of ballot-format.md's rules. Returns the contests with no
// fault, by id in ballot order, each { id, type, officeType, blocks, subjects,
// notResearched }: blocks are the article's, in order (article-format.md),
// each { name, subject, sections }; subjects the candidate or official ids;
// notResearched the sections not_researched names, `all` resolved. `people`,
// when given, also gets each candidate's or official's id that is an id and
// unique in its contest, even in a contest with another fault.
const parseContests = (data, report, people) => {
  const contests = new Map();
  if (!Array.isArray(data?.contests) || data.contests.length === 0) {
    report(["contests"], "ballot-invalid");
    return contests;
  }
  const ids = new Set();
  for (const [c, contest] of data.contests.entries()) {
    const keys = ["contests", c];
    let faulted = false;
    const fault = (at, code) => {
      faulted = true;
      report(at, code);
    };
    if (!isMap(contest)) {
      fault(keys, "ballot-invalid");
      continue;
    }
    const { type } = contest;
    if (typeof type !== "string" || !Object.hasOwn(SECTIONS, type)) {
      fault([...keys, "type"], "ballot-invalid");
      continue;
    }
    if (typeof contest.id !== "string" || !ID_PATTERN.test(contest.id) || contest.id === "ballot") {
      fault([...keys, "id"], "id-invalid");
    } else if (ids.has(contest.id)) {
      fault([...keys, "id"], "id-duplicate");
    } else {
      ids.add(contest.id);
    }
    const later = contest.not_researched;
    if (
      later !== undefined &&
      later !== "all" &&
      (!Array.isArray(later) ||
        !later.every((s) => DEFERRABLE[type].includes(s)) ||
        new Set(later).size !== later.length)
    ) {
      fault([...keys, "not_researched"], "not-researched-invalid");
    }

    // A candidate or the official, or null when it is not a map.
    const subjectIds = new Set();
    const person = (value, pkeys) => {
      if (!isMap(value)) {
        fault(pkeys, "ballot-invalid");
        return null;
      }
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id))
        fault([...pkeys, "id"], "id-invalid");
      else if (subjectIds.has(value.id)) fault([...pkeys, "id"], "id-duplicate");
      else {
        subjectIds.add(value.id);
        people?.add(value.id);
      }
      if (!isText(value.name)) fault([...pkeys, "name"], "ballot-invalid");
      return value;
    };

    let blocks;
    if (type === "candidate") {
      if (!OFFICE_TYPES.includes(contest.office_type))
        fault([...keys, "office_type"], "ballot-invalid");
      const listed = Array.isArray(contest.candidates) ? contest.candidates : [];
      if (listed.length === 0) fault([...keys, "candidates"], "ballot-invalid");
      const people = [];
      for (const [n, candidate] of listed.entries()) {
        const pkeys = [...keys, "candidates", n];
        if (!person(candidate, pkeys)) continue;
        if (!STATUSES.includes(candidate.status)) fault([...pkeys, "status"], "ballot-invalid");
        people.push(candidate);
      }
      // Printed candidates in ballot order, then certified write-ins (article-format.md).
      const writeIn = (p) => p.status === "certified_write_in";
      blocks = [...people.filter((p) => !writeIn(p)), ...people.filter(writeIn)].map((p) => ({
        name: p.name,
        subject: p.id,
        sections: p.status === "withdrawn_still_printed" ? WITHDRAWN_SECTIONS : SECTIONS.candidate,
      }));
    } else if (type === "retention") {
      if (contest.office_type !== undefined && contest.office_type !== "judicial") {
        fault([...keys, "office_type"], "ballot-invalid");
      }
      const official = person(contest.official, [...keys, "official"]);
      blocks = official
        ? [{ name: official.name, subject: official.id, sections: SECTIONS.retention }]
        : [];
    } else {
      blocks = [{ name: contest.id, subject: "_race", sections: SECTIONS.measure }];
    }
    if (faulted) continue;
    contests.set(contest.id, {
      id: contest.id,
      type,
      officeType: contest.office_type,
      blocks,
      subjects: subjectIds,
      notResearched: new Set(later === "all" ? DEFERRABLE[type] : later),
    });
  }
  return contests;
};

// parseContests' contests of ballot.yaml as read (`data`), or one failure,
// `location ballot-invalid`, for any fault: ballot-check locates each by line.
const contestsOf = (data, location = "ballot.yaml") => {
  let faulted = false;
  const contests = parseContests(data, () => {
    faulted = true;
  });
  if (faulted) throw new Failure(location, "ballot-invalid");
  return contests;
};

// contestsOf, read from <ballotDir>/ballot.yaml.
const loadContests = (ballotDir, location = "ballot.yaml") =>
  contestsOf(readYamlDocument(path.join(ballotDir, "ballot.yaml"), location).doc.toJS(), location);

// parseContests' contests of ballot.yaml as read (`data`) with no fault, or
// null when it has no `contests` list: what a script reads of a ballot.yaml
// it does not check, so a half-typed contest stops no other work. ballot-check
// on that ballot locates the faults.
const faultFreeContests = (data) =>
  Array.isArray(data?.contests) ? parseContests(data, () => {}) : null;

// The printed titles of contests with a display_title, from ballot.yaml as read.
const hiddenTitles = (data) =>
  (Array.isArray(data?.contests) ? data.contests : [])
    .filter((c) => c?.display_title !== undefined && typeof c.title === "string")
    .map((c) => c.title);

// The classes a tiers.yaml match or source may not hold (ballot-format.md, Tiers).
const TIERS_CLASSES = ["private-string"];

// Every other ballot's private_strings, as { strings, failures }: a
// private.yaml that cannot be read is a Failure located `-`, so no other
// ballot's id reaches the output.
const otherPrivateStrings = (root, ballot) => {
  const strings = [];
  const failures = [];
  for (const other of ballotDirs(root)) {
    if (other === ballot || !fs.existsSync(path.join(root, other, "private.yaml"))) continue;
    try {
      strings.push(...loadPrivate(root, other, "-").private_strings);
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      failures.push(error);
    }
  }
  return { strings, failures };
};

// Every tiers.yaml match or source that holds a private value, as Failures
// located by the entry's line and keyed by the field. `values` hold every
// ballot's private_strings, as loadPrivateValues and ballot-check read them.
// `tiers` is tiers.yaml's readYamlDocument result, when the caller has
// already read it.
const tiersPrivacy = (
  root,
  values,
  tiers = readYamlDocument(path.join(root, "tiers.yaml"), "tiers.yaml"),
) => {
  const failures = [];
  const { doc, lineCounter } = tiers;
  const YAML = load("yaml");
  for (const item of YAML.isSeq(doc.contents) ? doc.contents.items : []) {
    for (const key of ["match", "source"]) {
      const node = YAML.isMap(item) ? item.get(key, true) : null;
      if (!YAML.isScalar(node) || typeof node.value !== "string") continue;
      const at = `tiers.yaml:${lineCounter.linePos(node.range[0]).line}`;
      const classes = new Set(scan(node.value, values, TIERS_CLASSES).map((m) => m.class));
      for (const cls of TIERS_CLASSES) {
        if (classes.has(cls)) failures.push(new Failure(at, CLASSES[cls], key));
      }
    }
  }
  return failures;
};

// The candidate and official ids of every ballot, the owners tiers.yaml may
// name: each id parseContests accepts, even in a contest with another fault,
// so a half-typed ballot.yaml stops no fetch. A ballot.yaml with no contests
// list fails ballot-invalid, located by the file for the current ballot,
// `ballot`. Another ballot's id never reaches this run's output, so its
// failures are located `-` and followed by check-each-ballot.
const ownerIds = (root, ballot) => {
  const people = new Set();
  for (const other of ballotDirs(root)) {
    if (!fs.existsSync(path.join(root, other, "ballot.yaml"))) continue;
    const location = other === ballot ? `${ballot}/ballot.yaml` : "-";
    try {
      const data = readYamlDocument(path.join(root, other, "ballot.yaml"), location).doc.toJS();
      if (!Array.isArray(data?.contests)) throw new Failure(location, "ballot-invalid");
      parseContests(data, () => {}, people);
    } catch (error) {
      if (error instanceof Failure && other !== ballot) error.hint = "check-each-ballot";
      throw error;
    }
  }
  return people;
};

// tiers.yaml entries, each { match, parsed, tier, statements_only, owner, source }.
// Refuses the whole file on any bad entry (source-tiers.md), and on a match or
// source holding a private value of any ballot (`values`, loadPrivateValues').
// `ballot` is the current ballot (ownerIds).
const loadTiers = (root, values, ballot) => {
  const { doc, lineCounter } = readYamlDocument(path.join(root, "tiers.yaml"), "tiers.yaml");
  if (!load("yaml").isSeq(doc.contents)) {
    throw new Failure("tiers.yaml", "tiers-invalid");
  }
  const people = ownerIds(root, ballot);
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
  const [leak] = tiersPrivacy(root, values, { doc, lineCounter });
  if (leak) throw leak;
  return entries.map(({ at, ...entry }) => entry);
};

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
// by class: the ballot id, the private_strings of every ballot in the data
// repo, and the API key values set in the environment. A URL is refused for
// any ballot's private string, since privacy is the family's against the
// public, not one ballot's against another's. Another ballot's private.yaml
// that cannot be read fails, followed by check-each-ballot. No script prints
// any of them (Rule 5).
const loadPrivateValues = (root, ballot) => {
  const own = loadPrivate(root, ballot, `${ballot}/private.yaml`).private_strings;
  const others = otherPrivateStrings(root, ballot);
  const [failure] = others.failures;
  if (failure) {
    failure.hint = "check-each-ballot";
    throw failure;
  }
  return {
    "ballot-id": [ballot.split("/")[1]],
    "private-string": [...own, ...others.strings],
    key: KEY_ENV.map((name) => process.env[name]).filter(Boolean),
  };
};

// loadPrivateValues plus every other ballot's id: what publish keeps off a
// page (SKILL.md step 6.3). The page is public, so another ballot's id is
// private there too. ballot-check has already read each private.yaml (Tiers
// rule).
const familyPrivateValues = (root, ballot) => {
  const values = loadPrivateValues(root, ballot);
  for (const other of ballotDirs(root)) {
    if (other !== ballot) values["ballot-id"].push(other.split("/")[1]);
  }
  return values;
};

module.exports = {
  ON_BALLOT,
  ballotDirs,
  ballotEntries,
  contestsOf,
  familyPrivateValues,
  faultFreeContests,
  hiddenTitles,
  isDir,
  loadContests,
  loadPrivate,
  loadPrivateValues,
  loadTiers,
  otherPrivateStrings,
  parseContests,
  readYamlDocument,
  tiersPrivacy,
};
