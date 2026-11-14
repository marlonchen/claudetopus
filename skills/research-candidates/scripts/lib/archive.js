"use strict";

// fetch-snapshot --archive <election>/<ballot-id>
//
// The Wayback batch (snapshot-format.md, Saved copies): ask the Wayback
// Machine to capture each eligible snapshot's own `url`, and append the
// snapshot path and the 14-digit capture time to <ballot>/archives.tsv, which
// publish reads for a receipt's archive link. A snapshot is eligible when it
// is not under sources/_ballot/ (every --ballot and --ballot --file save is),
// its subject is not _ballot, its method is html or pdf, never api, its `url`
// has no query string and it has no `public_url`. A path archives.tsv already
// lists is skipped, so a rerun resumes where the last one stopped.
//
// Each URL is matched against every ballot's private values, as a fetch URL
// is and as the page is (other ballots' ids too, since a capture is public),
// before it is sent; a match is never sent and prints only its class code.
// The URL is all that leaves: no front matter, body, path or ballot id.
// Output is `location code` lines located by snapshot path (Rule 5), never a
// URL. A Wayback outage, throttling included, stops the batch and fails soft:
// nothing is written for it, the receipt simply has no archive link, and a
// later run picks up from there.

const fs = require("node:fs");
const path = require("node:path");
const { familyPrivateValues } = require("./data-files");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { isHttp, send, spellings, testTarget } = require("./fetch-page");
const { Failure, Failures, runCommand } = require("./output");
const { URL_CLASSES, findRefusal } = require("./privacy");
const { FRONT_MATTER } = require("./snapshot-file");
const { isSnapshotPath, verifyManifest, walk } = require("./snapshot-hash");
const { appendLine, checkLog, withLock } = require("./snapshot-store");

const ARCHIVES = "archives.tsv";
const WAYBACK = "https://web.archive.org";
// Save Page Now can take a minute on a slow page.
const TIMEOUT_MS = 120000;
// Anonymous Save Page Now allows a few captures a minute; the local test
// server has no limit.
const GAP_MS = 15000;

// archives.tsv as a Map from snapshot path to its 14-digit Wayback capture
// time; a later line for a path wins. Any other line, or a last line with no
// newline, fails archives-invalid.
const ARCHIVE_LINE = /^(sources\/[^\t]+)\t([0-9]{14})$/;
const readArchives = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, ARCHIVES), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return new Map();
    throw error;
  }
  const lines = text.split("\n");
  const unended = lines.pop();
  if (unended !== "") throw new Failure(`${ARCHIVES}:${lines.length + 1}`, "archives-invalid");
  const archives = new Map();
  for (const [i, line] of lines.entries()) {
    const m = ARCHIVE_LINE.exec(line);
    if (!m || !isSnapshotPath(m[1])) throw new Failure(`${ARCHIVES}:${i + 1}`, "archives-invalid");
    archives.set(m[1], m[2]);
  }
  return archives;
};

// The URL to capture for the snapshot at `rel`, or null when it is not
// eligible. It is the page link publish rebuilds: scheme, host and path.
const archiveUrl = (ballotDir, rel, YAML) => {
  if (rel.startsWith("sources/_ballot/")) return null;
  const front = FRONT_MATTER.exec(fs.readFileSync(path.join(ballotDir, rel), "utf8"));
  let fields;
  try {
    fields = (front && YAML.parse(front[1] ?? "")) || {};
  } catch {
    return null;
  }
  if (fields.subject === "_ballot" || fields.public_url !== undefined) return null;
  if (fields.method !== "html" && fields.method !== "pdf") return null;
  if (typeof fields.url !== "string") return null;
  let url;
  try {
    url = new URL(fields.url);
  } catch {
    return null;
  }
  if (!isHttp(url) || url.username || url.password || url.search || url.hash) return null;
  return { given: fields.url, url: new URL(`${url.protocol}//${url.host}${url.pathname}`) };
};

// The 14-digit capture time a Save Page Now answer names, from the
// /web/<timestamp>/ URL it redirects to or gives as its Content-Location.
const CAPTURE = /^(?:https?:\/\/web\.archive\.org)?\/web\/([0-9]{14})\//;
const captureTime = (response) => {
  for (const header of ["location", "content-location"]) {
    const m = CAPTURE.exec(response.headers.get(header) ?? "");
    if (m) return m[1];
  }
  return null;
};

// Ask for one capture: its time, "unavailable" for an outage (no answer, a
// timeout, throttling or a server error), or "no-capture" for any other
// answer.
const capture = async (url) => {
  let response;
  try {
    response = await send(new URL(`/save/${url.href}`, WAYBACK), {
      redirect: "manual",
      headers: { "user-agent": "research-candidates fetch-snapshot" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await response.body?.cancel();
  } catch {
    return "unavailable";
  }
  if (response.status === 429 || response.status >= 500) return "unavailable";
  return captureTime(response) ?? "no-capture";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = (argv) =>
  runCommand(async () => {
    if (argv.length !== 1 || argv[0].startsWith("--")) throw new Failure("-", "usage");
    const [ballot] = argv;
    parseBallot(ballot);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    // Only snapshots fetch-snapshot wrote, unchanged since, are ever sent.
    const tampered = verifyManifest(ballotDir);
    if (tampered.length) throw new Failures(tampered.map((failure) => failure.line));
    const archived = readArchives(ballotDir);
    const values = familyPrivateValues(root, ballot);
    const YAML = load("yaml");

    const lines = [];
    let refused = false;
    let sent = false;
    for (const { rel } of walk(ballotDir)) {
      if (archived.has(rel)) continue;
      const target = archiveUrl(ballotDir, rel, YAML);
      if (!target) continue;
      const code = findRefusal(
        [...spellings(target.url, target.given), target.url.href],
        values,
        URL_CLASSES,
      );
      if (code) {
        lines.push(`${rel} ${code}`);
        refused = true;
        continue;
      }
      if (sent && !testTarget()) await sleep(GAP_MS);
      sent = true;
      const answer = await capture(target.url);
      if (answer === "unavailable") {
        lines.push(`${rel} wayback-unavailable`, "- rerun-later");
        break;
      }
      if (answer === "no-capture") {
        lines.push(`${rel} wayback-no-capture`);
        continue;
      }
      withLock(ballotDir, () => {
        checkLog(path.join(ballotDir, ARCHIVES), "archives-invalid");
        appendLine(path.join(ballotDir, ARCHIVES), `${rel}\t${answer}\n`);
      });
      lines.push(`${rel} archived`);
    }
    if (refused) throw new Failures(lines);
    return lines.length ? lines : [`${ARCHIVES} up-to-date`];
  });

module.exports = { main, readArchives };
