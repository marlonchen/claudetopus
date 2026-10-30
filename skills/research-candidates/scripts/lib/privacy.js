"use strict";

// The privacy matcher (SKILL.md step 6.3), shared by fetch-snapshot's URL
// refusals (Rule 7), ballot-check's Private text and Tiers rules and
// publish's privacy scan. It reports where a
// private value matched and the class of value, never the value or the text.
//
// Text is checked in three forms: raw; decoded and folded; and folded again
// with - _ / . + = : , ; ~ & read as spaces. The two folded forms are each built in eight
// variants (entities read as page text or as an attribute value, default-ignorable
// code points removed or read as spaces, NFKC on or off), since each fold catches
// a spelling the others miss and can hide
// another. In every variant the ignorable fold and NFKC come first, then the
// quote, dash and case folds, whitespace collapse and the third form's
// separators, so NFKC never brings back capitals or separators after they were
// folded. Each value is normalized exactly like the form and variant it is
// matched against. Every normalized string keeps, as breakpoints, the offset
// in the original text each UTF-16 unit came from, so a match is located by line.

// The value classes a caller can ask for, in report order, with the code a
// privacy refusal prints for each (Rule 5: only the class, never the text).
const CLASSES = {
  "ballot-id": "private-ballot-id",
  address: "private-address",
  zip: "private-zip",
  label: "private-label",
  "private-string": "private-string",
  title: "private-title",
  key: "private-key",
};
const ORDER = Object.keys(CLASSES);

const DIGIT = /\p{Nd}/u;
// A digit run that reads as a year matches only beside its entry's other words.
const YEAR = /^(19|20)[0-9]{2}$/;

const { load } = require("./deps");
const { WORD, occurrences } = require("./normalize");

// { text, segs }: the text and where each UTF-16 unit came from in the
// original, as breakpoints rather than one offset per unit, so a page-sized
// text costs memory in proportion to its replacements. Segment k covers
// units from out[k] up to out[k + 1]; unit i of it came from src[k] + i -
// out[k] when step[k] is 1, and from src[k] when it is 0 (a replacement).
const mapped = (text) => ({ text, segs: { out: [0], src: [0], step: [1] } });

// The offset in the original text that unit `i` of `s` came from.
const origin = ({ segs }, i) => {
  let lo = 0;
  let hi = segs.out.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (segs.out[mid] <= i) lo = mid;
    else hi = mid - 1;
  }
  return segs.src[lo] + segs.step[lo] * (i - segs.out[lo]);
};

// Replace each match of the global `pattern`; every unit of a replacement maps
// to the start of the text it replaced. A match replaced by itself is kept.
const rewrite = (s, pattern, replace) => {
  const { text, segs } = s;
  const parts = [];
  let length = 0;
  const next = { out: [], src: [], step: [] };
  // Append `piece`, whose first unit came from `src`. A one-unit piece maps the
  // same either way, so it is read as a copy and never splits a copied run.
  const append = (piece, src, step) => {
    const k = next.out.length - 1;
    const copy = step === 1 || piece.length === 1;
    const len = length - next.out[k];
    const lastCopy = k >= 0 && (next.step[k] === 1 || len === 1);
    if (!(copy && lastCopy && next.src[k] + len === src)) {
      next.out.push(length);
      next.src.push(src);
      next.step.push(copy ? 1 : 0);
    } else next.step[k] = 1;
    parts.push(piece);
    length += piece.length;
  };
  // Copy units [from, to) of `s`, a segment at a time.
  let k = 0;
  const keep = (from, to) => {
    for (let i = from; i < to; ) {
      while (k + 1 < segs.out.length && segs.out[k + 1] <= i) k++;
      const end = Math.min(to, segs.out[k + 1] ?? text.length);
      append(text.slice(i, end), segs.src[k] + segs.step[k] * (i - segs.out[k]), segs.step[k]);
      i = end;
    }
  };
  let changed = false;
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const replacement = replace(m[0]);
    if (replacement === m[0]) continue;
    changed = true;
    keep(last, m.index);
    if (replacement) append(replacement, origin(s, m.index), 0);
    last = m.index + m[0].length;
  }
  if (!changed) return s;
  keep(last, text.length);
  if (next.out.length === 0) return mapped("");
  return { text: parts.join(""), segs: next };
};

// HTML entities as browsers decode them (`entities`), numeric ones with or
// without their `;`, in each of the two ways browsers read a named one with no
// `;`: page text decodes its longest known prefix (`Pct&nbsp12`), an attribute
// value only when no letter, digit or `=` follows (`?a=1&para=2`). Each way
// can hide a value the other shows, so the text is decoded both ways.
const ENTITIES = {
  text: /&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[a-zA-Z][a-zA-Z0-9]*;?)/g,
  attribute: /&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[a-zA-Z][a-zA-Z0-9]*;|[a-zA-Z]+(?![a-zA-Z0-9=]))/g,
};
let decodeHTML;
const decodeEntity = (entity) => {
  decodeHTML ??= load("entities").decodeHTML;
  return decodeHTML(entity);
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

// HTML entities (read as `entities`: "text" or "attribute") and URL encoding,
// repeated so a double-encoded value decodes too.
const decode = (s, entities) => {
  for (let round = 0; round < 4; round++) {
    const next = rewrite(
      rewrite(s, ENTITIES[entities], decodeEntity),
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
  // NFKC leaves ASCII alone, so an ASCII letter is read only with marks after it.
  if (nfkc) {
    s = rewrite(s, /[^\0-\x7f]\p{M}*|[\0-\x7f]\p{M}+/gsu, (seg) => seg.normalize("NFKC"));
  }
  s = rewrite(s, /[‘’‚‛′]/g, () => "'");
  s = rewrite(s, /[“”„‟″]/g, () => '"');
  s = rewrite(s, /[\p{Pd}−]/gu, () => "-");
  s = rewrite(s, /\p{Changes_When_Lowercased}/gu, (ch) => ch.toLowerCase());
  // The full case folds lowercasing leaves out: STRASSE is Straße.
  s = rewrite(s, /[ßς]/g, (ch) => (ch === "ß" ? "ss" : "σ"));
  if (form === 3) s = rewrite(s, /[-_/.+=:,;~&]/g, () => " ");
  // A lone space is already collapsed.
  return rewrite(s, /\s{2,}|[^\S ]/gu, () => " ");
};

const VARIANTS = [];
for (const entities of Object.keys(ENTITIES)) {
  for (const form of [2, 3]) {
    for (const ignorable of ["remove", "space"]) {
      for (const nfkc of [false, true]) VARIANTS.push({ entities, form, ignorable, nfkc });
    }
  }
}

// A value normalized like the form it is matched against, or "" when nothing is left.
const normalizeValue = (value, variant) =>
  variant
    ? fold(decode(mapped(value), variant.entities), variant.form, variant).text.trim()
    : value.trim();

// `text` in the publish scan's third form (NFKC, ignorables removed, case
// folded, separators read as spaces), trimmed: ballot-check's private_strings
// accounting reads lines and entries this way (SKILL.md step 6.3).
const privateForm = (text) =>
  fold(mapped(text), 3, { ignorable: "remove", nfkc: true }).text.trim();

// The searches one private_strings entry makes in one form: the whole entry,
// then each digit run alone (4+ digits, not a year) or beside each of the
// entry's other words. `digits` marks a digit-run search, which publish skips
// inside its generated dates; a whole entry with no letter is one.
const privateStringSearches = (entry) => {
  const searches = [{ needle: entry, edge: WORD, digits: !/\p{L}/u.test(entry) }];
  const words = entry.split(" ").filter((w) => /[\p{L}\p{Nd}]/u.test(w));
  for (const [run] of entry.matchAll(/\p{Nd}+/gu)) {
    if (run.length >= 4 && !YEAR.test(run)) {
      searches.push({ needle: run, edge: DIGIT, digits: true });
      continue;
    }
    for (const word of words.filter((w) => w !== run)) {
      searches.push(
        { needle: `${word} ${run}`, edge: WORD, digits: true },
        { needle: `${run} ${word}`, edge: WORD, digits: true },
      );
    }
  }
  return searches;
};

// The searches one value of `cls` makes, normalized for `variant` (null: raw).
const searchesFor = (cls, value, variant) => {
  if (cls === "zip") return [{ needle: value.trim(), edge: DIGIT, digits: true }];
  const needle = normalizeValue(value, variant);
  if (cls === "private-string") return needle ? privateStringSearches(needle) : [];
  return [{ needle, edge: WORD }];
};

// SKILL.md step 6.2: a word needle as a pattern that also finds it split at a
// pdftotext line break and quoted either way (article-format.md, Matching).
// Read in form 2, after the dash fold, so every dash and minus is `-` and the
// ignorables beside it are gone: a hyphen (and a space after it) may sit
// between any two letters, the needle's own letter hyphens may be dropped,
// and a space may read as a hyphen. A hyphen beside a digit is never joined.
const LETTER = /\p{L}/u;
const LETTER_OR_MARK = /[\p{L}\p{M}]/u;
const SPLIT = "(?:- ?)?";
const hyphenPatterns = new Map();
const hyphenPattern = (needle) => {
  if (!hyphenPatterns.has(needle)) {
    const chars = [...needle];
    let source = WORD.test(chars[0]) ? `(?<!${WORD.source})` : "";
    chars.forEach((ch, k) => {
      const [before, after] = [chars[k - 1] ?? "", chars[k + 1] ?? ""];
      if (ch === " ") source += "[ -]";
      else if (ch === "-" && LETTER_OR_MARK.test(before) && LETTER.test(after)) source += SPLIT;
      else source += ch.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
      if (LETTER_OR_MARK.test(ch) && LETTER.test(after)) source += SPLIT;
    });
    if (WORD.test(chars.at(-1))) source += `(?!${WORD.source})`;
    hyphenPatterns.set(needle, new RegExp(source, "gu"));
  }
  return hyphenPatterns.get(needle);
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

// The [start, end) span of the original text that units [i, i + length) of
// `s` came from, widened to the whole of a replaced run (an entity) at its end.
const spanOf = (s, i, length, textLength) => {
  const next = i + length < s.text.length ? origin(s, i + length) : textLength;
  return [origin(s, i), Math.max(next, origin(s, i + length - 1) + 1)];
};

// `text` in each form it is scanned in: { variant: null, s } for the raw
// text, then { variant, s } for each folded variant of forms 2 and 3. `s`
// maps each unit back to the original (origin, spanOf).
const forms = (text) => {
  const raw = mapped(text);
  const decoded = { text: decode(raw, "text"), attribute: decode(raw, "attribute") };
  // Most text decodes the same both ways; its attribute variants would repeat the text ones.
  const same = decoded.text.text === decoded.attribute.text;
  const folded = VARIANTS.filter((v) => !same || v.entities === "text").map((variant) => ({
    variant,
    s: fold(decoded[variant.entities], variant.form, variant),
  }));
  return { raw, decoded, folded };
};

// The line of each offset in `text`, from 1.
const lineFinder = (text) => {
  const lineStarts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  return (offset) => lineOf(lineStarts, offset);
};

// Every { line, class } where `text` holds a value of one of `classes`, sorted
// and without repeats. `values` maps each class to its values (strings);
// ZIPs are 5-digit strings, keys are API key values. Options: `skip`, a list
// of [start, end) offsets in `text` where a digit-run or ZIP search does not
// count a match lying wholly inside one (publish's generated dates);
// `spans`, to add each match's [start, end) offsets as `spans`; `hyphens`, to
// also find a word value split at a line break (hyphenPattern, step 6.2).
const scan = (text, values, classes, { skip = [], spans = false, hyphens = false } = {}) => {
  for (const cls of classes) {
    if (!Object.hasOwn(CLASSES, cls)) throw new Error(`unknown privacy class ${cls}`);
  }
  const lineAt = lineFinder(text);
  const hits = new Map();
  const hit = (cls, s, i, length, digits) => {
    const [start, end] = spanOf(s, i, length, text.length);
    if (digits && skip.some(([from, to]) => start >= from && end <= to)) return;
    const key = `${lineAt(start)}\0${cls}`;
    if (!hits.has(key)) hits.set(key, new Map());
    hits.get(key).set(`${start} ${end}`, [start, end]);
  };

  const { raw, decoded, folded } = forms(text);
  for (const cls of classes) {
    for (const value of values[cls] ?? []) {
      if (typeof value !== "string") continue;
      if (cls === "key") {
        // A key value is random text: any occurrence counts, case and boundaries kept.
        const key = value.trim();
        if (!key) continue;
        for (const s of [raw, decoded.text, decoded.attribute]) {
          for (let i = s.text.indexOf(key); i !== -1; i = s.text.indexOf(key, i + 1)) {
            hit(cls, s, i, key.length, false);
          }
        }
        continue;
      }
      // A value with no letter or digit would match every separator, so it is no value.
      if (!/[\p{L}\p{N}]/u.test(value)) continue;
      for (const { variant, s } of [{ variant: null, s: raw }, ...folded]) {
        const split = hyphens && variant?.form === 2;
        for (const { needle, edge, digits } of searchesFor(cls, value, variant)) {
          if (split && edge === WORD && needle) {
            for (const m of s.text.matchAll(hyphenPattern(needle))) {
              hit(cls, s, m.index, m[0].length, digits);
            }
          } else {
            for (const i of occurrences(s.text, needle, edge))
              hit(cls, s, i, needle.length, digits);
          }
        }
      }
    }
  }
  return [...hits]
    .map(([key, found]) => {
      const [line, cls] = key.split("\0");
      const match = { line: Number(line), class: cls };
      if (spans) match.spans = [...found.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return match;
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

// Every decimal digit run in `text`, in any script, as ASCII digits ("١٢" is
// "12"): Unicode places each script's digits 0-9 in order, in runs of whole tens.
const digitRuns = (text) =>
  [...text.matchAll(/\p{Nd}+/gu)].map(([run]) =>
    [...run]
      .map((ch) => {
        let start = ch.codePointAt(0);
        while (DIGIT.test(String.fromCodePoint(start - 1))) start--;
        return String((ch.codePointAt(0) - start) % 10);
      })
      .join(""),
  );

// True when `value` keeps no letter or digit once normalized for some variant,
// so the scan would skip it there (ballot-check refuses such an entry).
const isEmptyValue = (value) =>
  [null, ...VARIANTS].some((variant) => !/[\p{L}\p{N}]/u.test(normalizeValue(value, variant)));

module.exports = {
  CLASSES,
  URL_CLASSES,
  YEAR,
  digitRuns,
  findRefusal,
  forms,
  isEmptyValue,
  lineFinder,
  normalizeValue,
  privateForm,
  refusalCode,
  scan,
  spanOf,
};
