"use strict";

// check <election>/<ballot-id> [<contest>]...
//
// Steps 4.4, 5 and 6.1: every claim's excerpt is found in the one snapshot its
// claim links to, and every snapshot matches snapshots.sha256
// (article-format.md, Command line). Every failure found is reported, as
// `location code` lines located in the ballot directory, never with a value
// or a link target (Rule 5).

const fs = require("node:fs");
const path = require("node:path");
const { apiRecords } = require("./api-text");
const { parseArticle } = require("./article");
const { EXCERPT_LENGTH, ID_PATTERN, ROLES, VIEW } = require("./constants");
const { hiddenTitles, readYamlDocument } = require("./data-files");
const { figuresBacked } = require("./figures");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { bodyText, findExcerpt, normalizeLine, recordText } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { scan } = require("./privacy");
const { isSnapshotPath, verifyManifest } = require("./snapshot-hash");
const { FRONT_MATTER } = require("./snapshot-file");
const { sha256, withLock } = require("./snapshot-store");
const { TIER_RANK } = require("./tiers");

// The _ballot roles the compile agent reads whole (ballot-format.md, Ballot view).
const COMPANION_ROLES = ROLES.filter((role) => role !== "sample_ballot");
// source-tiers.md, Claim tags: a claim tag as its tier and mark.
const CLAIM_TAG = /^(T[1-4])([si])?$/;
// articles/<contest>.md, for a contest id.
const ARTICLE_NAME = new RegExp(`${ID_PATTERN.source.slice(0, -1)}\\.md$`);

const parseArgs = (argv) => {
  if (argv.length === 0 || argv.some((arg) => arg.startsWith("--")))
    throw new Failure("-", "usage");
  const [ballot, ...given] = argv;
  parseBallot(ballot);
  if (!given.every((c) => ID_PATTERN.test(c))) throw new Failure("-", "usage");
  // A contest given twice is checked once.
  return { ballot, contests: [...new Set(given)] };
};

// ballot-view.md as { link, spans }, or null when there is none
// (ballot-format.md, Ballot check).
const readView = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, VIEW), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let link = null;
  const spans = new Set();
  for (const line of text.split("\n")) {
    const linked = /^link: (.+)$/.exec(line);
    if (linked) link ??= linked[1];
    else if (line && !/^(read|sha256): /.test(line)) spans.add(line);
  }
  return { link, spans };
};

// The printed titles of contests with a display_title (ballot-format.md). When
// ballot.yaml cannot be read, its failure goes to `failureLines` and there are
// none. ballot-check validates the rest.
const readHiddenTitles = (ballotDir, failureLines) => {
  try {
    return hiddenTitles(
      readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS(),
    );
  } catch (error) {
    if (!(error instanceof Failure) || !["file-missing", "yaml-invalid"].includes(error.code))
      throw error;
    failureLines.push(error.line);
    return [];
  }
};

// The ballot-relative path a claim's link target names, or null when it is not
// a relative link to a snapshot path under sources/.
const resolveTarget = (target) => {
  if (/[\\%]/.test(target) || target.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(target))
    return null;
  const rel = path.posix.normalize(path.posix.join("articles", target));
  return isSnapshotPath(rel) ? rel : null;
};

// Each cited snapshot, read once: { ballot, tier, statementsOnly, body, records,
// fields, hash } or null when it is missing or not a regular file. `records`
// is an api snapshot's records, each read as a body on its own
// (snapshot-format.md, Body), and null for any other method; an api body and
// its records are read with no hyphen breaks (recordText). `fields` is its
// parsed front matter ({} when it cannot be read) and `hash` the sha256 of the
// whole file. `ballot` is true for a
// _ballot snapshot whose front matter does not give a companion role, so a
// sample ballot whose role cannot be read is never matched like an ordinary
// source. `tier` and `statementsOnly` are null when the front matter does not
// give them.
const snapshotReader = (ballotDir, YAML) => {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const file = path.join(ballotDir, rel);
    let read = null;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      const bytes = fs.readFileSync(file);
      const text = bytes.toString("utf8");
      const front = FRONT_MATTER.exec(text);
      const body = front ? text.slice(front[0].length) : text;
      let fields = {};
      try {
        fields = (front && YAML.parse(front[1] ?? "")) || {};
      } catch {
        fields = {};
      }
      const role = rel.startsWith("sources/_ballot/") ? fields.role : null;
      const api = fields.method === "api";
      read = {
        ballot: rel.startsWith("sources/_ballot/") && !COMPANION_ROLES.includes(role),
        tier: Object.hasOwn(TIER_RANK, fields.tier ?? "") ? fields.tier : null,
        statementsOnly: typeof fields.statements_only === "boolean" ? fields.statements_only : null,
        body: api ? recordText(body) : bodyText(body),
        records: api ? apiRecords(body).map(recordText) : null,
        fields,
        hash: sha256(bytes),
      };
    }
    cache.set(rel, read);
    return read;
  };
};

// Does a tag, parsed by CLAIM_TAG, fit the snapshot (source-tiers.md, Claim
// tags)? A plain tag is T1 to T3 on a snapshot that is not statements_only,
// an `s` tag any tier, and an `i` tag a T2 snapshot that is not
// statements_only; every tag's tier is the snapshot's own. A snapshot whose
// tier or statements_only cannot be read fits no tag.
const tagFits = (tag, snapshot) => {
  if (!tag || !snapshot.tier || snapshot.statementsOnly === null) return false;
  if (tag.tier !== snapshot.tier) return false;
  if (tag.mark === "s") return true;
  if (snapshot.statementsOnly) return false;
  return tag.mark === "i" ? tag.tier === "T2" : tag.tier !== "T4";
};

// Does any of `texts` hold `<!--` or `-->`, raw or normalized, so a fullwidth
// or dash-folded marker counts too? The link text is always `s` and a number.
const hasCommentMarker = (texts) =>
  texts.some((text) =>
    [text, normalizeLine(text)].some((t) => t.includes("<!--") || t.includes("-->")),
  );

// A hyphen between two letters, which a pdftotext break can leave in a word.
const LETTER_HYPHEN = /(?<=\p{L})-(?=\p{L})/gu;

// Does a claim or excerpt hold a hidden printed title, matched as publish
// matches it (SKILL.md steps 6.2 and 6.3): as written, then with every hyphen
// between two letters removed, against each title with and without its own
// hyphens?
const holdsTitle = (text, titles) => {
  const unhyphen = (t) => normalizeLine(t).replace(LETTER_HYPHEN, "");
  const values = { title: [...titles, ...titles.map(unhyphen)] };
  return [text, unhyphen(text)].some((t) => scan(t, values, ["title"]).length > 0);
};

// Is a resolved snapshot path one an article of `contest` may cite: filed
// under the contest, or a _ballot snapshot?
const citable = (rel, contest) =>
  rel.startsWith(`sources/${contest}/`) || rel.startsWith("sources/_ballot/");

// A bidi control reorders what a reader sees, and normalizing drops it, so a
// review key would not change with it (review-list.md, Item keys).
const BIDI = /\p{Bidi_Control}/u;

// The failures of one claim of `contest`, located `at` (its claim line), in
// report order. A claim whose link does not resolve, or names another
// contest's snapshot, still gets every check that does not need its snapshot.
const claimFailures = (claim, at, contest, { view, titles, readSnapshot }) => {
  const resolved = resolveTarget(claim.target);
  const rel = resolved && citable(resolved, contest) ? resolved : null;
  const snapshot = rel && readSnapshot(rel);
  const reordered = [claim.text, claim.excerpt].some((t) => BIDI.test(t));
  const failures = snapshot && !reordered ? [] : [new Failure(at, "claim-format")];
  if (hasCommentMarker([claim.text, claim.excerpt]))
    failures.push(new Failure(at, "comment-marker"));
  if (holdsTitle(claim.text, titles)) failures.push(new Failure(at, "title-in-claim"));
  if (holdsTitle(claim.excerpt, titles)) failures.push(new Failure(at, "title-in-excerpt"));
  const parsed = CLAIM_TAG.exec(claim.tag);
  const tag = parsed && { tier: parsed[1], mark: parsed[2] };
  if (snapshot && !tagFits(tag, snapshot)) failures.push(new Failure(at, "tag-mismatch"));
  if (tag?.mark === "s" && !claim.text.startsWith("Says:"))
    failures.push(new Failure(at, "says-missing"));
  // The parser keeps the tag and link out of the text, so their snapshot names
  // and ids are never read as claimed figures.
  if (!figuresBacked(claim.text, claim.excerpt)) failures.push(new Failure(at, "figure-missing"));
  if (!snapshot) return failures;
  if ((view && rel === view.link) || snapshot.ballot) {
    const whole = view && rel === view.link && view.spans.has(normalizeLine(claim.excerpt));
    if (!whole) failures.push(new Failure(at, "ballot-excerpt"));
    return failures;
  }
  const length = [...normalizeLine(claim.excerpt)].length;
  if (length < EXCERPT_LENGTH.min || length > EXCERPT_LENGTH.max)
    failures.push(new Failure(at, "excerpt-length"));
  const found = (snapshot.records ?? [snapshot.body]).some((record) =>
    findExcerpt(record, claim.excerpt),
  );
  if (!found && snapshot.records && findExcerpt(snapshot.body, claim.excerpt))
    failures.push(new Failure(at, "excerpt-crosses-record"));
  else if (!found) failures.push(new Failure(at, "excerpt-not-found"));
  return failures;
};

// Every article under articles/ named for a contest id, sorted.
const allContests = (ballotDir) => {
  const dir = path.join(ballotDir, "articles");
  if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => ARTICLE_NAME.test(name))
    .map((name) => name.slice(0, -".md".length))
    .sort();
};

// What every article's check reads once: the ballot view, the hidden titles
// and one snapshot reader. ballot.yaml's failure goes to `failureLines`.
const checkContext = (ballotDir, YAML, failureLines) => ({
  view: readView(ballotDir),
  titles: readHiddenTitles(ballotDir, failureLines),
  readSnapshot: snapshotReader(ballotDir, YAML),
});

// The failure lines of `contest`'s parsed article, located under `rel`, in
// line order.
const articleCheck = (rel, contest, article, context) => {
  // [line, Failure] pairs, so the article's failures print in line order.
  const found = article.failures.map(({ line, code }) => [
    line,
    new Failure(`${rel}:${line}`, code),
  ]);
  for (const claim of article.claims) {
    for (const failure of claimFailures(claim, `${rel}:${claim.line}`, contest, context))
      found.push([claim.line, failure]);
  }
  found.sort((a, b) => a[0] - b[0]);
  return found.map(([, failure]) => failure.line);
};

const check = (ballotDir, given) => {
  // Loaded first, so a missing install is one deps-missing, not a failure per claim.
  const YAML = load("yaml");
  const failureLines = verifyManifest(ballotDir).map((f) => f.line);
  const contests = given.length ? given : allContests(ballotDir);
  const context = checkContext(ballotDir, YAML, failureLines);
  for (const contest of contests) {
    const rel = `articles/${contest}.md`;
    const file = path.join(ballotDir, rel);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      failureLines.push(new Failure(rel, "file-missing").line);
      continue;
    }
    const article = parseArticle(fs.readFileSync(file, "utf8"));
    failureLines.push(...articleCheck(rel, contest, article, context));
  }
  if (failureLines.length) throw new Failures(failureLines);
  return [`snapshots.sha256 checked`, ...contests.map((c) => `articles/${c}.md checked`)];
};

const main = (argv) =>
  runCommand(async () => {
    const { ballot, contests } = parseArgs(argv);
    const ballotDir = openBallot(process.cwd(), ballot);
    // Under the ballot lock, so a save running now is never half seen.
    return withLock(ballotDir, () => check(ballotDir, contests));
  });

module.exports = {
  LETTER_HYPHEN,
  allContests,
  articleCheck,
  checkContext,
  main,
  parseArgs,
  resolveTarget,
};
