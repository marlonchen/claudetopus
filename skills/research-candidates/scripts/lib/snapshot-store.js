"use strict";

// Write-once snapshot saves (snapshot-format.md, Manifest). A save is three
// steps, so a crash at any point leaves a state the next run repairs:
//   1. write <ballot>/.partial/<sha256> and sync it;
//   2. append "<sha256>  <path>\n" to snapshots.sha256 in one write;
//   3. link the file into sources/ with exclusive create, then drop the partial.
// Every run first finishes or discards leftover partials. Discovery agents for
// different contests run at once, and recovery deletes partials it cannot
// place, so recovery and saves hold a per-ballot lock (.partial/.lock, holding
// the owner's pid; a lock whose process is gone is stale and taken over).
//
// RESEARCH_CANDIDATES_TEST_CRASH=after-partial|after-manifest kills the
// process with SIGKILL right after that step. Tests only.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Failure } = require("./output");

const MANIFEST = "snapshots.sha256";
const LOCK_WAIT_MS = 60000;
const HASH_LINE = /^([0-9a-f]{64}) {2}(sources\/.+)$/;
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

// Run `body` holding the ballot's lock.
const withLock = (ballotDir, body) => {
  const partialDir = path.join(ballotDir, ".partial");
  fs.mkdirSync(partialDir, { recursive: true });
  const lock = path.join(partialDir, ".lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const pid = Number.parseInt(fs.readFileSync(lock, { encoding: "utf8", flag: "a+" }), 10);
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      fs.rmSync(lock, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Failure(".partial/.lock", "ballot-locked");
    sleep(50);
  }
  try {
    return body();
  } finally {
    fs.rmSync(lock, { force: true });
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
    if (name === ".lock") continue;
    const partial = path.join(partialDir, name);
    for (const rel of livePathsFor(manifest, name)) {
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

  writeSynced(path.join(ballotDir, MANIFEST), `${hash}  ${rel}\n`, "a");
  crashPoint("after-manifest");

  const target = path.join(ballotDir, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.linkSync(partial, target);
  fs.rmSync(partial);
  return rel;
};

module.exports = { recover, save, withLock };
