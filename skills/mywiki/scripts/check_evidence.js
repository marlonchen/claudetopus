#!/usr/bin/env node
"use strict";

/**
 * Mechanical evidence check for a Karpathy-style LLM wiki.
 *
 * Report-only; never modifies files. Three sweeps:
 *
 * 1. Fidelity — extract candidate literals (specific numbers, ISO dates,
 *    direct quotes) from each wiki article and verify that each candidate
 *    appears verbatim in the body of the raw files linked by that
 *    article's Raw field. Misses are listed as suspects. Derived values,
 *    product names, and deliberate paraphrases will show up as suspects;
 *    judging them is the reader's job, not this script's.
 * 2. Evidence errors — articles that cannot be verified at all: a missing
 *    Raw field on a non-archive article, Raw links that do not resolve,
 *    or Raw links that escape the source directory (evidence must live in
 *    immutable source files).
 * 3. Inventory — source files that no article's Raw field references,
 *    excluding files whose ingest was logged as "no material" and files
 *    that raw.config filters out.
 *
 * Coverage boundary (closed candidate set, frozen): candidates are
 * - quotes of 15+ characters (double-quoted spans and body blockquotes)
 * - ISO dates (YYYY-MM-DD, YYYY-MM)
 * - specific numbers: thousands-grouped (10,000), dotted (2.1.80, 3.14),
 *   suffixed (42K, 99.9%), or 4+ digits (2026)
 * Small plain integers ("42", "500") and exotic forms (signs, currencies,
 * spelled-out dates) are deliberately not checked; they belong to the
 * compile-time locate-before-write rule and to judgment review. New prose
 * forms extend this list in this comment, not the regexes.
 *
 * The exit code carries no information; the report is the interface.
 *
 * Configuration: an optional raw.config at the project root, one directive
 * per line, `#` for comments:
 *
 *     source <dir>     source directory, relative to the project root
 *                      (default: raw)
 *     include <glob>   only these source files are considered ingestable
 *     exclude <glob>   these source files are not
 *
 * Globs are fnmatch patterns matched against paths relative to the source
 * directory, so `*` crosses directory separators. With no include
 * directive every file is included; when a path matches both an include
 * and an exclude, the include wins. Filtering affects sweep 3 only.
 *
 * Usage: check_evidence.js [project-root] [article.md ...]
 * Defaults: project-root is the current directory; every markdown file
 * under .wiki/ except index.md and log.md is checked. Article paths may
 * be absolute or relative to the project root.
 */

const fs = require("node:fs");
const path = require("node:path");

const NUMBER_TOKEN_RE =
  /(?:\d{1,3}(?:,\d{3})+(?:\.\d+)*(?:\s*[KMB%](?![A-Za-z]))?|\d+(?:\.\d+)*(?:\s*[KMB%](?![A-Za-z]))?)(?![A-Za-z])/g;
const SUFFIX_RE = /[KMB%]$/;
const DATE_RE = /\d{4}-\d{2}(?:-\d{2})?/g;
const QUOTE_RES = [/"([^"\n]*)"/g, /“([^”\n]*)”/g];
const METADATA_RE = /^>\s*(Sources?|Raw|Collected|Published|Updated|Archived):/;
const STATUS_LINE_RE = /^>\s*\*\*Status:/;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const RAW_LINK_RE = /\(([^)]+\.md)[^)]*\)/g;
const RAW_FIELD_RE = /^>\s*Raw:/;
const NO_MATERIAL_HEADING_RE = /^## \[[^\]]*\]\s*ingest\s*\|\s*no material:\s*(\S+)/i;
const ARCHIVED_RE = /^>\s*Archived:/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const WS_RE = /\s+/g;
const TRIM_PUNCT_RE = /^[.,;:()[\]]+|[.,;:()[\]]+$/g;

const SKIP_FILES = new Set(["index.md", "log.md"]);
const WIKI_DIRNAME = ".wiki";
const DEFAULT_SOURCE = "raw";
const CONFIG_FILENAME = "raw.config";

// --- small helpers that stand in for Python builtins ----------------------

/** Python's str.splitlines(): no phantom trailing element, [] for "". */
function splitLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r\n|\n|\r/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const globCache = new Map();

/**
 * Python fnmatch semantics, deliberately NOT path.matchesGlob(): `*` must
 * cross directory separators, so `drafts/*` excludes `drafts/a/b.md`.
 */
function globToRegExp(pattern) {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i++];
    if (c === "*") {
      out += ".*";
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let j = i;
      if (j < pattern.length && pattern[j] === "!") j++;
      if (j < pattern.length && pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j++;
      if (j >= pattern.length) {
        out += "\\[";
      } else {
        let inner = pattern.slice(i, j).replace(/\\/g, "\\\\");
        if (inner.startsWith("!")) inner = `^${inner.slice(1)}`;
        out += `[${inner}]`;
        i = j + 1;
      }
    } else {
      out += escapeRegExp(c);
    }
  }
  const compiled = new RegExp(`^${out}$`, "s");
  globCache.set(pattern, compiled);
  return compiled;
}

function fnmatch(name, pattern) {
  return globToRegExp(pattern).test(name);
}

/**
 * Python's Path.resolve(): absolute AND symlink-free, tolerating paths that
 * do not exist. path.resolve() alone would leave /var vs /private/var
 * mismatches on macOS and break every containment check.
 */
function resolvePath(target) {
  const absolute = path.resolve(target);
  let current = absolute;
  const rest = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Python's Path.is_relative_to(). */
function isRelativeTo(target, base) {
  const rel = path.relative(base, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Python's Path.relative_to(...).as_posix(); null stands in for ValueError. */
function relativeToPosix(target, base) {
  if (!isRelativeTo(target, base)) return null;
  return toPosix(path.relative(base, target));
}

function toPosix(p) {
  return path.sep === "/" ? p : p.split(path.sep).join("/");
}

/** Python sorts Path objects by their parts tuple, not by the raw string. */
function comparePathParts(a, b) {
  const left = a.split(path.sep);
  const right = b.split(path.sep);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return left.length - right.length;
}

/** Python's Path.rglob("*.md"), sorted. */
function walkMarkdown(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith(".md")) found.push(full);
    }
  }
  found.sort(comparePathParts);
  return found;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readText(p) {
  return fs.readFileSync(p, "utf8");
}

// --- configuration --------------------------------------------------------

/** Resolved contents of raw.config: where sources live and which ones count. */
class SourceConfig {
  constructor(source = DEFAULT_SOURCE, include = [], exclude = []) {
    this.source = source;
    this.include = include;
    this.exclude = exclude;
  }

  dir(root) {
    return path.join(root, this.source);
  }

  /**
   * Does a source-relative path belong to the ingestable set?
   *
   * No include patterns means everything is included. When a path matches
   * both an include and an exclude, the include wins (raw.config documents
   * includes as taking precedence). Patterns are fnmatch globs, so `*`
   * crosses directory separators.
   */
  selects(relpath) {
    const included = this.include.length === 0 || this.include.some((p) => fnmatch(relpath, p));
    if (!included) return false;
    if (this.exclude.some((p) => fnmatch(relpath, p))) {
      return this.include.some((p) => fnmatch(relpath, p));
    }
    return true;
  }
}

/** Read raw.config from the project root. Missing file means defaults. */
function loadConfig(root) {
  const configFile = path.join(root, CONFIG_FILENAME);
  if (!isFile(configFile)) return new SourceConfig();
  let source = DEFAULT_SOURCE;
  const include = [];
  const exclude = [];
  const lines = splitLines(readText(configFile));
  for (let i = 0; i < lines.length; i++) {
    const lineno = i + 1;
    const stripped = lines[i].trim();
    if (!stripped || stripped.startsWith("#")) continue;
    const space = stripped.indexOf(" ");
    const directive = space === -1 ? stripped : stripped.slice(0, space);
    const value = (space === -1 ? "" : stripped.slice(space + 1)).trim();
    if (!value) {
      process.stderr.write(
        `warning: ${CONFIG_FILENAME}:${lineno}: directive with no value, ignored\n`,
      );
      continue;
    }
    if (directive === "source") {
      source = value.replace(/^\/+|\/+$/g, "");
    } else if (directive === "include") {
      include.push(value);
    } else if (directive === "exclude") {
      exclude.push(value);
    } else {
      process.stderr.write(
        `warning: ${CONFIG_FILENAME}:${lineno}: unknown directive '${directive}', ignored\n`,
      );
    }
  }
  return new SourceConfig(source || DEFAULT_SOURCE, include, exclude);
}

// --- document parsing -----------------------------------------------------

function normalize(text) {
  return text.replace(WS_RE, " ").trim();
}

function fenceOpener(line) {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const [, marker, info] = m;
  if (marker[0] === "`" && info.includes("`")) return null;
  return { char: marker[0], length: marker.length };
}

function isFenceCloser(line, char, length) {
  const m = FENCE_CLOSE_RE.exec(line);
  return Boolean(m && m[1][0] === char && m[1].length >= length);
}

/**
 * Return the visible title, metadata header, and body.
 *
 * The metadata header is only the contiguous blockquote immediately
 * after the first H1 outside a fence. A fence is a body boundary; its
 * removal must not promote a later blockquote into the header.
 */
function parseDocument(text) {
  let title = null;
  const header = [];
  const preamble = [];
  const body = [];
  let state = "before_title";
  let fenceChar = null;
  let fenceLen = 0;

  for (const line of splitLines(text)) {
    if (fenceChar) {
      if (isFenceCloser(line, fenceChar, fenceLen)) fenceChar = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      fenceChar = opener.char;
      fenceLen = opener.length;
      if (state === "after_title") state = "body";
      continue;
    }
    if (state === "before_title") {
      if (line.startsWith("# ")) {
        title = line;
        state = "after_title";
      } else {
        preamble.push(line);
      }
    } else if (state === "after_title") {
      if (!line.trim()) continue;
      if (line.trim().startsWith(">")) {
        header.push(line);
        state = "header";
      } else {
        body.push(line);
        state = "body";
      }
    } else if (state === "header") {
      if (line.trim().startsWith(">")) {
        header.push(line);
      } else {
        body.push(line);
        state = "body";
      }
    } else {
      body.push(line);
    }
  }

  return { title, header, body: [...preamble, ...body] };
}

/** Remove Standard Markdown fenced code blocks. */
function stripFences(text) {
  const out = [];
  let fenceChar = null;
  let fenceLen = 0;
  for (const line of splitLines(text)) {
    if (fenceChar) {
      if (isFenceCloser(line, fenceChar, fenceLen)) fenceChar = null;
      continue;
    }
    const opener = fenceOpener(line);
    if (opener) {
      fenceChar = opener.char;
      fenceLen = opener.length;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function stripNoise(text) {
  return text.replace(INLINE_CODE_RE, " ").replace(LINK_RE, "$1");
}

// --- candidate extraction -------------------------------------------------

function keepNumber(token) {
  const trimmed = token.trim();
  if (SUFFIX_RE.test(trimmed) || trimmed.includes(",") || trimmed.includes(".")) return true;
  return trimmed.length >= 4;
}

function extractNumericDateCandidates(rawLine) {
  const line = stripNoise(rawLine);
  const dateMatches = [...line.matchAll(DATE_RE)];
  const candidates = dateMatches.map((m) => ({ kind: "date", value: m[0] }));
  const chars = line.split("");
  for (const m of dateMatches) {
    for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = " ";
  }
  for (const m of chars.join("").matchAll(NUMBER_TOKEN_RE)) {
    if (keepNumber(m[0])) candidates.push({ kind: "number", value: m[0] });
  }
  return candidates;
}

function extractCandidates(text) {
  const document = parseDocument(text);
  const lines = [
    ...(document.title ? [document.title] : []),
    ...document.header.filter((line) => !METADATA_RE.test(line.trim())),
    ...document.body,
  ];
  const candidates = [];
  let skipStatusBlock = false;
  let blockquote = [];
  let paragraph = [];

  const flushBlockquote = () => {
    if (blockquote.length) {
      const joined = normalize(blockquote.join(" "));
      if (joined.length >= 15) candidates.push({ kind: "quote", value: joined });
      blockquote = [];
    }
  };

  const flushParagraph = () => {
    if (paragraph.length) {
      const joined = normalize(paragraph.join(" "));
      for (const quoteRe of QUOTE_RES) {
        for (const m of joined.matchAll(quoteRe)) {
          if (m[1].trim().length >= 15) candidates.push({ kind: "quote", value: m[1] });
        }
      }
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const stripped = rawLine.trim();
    if (STATUS_LINE_RE.test(stripped)) {
      flushBlockquote();
      flushParagraph();
      skipStatusBlock = true;
      continue;
    }
    if (skipStatusBlock) {
      if (stripped.startsWith(">")) continue;
      skipStatusBlock = false;
    }
    if (stripped.startsWith(">")) {
      flushParagraph();
      const content = stripNoise(stripped.replace(/^>+/, "").trim());
      blockquote.push(content);
      candidates.push(...extractNumericDateCandidates(content));
      continue;
    }
    flushBlockquote();
    if (!stripped) {
      flushParagraph();
      continue;
    }
    const line = stripNoise(rawLine);
    candidates.push(...extractNumericDateCandidates(line));
    paragraph.push(line);
  }
  flushBlockquote();
  flushParagraph();

  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    const value = candidate.value.trim().replace(TRIM_PUNCT_RE, "");
    const key = `${candidate.kind} ${value}`;
    if (value && !seen.has(key)) {
      seen.add(key);
      unique.push({ kind: candidate.kind, value });
    }
  }
  return unique;
}

/**
 * Raw links come only from the metadata header; identical lines in
 * the body or in code fences are content, not fields.
 */
function rawLinksOf(articleText) {
  const links = [];
  for (const line of parseDocument(articleText).header) {
    if (RAW_FIELD_RE.test(line.trim())) {
      for (const m of line.matchAll(RAW_LINK_RE)) links.push(m[1]);
    }
  }
  return links;
}

function contains(haystack, candidate) {
  if (candidate.kind === "quote") return haystack.includes(candidate.value);
  // Values must stand on their own, while sentence punctuation remains
  // valid. A month may not pass as the prefix of a full ISO date.
  const right = candidate.kind === "date" && candidate.value.length === 7 ? "(?!-\\d{2})" : "";
  const pattern = `(?<![\\d.,])${escapeRegExp(candidate.value)}${right}(?![A-Za-z0-9]|[.,]\\d|%)`;
  return new RegExp(pattern).test(haystack);
}

/**
 * Raw file body with the metadata header removed. Collection
 * metadata (Source/Collected/Published) is bookkeeping, not evidence;
 * letting it match candidates would false-pass dates and years.
 */
function sourceContent(file) {
  return normalize(parseDocument(readText(file)).body.join("\n"));
}

// --- sweeps ---------------------------------------------------------------

/** Return {misses, errors} for one article. */
function checkArticle(article, root, config) {
  const text = readText(article);
  const links = rawLinksOf(text);
  if (links.length === 0) {
    const header = parseDocument(text).header;
    if (header.some((line) => ARCHIVED_RE.test(line.trim()))) return { misses: [], errors: [] };
    return { misses: [], errors: ["article has no Raw field"] };
  }
  const rawRoot = resolvePath(config.dir(root));
  const raws = [];
  const errors = [];
  for (const link of links) {
    const target = resolvePath(path.join(path.dirname(article), link));
    if (!isRelativeTo(target, rawRoot)) {
      errors.push(`Raw link escapes ${config.source}/: ${link}`);
    } else if (!isFile(target)) {
      errors.push(`unresolvable Raw link: ${link}`);
    } else {
      raws.push(sourceContent(target));
    }
  }
  const misses = [];
  if (raws.length) {
    for (const candidate of extractCandidates(text)) {
      const normalized = { kind: candidate.kind, value: normalize(candidate.value) };
      if (!raws.some((raw) => contains(raw, normalized))) misses.push(normalized.value);
    }
  }
  return { misses, errors };
}

function iterArticles(wikiDir) {
  return walkMarkdown(wikiDir).filter((p) => !SKIP_FILES.has(relativeToPosix(p, wikiDir) ?? ""));
}

function noMaterialPaths(logFile) {
  if (!isFile(logFile)) return new Set();
  const paths = new Set();
  for (const line of splitLines(stripFences(readText(logFile)))) {
    const m = NO_MATERIAL_HEADING_RE.exec(line);
    if (m) paths.add(m[1].replace(/^[`,.;]+|[`,.;]+$/g, ""));
  }
  return paths;
}

function referencedRaws(root) {
  const referenced = new Set();
  for (const article of iterArticles(path.join(root, WIKI_DIRNAME))) {
    for (const link of rawLinksOf(readText(article))) {
      referenced.add(resolvePath(path.join(path.dirname(article), link)));
    }
  }
  return referenced;
}

function unreferencedRaws(root, config) {
  const rawDir = config.dir(root);
  if (!isDir(rawDir)) return [];
  const referenced = referencedRaws(root);
  const disposed = noMaterialPaths(path.join(root, WIKI_DIRNAME, "log.md"));
  const missing = [];
  for (const file of walkMarkdown(rawDir)) {
    if (!config.selects(relativeToPosix(file, rawDir))) continue;
    const label = relativeToPosix(file, root);
    if (!referenced.has(resolvePath(file)) && !disposed.has(label)) missing.push(label);
  }
  return missing;
}

// --- entry point ----------------------------------------------------------

function main(argv) {
  const root = argv.length > 0 ? resolvePath(argv[0]) : resolvePath(process.cwd());
  const config = loadConfig(root);
  const wikiDir = path.join(root, WIKI_DIRNAME);
  if (!isDir(wikiDir)) {
    console.log(`no ${WIKI_DIRNAME}/ directory under ${root}`);
    return 1;
  }

  let articles = [];
  for (const arg of argv.slice(1)) {
    const candidate = path.isAbsolute(arg) ? arg : path.join(root, arg);
    const rel = relativeToPosix(resolvePath(candidate), wikiDir);
    if (rel !== null && SKIP_FILES.has(rel)) {
      process.stderr.write(`warning: ${arg} is an index/log file, skipping\n`);
      continue;
    }
    if (!isFile(candidate)) {
      process.stderr.write(`warning: article not found: ${arg}\n`);
      continue;
    }
    articles.push(candidate);
  }
  if (argv.length <= 1) articles = iterArticles(wikiDir);

  const results = articles.map((article) => [article, checkArticle(article, root, config)]);

  const label = (article) => relativeToPosix(resolvePath(article), root) ?? article;

  console.log("# Evidence check\n");
  console.log("## Fidelity suspects");
  let suspectCount = 0;
  for (const [article, { misses }] of results) {
    if (misses.length) {
      console.log(`\n${label(article)}`);
      for (const miss of misses) {
        console.log(`- ${miss}`);
        suspectCount++;
      }
    }
  }
  if (suspectCount === 0) console.log("\n(none)");

  console.log("\n## Evidence errors");
  let errorCount = 0;
  for (const [article, { errors }] of results) {
    if (errors.length) {
      console.log(`\n${label(article)}`);
      for (const error of errors) {
        console.log(`- ${error}`);
        errorCount++;
      }
    }
  }
  if (errorCount === 0) console.log("(none)");

  console.log("\n## Unreferenced raw files");
  const orphans = unreferencedRaws(root, config);
  for (const orphan of orphans) console.log(`- ${orphan}`);
  if (orphans.length === 0) console.log("(none)");

  console.log(
    `\n## Summary\n${suspectCount} fidelity suspect(s), ` +
      `${errorCount} evidence error(s), ${orphans.length} unreferenced raw file(s)`,
  );
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
