"use strict";

// PDF to text (snapshot-format.md, Body) through poppler's `pdftotext`, found
// on PATH. `_ballot` PDFs use plain `pdftotext`, never `-layout`, so wrapped
// titles stay in reading order. A PDF with no text layer (a scan) fails
// instead of saving an empty snapshot.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Failure } = require("./output");

const MAX_TEXT = 64 * 1024 * 1024;
// A ballot or pamphlet converts in seconds; a PDF that takes longer is broken.
const TIMEOUT_MS = 60000;
const TEMP_PREFIX = "rc-pdf-";
// Older than any conversion could take, so a live run's directory is never removed.
const TEMP_STALE_MS = 60 * 60 * 1000;

// Temp directories a killed run left behind: each holds a ballot PDF.
const removeStaleTemps = () => {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    if (!name.startsWith(TEMP_PREFIX)) continue;
    const dir = path.join(tmp, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > TEMP_STALE_MS) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // Another user's, or already gone.
    }
  }
};

// The text of a PDF's bytes, through a private temp file that is always
// removed; failures are located at `where`.
const pdfText = (bytes, where) => {
  removeStaleTemps();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  let result;
  try {
    const file = path.join(dir, "in.pdf");
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    result = spawnSync("pdftotext", ["-enc", "UTF-8", "-q", file, "-"], {
      maxBuffer: MAX_TEXT,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (result.error?.code === "ENOENT") throw new Failure(where, "pdftotext-missing");
  // A timeout kills pdftotext and sets error (ETIMEDOUT).
  if (result.error || result.status !== 0) throw new Failure(where, "pdf-unreadable");
  // Form feeds end pages; a page break reads as a line break.
  const text = result.stdout.replace(/\r\n?/g, "\n").replace(/\f/g, "\n").trimEnd();
  if (!text.trim()) throw new Failure(where, "pdf-no-text");
  return text;
};

module.exports = { pdfText };
