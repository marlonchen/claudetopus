"use strict";

// publish's privacy scan (SKILL.md steps 6.2-6.3). Before the render, each
// ready contest's claims, excerpts and cited source names are scanned whole,
// so a match the page would split is still found; a match drops the contest.
// Then the rendered page is scanned in its three forms, and any match refuses
// the whole page. Matching is the privacy matcher's (privacy.js); reports
// hold locations, keys and codes only (Rule 5).

const { KEY_PARAM } = require("./fetch-page");
const { esc, generatedDates } = require("./page");
const { CLASSES, forms, lineFinder, normalizeValue, scan, spanOf } = require("./privacy");

// The value classes the scan matches (SKILL.md step 6.3).
const VALUE_CLASSES = Object.keys(CLASSES);

// The codes of what the page's markup may not hold, after the value classes'
// codes in report order: a script, an external src or href that is not a
// receipt link, and a key parameter (reported as a key, like a key value).
const MARKUP = { script: "page-script", link: "page-link", "key-param": CLASSES.key };
const ORDER = [...Object.values(CLASSES), MARKUP.script, MARKUP.link];

const SCRIPT = /<script/gi;
const ATTRIBUTE = /(?<![\w-])(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>=`]+))/dgi;
// snapshot-format.md, Cleaning the URL: a query parameter with a key's name.
const KEY_QUERY = new RegExp(`[?&]\\s*${KEY_PARAM.source.slice(1, -1)}\\s*=`, "gi");

// Every { class, start, end } where `text` holds markup the page may not:
// `<script` in any form; in the raw text and form 2, a key parameter, or a
// src or href that is neither an anchor on the page (`#...`) nor one of
// `links`. Form 3 reads `=` as a space, so it has no attributes to read.
const markupMatches = (text, links) => {
  const found = [];
  const { raw, folded } = forms(text);
  for (const { variant, s } of [{ variant: null, s: raw }, ...folded]) {
    const add = (cls, i, length) => {
      const [start, end] = spanOf(s, i, length, text.length);
      found.push({ class: cls, start, end });
    };
    for (const m of s.text.matchAll(SCRIPT)) add("script", m.index, m[0].length);
    if (variant?.form === 3) continue;
    for (const m of s.text.matchAll(KEY_QUERY)) add("key-param", m.index, m[0].length);
    // The raw page holds each link as the page escaped it.
    const allowed = new Set(
      variant ? links.map((link) => normalizeValue(link, variant)) : links.map(esc),
    );
    for (const m of s.text.matchAll(ATTRIBUTE)) {
      const value = (m[1] ?? m[2] ?? m[3]).trim();
      if (!value.startsWith("#") && !allowed.has(value)) add("link", m.index, m[0].length);
    }
  }
  return found;
};

// True when `text`, scanned whole, holds a value, also split at a pdftotext
// line break (privacy.js, hyphenPattern), or markup the page may not hold.
const holdsPrivate = (text, values) =>
  markupMatches(text, []).length > 0 ||
  scan(text, values, VALUE_CLASSES, { hyphens: true }).length > 0;

// Step 6.2: the ready contests a claim, an excerpt or a cited source name
// drops. `answers` is ready()'s Map, read for `ids` in ballot order. Returns
// { lines, dropped }: a `private-match` line for each claim or excerpt that
// matched, located by its article line and keyed by the claim's key, and a
// `private-source` line for each claim citing a snapshot whose `source:`
// name matched; and `dropped`, a Map from each dropped contest to its reasons.
const dropContests = (ids, answers, values) => {
  const sources = new Map();
  const lines = [];
  const dropped = new Map();
  for (const id of ids) {
    const answer = answers.get(id);
    if (!answer.ready) continue;
    const rel = `articles/${id}.md`;
    const reasons = new Set();
    const report = (line, code, key) => {
      lines.push(`${rel}:${line} ${code} ${key}`);
      reasons.add(code);
    };
    for (const { claim, key, snapshot } of answer.claims) {
      if (holdsPrivate(claim.text, values)) report(claim.line, "private-match", key);
      if (holdsPrivate(claim.excerpt, values)) report(claim.excerptLine, "private-match", key);
      if (!sources.has(snapshot)) {
        const source = answer.readSnapshot(snapshot)?.fields?.source;
        sources.set(snapshot, typeof source === "string" && holdsPrivate(source, values));
      }
      if (sources.get(snapshot)) report(claim.line, "private-source", key);
    }
    if (reasons.size) dropped.set(id, [...reasons]);
  }
  return { lines, dropped };
};

// Step 6.3: every { line, code, spans } where the page `html` holds a value
// or markup it may not, sorted by line and code. The digit-run and ZIP checks
// skip only the page's generated dates. `links` are the receipt links the
// page may hold.
const scanPage = (html, values, { links }) => {
  const lineAt = lineFinder(html);
  const hits = new Map();
  const hit = (line, code, span) => {
    const key = `${line}\0${code}`;
    if (!hits.has(key)) hits.set(key, { line, code, spans: [] });
    hits.get(key).spans.push(span);
  };
  const skip = generatedDates(html);
  for (const m of scan(html, values, VALUE_CLASSES, { skip, spans: true })) {
    for (const span of m.spans) hit(m.line, CLASSES[m.class], span);
  }
  for (const m of markupMatches(html, links)) {
    hit(lineAt(m.start), MARKUP[m.class], [m.start, m.end]);
  }
  return [...hits.values()].sort(
    (a, b) => a.line - b.line || ORDER.indexOf(a.code) - ORDER.indexOf(b.code),
  );
};

module.exports = { dropContests, scanPage };
