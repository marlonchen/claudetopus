"use strict";

// coverage <election>/<ballot-id> [<contest>]...
//
// Steps 4.4, 5 and 6.1: every article has every block, section and Positions
// issue sections.md gives its contest, in order and once, each in exactly one
// state it may use, and every Unknown is backed by the search log
// (article-format.md, Command line). Snapshots under the contest that no claim
// cites are listed, never failed. Every failure found is reported, as
// `location code` lines located in the ballot directory, never with a value
// (Rule 5). The claims themselves are check's.

const fs = require("node:fs");
const path = require("node:path");
const { parseArticle } = require("./article");
const { allContests, parseArgs, resolveTarget } = require("./check");
const {
  CHECKLIST_ITEMS,
  EXEMPTION,
  ID_PATTERN,
  OFFICE_TYPES,
  POSITIONS_ISSUES,
  SAYS_ONLY,
  SECTION_ITEMS,
  SECTION_STATES,
  SECTIONS,
  STATUSES,
  WITHDRAWN_SECTIONS,
} = require("./constants");
const { readYamlDocument } = require("./data-files");
const { openBallot } = require("./fetch-common");
const { Failure, Failures, runCommand } = require("./output");
const { logPath } = require("./search-log");
const { locate, walk } = require("./snapshot-hash");
const { withLock } = require("./snapshot-store");

const [UNKNOWN, NOT_RESEARCHED, NOT_JOB] = SECTION_STATES;
const ON_BALLOT = SECTIONS.candidate[0];
// source-tiers.md, Claim tags: a "Says:" tag.
const SAYS_TAG = /^T[1-4]s$/;

// The search log (snapshot-format.md, Search log).
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

// Is `date` a real YYYY-MM-DD date?
const isDate = (date) => {
  const m = DATE.exec(date);
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
};

// The contest's log as { logged, failures }: logged holds `<subject>\t<item>`
// for each well-formed line whose subject is in `subjects`; failures are
// search-not-logged, located by log line, for each line that does not split
// into the four fields, does not end in a newline, names another contest, or
// has a malformed subject, item or date. A missing log has no lines.
const readSearchLog = (ballotDir, contest, type, subjects) => {
  const rel = logPath(contest);
  const logged = new Set();
  const failures = [];
  const stat = fs.lstatSync(path.join(ballotDir, rel), { throwIfNoEntry: false });
  if (!stat) return { logged, failures };
  if (!stat.isFile()) return { logged, failures: [new Failure(rel, "search-not-logged")] };
  const lines = fs.readFileSync(path.join(ballotDir, rel), "utf8").split("\n");
  const unended = lines.pop();
  if (unended !== "") lines.push(null);
  for (const [i, line] of lines.entries()) {
    const fields = line?.split("\t") ?? [];
    const [logContest, subject, item, date] = fields;
    const wellFormed =
      fields.length === 4 &&
      logContest === contest &&
      (subject === "_race" || ID_PATTERN.test(subject)) &&
      CHECKLIST_ITEMS[type].includes(item) &&
      isDate(date);
    if (!wellFormed) failures.push(new Failure(`${rel}:${i + 1}`, "search-not-logged"));
    else if (subjects.has(subject)) logged.add(`${subject}\t${item}`);
  }
  return { logged, failures };
};

const isText = (value) => typeof value === "string" && value !== "";

// What coverage reads of one ballot.yaml contest, or null when it lacks it.
// ballot-check validates the rest and locates each fault by line.
const readContest = (contest) => {
  if (!contest || !isText(contest.id) || !Object.hasOwn(SECTIONS, contest.type)) return null;
  const { type } = contest;
  // The sections not_researched may name: all but On the ballot.
  const deferrable = SECTIONS[type].filter((s) => s !== ON_BALLOT);
  const later = contest.not_researched;
  const valid =
    later === undefined ||
    later === "all" ||
    (Array.isArray(later) && later.every((s) => deferrable.includes(s)));
  if (!valid) return null;
  const read = {
    id: contest.id,
    type,
    notResearched: new Set(later === "all" ? deferrable : later),
  };
  if (type === "candidate") {
    if (!OFFICE_TYPES.includes(contest.office_type) || !Array.isArray(contest.candidates))
      return null;
    const people = contest.candidates;
    if (!people.every((c) => isText(c?.id) && isText(c.name) && STATUSES.includes(c.status)))
      return null;
    // Printed candidates in ballot order, then certified write-ins (article-format.md).
    const writeIn = (c) => c.status === "certified_write_in";
    const ordered = [...people.filter((c) => !writeIn(c)), ...people.filter(writeIn)];
    read.officeType = contest.office_type;
    read.blocks = ordered.map((c) => ({
      name: c.name,
      subject: c.id,
      sections: c.status === "withdrawn_still_printed" ? WITHDRAWN_SECTIONS : SECTIONS.candidate,
    }));
  } else if (type === "retention") {
    const { official } = contest;
    if (!isText(official?.id) || !isText(official.name)) return null;
    read.blocks = [{ name: official.name, subject: official.id, sections: SECTIONS.retention }];
  } else {
    read.blocks = [{ name: contest.id, subject: "_race", sections: SECTIONS.measure }];
  }
  return read;
};

// ballot.yaml's contests by id, as readContest reads them.
const readContests = (ballotDir) => {
  const data = readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS();
  if (!Array.isArray(data?.contests)) throw new Failure("ballot.yaml", "ballot-invalid");
  const contests = new Map();
  for (const contest of data.contests) {
    const read = readContest(contest);
    if (!read) throw new Failure("ballot.yaml", "ballot-invalid");
    contests.set(read.id, read);
  }
  return contests;
};

// A section's heading as sections.md writes it: its letter and its name.
const heading = (type, name) =>
  `${String.fromCharCode(65 + SECTIONS[type].indexOf(name))}. ${name}`;

// Match headed items ({ name, line }) to the `expected` names, in order and
// once each. Returns the matched [index, item] pairs, the items at fault (not
// expected, a repeat, or out of order; an out-of-order one is still matched)
// and the expected indexes no item matched.
const matchInOrder = (expected, items) => {
  const pairs = [];
  const faults = [];
  const used = new Set();
  let last = -1;
  for (const item of items) {
    const index = expected.findIndex((name, i) => name === item.name && !used.has(i));
    if (index === -1) {
      faults.push(item);
      continue;
    }
    used.add(index);
    pairs.push([index, item]);
    if (index < last) faults.push(item);
    else last = index;
  }
  const missing = expected.map((_, i) => i).filter((i) => !used.has(i));
  return { pairs, faults, missing };
};

// The states a section or issue holds: each state line, and "claims" once
// for any claims, a claim line check fails included.
const statesOf = (part) => [
  ...part.states.map((s) => s.state),
  ...(part.claims.length || part.rejected.length ? ["claims"] : []),
];

// The failures of one article, as [line, Failure] pairs (line 0 for one
// located by the article alone).
const articleFailures = (rel, article, contest, logged) => {
  const found = [];
  const fail = (line, code) =>
    found.push([line ?? 0, new Failure(line ? `${rel}:${line}` : rel, code)]);

  // The # heading: the contest id, once, before every block.
  const [title, ...extra] = article.titles;
  if (!title || title.text !== contest.id) fail(title?.line, "block-missing");
  for (const t of extra) fail(t.line, "block-missing");
  for (const line of article.strays) fail(line, "section-missing");

  const blocks = matchInOrder(
    contest.blocks.map((b) => b.name),
    article.blocks,
  );
  for (const block of blocks.faults) fail(block.line, "block-missing");
  for (const block of article.blocks)
    if (title && block.line < title.line && !blocks.faults.includes(block))
      fail(block.line, "block-missing");
  for (const _ of blocks.missing) fail(title?.line, "block-missing");

  for (const [index, block] of blocks.pairs) {
    const expected = contest.blocks[index];
    const names = expected.sections;
    const sections = matchInOrder(
      names.map((name) => heading(contest.type, name)),
      block.sections,
    );
    for (const s of sections.faults) fail(s.line, "section-missing");
    for (const _ of sections.missing) fail(block.line, "section-missing");
    const matched = new Set(sections.pairs.map(([, s]) => s));
    // An unmatched section is at fault already; so is every issue under it.
    for (const s of block.sections)
      if (!matched.has(s)) for (const i of s.issues) fail(i.line, "section-missing");

    for (const [i, part] of sections.pairs) {
      checkSection(names[i], part, { contest, subject: expected.subject, logged, fail });
    }
  }
  return found;
};

// One section's states, issues and claims (article-format.md, Section states).
const checkSection = (name, part, { contest, subject, logged, fail }) => {
  const { type } = contest;
  const issueClaims = part.issues.flatMap((i) => i.claims);
  if (SAYS_ONLY[type].includes(name)) {
    for (const claim of [...part.claims, ...issueClaims])
      if (!SAYS_TAG.test(claim.tag) || !claim.text.startsWith("Says:"))
        fail(claim.line, "says-missing");
  }
  // An Unknown needs a log line for the subject and each item the section draws on.
  const backed = (state) => {
    const items = SECTION_ITEMS[type][name] ?? [];
    if (!items.every((item) => logged.has(`${subject}\t${item}`)))
      fail(state.line, "search-not-logged");
  };
  // The one state a section or issue holds, of those `allowed`, or null
  // after failing it. An Unknown also needs the log.
  const stateOf = (holder, allowed) => {
    const states = statesOf(holder);
    if (states.length !== 1 || !allowed.includes(states[0])) {
      fail(holder.line, "section-state");
      return null;
    }
    if (states[0] === UNKNOWN) backed(holder.states[0]);
    return states[0];
  };

  const exempt =
    type === EXEMPTION.type &&
    name === EXEMPTION.section &&
    contest.officeType === EXEMPTION.office_type;
  const positions = type === "candidate" && name === "Positions";
  const allowed = exempt
    ? [NOT_JOB]
    : contest.notResearched.has(name)
      ? [NOT_RESEARCHED]
      : name === ON_BALLOT
        ? ["claims"]
        : ["claims", UNKNOWN];
  // Only Positions, in a state of its issues, holds issue headings.
  if (!positions || allowed.length === 1) {
    for (const issue of part.issues) fail(issue.line, "section-missing");
    stateOf(part, allowed);
    return;
  }
  // Positions holds only its office type's issues, in order and once.
  if (statesOf(part).length) fail(part.line, "section-state");
  const issues = matchInOrder(POSITIONS_ISSUES[contest.officeType], part.issues);
  for (const issue of issues.faults) fail(issue.line, "section-missing");
  for (const _ of issues.missing) fail(part.line, "section-missing");
  for (const [, issue] of issues.pairs) stateOf(issue, allowed);
};

// The snapshots under sources/<contest>/ that no claim of the article cites,
// as `<path> uncited` lines, each path located as check locates it.
const uncited = (ballotDir, contest, article) => {
  const targets = [...article.claims, ...article.rejected].map((c) => resolveTarget(c.target));
  const cited = new Set(targets.filter(Boolean));
  const lines = walk(ballotDir)
    .filter(({ rel, kind }) => kind === "file" && rel.startsWith(`sources/${contest}/`))
    .filter(({ rel }) => !cited.has(rel))
    .map(({ rel }) => `${locate(rel, false)} uncited`);
  return [...new Set(lines)];
};

const coverage = (ballotDir, given) => {
  const contests = readContests(ballotDir);
  const lines = [];
  let failed = false;
  for (const id of given.length ? given : allContests(ballotDir)) {
    const rel = `articles/${id}.md`;
    const contest = contests.get(id);
    if (!contest) {
      lines.push(new Failure(rel, "unknown-contest").line);
      failed = true;
      continue;
    }
    const file = path.join(ballotDir, rel);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      lines.push(new Failure(rel, "file-missing").line);
      failed = true;
      continue;
    }
    const article = parseArticle(fs.readFileSync(file, "utf8"));
    const subjects = new Set(contest.blocks.map((b) => b.subject));
    const log = readSearchLog(ballotDir, id, contest.type, subjects);
    const found = articleFailures(rel, article, contest, log.logged);
    // Stable, so failures on one line keep the order they were found in.
    found.sort((a, b) => a[0] - b[0]);
    const failures = [...found.map(([, f]) => f), ...log.failures];
    lines.push(...failures.map((f) => f.line), ...uncited(ballotDir, id, article));
    if (failures.length) failed = true;
    else lines.push(`${rel} passed`);
  }
  if (failed) throw new Failures(lines);
  return lines;
};

const main = (argv) =>
  runCommand(async () => {
    const { ballot, contests } = parseArgs(argv);
    const ballotDir = openBallot(process.cwd(), ballot);
    // Under the ballot lock, so a save or log line written now is never half seen.
    return withLock(ballotDir, () => coverage(ballotDir, contests));
  });

module.exports = { main };
