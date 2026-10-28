"use strict";

// The manifest check `check` and `publish` share (snapshot-format.md,
// Manifest): every file under sources/ matches its line in snapshots.sha256,
// and the manifest itself is well formed. Every failure is `snapshot-hash`,
// located by the snapshot's path or by manifest line. A path with a part
// fetch-snapshot could not have named is located by the parts before it and
// `-`, since a planted file can be named after private text; so is a manifest
// path, by its line instead.

const fs = require("node:fs");
const path = require("node:path");
const { ID_PATTERN, LEFTOVER } = require("./constants");
const { Failure } = require("./output");
const { HASH_LINE, MANIFEST, RETIRE_LINE, SAFE_PATH, sha256 } = require("./snapshot-store");

// Whether part `k` of a sources/ path is one fetch-snapshot could name:
// sources/_ballot/<id>.md or sources/<contest>/<subject or _race>/<id>.md.
// `isDir` is true for a directory, false for a file, undefined for either.
const namedPart = (parts, k, isDir) => {
  const part = parts[k];
  const ballot = parts[1] === "_ballot";
  const fileAt = ballot ? 2 : 3;
  if (k === fileAt)
    return isDir !== true && part.endsWith(".md") && ID_PATTERN.test(part.slice(0, -3));
  if (k > fileAt || isDir === false) return false;
  if (k === 1) return part === "_ballot" || ID_PATTERN.test(part);
  return part === "_race" || ID_PATTERN.test(part);
};

// The number of leading parts of `parts` (parts[0] is "sources") that
// fetch-snapshot could have named; the last is `isDir`.
const namedUpTo = (parts, isDir) => {
  for (let k = 1; k < parts.length; k++) {
    if (!namedPart(parts, k, k === parts.length - 1 ? isDir : true)) return k;
  }
  return parts.length;
};

// The path itself when every part could be named, else its named parts and `-`.
const locate = (rel, isDir) => {
  const parts = rel.split("/");
  const k = namedUpTo(parts, isDir);
  return k === parts.length ? rel : [...parts.slice(0, k), "-"].join("/");
};

// A sources/ snapshot path a claim may cite: every part named, ending in a file.
const isSnapshotPath = (rel) => {
  const parts = rel.split("/");
  return parts[0] === "sources" && parts.length > 2 && namedUpTo(parts, false) === parts.length;
};

// Every entry under sources/, as { rel, kind: "file" | "symlink" | "other" },
// leftovers skipped, sorted by path.
const walk = (ballotDir) => {
  const found = [];
  const visit = (rel) => {
    for (const entry of fs.readdirSync(path.join(ballotDir, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) found.push({ rel: child, kind: "symlink" });
      else if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) {
        if (!LEFTOVER.test(entry.name)) found.push({ rel: child, kind: "file" });
      } else found.push({ rel: child, kind: "other" });
    }
  };
  const top = fs.lstatSync(path.join(ballotDir, "sources"), { throwIfNoEntry: false });
  if (top?.isSymbolicLink()) found.push({ rel: "sources", kind: "symlink" });
  else if (top?.isDirectory()) visit("sources");
  else if (top) found.push({ rel: "sources", kind: "other" });
  return found.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
};

// Failures for the manifest and every file under sources/, in order:
// manifest lines, then files on disk, then listed files that are gone.
const verifyManifest = (ballotDir) => {
  const failures = [];
  const fail = (location) => failures.push(new Failure(location, "snapshot-hash"));
  const byLine = (n) => `${MANIFEST}:${n}`;

  let text = "";
  try {
    text = fs.readFileSync(path.join(ballotDir, MANIFEST), "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const lines = text.split("\n");
  // A last line with no newline is malformed: the next append would join it.
  const unended = lines.pop();
  // path -> { hash, line, retired }
  const listed = new Map();
  for (const [i, line] of lines.entries()) {
    const n = i + 1;
    const hashed = HASH_LINE.exec(line);
    const retired = RETIRE_LINE.exec(line);
    const rel = hashed?.[2] ?? retired?.[1];
    if (!rel || !SAFE_PATH.test(rel)) {
      fail(byLine(n));
      continue;
    }
    const entry = listed.get(rel);
    if (hashed) {
      if (entry) fail(byLine(n));
      else listed.set(rel, { hash: hashed[1], line: n, retired: false });
    } else if (!entry || entry.retired) {
      fail(byLine(n));
    } else {
      entry.retired = true;
    }
  }
  if (unended !== "") fail(byLine(lines.length + 1));

  const onDisk = new Set();
  for (const { rel, kind } of walk(ballotDir)) {
    onDisk.add(rel);
    if (kind !== "file") {
      fail(locate(rel, kind === "symlink" ? undefined : false));
      continue;
    }
    const entry = listed.get(rel);
    if (
      !entry ||
      entry.retired ||
      entry.hash !== sha256(fs.readFileSync(path.join(ballotDir, rel)))
    ) {
      fail(locate(rel, false));
    }
  }
  for (const [rel, entry] of listed) {
    if (entry.retired || onDisk.has(rel)) continue;
    fail(isSnapshotPath(rel) ? rel : byLine(entry.line));
  }
  return failures;
};

module.exports = { isSnapshotPath, verifyManifest };
