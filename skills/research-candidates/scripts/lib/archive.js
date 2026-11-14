"use strict";

// fetch-snapshot --archive <election>/<ballot-id>
//
// The Wayback batch (snapshot-format.md, Saved copies): ask the Wayback
// Machine to capture the own `url` of each eligible snapshot the page cites,
// and append the snapshot path and the 14-digit capture time to
// <ballot>/archives.tsv, which publish reads for a receipt's archive link.
// The page cites the snapshots the claims of the contests publish shows cite:
// ready, and not dropped by its step 6.2 scan (page-contests.js); no other
// snapshot is ever sent. One is eligible when it is not under sources/_ballot/
// (every --ballot and --ballot --file save is), its subject is not _ballot,
// its method is html or pdf, never api, its `url` has no query string and it
// has no `public_url`. A path archives.tsv already lists is skipped, so a
// rerun resumes where the last one stopped.
//
// Each URL is read from bytes that still match the snapshot's manifest line
// as it stood when the batch began, and is matched against the values the
// page is scanned with (every ballot's ids and private strings, key values,
// and the printed titles a display_title hides) before it is sent; a match is
// never sent and prints only its class code. The URL is all that leaves: no
// front matter, body, path or ballot id. Output is `location code` lines
// located by snapshot path (Rule 5), never a URL. Each capture is asked for
// under the ballot lock, with archives.tsv read again there, so two runs at
// once never send the same snapshot twice. A Wayback outage (throttling, no
// answer, or SERVER_ERRORS server errors in a row) stops the batch and fails
// soft: nothing is written for it, the receipt simply has no archive link,
// and a later run picks up from there.

const fs = require("node:fs");
const path = require("node:path");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { isHttp, send, spellings, testTarget } = require("./fetch-page");
const { Failure, Failures, runCommand } = require("./output");
const { citedSnapshots, pageContests } = require("./page-contests");
const { URL_CLASSES, findRefusal } = require("./privacy");
const { FRONT_MATTER } = require("./snapshot-file");
const { isSnapshotPath, verifyManifest } = require("./snapshot-hash");
const {
  appendLine,
  checkLog,
  readManifest,
  sha256,
  withLock,
  withLockAsync,
} = require("./snapshot-store");

const ARCHIVES = "archives.tsv";
const WAYBACK = "https://web.archive.org";
// Save Page Now can take a minute on a slow page.
const TIMEOUT_MS = 120000;
// The Save Page Now (SPN2) API document allows anonymous callers 3 captures a
// minute; one every 21 seconds stays under that with room to spare. The local
// test server has no limit.
const GAP_MS = 21000;
// This many server errors in a row is an outage; fewer is that page's own failure.
const SERVER_ERRORS = 3;
const STAMP = /^[0-9]{14}$/;
// The classes the page scan matches (page-scan.js): a fetch URL's, and the
// printed titles a display_title hides.
const PAGE_CLASSES = [...URL_CLASSES, "title"];

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

// Each listed snapshot's hash in snapshots.sha256, retired ones left out.
const manifestHashes = (ballotDir) => {
  const hashes = new Map();
  for (const line of readManifest(ballotDir)) {
    if (line.hash) hashes.set(line.path, line.hash);
    else hashes.delete(line.path);
  }
  return hashes;
};

// The URL to capture for the snapshot at `rel`, as { given, url }, read from
// the bytes on disk, which must still hash to `hash`; { code: "snapshot-hash" }
// when they do not; or null when it is not eligible. It is the page link
// publish rebuilds: scheme, host and path.
const archiveUrl = (ballotDir, rel, hash, YAML) => {
  if (rel.startsWith("sources/_ballot/")) return null;
  let bytes;
  try {
    bytes = fs.readFileSync(path.join(ballotDir, rel));
  } catch (error) {
    if (error.code === "ENOENT") return { code: "snapshot-hash" };
    throw error;
  }
  if (sha256(bytes) !== hash) return { code: "snapshot-hash" };
  const front = FRONT_MATTER.exec(bytes.toString("utf8"));
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

// Whether a 14-digit Wayback timestamp is a real UTC time no later than now.
const isPastStamp = (stamp) => {
  const [, y, mo, d, h, mi, s] = /^(.{4})(..)(..)(..)(..)(..)$/.exec(stamp);
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso && time <= Date.now();
};

// The 14-digit capture time a Save Page Now answer names, from the
// /web/<timestamp>/<url> URL it redirects to or gives as its
// Content-Location, only when that <url> is the one sent and the timestamp
// is a real time, not in the future.
const CAPTURE = /^(?:https?:\/\/web\.archive\.org)?\/web\/([0-9]{14})\/(.*)$/s;
const captureTime = (response, url) => {
  for (const header of ["location", "content-location"]) {
    const m = CAPTURE.exec(response.headers.get(header) ?? "");
    if (m && m[2] === url.href && isPastStamp(m[1])) return m[1];
  }
  return null;
};

// Ask for one capture: its time; "unavailable" for no answer (a timeout
// included) or throttling; "server-error" for a server error; or
// "no-capture" for any other answer.
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
  if (response.status === 429) return "unavailable";
  if (response.status >= 500) return "server-error";
  return captureTime(response, url) ?? "no-capture";
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = (argv) =>
  runCommand(async () => {
    if (argv.length !== 1 || argv[0].startsWith("--")) throw new Failure("-", "usage");
    const [ballot] = argv;
    parseBallot(ballot);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    const YAML = load("yaml");
    // Under the ballot lock, so a save written now is never half seen.
    const { cited, hashes, values } = withLock(ballotDir, (refresh) => {
      // Only snapshots fetch-snapshot wrote, unchanged since, are ever sent.
      const tampered = verifyManifest(ballotDir);
      if (tampered.length) throw new Failures(tampered.map((failure) => failure.line));
      readArchives(ballotDir);
      // Only what the page cites, judged as publish judges it, and scanned
      // with the values its page scan uses.
      const shown = pageContests(root, ballot, ballotDir, refresh);
      return {
        cited: citedSnapshots(shown.shown),
        hashes: manifestHashes(ballotDir),
        values: shown.values,
      };
    });

    // The snapshot at `rel`: { given, url } to send, { code } to refuse, or
    // null to skip.
    const prepare = (rel) => {
      const target = archiveUrl(ballotDir, rel, hashes.get(rel), YAML);
      if (!target || target.code) return target;
      const code = findRefusal(
        [...spellings(target.url, target.given), target.url.href],
        values,
        PAGE_CLASSES,
      );
      return code ? { code } : target;
    };

    const lines = [];
    let refused = false;
    let sent = false;
    let serverErrors = 0;
    try {
      for (const rel of cited) {
        // A path fetch-snapshot could not have named is never printed or sent (ADR 0006).
        if (!isSnapshotPath(rel)) continue;
        // Wait only before a request; the check under the lock decides.
        if (sent && !testTarget() && !readArchives(ballotDir).has(rel) && prepare(rel)?.url)
          await sleep(GAP_MS);
        const answer = await withLockAsync(ballotDir, async (refresh) => {
          // Read again here: another run may have captured it meanwhile.
          if (readArchives(ballotDir).has(rel)) return null;
          const target = prepare(rel);
          if (!target || target.code) return target?.code ?? null;
          sent = true;
          const time = await capture(target.url);
          if (!STAMP.test(time)) return time;
          refresh();
          checkLog(path.join(ballotDir, ARCHIVES), "archives-invalid");
          appendLine(path.join(ballotDir, ARCHIVES), `${rel}\t${time}\n`);
          return "archived";
        });
        if (answer === null) continue;
        if (answer === "server-error") {
          serverErrors += 1;
          if (serverErrors < SERVER_ERRORS) {
            lines.push(`${rel} wayback-no-capture`);
            continue;
          }
        }
        if (answer === "unavailable" || answer === "server-error") {
          lines.push(`${rel} wayback-unavailable`, "- rerun-later");
          break;
        }
        if (answer === "archived" || answer === "no-capture") {
          serverErrors = 0;
          lines.push(`${rel} ${answer === "archived" ? "archived" : "wayback-no-capture"}`);
          continue;
        }
        // A privacy class, or snapshot-hash: never sent.
        lines.push(`${rel} ${answer}`);
        refused = true;
      }
    } catch (error) {
      if (error instanceof Failure) throw new Failures([...lines, error.line]);
      throw error;
    }
    if (refused) throw new Failures(lines);
    return lines.length ? lines : [`${ARCHIVES} up-to-date`];
  });

module.exports = { main, readArchives };
