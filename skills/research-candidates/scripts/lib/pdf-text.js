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

// The text of the PDF at `file`; failures are located at `where`.
const pdfFileText = (file, where) => {
  const result = spawnSync("pdftotext", ["-enc", "UTF-8", "-q", file, "-"], {
    maxBuffer: MAX_TEXT,
    encoding: "utf8",
  });
  if (result.error?.code === "ENOENT") throw new Failure(where, "pdftotext-missing");
  if (result.error || result.status !== 0) throw new Failure(where, "pdf-unreadable");
  // Form feeds end pages; a page break reads as a line break.
  const text = result.stdout.replace(/\r\n?/g, "\n").replace(/\f/g, "\n").trimEnd();
  if (!text.trim()) throw new Failure(where, "pdf-no-text");
  return text;
};

// The text of a fetched PDF's bytes, through a private temp file that is
// always removed.
const pdfText = (bytes, where) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-pdf-"));
  try {
    const file = path.join(dir, "in.pdf");
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    return pdfFileText(file, where);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

module.exports = { pdfFileText, pdfText };
