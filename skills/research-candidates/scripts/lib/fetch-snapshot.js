"use strict";

// fetch-snapshot <election>/<ballot-id> <contest> <subject> <name> <url>
// fetch-snapshot --keep-short <election>/<ballot-id> <contest> <subject> <name> <url>
//
// Save one web page or API response as a write-once snapshot under
// <ballot>/sources/<contest>/<subject>/<name>.md (snapshot-format.md). Its
// tier, statements_only, owner and source name come only from the matched
// tiers.yaml entries; a page that cannot be saved, including one whose
// redirects land on another site or a login page and a short teaser
// (Unfetchable pages), is logged to unfetchable.md. --keep-short is the
// researcher's own plain fetch, at their terminal, that saves a short page
// once they confirm it is the article.
// A URL holding a private value (Rule 7) is refused before anything else
// reads it, on every hop, and only its class code is printed: it is never
// requested and never logged, since the URL is the private text.
//
// fetch-snapshot --ballot ... is the researcher's step 2 import (ballot-import.js),
// and fetch-snapshot --searched ... the discovery agent's search log (search-log.js).

const fs = require("node:fs");
const path = require("node:path");
const { jsonToText } = require("./api-text");
const ballotImport = require("./ballot-import").main;
const { ID_PATTERN, SHORT_PAGE, WALL_SEGMENTS } = require("./constants");
const { loadBallot, loadPrivateValues, loadTiers } = require("./data-files");
const { openBallot, parseBallot, parseHttpUrl } = require("./fetch-common");
const { fetchPage, recordedHref, spellings } = require("./fetch-page");
const { htmlToText } = require("./html-text");
const { Failure, runCommand } = require("./output");
const { URL_CLASSES, findRefusal } = require("./privacy");
const searched = require("./search-log").main;
const { snapshotText, today } = require("./snapshot-file");
const { appendLine, save, withLock } = require("./snapshot-store");
const { confirm, requireTerminal } = require("./terminal");

const parseArgs = (argv) => {
  if (argv.length !== 5 || argv.some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [ballot, contest, subject, name, url] = argv;
  parseBallot(ballot);
  return { ballot, contest, subject, name, given: url, url: parseHttpUrl(url) };
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
  const line = `- ${recordedHref(url)} | ${where} | ${today()} | ${reason}\n`;
  // Under the ballot lock, so review-list never reads a half-written line.
  withLock(ballotDir, () => {
    const file = path.join(ballotDir, "unfetchable.md");
    // After a line a crash cut short, start a new one: the torn line stays
    // for review-list to locate, and this entry is whole.
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    appendLine(file, text === "" || text.endsWith("\n") ? line : `\n${line}`);
  });
};

// snapshot-format.md, Unfetchable pages. The host with one leading `www.`
// dropped, so example.com and www.example.com are one site.
const site = (url) => url.hostname.replace(/^www\./, "");
// The path segments, case folded and up to their first `.` or `;`, that name
// a login or subscribe page.
const wallSegments = (url) =>
  url.pathname
    .split("/")
    .map((part) => part.toLowerCase().split(/[.;]/)[0])
    .filter((part) => WALL_SEGMENTS.includes(part));
// The refusals of a hop the redirects landed on that its URL decides instead:
// one it answered (or, untiered, was never asked), but not a broken redirect
// chain or an owner change, which say more.
const LANDED = ["domain-not-in-tiers", "http-error", "not-html", "too-large"];

// The Unfetchable pages rule `page` breaks by where its redirects landed,
// whatever that URL answered, as { code, reason }, or null. A host off the
// site is refused even when tiers.yaml does not list it, and is never
// contacted; a wall segment `given` already has (a trailing-slash redirect
// on /elections/register) is not a wall.
const landedOnWall = (given, page) => {
  if (page.url.href === given.href) return null;
  if (page.refused && !LANDED.includes(page.refused.code)) return null;
  if (site(page.url) !== site(given)) {
    return { code: "off-site-redirect", reason: `off-site redirect to ${page.url.hostname}` };
  }
  const asked = new Set(wallSegments(given));
  if (wallSegments(page.url).some((part) => !asked.has(part))) {
    return { code: "login-redirect", reason: "login redirect" };
  }
  return null;
};
const SHORT = { code: "short-page", reason: "short page" };

const MODES = {
  "--ballot": ballotImport,
  "--searched": searched,
  "--keep-short": (argv) => plainFetch(argv.slice(1), { keepShort: true }),
};
// Own keys only, so `constructor` or `toString` is a ballot plainFetch refuses.
const main = (argv) => (Object.hasOwn(MODES, argv[0]) ? MODES[argv[0]] : plainFetch)(argv);

const plainFetch = (argv, { keepShort = false } = {}) =>
  runCommand(async () => {
    // The researcher's own judgment, so never the session's (Rule 5's guard).
    if (keepShort) requireTerminal();
    const root = process.cwd();
    const args = parseArgs(argv);
    const ballotDir = openBallot(root, args.ballot);

    const target = checkTarget(root, args);
    const where = `${args.contest}/${args.subject}`;
    const values = loadPrivateValues(root, args.ballot);
    // A privacy refusal stops the command here or inside fetchPage, so it can
    // never reach logUnfetchable.
    const checkPrivate = (texts) => {
      const code = findRefusal(texts, values, URL_CLASSES);
      if (code) throw new Failure(where, code);
    };
    // Every spelling, before tiers.yaml is read, so a private URL never reaches the tier lookup.
    checkPrivate(spellings(args.url, args.given));
    const entries = loadTiers(root, args.ballot, values);

    // An Unfetchable pages rule is logged under the URL given, since that is
    // the source that could not be saved; any other failure under its hop.
    const unfetchable = (url, { code, reason }) => {
      logUnfetchable(ballotDir, url, where, reason);
      return new Failure(where, code);
    };
    const page = await fetchPage(entries, args.url, checkPrivate, { json: true });
    const wall = landedOnWall(args.url, page);
    if (wall) throw unfetchable(args.url, wall);
    if (page.refused) throw unfetchable(page.url, page.refused);
    // A campaign site is filed only under its own candidate.
    if (target.subjects.has(page.tiers.owner) && page.tiers.owner !== args.subject) {
      throw new Failure(where, "owner-not-subject");
    }
    const method = page.kind === "json" ? "api" : "html";
    const text = method === "api" ? jsonToText(page.body) : htmlToText(page.body);
    // A page that echoes a key, raw or as decoded: never saved, and never logged.
    const key = findRefusal([page.body, text], values, ["key"]);
    if (key) throw new Failure(where, key);
    if (!text) {
      throw unfetchable(page.url, { code: "no-readable-text", reason: "no readable text" });
    }
    // A paywall teaser reads as a short article (snapshot-format.md,
    // Unfetchable pages); with --keep-short the researcher may say it is the
    // article, and a no logs nothing new, since the plain fetch already did.
    const length = [...text].length;
    if (method === "html" && length < SHORT_PAGE) {
      if (!keepShort) throw unfetchable(args.url, SHORT);
      const href = recordedHref(page.url);
      if (!(await confirm(`Save ${href}, ${length} characters of text, as ${where}? [y/N] `))) {
        throw new Failure(where, "not-confirmed");
      }
    }

    const fileText = snapshotText(
      {
        source: page.tiers.source,
        url: recordedHref(page.url),
        requested_url: recordedHref(args.url),
        fetched: today(),
        method,
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
