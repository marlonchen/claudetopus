"use strict";

// The snapshot file text (snapshot-format.md) every fetch-snapshot mode writes:
// front matter from a YAML emitter, then the body.

const { load } = require("./deps");
const { Failure } = require("./output");

// A snapshot's front matter, as snapshotText writes it; group 1 is its YAML.
const FRONT_MATTER = /^---\n([\s\S]*?\n)?---\n/;

// Local date, as for `fetched:`.
const today = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// C0 and C1 controls, DEL, and the line and paragraph separators.
const hasControl = (value) =>
  [...value].some((ch) => {
    const code = ch.codePointAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
  });

const snapshotText = (fields, text) => {
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string" && (hasControl(value) || value.includes("---"))) {
      throw new Failure(key, "unsafe-value");
    }
  }
  const YAML = load("yaml");
  const yaml = YAML.stringify(fields, { lineWidth: 0 });
  return `---\n${yaml}---\n${text}\n`;
};

module.exports = { FRONT_MATTER, snapshotText, today };
