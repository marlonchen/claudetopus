"use strict";

// The privacy matcher (SKILL.md step 6.3), shared by fetch-snapshot's URL
// refusals (Rule 7) and, later, ballot-check and publish (which adds the
// printed-title class). It reports where a
// private value matched and the class of value, never the value or the text.
//
// Text is checked in three forms: raw; decoded and folded; and folded again
// with - _ / . + = : , ; ~ & read as spaces. The two folded forms are each built in four
// variants (default-ignorable code points removed or read as spaces, NFKC on
// or off), since each fold catches a spelling the others miss and can hide
// another. In every variant the ignorable fold and NFKC come first, then the
// quote, dash and case folds, whitespace collapse and the third form's
// separators, so NFKC never brings back capitals or separators after they were
// folded. Each value is normalized exactly like the form and variant it is
// matched against. Every normalized string keeps, for each UTF-16 unit, the
// offset in the original text it came from, so a match is located by line.

// The value classes a caller can ask for, in report order, with the code a
// privacy refusal prints for each (Rule 5: only the class, never the text).
const CLASSES = {
  "ballot-id": "private-ballot-id",
  address: "private-address",
  zip: "private-zip",
  label: "private-label",
  "private-string": "private-string",
  key: "private-key",
};
const ORDER = Object.keys(CLASSES);

const DIGIT = /\p{Nd}/u;
// A digit run that reads as a year matches only beside its entry's other words.
const YEAR = /^(19|20)[0-9]{2}$/;

const { WORD, pointAt, pointBefore } = require("./normalize");

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "­",
  zwsp: "​",
  zwnj: "‌",
  zwj: "‍",
  hyphen: "‐",
  dash: "‐",
  ndash: "–",
  mdash: "—",
  minus: "−",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  sol: "/",
  lowbar: "_",
  period: ".",
  plus: "+",
  num: "#",
};

// { text, from }: the text and, per UTF-16 unit, its offset in the original.
const mapped = (text) => ({ text, from: Array.from({ length: text.length }, (_, i) => i) });

// Replace each match of the global `pattern`; every unit of a replacement maps
// to the start of the text it replaced.
const rewrite = ({ text, from }, pattern, replace) => {
  let out = "";
  const outFrom = [];
  let last = 0;
  const keep = (end) => {
    out += text.slice(last, end);
    for (let i = last; i < end; i++) outFrom.push(from[i]);
  };
  for (const m of text.matchAll(pattern)) {
    keep(m.index);
    const replacement = replace(m[0]);
    out += replacement;
    for (let i = 0; i < replacement.length; i++) outFrom.push(from[m.index]);
    last = m.index + m[0].length;
  }
  keep(text.length);
  return { text: out, from: outFrom };
};

const decodeEntity = (entity) => {
  const body = entity.slice(1, -1);
  if (body[0] !== "#") return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  const code =
    body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "�";
};

// UTF-8, or latin1 when the bytes are not valid UTF-8 (`Pe%F1a`).
const decodePercent = (run) => {
  const bytes = Buffer.from(
    run
      .slice(1)
      .split("%")
      .map((hex) => parseInt(hex, 16)),
  );
  const utf8 = bytes.toString("utf8");
  return utf8.includes("\ufffd") ? bytes.toString("latin1") : utf8;
};

// HTML entities and URL encoding, repeated so a double-encoded value decodes too.
const decode = (s) => {
  for (let round = 0; round < 4; round++) {
    const next = rewrite(
      rewrite(s, /&(#[0-9]{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,8});/gi, decodeEntity),
      /(%[0-9a-f]{2})+/gi,
      decodePercent,
    );
    if (next.text === s.text) return next;
    s = next;
  }
  return s;
};

// Form 2 or 3 of decoded text `s` in one variant: { ignorable: "remove" | "space", nfkc }.
const fold = (s, form, { ignorable, nfkc }) => {
  s = rewrite(s, /\p{Default_Ignorable_Code_Point}/gu, () => (ignorable === "space" ? " " : ""));
  // One base character and its marks at a time, so each output unit maps back.
  if (nfkc) s = rewrite(s, /\P{M}\p{M}*|\p{M}+/gsu, (seg) => seg.normalize("NFKC"));
  s = rewrite(s, /[‘’‚‛′]/g, () => "'");
  s = rewrite(s, /[“”„‟″]/g, () => '"');
  s = rewrite(s, /[\p{Pd}−]/gu, () => "-");
  s = rewrite(s, /\p{Changes_When_Lowercased}/gu, (ch) => ch.toLowerCase());
  // The full case folds lowercasing leaves out: STRASSE is Straße.
  s = rewrite(s, /[ßς]/g, (ch) => (ch === "ß" ? "ss" : "σ"));
  if (form === 3) s = rewrite(s, /[-_/.+=:,;~&]/g, () => " ");
  return rewrite(s, /\s+/gu, () => " ");
};

const VARIANTS = [];
for (const form of [2, 3]) {
  for (const ignorable of ["remove", "space"]) {
    for (const nfkc of [false, true]) VARIANTS.push({ form, ignorable, nfkc });
  }
}

// A value normalized like the form it is matched against, or "" when nothing is left.
const normalizeValue = (value, variant) =>
  variant ? fold(decode(mapped(value)), variant.form, variant).text.trim() : value.trim();

// Start offsets of `needle` in `hay` that sit on boundaries `edge` allows.
const occurrences = (hay, needle, edge) => {
  const found = [];
  if (!needle) return found;
  const startsWord = edge.test(pointAt(needle, 0));
  const endsWord = edge.test(pointBefore(needle, needle.length));
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + 1)) {
    const clearBefore = !startsWord || !edge.test(pointBefore(hay, i));
    const clearAfter = !endsWord || !edge.test(pointAt(hay, i + needle.length));
    if (clearBefore && clearAfter) found.push(i);
  }
  return found;
};

// The searches one private_strings entry makes in one form: the whole entry,
// then each digit run alone (4+ digits, not a year) or beside each of the
// entry's other words.
const privateStringSearches = (entry) => {
  const searches = [{ needle: entry, edge: WORD }];
  const words = entry.split(" ").filter((w) => /[\p{L}\p{Nd}]/u.test(w));
  for (const [run] of entry.matchAll(/\p{Nd}+/gu)) {
    if (run.length >= 4 && !YEAR.test(run)) {
      searches.push({ needle: run, edge: DIGIT });
      continue;
    }
    for (const word of words.filter((w) => w !== run)) {
      searches.push(
        { needle: `${word} ${run}`, edge: WORD },
        { needle: `${run} ${word}`, edge: WORD },
      );
    }
  }
  return searches;
};

// The searches one value of `cls` makes, normalized for `variant` (null: raw).
const searchesFor = (cls, value, variant) => {
  if (cls === "zip") return [{ needle: value.trim(), edge: DIGIT }];
  const needle = normalizeValue(value, variant);
  if (cls === "private-string") return needle ? privateStringSearches(needle) : [];
  return [{ needle, edge: WORD }];
};

const lineOf = (lineStarts, offset) => {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
};

// Every { line, class } where `text` holds a value of one of `classes`, sorted
// and without repeats. `values` maps each class to its values (strings);
// ZIPs are 5-digit strings, keys are API key values.
const scan = (text, values, classes) => {
  for (const cls of classes) {
    if (!Object.hasOwn(CLASSES, cls)) throw new Error(`unknown privacy class ${cls}`);
  }
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const hits = new Set();
  const hit = (cls, offset) => hits.add(`${lineOf(lineStarts, offset)}\0${cls}`);

  const raw = mapped(text);
  const decoded = decode(raw);
  const folded = VARIANTS.map((variant) => ({ variant, s: fold(decoded, variant.form, variant) }));
  for (const cls of classes) {
    for (const value of values[cls] ?? []) {
      if (typeof value !== "string") continue;
      if (cls === "key") {
        // A key value is random text: any occurrence counts, case and boundaries kept.
        const key = value.trim();
        if (!key) continue;
        for (const s of [raw, decoded]) {
          for (let i = s.text.indexOf(key); i !== -1; i = s.text.indexOf(key, i + 1)) {
            hit(cls, s.from[i]);
          }
        }
        continue;
      }
      // A value with no letter or digit would match every separator, so it is no value.
      if (!/[\p{L}\p{N}]/u.test(value)) continue;
      for (const { variant, s } of [{ variant: null, s: raw }, ...folded]) {
        for (const { needle, edge } of searchesFor(cls, value, variant)) {
          for (const i of occurrences(s.text, needle, edge)) hit(cls, s.from[i]);
        }
      }
    }
  }
  return [...hits]
    .map((key) => {
      const [line, cls] = key.split("\0");
      return { line: Number(line), class: cls };
    })
    .sort((a, b) => a.line - b.line || ORDER.indexOf(a.class) - ORDER.indexOf(b.class));
};

// The refusal code of the first class matched, in CLASSES order, or null.
const refusalCode = (matches) => {
  const first = matches.map((m) => m.class).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))[0];
  return first ? CLASSES[first] : null;
};

// The classes a fetched URL may not hold (Rule 7, snapshot-format.md).
const URL_CLASSES = ["ballot-id", "address", "zip", "label", "private-string", "key"];

// The refusal code for the first of `classes` any of `texts` holds, or null.
const findRefusal = (texts, values, classes) =>
  refusalCode(texts.flatMap((text) => scan(text, values, classes)));

module.exports = { CLASSES, URL_CLASSES, findRefusal, refusalCode, scan };
