"use strict";

// <ballot>/archives.tsv (snapshot-format.md, Saved copies): one line per
// Wayback capture, the snapshot path, a tab and its 14-digit capture time.
// fetch-snapshot --archive appends to it; publish reads it for a receipt's
// archive link.

const fs = require("node:fs");
const path = require("node:path");
const { Failure } = require("./output");
const { isSnapshotPath } = require("./snapshot-hash");

const ARCHIVES = "archives.tsv";

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

module.exports = { ARCHIVES, readArchives };
