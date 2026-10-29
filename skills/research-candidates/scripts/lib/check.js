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
const { parseArticle } = require("./article");
const { EXCERPT_LENGTH, ID_PATTERN, ROLES, VIEW } = require("./constants");
const { hiddenTitles } = require("./ballot-privacy");
const { readYamlDocument } = require("./data-files");
const { figuresBacked } = require("./figures");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { bodyText, findExcerpt, normalizeLine } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { scan } = require("./privacy");
const { isSnapshotPath, verifyManifest } = require("./snapshot-hash");
const { FRONT_MATTER } = require("./snapshot-file");
const { withLock } = require("./snapshot-store");
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

// The printed titles of contests with a display_title (ballot-format.md), or
// a Failure when ballot.yaml cannot be read. ballot-check validates the rest.
const readHiddenTitles = (ballotDir) => {
  try {
    return hiddenTitles(
      readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS(),
    );
  } catch (error) {
    if (error instanceof Failure) return error;
    throw error;
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

// Each cited snapshot, read once: { ballot, tier, statementsOnly, body } or
// null when it is missing or not a regular file. `ballot` is true for a
// _ballot snapshot whose front matter does not give a companion role, so a
// sample ballot whose role cannot be read is never matched like an ordinary
// source. `tier` is null when the front matter does not give one.
const snapshotReader = (ballotDir) => {
  const cache = new Map();
  return (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    const file = path.join(ballotDir, rel);
    let read = null;
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      const text = fs.readFileSync(file, "utf8");
      const front = FRONT_MATTER.exec(text);
      let fields = {};
      try {
        fields = (front && load("yaml").parse(front[1] ?? "")) || {};
      } catch {
        fields = {};
      }
      const role = rel.startsWith("sources/_ballot/") ? fields.role : null;
      read = {
        ballot: rel.startsWith("sources/_ballot/") && !COMPANION_ROLES.includes(role),
        tier: Object.hasOwn(TIER_RANK, fields.tier ?? "") ? fields.tier : null,
        statementsOnly: fields.statements_only === true,
        body: bodyText(front ? text.slice(front[0].length) : text),
      };
    }
    cache.set(rel, read);
    return read;
  };
};

// Does a tag, parsed by CLAIM_TAG, fit the snapshot (source-tiers.md, Claim
// tags)? A plain tag is T1 to T3 on a snapshot that is not statements_only,
// an `s` tag any tier, and an `i` tag a T2 snapshot that is not statements_only; every tag's tier is the
// snapshot's own.
const tagFits = (tag, snapshot) => {
  if (!tag || !snapshot.tier || tag.tier !== snapshot.tier) return false;
  if (tag.mark === "s") return true;
  if (snapshot.statementsOnly) return false;
  return tag.mark === "i" ? tag.tier === "T2" : tag.tier !== "T4";
};

// Does any of `texts` hold `<!--` or `-->`, raw or normalized, so a fullwidth
// or dash-folded marker counts too?
const hasCommentMarker = (texts) =>
  texts.some((text) =>
    [text, normalizeLine(text)].some((t) => t.includes("<!--") || t.includes("-->")),
  );

// The failures of one claim, located `at` (its claim line), in report order.
const claimFailures = (claim, at, { view, titles, readSnapshot }) => {
  const rel = resolveTarget(claim.target);
  const snapshot = rel && readSnapshot(rel);
  if (!snapshot) return [new Failure(at, "claim-format")];
  const failures = [];
  if (hasCommentMarker([claim.text, claim.label, claim.excerpt]))
    failures.push(new Failure(at, "comment-marker"));
  // Matched as the publish privacy scan matches it (SKILL.md step 6.3).
  if (scan(claim.excerpt, { title: titles }, ["title"]).length)
    failures.push(new Failure(at, "title-in-excerpt"));
  const parsed = CLAIM_TAG.exec(claim.tag);
  const tag = parsed && { tier: parsed[1], mark: parsed[2] };
  if (!tagFits(tag, snapshot)) failures.push(new Failure(at, "tag-mismatch"));
  if (tag?.mark === "s" && !claim.text.startsWith("Says:"))
    failures.push(new Failure(at, "says-missing"));
  // The parser keeps the tag and link out of the text, so their snapshot names
  // and ids are never read as claimed figures.
  if (!figuresBacked(claim.text, claim.excerpt)) failures.push(new Failure(at, "figure-missing"));
  if ((view && rel === view.link) || snapshot.ballot) {
    const whole = view && rel === view.link && view.spans.has(normalizeLine(claim.excerpt));
    if (!whole) failures.push(new Failure(at, "ballot-excerpt"));
    return failures;
  }
  const length = [...normalizeLine(claim.excerpt)].length;
  if (length < EXCERPT_LENGTH.min || length > EXCERPT_LENGTH.max)
    failures.push(new Failure(at, "excerpt-length"));
  if (!findExcerpt(snapshot.body, claim.excerpt))
    failures.push(new Failure(at, "excerpt-not-found"));
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

const check = (ballotDir, given) => {
  const failureLines = verifyManifest(ballotDir).map((f) => f.line);
  const contests = given.length ? given : allContests(ballotDir);
  const titles = readHiddenTitles(ballotDir);
  if (titles instanceof Failure) failureLines.push(titles.line);
  const context = {
    view: readView(ballotDir),
    titles: titles instanceof Failure ? [] : titles,
    readSnapshot: snapshotReader(ballotDir),
  };
  for (const contest of contests) {
    const rel = `articles/${contest}.md`;
    const file = path.join(ballotDir, rel);
    if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
      failureLines.push(new Failure(rel, "file-missing").line);
      continue;
    }
    const article = parseArticle(fs.readFileSync(file, "utf8"));
    // [line, Failure] pairs, so the article's failures print in line order.
    const found = article.failures.map(({ line, code }) => [
      line,
      new Failure(`${rel}:${line}`, code),
    ]);
    for (const claim of article.claims) {
      for (const failure of claimFailures(claim, `${rel}:${claim.line}`, context))
        found.push([claim.line, failure]);
    }
    found.sort((a, b) => a[0] - b[0]);
    failureLines.push(...found.map(([, failure]) => failure.line));
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

module.exports = { main };
