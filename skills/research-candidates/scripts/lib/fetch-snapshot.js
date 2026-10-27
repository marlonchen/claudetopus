"use strict";

// fetch-snapshot <election>/<ballot-id> <contest> <subject> <name> <url>
//
// Save one web page as a write-once snapshot under
// <ballot>/sources/<contest>/<subject>/<name>.md (snapshot-format.md). Its
// tier, statements_only, owner and source name come only from the matched
// tiers.yaml entries; a page that cannot be saved is logged to unfetchable.md.
// A URL holding a private value (Rule 7) is refused before anything else
// reads it, on every hop, and only its class code is printed: it is never
// requested and never logged, since the URL is the private text.
//
// fetch-snapshot --ballot ... is the researcher's step 2 import (ballot-import.js).

const fs = require("node:fs");
const path = require("node:path");
const ballotImport = require("./ballot-import").main;
const { BALLOT_ID_PATTERN, ELECTION_PATTERN, ID_PATTERN } = require("./constants");
const { loadBallot, loadPrivateValues, loadTiers } = require("./data-files");
const { cleanUrl, fetchPage, isHttp, spellings } = require("./fetch-page");
const { htmlToText } = require("./html-text");
const { Failure, runCommand } = require("./output");
const { refusalCode, scan } = require("./privacy");
const { guardRepo } = require("./repo-guard");
const { URL_CLASSES, snapshotText, today } = require("./snapshot-file");
const { recover, save, withLock } = require("./snapshot-store");

const parseArgs = (argv) => {
  if (argv.length !== 5 || argv.some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [ballot, contest, subject, name, url] = argv;
  const [election, ballotId, extra] = ballot.split("/");
  if (extra !== undefined || !ELECTION_PATTERN.test(election ?? "")) {
    throw new Failure("-", "bad-ballot");
  }
  if (!BALLOT_ID_PATTERN.test(ballotId ?? "")) throw new Failure("-", "bad-ballot");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Failure("-", "bad-url");
  }
  // Credentials in a URL are never fetched or recorded.
  if (!isHttp(parsed) || parsed.username || parsed.password) throw new Failure("-", "bad-url");
  return { ballot, contest, subject, name, given: url, url: parsed };
};

// The contest and subject must be a pair ballot.yaml lists (or _race), so the
// target path under sources/ is always built from known ids.
const checkTarget = (root, { ballot, contest, subject, name }) => {
  // Checked here too, so an id ballot-check would fail never becomes a path.
  if (!ID_PATTERN.test(contest)) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  // A malformed subject is never echoed: it is the agent's text (Rule 5).
  if (subject !== "_race" && !ID_PATTERN.test(subject)) {
    throw new Failure(`${contest}/-`, "unknown-subject");
  }
  const contests = loadBallot(root, ballot).contests;
  const listed = contests.get(contest);
  if (!listed) throw new Failure(`${ballot}/ballot.yaml`, "unknown-contest");
  if (subject !== "_race" && !listed.subjects.has(subject)) {
    throw new Failure(`${contest}/${subject}`, "unknown-subject");
  }
  // A trailing -<digits> is how a re-fetch is numbered, so a name never has one.
  if (!ID_PATTERN.test(name) || /-[0-9]+$/.test(name)) {
    throw new Failure(`${contest}/${subject}`, "bad-name");
  }
  return listed;
};

const logUnfetchable = (ballotDir, url, where, reason) => {
  // A non-http redirect target can hold raw spaces and |, which would forge fields.
  const href = cleanUrl(url).href.replace(/[\s|]/g, encodeURIComponent);
  const line = `- ${href} | ${where} | ${today()} | ${reason}\n`;
  fs.appendFileSync(path.join(ballotDir, "unfetchable.md"), line);
};

const main = (argv) => (argv[0] === "--ballot" ? ballotImport(argv) : plainFetch(argv));

const plainFetch = (argv) =>
  runCommand(async () => {
    const root = process.cwd();
    const args = parseArgs(argv);
    guardRepo(root);
    const ballotDir = path.join(root, args.ballot);
    if (!fs.statSync(ballotDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Failure(args.ballot, "unknown-ballot");
    }
    withLock(ballotDir, () => recover(ballotDir));

    const target = checkTarget(root, args);
    const where = `${args.contest}/${args.subject}`;
    const values = loadPrivateValues(root, args.ballot);
    // A privacy refusal stops the command here or inside fetchPage, so it can
    // never reach logUnfetchable.
    const checkPrivate = (texts) => {
      const code = refusalCode(texts.flatMap((text) => scan(text, values, URL_CLASSES)));
      if (code) throw new Failure(where, code);
    };
    // Every spelling, before tiers.yaml is read, so a private URL never reaches the tier lookup.
    checkPrivate(spellings(args.url, args.given));
    const entries = loadTiers(root);

    const page = await fetchPage(entries, args.url, checkPrivate);
    if (page.refused) {
      logUnfetchable(ballotDir, page.url, where, page.refused.reason);
      throw new Failure(where, page.refused.code);
    }
    // A campaign site is filed only under its own candidate.
    if (target.subjects.has(page.tiers.owner) && page.tiers.owner !== args.subject) {
      throw new Failure(where, "owner-not-subject");
    }
    const text = htmlToText(page.html);
    if (!text) {
      logUnfetchable(ballotDir, page.url, where, "no readable text");
      throw new Failure(where, "no-readable-text");
    }

    const fileText = snapshotText(
      {
        source: page.tiers.source,
        url: cleanUrl(page.url).href,
        fetched: today(),
        method: "html",
        tier: page.tiers.tier,
        statements_only: page.tiers.statements_only,
        subject: args.subject,
        owner: page.tiers.owner,
      },
      text,
    );
    const rel = withLock(ballotDir, () => save(ballotDir, where, args.name, fileText));
    return [`${rel} saved`];
  });

module.exports = { main };
