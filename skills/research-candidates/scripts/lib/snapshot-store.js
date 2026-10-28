"use strict";

// Write-once snapshot saves (snapshot-format.md, Manifest). A save is three
// steps, so a crash at any point leaves a state the next run repairs:
//   1. write <ballot>/.partial/<sha256> and sync it;
//   2. append "<sha256>  <path>\n" to snapshots.sha256 in one write;
//   3. link the file into sources/ with exclusive create, then drop the partial.
// Every run first finishes or discards leftover partials. Discovery agents for
// different contests run at once, and recovery deletes partials it cannot
// place, so recovery and saves hold a per-ballot lock: <ballot>/.lock/held,
// holding a random token, created whole by an exclusive link so it is never
// empty. A lock is held only for one recovery or save, so it is stale once it
// is older than any save could take. Age is the only test: a pid means nothing
// to a run in another pid namespace (a sandboxed agent). Removing a stale lock
// is serialized by a second lock, .lock/break, and checked against the very
// file judged stale (breakLock), and a run removes its own lock only while it
// still holds its token.
//
// RESEARCH_CANDIDATES_TEST_CRASH=after-partial|after-manifest|after-link kills the
// process with SIGKILL right after that step. Tests only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Failure } = require("./output");

const MANIFEST = "snapshots.sha256";
const LOCK_WAIT_MS = 60000;
// A recovery or save takes milliseconds; this leaves room for a slow disk.
const LOCK_STALE_MS = 30000;
// The break lock is held only while one stale lock is removed.
const LOCK_GRACE_MS = 5000;
const HASH_LINE = /^([0-9a-f]{64}) {2}(sources\/.+)$/;
// A manifest path recovery may write to: under sources/, no empty, . or .. segment.
const SAFE_PATH = /^sources(\/(?!\.\.?(\/|$))[^/]+)+$/;
const RETIRE_LINE = /^- {2}(sources\/.+)$/;

const crashPoint = (step) => {
  if (process.env.RESEARCH_CANDIDATES_TEST_CRASH === step) process.kill(process.pid, "SIGKILL");
};

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");

// A lock file's text and identity, or null when there is none. One open file,
// so the age, inode and text all come from the same file even when a lock is
// replaced in between and the filesystem reuses its inode number.
const readLock = (lock) => {
  let fd;
  try {
    fd = fs.openSync(lock, "r");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const { mtimeMs, ino } = fs.fstatSync(fd);
    return { text: fs.readFileSync(fd, "utf8"), mtimeMs, ino };
  } finally {
    fs.closeSync(fd);
  }
};

// Either way, so an mtime in the future (a clock stepped back, a skewed file
// server) cannot keep a dead lock alive.
const olderThan = ({ mtimeMs }, ms) => Math.abs(Date.now() - mtimeMs) > ms;

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

// Remove a stale lock; true when it is gone. Only the holder of the break lock
// may remove it, and only while it is still the file judged stale (same text
// and inode). A break lock left by a crash is itself stale after the grace period.
const breakLock = (lock, seen, token) => {
  const brk = path.join(path.dirname(lock), "break");
  if (!tryCreateLock(brk, `${process.pid} ${token}\n`, token)) {
    const held = readLock(brk);
    if (held && olderThan(held, LOCK_GRACE_MS)) fs.rmSync(brk, { force: true });
    return false;
  }
  try {
    const now = readLock(lock);
    if (now && (now.text !== seen.text || now.ino !== seen.ino)) return false;
    fs.rmSync(lock, { force: true });
    return true;
  } finally {
    fs.rmSync(brk, { force: true });
  }
};

// Temp files a crash left between writing and linking a lock. A live run's is
// only milliseconds old.
const removeLeftoverTemps = (lockDir) => {
  for (const name of fs.readdirSync(lockDir)) {
    if (!name.includes(".tmp-")) continue;
    const leftover = readLock(path.join(lockDir, name));
    if (leftover && olderThan(leftover, LOCK_GRACE_MS)) {
      fs.rmSync(path.join(lockDir, name), { force: true });
    }
  }
};

// Run `body` holding the ballot's lock, or fail with ballot-locked after `waitMs`.
const withLock = (ballotDir, body, waitMs = LOCK_WAIT_MS) => {
  const lockDir = path.join(ballotDir, ".lock");
  fs.mkdirSync(lockDir, { recursive: true });
  const lock = path.join(lockDir, "held");
  const token = crypto.randomBytes(8).toString("hex");
  // The pid is only for a person looking at the file.
  const text = `${process.pid} ${token}\n`;
  const deadline = Date.now() + waitMs;
  while (!tryCreateLock(lock, text, token)) {
    const seen = readLock(lock);
    // Gone, or stale and removed by this run: try again at once.
    if (!seen || (olderThan(seen, LOCK_STALE_MS) && breakLock(lock, seen, token))) continue;
    if (Date.now() > deadline) throw new Failure(".lock", "ballot-locked");
    sleep(50);
  }
  try {
    removeLeftoverTemps(lockDir);
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
    const partial = path.join(partialDir, name);
    const paths = livePathsFor(manifest, name).filter((p) => SAFE_PATH.test(p));
    // Never place a partial whose content is not what its manifest line names.
    if (
      paths.length &&
      fs.statSync(partial).isFile() &&
      sha256(fs.readFileSync(partial)) === name
    ) {
      for (const rel of paths) {
        const target = path.join(ballotDir, rel);
        if (fs.existsSync(target)) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.linkSync(partial, target);
      }
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
// `beforeLink(rel)`, when given, runs after the manifest line is written and
// before the file lands (the ballot.ledger line, snapshot-format.md).
const save = (ballotDir, dir, name, text, beforeLink) => {
  // A run that crashed since this one's first recovery left partials too.
  recover(ballotDir);
  const manifestFile = path.join(ballotDir, MANIFEST);
  checkLog(manifestFile, "manifest-invalid");
  const data = Buffer.from(text, "utf8");
  const hash = sha256(data);

  const partial = path.join(ballotDir, ".partial", hash);
  fs.mkdirSync(path.dirname(partial), { recursive: true });
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
  beforeLink?.(rel);

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

// Fail `code` when an append-only log's hand-written last line has no
// newline, so a line appended next would join it.
const checkLog = (file, code) => {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (text && !text.endsWith("\n")) throw new Failure(path.basename(file), code);
};

// Append one line to an append-only log in one synced write.
const appendLine = (file, line) => writeSynced(file, line, "a");

module.exports = {
  HASH_LINE,
  MANIFEST,
  RETIRE_LINE,
  SAFE_PATH,
  appendLine,
  checkLog,
  readManifest,
  recover,
  save,
  sha256,
  withLock,
};
