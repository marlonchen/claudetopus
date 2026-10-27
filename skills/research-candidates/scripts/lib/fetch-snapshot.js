"use strict";

// fetch-snapshot <election>/<ballot-id> <contest> <subject> <name> <url>
//
// Save one web page as a write-once snapshot under
// <ballot>/sources/<contest>/<subject>/<name>.md (snapshot-format.md). Its
// tier, statements_only, owner and source name come only from the matched
// tiers.yaml entries; a page that cannot be saved is logged to unfetchable.md.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN, ID_PATTERN } = require("./constants");
const { loadBallot, loadTiers } = require("./data-files");
const { load } = require("./deps");
const { cleanUrl, fetchPage, isHttp } = require("./fetch-page");
const { htmlToText } = require("./html-text");
const { Failure, runCommand } = require("./output");
const { guardRepo } = require("./repo-guard");
const { recover, save, withLock } = require("./snapshot-store");

// Local date, as for `fetched:`.
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// C0 and C1 controls, DEL, and the line and paragraph separators.
const hasControl = (value) =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });

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
  return { ballot, contest, subject, name, url: parsed };
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
  if (!ID_PATTERN.test(name)) throw new Failure(`${contest}/${subject}`, "bad-name");
  return listed;
};

const logUnfetchable = (ballotDir, url, where, reason) => {
  // A non-http redirect target can hold raw spaces and |, which would forge fields.
  const href = cleanUrl(url).href.replace(/[\s|]/g, encodeURIComponent);
  const line = `- ${href} | ${where} | ${today()} | ${reason}\n`;
  fs.appendFileSync(path.join(ballotDir, "unfetchable.md"), line);
};

// The snapshot file: front matter from a YAML emitter, then the body.
const snapshotText = (fields, text) => {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && (hasControl(value) || value.includes("---"))) {
      throw new Failure(key, "unsafe-value");
    }
  }
  const YAML = load("yaml");
  const yaml = YAML.stringify(fields, { lineWidth: 0 });
  return `---\n${yaml}---\n${text}\n`;
};

const main = (argv) =>
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
    const entries = loadTiers(root);
    const where = `${args.contest}/${args.subject}`;

    const page = await fetchPage(entries, args.url);
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
