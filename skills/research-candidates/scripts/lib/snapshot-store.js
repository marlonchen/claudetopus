"use strict";

// Write-once snapshot saves (snapshot-format.md, Manifest). A save is three
// steps, so a crash at any point leaves a state the next run repairs:
//   1. write <ballot>/.partial/<sha256> and sync it;
//   2. append "<sha256>  <path>\n" to snapshots.sha256 in one write;
//   3. link the file into sources/ with exclusive create, then drop the partial.
// Every run first finishes or discards leftover partials. Discovery agents for
// different contests run at once, and recovery deletes partials it cannot
// place, so recovery and saves hold a per-ballot lock: .partial/.lock, holding
// the owner's pid and a random token, created whole by an exclusive link so it
// is never empty. A lock is stale when its process is gone, when it is older
// than any save could take (a reused pid), or when it is unreadable and not
// brand new. A stale lock is taken over by renaming it aside first, so only one
// waiter can take it, and a run removes the lock only while it holds its token.
//
// RESEARCH_CANDIDATES_TEST_CRASH=after-partial|after-manifest|after-link kills the
// process with SIGKILL right after that step. Tests only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Failure } = require("./output");

const MANIFEST = "snapshots.sha256";
const LOCK_WAIT_MS = 60000;
// A lock is held only for one recovery or save, which takes milliseconds.
const LOCK_STALE_MS = 10 * 60 * 1000;
const LOCK_GRACE_MS = 5000;
const HASH_LINE = /^([0-9a-f]{64}) {2}(sources\/.+)$/;
// A manifest path recovery may write to: under sources/, no empty, . or .. segment.
const SAFE_PATH = /^sources(\/(?!\.\.?(\/|$))[^/]+)+$/;
const RETIRE_LINE = /^- {2}(sources\/.+)$/;

const crashPoint = (step) => {
  if (process.env.RESEARCH_CANDIDATES_TEST_CRASH === step) process.kill(process.pid, "SIGKILL");
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

// The lock's text, or null when there is no lock.
const readLock = (lock) => {
  try {
    return { text: fs.readFileSync(lock, "utf8"), mtimeMs: fs.statSync(lock).mtimeMs };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
};

const isStale = ({ text, mtimeMs }) => {
  const age = Date.now() - mtimeMs;
  const pid = Number.parseInt(text, 10);
  if (!Number.isInteger(pid) || pid <= 0) return age > LOCK_GRACE_MS;
  return !alive(pid) || age > LOCK_STALE_MS;
};

// Create the lock whole: write a temp file, then link it into place exclusively.
const tryCreateLock = (lock, text, token) => {
  const tmp = `${lock}.tmp-${token}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.linkSync(tmp, lock);
    return true;
  } catch (error) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
};

// Move a stale lock aside. Only one waiter's rename can take it; if what it took
// is not the lock it judged stale, a new owner got there first, so put it back.
const takeOver = (lock, seen, token) => {
  const aside = `${lock}.stale-${token}`;
  try {
    fs.renameSync(lock, aside);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (fs.readFileSync(aside, "utf8") !== seen.text) {
    try {
      fs.linkSync(aside, lock);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  fs.rmSync(aside, { force: true });
};

// Run `body` holding the ballot's lock.
const withLock = (ballotDir, body) => {
  const partialDir = path.join(ballotDir, ".partial");
  fs.mkdirSync(partialDir, { recursive: true });
  const lock = path.join(partialDir, ".lock");
  const token = crypto.randomBytes(8).toString("hex");
  const text = `${process.pid} ${token}\n`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!tryCreateLock(lock, text, token)) {
    const seen = readLock(lock);
    if (seen && isStale(seen)) {
      takeOver(lock, seen, token);
      continue;
    }
    if (Date.now() > deadline) throw new Failure(".partial/.lock", "ballot-locked");
    sleep(50);
  }
  try {
    return body();
  } finally {
    if (readLock(lock)?.text === text) fs.rmSync(lock, { force: true });
  }
};

// Manifest lines as { hash, path } (hash null for a retire line); lines in
// neither form are skipped here, since check reports them.
const readManifest = (ballotDir) => {
  let text;
  try {
    text = fs.readFileSync(path.join(ballotDir, MANIFEST), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const lines = [];
  for (const line of text.split("\n")) {
    const hashed = HASH_LINE.exec(line);
    if (hashed) lines.push({ hash: hashed[1], path: hashed[2] });
    const retired = RETIRE_LINE.exec(line);
    if (retired) lines.push({ hash: null, path: retired[1] });
  }
  return lines;
};

// Paths whose latest manifest line is this hash: listed and not retired after.
const livePathsFor = (manifest, hash) => {
  const latest = new Map();
  for (const line of manifest) latest.set(line.path, line.hash);
  return [...latest].filter(([, h]) => h === hash).map(([p]) => p);
};

// Finish or discard every leftover partial. Call holding the lock.
const recover = (ballotDir) => {
  const partialDir = path.join(ballotDir, ".partial");
  if (!fs.existsSync(partialDir)) return;
  const manifest = readManifest(ballotDir);
  for (const name of fs.readdirSync(partialDir)) {
    if (name.startsWith(".lock")) continue;
    const partial = path.join(partialDir, name);
    for (const rel of livePathsFor(manifest, name).filter((p) => SAFE_PATH.test(p))) {
      const target = path.join(ballotDir, rel);
      if (fs.existsSync(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.linkSync(partial, target);
    }
    fs.rmSync(partial, { recursive: true, force: true });
  }
};

const writeSynced = (file, data, flag) => {
  const fd = fs.openSync(file, flag);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

// Save `text` as sources/<dir>/<name>.md, or the next free numeric suffix.
// Returns the path relative to the ballot directory. Call holding the lock.
const save = (ballotDir, dir, name, text) => {
  // A run that crashed since this one's first recovery left partials too.
  recover(ballotDir);
  // A hand-written last line with no newline would swallow the line appended next.
  const manifestFile = path.join(ballotDir, MANIFEST);
  const manifestText = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, "utf8") : "";
  if (manifestText && !manifestText.endsWith("\n")) throw new Failure(MANIFEST, "manifest-invalid");
  const data = Buffer.from(text, "utf8");
  const hash = crypto.createHash("sha256").update(data).digest("hex");

  const partial = path.join(ballotDir, ".partial", hash);
  writeSynced(partial, data, "wx");
  crashPoint("after-partial");

  // A name is free when no file holds it and the manifest never listed it, so
  // a retired path is never reused.
  const listed = new Set(readManifest(ballotDir).map((line) => line.path));
  let rel;
  for (let n = 1; ; n++) {
    rel = `sources/${dir}/${n === 1 ? name : `${name}-${n}`}.md`;
    if (!listed.has(rel) && !fs.existsSync(path.join(ballotDir, rel))) break;
  }

  writeSynced(manifestFile, `${hash}  ${rel}\n`, "a");
  crashPoint("after-manifest");

  // Only a writer that skips the lock can take the path now. The manifest line
  // is already written and is never changed, so report it rather than retry;
  // check then reports the line as snapshot-hash.
  const target = path.join(ballotDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.linkSync(partial, target);
  } catch (error) {
    if (error.code === "EEXIST") throw new Failure(rel, "snapshot-exists");
    throw error;
  }
  crashPoint("after-link");
  fs.rmSync(partial);
  return rel;
};

module.exports = { recover, save, withLock };
