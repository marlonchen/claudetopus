"use strict";

// review-list <election>/<ballot-id> [<contest>]...
// review-list --keys <election>/<ballot-id> [<contest>]...
// review-list --refused-hosts <election>/<ballot-id> <contest>
//
// Steps 4.5 and 5 (review-list.md): write review/<contest>.md, adding every
// mechanical item itself and keeping the researcher's marks by key. Every key
// is recomputed from its claim's fields, never read from a file, and
// acceptance only grows: the first run writes the baseline once, and each
// later run appends marked keys to .accepted. `ready` is the readiness
// publish recomputes. Output is `location code [key]` lines only (Rule 5).

const fs = require("node:fs");
const path = require("node:path");
const { parseArticle } = require("./article");
const {
  LETTER_HYPHEN,
  allContests,
  articleCheck,
  checkContext,
  resolveTarget,
} = require("./check");
const { ABBREVIATIONS, ALLEGATION_WORDS, ALWAYS_REVIEWED, ID_PATTERN } = require("./constants");
const { coverArticle, readContests } = require("./coverage");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { normalizeLine } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { isDate, readSearchLog } = require("./search-log");
const { verifyManifest, walk } = require("./snapshot-hash");
const { appendLine, sha256, withLock, writeOnce } = require("./snapshot-store");

// Item keys: 32 hex digits, 128 bits of a sha256 (review-list.md, Item keys).
const KEY = /^[0-9a-f]{32}$/;
// JSON keeps every field apart, so no two field lists hash the same text, and
// the first field keeps claim and unfetchable keys apart.
const hashKey = (fields) => sha256(JSON.stringify(fields)).slice(0, 32);

// A claim's key: its subject (the candidate's or official's id, or the contest
// id for a measure), section heading, Positions issue, claim text, tag,
// excerpt, snapshot path and the snapshot file's hash. The text and excerpt
// are normalized as excerpt matching normalizes them, so two spellings that
// differ only in characters normalizing drops or folds share one key.
const claimKey = ({ subject, section, issue, text, tag, excerpt, snapshot, fileHash }) =>
  hashKey([
    "claim",
    subject,
    section,
    issue ?? "",
    normalizeLine(text),
    tag,
    normalizeLine(excerpt),
    snapshot,
    fileHash,
  ]);
// An unfetchable entry's key: its URL and `<contest>/<subject>`.
const entryKey = ({ url, where }) => hashKey(["unfetchable", url, where]);

// The reasons an item is on the list, in the order its `why` line gives them.
const REASONS = [
  "attribution",
  "misfiled",
  "always-reviewed",
  "t2i",
  "allegation-word",
  "neutrality",
  "not-verbatim",
  "unaccepted",
];

// An allegation word, whole and case folded: each stem bare or with one of
// its endings (review-list.md, What goes on it).
const ALLEGATION = new RegExp(
  `(?<![\\p{L}\\p{M}\\p{Nd}])(?:${ALLEGATION_WORDS.map((w) =>
    w.replace(/\((.+)\)$/, "(?:$1)?"),
  ).join("|")})(?![\\p{L}\\p{M}\\p{Nd}])`,
  "iu",
);
// Read as written and with each hyphen between two letters removed, so a word
// split at a pdftotext break, which an excerpt may keep, still counts.
const hasAllegation = (text) => {
  const line = normalizeLine(text);
  return [line, line.replace(LETTER_HYPHEN, "")].some((t) => ALLEGATION.test(t));
};

// Is the claim text, without a leading `Says:` and one pair of enclosing
// quotes, one whole sentence of its excerpt once both are normalized, opening
// quotes and closing punctuation aside, of at least three words
// (review-list.md, Accepted keys)? A sentence starts with a capital letter or
// digit and ends in `.`, `!` or `?`. `wholeSpan` is true for a claim citing
// the sample ballot, whose excerpt check matched as one whole span of
// ballot-view.md: the whole excerpt counts too, whatever its length.
const QUOTED = /^(["'])(.*)\1$/;
// A word, its end marks and any closing quotes or brackets, then a space.
const END = /([\p{L}\p{M}\p{Nd}]*)([.!?]+)["')\]]* /gu;
const OPENING = /^["'([]+/;
const ENDS = /[.!?]+["')\]]*$/;
const OPENS = /^["'([]*[\p{Lu}\p{Nd}]/u;
const WORDS = /[\p{L}\p{M}\p{Nd}]+/gu;
const bare = (text) => text.replace(OPENING, "").replace(ENDS, "").trim();
// The text's sentences, split after each end mark followed by a capital
// letter or digit, except an ellipsis, or a period after a single letter (an
// initial, U.S.) or an abbreviation: a tail after `Sen.` or `...` drops what
// came before it, so it is never a sentence of its own. When unsure, it does
// not split, which only puts a claim on the list.
const sentences = (text) => {
  const found = [];
  let start = 0;
  for (const m of text.matchAll(END)) {
    const [all, word, marks] = m;
    const next = m.index + all.length;
    const abbreviated =
      marks === "." && (/^\p{L}$/u.test(word) || ABBREVIATIONS.includes(word.toLowerCase()));
    if (marks.includes("..") || abbreviated || !OPENS.test(text.slice(next))) continue;
    found.push(text.slice(start, next - 1));
    start = next;
  }
  return [...found, text.slice(start)];
};
const isVerbatim = (text, excerpt, wholeSpan = false) => {
  let claim = normalizeLine(text);
  if (claim.startsWith("Says:")) claim = claim.slice("Says:".length).trim();
  const quoted = QUOTED.exec(claim);
  if (quoted) claim = quoted[2];
  claim = bare(claim);
  if (claim === "") return false;
  const whole = normalizeLine(excerpt);
  if (wholeSpan && bare(whole) === claim) return true;
  if ((claim.match(WORDS) ?? []).length < 3) return false;
  return sentences(whole).some((s) => ENDS.test(s) && OPENS.test(s) && bare(s) === claim);
};

const SAYS_TAG = /^T[1-4]s$/;
const DOMAIN_REFUSED = "domain not in tiers.yaml";

const lstat = (ballotDir, rel) =>
  fs.lstatSync(path.join(ballotDir, rel), { throwIfNoEntry: false });

// Fail review-invalid unless review/ is a directory or absent, so no review
// file is read or written through a symlink.
const checkReviewDir = (ballotDir) => {
  const dir = lstat(ballotDir, "review");
  if (dir && !dir.isDirectory()) throw new Failure("review", "review-invalid");
};

// Remove the temporary files writeOnce leaves in review/ when a crash cuts it
// short. Under the ballot lock, any one there is a leftover.
const TEMP = /\.tmp-[0-9a-f]{16}$/;
const removeTemps = (ballotDir) => {
  const dir = path.join(ballotDir, "review");
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
    if (entry.isFile() && TEMP.test(entry.name)) fs.rmSync(path.join(dir, entry.name));
};

// A file's lines and whether its last one ended in a newline, or null when it
// does not exist. Anything but a regular file fails `code`.
const readLines = (ballotDir, rel, code) => {
  const stat = lstat(ballotDir, rel);
  if (!stat) return null;
  if (!stat.isFile()) throw new Failure(rel, code);
  const lines = fs.readFileSync(path.join(ballotDir, rel), "utf8").split("\n");
  const unended = lines.pop();
  return { lines: unended === "" ? lines : [...lines, unended], ended: unended === "" };
};

// review/<contest>.baseline or .accepted as its keys, or null when it does
// not exist. A last line with no newline fails, except with `torn` (.accepted),
// where it is an append a crash cut short: ignored here, and dropped before
// the next append (dropTornLine).
const readKeys = (ballotDir, rel, { torn = false } = {}) => {
  const read = readLines(ballotDir, rel, "review-invalid");
  if (!read) return null;
  const lines = torn && !read.ended ? read.lines.slice(0, -1) : read.lines;
  for (const [i, line] of lines.entries()) {
    if (!KEY.test(line) || (i === read.lines.length - 1 && !read.ended))
      throw new Failure(`${rel}:${i + 1}`, "review-invalid");
  }
  return lines;
};

// Cut .accepted back to its last newline, so the next append starts a line.
const dropTornLine = (file) => {
  const text = fs.readFileSync(file, "utf8");
  if (text.endsWith("\n")) return;
  fs.truncateSync(file, Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)));
};

// The accepted set: { first, keys }, where first is true when no baseline
// exists yet. An .accepted with no baseline is review-invalid.
const readAccepted = (ballotDir, id) => {
  const baseline = readKeys(ballotDir, `review/${id}.baseline`);
  const accepted = readKeys(ballotDir, `review/${id}.accepted`, { torn: true });
  if (!baseline && accepted) throw new Failure(`review/${id}.accepted`, "review-invalid");
  return { first: !baseline, keys: new Set([...(baseline ?? []), ...(accepted ?? [])]) };
};

// The items the researcher marked [x] in review/<contest>.md, as a map from
// key to what the item showed: { line, reasons, flags }, its item line and the
// reasons on its why line and its neutrality lines. Trailing whitespace is
// ignored, so an editor's CRLF or trailing space never drops a mark.
const ITEM = /^- \[([ xX])\] [^\n]* <!-- id:([0-9a-f]{32}) -->$/;
const WHY = /^ {2}- why: (.+) \([^()]+\)$/;
const NOTE = /^ {2}- neutrality: (.+)$/;
const readMarks = (ballotDir, id) => {
  const marks = new Map();
  let item = null;
  const lines = readLines(ballotDir, `review/${id}.md`, "review-invalid")?.lines ?? [];
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const head = ITEM.exec(line);
    if (head) {
      item = head[1] === " " ? null : { line: i + 1, reasons: new Set(), flags: new Set() };
      if (item && !marks.has(head[2])) marks.set(head[2], item);
      continue;
    }
    if (!line.startsWith("  ")) item = null;
    if (!item) continue;
    for (const reason of WHY.exec(line)?.[1].split(", ") ?? []) item.reasons.add(reason);
    const note = NOTE.exec(line);
    if (note) item.flags.add(note[1]);
  }
  return marks;
};

// review/<contest>.neutrality.md as { reviewed, flags }, flags mapping a key
// to the pass's reasons, or null when it does not exist (review-list.md,
// Command line).
const REVIEWED = /^<!-- reviewed:((?: \S+)*) -->$/;
const FLAG = /^- (\S+) \| (.*)$/;
const readNeutrality = (ballotDir, id) => {
  const rel = `review/${id}.neutrality.md`;
  const read = readLines(ballotDir, rel, "neutrality-invalid");
  if (!read) return null;
  const [first, ...rest] = read.lines.map((line) => line.trimEnd());
  const listed = REVIEWED.exec(first ?? "");
  const keys = listed ? listed[1].split(" ").filter(Boolean) : [];
  if (!listed || !keys.every((key) => KEY.test(key)))
    throw new Failure(`${rel}:1`, "neutrality-invalid");
  const reviewed = new Set(keys);
  const flags = new Map();
  for (const [i, line] of rest.entries()) {
    if (line === "") continue;
    const flag = FLAG.exec(line);
    const reason = flag?.[2].trim() ?? "";
    // No markup, so a reason can neither forge an item nor hide text.
    const angled = [reason, normalizeLine(reason)].some((t) => /[<>]/.test(t));
    if (!flag || !reviewed.has(flag[1]) || reason === "" || angled)
      throw new Failure(`${rel}:${i + 2}`, "neutrality-invalid");
    flags.set(flag[1], [...(flags.get(flag[1]) ?? []), reason]);
  }
  return { reviewed, flags };
};

// unfetchable.md's entries, [{ url, where, contest, subject, date, reason }]
// (snapshot-format.md, Unfetchable log). Any other line is unfetchable-invalid.
const ENTRY =
  /^- ([^\s|<>]+) \| (_ballot|([^\s|/]+)\/([^\s|/]+)) \| ([0-9]{4}-[0-9]{2}-[0-9]{2}) \| ([^|<>]+)$/;
const readUnfetchable = (ballotDir) => {
  const read = readLines(ballotDir, "unfetchable.md", "unfetchable-invalid");
  if (!read) return [];
  return read.lines.map((line, i) => {
    const [, url, where, contest, subject, date, reason] = ENTRY.exec(line) ?? [];
    const named =
      where === "_ballot" ||
      (ID_PATTERN.test(contest ?? "") && (subject === "_race" || ID_PATTERN.test(subject ?? "")));
    if (!url || !named || !isDate(date) || (i === read.lines.length - 1 && !read.ended))
      throw new Failure(`unfetchable.md:${i + 1}`, "unfetchable-invalid");
    return { url, where, contest, subject, date, reason };
  });
};

// The contest's unfetchable entries that go on its list: not a domain refusal,
// and not saved since by a snapshot of the same contest and subject whose url
// or requested_url is the entry's, fetched on or after it. One per key, in log order.
const entryItems = (id, { entries, snapshots, check }) => {
  const saved = ({ url, subject, date }) =>
    snapshots.some((rel) => {
      if (!rel.startsWith(`sources/${id}/${subject}/`)) return false;
      const fields = check.readSnapshot(rel)?.fields;
      const sameUrl = fields?.url === url || fields?.requested_url === url;
      return sameUrl && String(fields.fetched ?? "") >= date;
    });
  const items = new Map();
  for (const entry of entries) {
    if (entry.contest !== id || entry.reason === DOMAIN_REFUSED || saved(entry)) continue;
    const key = entryKey(entry);
    if (!items.has(key)) items.set(key, { key, entry });
  }
  return [...items.values()];
};

// The article's claims, each as { claim, at, key, snapshot, reasons,
// verbatim }, with its mechanical reasons (review-list.md, What goes on it).
// check and coverage have passed, so every claim sits in a block and section
// coverage matched and cites a snapshot of this contest or _ballot.
const readClaims = (rel, contest, article, { subjects, names }, { readSnapshot, view }) => {
  const ids = new Set(contest.blocks.map((b) => b.subject).filter((s) => s !== "_race"));
  const measure = contest.type === "measure";
  return article.claims.map((claim) => {
    const subject = subjects.get(claim.block);
    const snapshot = resolveTarget(claim.target);
    const read = readSnapshot(snapshot);
    const [, dir, filedUnder] = snapshot.split("/");
    const reasons = new Set();
    if (!measure && dir !== "_ballot") {
      if (SAYS_TAG.test(claim.tag) && read.fields?.owner !== subject) reasons.add("attribution");
      if (filedUnder !== subject && ids.has(filedUnder)) reasons.add("misfiled");
    }
    if (ALWAYS_REVIEWED[contest.type].includes(names.get(claim.section)))
      reasons.add("always-reviewed");
    if (claim.tag === "T2i") reasons.add("t2i");
    if (hasAllegation(claim.text) || hasAllegation(claim.excerpt)) reasons.add("allegation-word");
    const key = claimKey({
      subject: measure ? contest.id : subject,
      section: claim.section.name,
      issue: claim.issue?.name,
      text: claim.text,
      tag: claim.tag,
      excerpt: claim.excerpt,
      snapshot,
      fileHash: read.hash,
    });
    return {
      claim,
      at: `${rel}:${claim.line}`,
      key,
      snapshot,
      reasons,
      verbatim: isVerbatim(claim.text, claim.excerpt, snapshot === view?.link),
    };
  });
};

// What a run reads once for every contest: ballot.yaml's contests, check's
// context, whether the manifest or ballot.yaml fails every article's check,
// and, with `entries`, the unfetchable log and the snapshot files.
const runContext = (ballotDir, { entries }) => {
  // Loaded first, so a missing install is one deps-missing, not a failure per contest.
  const YAML = load("yaml");
  const contests = readContests(ballotDir);
  const failureLines = verifyManifest(ballotDir).map((f) => f.line);
  const check = checkContext(ballotDir, YAML, failureLines);
  return {
    contests,
    check,
    ballotFailed: failureLines.length > 0,
    entries: entries ? readUnfetchable(ballotDir) : null,
    snapshots: entries
      ? walk(ballotDir)
          .filter((s) => s.kind === "file")
          .map((s) => s.rel)
      : [],
  };
};

// Everything review-list reads of one contest: its claims and unfetchable
// items. Fails when the article is missing or check or coverage fails it;
// the article is parsed once, for all three.
const loadContest = (ballotDir, id, ctx) => {
  const rel = `articles/${id}.md`;
  const contest = ctx.contests.get(id);
  if (!contest) throw new Failure(rel, "unknown-contest");
  if (!lstat(ballotDir, rel)?.isFile()) throw new Failure(rel, "file-missing");
  const article = parseArticle(fs.readFileSync(path.join(ballotDir, rel), "utf8"));
  if (ctx.ballotFailed || articleCheck(rel, id, article, ctx.check).length)
    throw new Failure(rel, "check-failed");
  const covered = coverArticle(ballotDir, contest, article);
  if (covered.failures.length) throw new Failure(rel, "coverage-failed");
  return {
    article,
    claims: readClaims(rel, contest, article, covered, ctx.check),
    entries: ctx.entries ? entryItems(id, ctx) : [],
  };
};

// A claim's reasons: its mechanical ones, `neutrality` when the pass flags
// it and, on a first run, `not-verbatim` when it is not verbatim.
const reasonsOf = (c, flags, first) => {
  const reasons = new Set(c.reasons);
  if (flags.has(c.key)) reasons.add("neutrality");
  if (first && !c.verbatim) reasons.add("not-verbatim");
  return reasons;
};

// The list (review-list.md, What goes on it): one item per key, claims in
// article order with every location of the key, then unfetchable entries.
// `accepted` is the accepted set and `flags` the neutrality pass's. An item
// listed only because its key is not accepted leaves once it is.
const buildList = ({ claims, entries }, { accepted, flags, first }) => {
  const items = new Map();
  for (const c of claims) {
    const reasons = reasonsOf(c, flags, first);
    const item = items.get(c.key);
    if (item) {
      for (const r of reasons) item.reasons.add(r);
      item.at.push(c.at);
    } else items.set(c.key, { ...c, at: [c.at], reasons });
  }
  for (const item of items.values())
    if (!first && !item.reasons.size && !accepted.has(item.key)) item.reasons.add("unaccepted");
  return [
    ...[...items.values()].filter((item) => item.reasons.size),
    ...entries.map((e) => ({ ...e, reasons: new Set() })),
  ];
};

// The marks a later run reads (review-list.md, Command line), each on a
// current claim or entry key not yet accepted, as { counted, dropped }:
// counted, the keys whose item showed every reason and neutrality flag the key
// has now, and dropped, the marks whose item did not, as { key, line }, so a
// flag or rule that came after the researcher looked keeps the item open and
// is said.
const readCounted = ({ claims, entries }, marks, { accepted, flags }) => {
  const now = new Map(entries.map((e) => [e.key, new Set()]));
  for (const c of claims)
    now.set(c.key, new Set([...(now.get(c.key) ?? []), ...reasonsOf(c, flags, false)]));
  const saw = (key, shown) =>
    [...now.get(key)].every((r) => shown.reasons.has(r)) &&
    (flags.get(key) ?? []).every((f) => shown.flags.has(f));
  const counted = [];
  const dropped = [];
  for (const [key, shown] of marks) {
    if (!now.has(key) || accepted.has(key)) continue;
    if (saw(key, shown)) counted.push(key);
    else dropped.push({ key, line: shown.line });
  }
  return { counted, dropped };
};

// Every claim and unfetchable key accepted (review-list.md, Clearing it);
// check and coverage have passed.
const allAccepted = ({ claims, entries }, accepted) =>
  [...claims, ...entries].every((item) => accepted.has(item.key));

// Agent-written text as it goes into the review file: `<` escaped, so no tag
// in a claim or excerpt can hide or restyle what the researcher reads.
const escapeTags = (text) => text.replaceAll("<", "&lt;");

const render = (id, list, accepted, flags) => {
  const lines = [`# Review: ${id}`, ""];
  for (const item of list) {
    const box = accepted.has(item.key) ? "[x]" : "[ ]";
    if (item.entry) {
      const { url, where, date, reason } = item.entry;
      lines.push(
        `- ${box} Unfetchable: ${url} | ${where} | ${date} | ${reason} <!-- id:${item.key} -->`,
      );
      continue;
    }
    const { text, tag, label, excerpt } = item.claim;
    const why = REASONS.filter((r) => item.reasons.has(r)).join(", ");
    lines.push(
      `- ${box} ${escapeTags(text)} \`${tag}\` [${label}](../${item.snapshot}) <!-- id:${item.key} -->`,
      `  > ${escapeTags(excerpt)}`,
      `  - why: ${why} (${item.at.join(", ")})`,
      ...(flags.get(item.key) ?? []).map((reason) => `  - neutrality: ${reason}`),
    );
  }
  if (list.length) lines.push("");
  lines.push(`<!-- accepted: ${[...accepted].join(" ")} -->`, "");
  return lines.join("\n");
};

// Write one contest's review file (review-list.md, Command line), or fail
// without writing anything.
const writeReview = (ballotDir, id, ctx) => {
  const loaded = loadContest(ballotDir, id, ctx);
  checkReviewDir(ballotDir);
  const reviewRel = `review/${id}.md`;
  const existing = lstat(ballotDir, reviewRel);
  if (existing && !existing.isFile()) throw new Failure(reviewRel, "review-invalid");
  const { first, keys: before } = readAccepted(ballotDir, id);
  // A first run never reads a review file, so one a reset left behind fails
  // rather than being overwritten (review-list.md, Accepted keys).
  if (first && existing) throw new Failure(reviewRel, "review-invalid");
  const neutrality = readNeutrality(ballotDir, id);
  const neutralityRel = `review/${id}.neutrality.md`;
  const flags = neutrality?.flags ?? new Map();
  const claimKeys = new Set(loaded.claims.map((c) => c.key));

  let marks = [];
  let dropped = [];
  if (first) {
    // The baseline waits for a pass that read exactly the current claims.
    if (!neutrality) throw new Failure(neutralityRel, "neutrality-missing");
    const { reviewed } = neutrality;
    if (reviewed.size !== claimKeys.size || ![...claimKeys].every((k) => reviewed.has(k)))
      throw new Failure(`${neutralityRel}:1`, "neutrality-stale");
  } else {
    ({ counted: marks, dropped } = readCounted(loaded, readMarks(ballotDir, id), {
      accepted: before,
      flags,
    }));
    // Every key still not accepted once the marks count was read by the pass.
    const counted = new Set([...before, ...marks]);
    if ([...claimKeys].some((k) => !counted.has(k) && !neutrality?.reviewed.has(k)))
      throw neutrality
        ? new Failure(`${neutralityRel}:1`, "neutrality-stale")
        : new Failure(neutralityRel, "neutrality-missing");
  }
  const accepted = new Set([...before, ...marks]);
  const list = buildList(loaded, { accepted, flags, first });
  const lines = dropped.map(({ key, line }) => `${reviewRel}:${line} mark-not-counted ${key}`);
  fs.mkdirSync(path.join(ballotDir, "review"), { recursive: true });
  removeTemps(ballotDir);
  if (first) {
    const onList = new Set(list.map((item) => item.key));
    const baseline = [...claimKeys].filter((k) => !onList.has(k));
    for (const k of baseline) accepted.add(k);
    // Written once and whole: an existing file, or a link put in its place, fails.
    writeOnce(
      path.join(ballotDir, `review/${id}.baseline`),
      baseline.map((k) => `${k}\n`).join(""),
    );
    lines.push(`review/${id}.baseline written`);
  }
  if (marks.length) {
    const file = path.join(ballotDir, `review/${id}.accepted`);
    if (fs.existsSync(file)) dropTornLine(file);
    appendLine(file, marks.map((k) => `${k}\n`).join(""));
  }
  fs.writeFileSync(path.join(ballotDir, reviewRel), render(id, list, accepted, flags));
  lines.push(`${reviewRel} written`);
  lines.push(`articles/${id}.md ${allAccepted(loaded, accepted) ? "ready" : "not-ready"}`);
  return lines;
};

// --keys: each claim's location, whether its key is accepted, and its key.
const printKeys = (ballotDir, id, ctx) => {
  const { claims } = loadContest(ballotDir, id, ctx);
  checkReviewDir(ballotDir);
  const { keys } = readAccepted(ballotDir, id);
  return claims.map((c) => `${c.at} ${keys.has(c.key) ? "accepted" : "unaccepted"} ${c.key}`);
};

// The longest host --refused-hosts prints, and how many it prints: hosts come
// from agent-chosen URLs, so a long or many-host log is counted, not shown.
const MAX_HOST = 100;
const MAX_HOSTS = 20;

// A host name of dot-separated LDH labels, at least two, whose last label is
// not all digits, of at most MAX_HOST characters, or null.
const LDH_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ldhHost = (url) => {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const labels = host.split(".");
  const valid =
    host.length <= MAX_HOST &&
    labels.length >= 2 &&
    labels.every((label) => LDH_LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1));
  return valid ? host : null;
};

// The current discovery run's window: from the day before the first day of
// the latest run of consecutive log dates, so a run that crosses midnight, or
// a refusal logged before the run's first search line, still counts. Every
// entry counts when the log has no line.
const DAY_MS = 24 * 60 * 60 * 1000;
const dayBefore = (date) => new Date(Date.parse(date) - DAY_MS).toISOString().slice(0, 10);
const runStart = (dates) => {
  if (!dates.size) return "";
  let day = [...dates].sort().at(-1);
  while (dates.has(dayBefore(day))) day = dayBefore(day);
  return dayBefore(day);
};

// --refused-hosts: the hosts of the current discovery run's domain refusals.
const refusedHosts = (ballotDir, id) => {
  load("yaml");
  const contest = readContests(ballotDir).get(id);
  if (!contest) throw new Failure(`articles/${id}.md`, "unknown-contest");
  const log = readSearchLog(ballotDir, id, contest.type);
  if (log.faults.length) throw new Failure(`search-log/${id}.tsv`, "search-log-invalid");
  const since = runStart(log.dates);
  const hosts = new Set();
  let other = 0;
  for (const entry of readUnfetchable(ballotDir)) {
    if (entry.contest !== id || entry.reason !== DOMAIN_REFUSED || entry.date < since) continue;
    const host = ldhHost(entry.url);
    if (host) hosts.add(host);
    else other++;
  }
  const sorted = [...hosts].sort();
  const lines = sorted.slice(0, MAX_HOSTS).map((host) => `${id} domain-not-in-tiers ${host}`);
  if (sorted.length > MAX_HOSTS) lines.push(`${id} more-hosts ${sorted.length - MAX_HOSTS}`);
  if (other) lines.push(`${id} other-hosts ${other}`);
  return lines.length ? lines : [`${id} no-refused-hosts`];
};

// Is each contest ready (review-list.md, Clearing it)? publish's contest gate
// calls this once, for every contest, holding the ballot lock, so the ballot
// is read and its manifest verified once. Returns a map from contest id to
// { ready, reasons }, reasons being the codes that keep it from being ready:
// not-reviewed (no baseline), review-missing (a baseline with no review
// file), unaccepted, or the code of any failure that stopped the check
// (unknown-contest, file-missing, check-failed, coverage-failed,
// review-invalid, unfetchable-invalid, yaml-invalid, ballot-invalid,
// deps-missing); a failure of the whole run is every contest's. A contest
// whose article was read also gets `article`, the parsed article it judged,
// and `readSnapshot`, the reader its snapshots were hashed through, so publish
// renders exactly what was judged. It never throws a Failure.
const ready = (ballotDir, contests) => {
  const refused = (error) => {
    if (error instanceof Failure) return { ready: false, reasons: [error.code] };
    throw error;
  };
  let ctx;
  try {
    ctx = runContext(ballotDir, { entries: true });
  } catch (error) {
    return new Map(contests.map((id) => [id, refused(error)]));
  }
  const answers = new Map();
  for (const id of contests) {
    try {
      const loaded = loadContest(ballotDir, id, ctx);
      checkReviewDir(ballotDir);
      const { first, keys } = readAccepted(ballotDir, id);
      const reasons = [];
      if (first) reasons.push("not-reviewed");
      else if (!lstat(ballotDir, `review/${id}.md`)?.isFile()) reasons.push("review-missing");
      if (!allAccepted(loaded, keys)) reasons.push("unaccepted");
      answers.set(id, {
        ready: reasons.length === 0,
        reasons,
        article: loaded.article,
        readSnapshot: ctx.check.readSnapshot,
      });
    } catch (error) {
      answers.set(id, refused(error));
    }
  }
  return answers;
};

const MODES = ["--keys", "--refused-hosts"];

const parseArgs = (argv) => {
  const mode = MODES.includes(argv[0]) ? argv[0] : null;
  const rest = mode ? argv.slice(1) : argv;
  if (rest.length === 0 || rest.some((arg) => arg.startsWith("--")))
    throw new Failure("-", "usage");
  const [ballot, ...given] = rest;
  parseBallot(ballot);
  if (!given.every((c) => ID_PATTERN.test(c))) throw new Failure("-", "usage");
  if (mode === "--refused-hosts" && given.length !== 1) throw new Failure("-", "usage");
  // A contest given twice is reviewed once.
  return { mode, ballot, contests: [...new Set(given)] };
};

const reviewList = (ballotDir, { mode, contests: given }) => {
  if (mode === "--refused-hosts") return refusedHosts(ballotDir, given[0]);
  // Read once: a bad unfetchable.md (read only by the write form) is one
  // failure, not one per contest.
  const ctx = runContext(ballotDir, { entries: mode === null });
  const run = mode === "--keys" ? printKeys : writeReview;
  const lines = [];
  let failed = false;
  for (const id of given.length ? given : allContests(ballotDir)) {
    try {
      lines.push(...run(ballotDir, id, ctx));
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      lines.push(error.line);
      failed = true;
    }
  }
  if (failed) throw new Failures(lines);
  return lines;
};

const main = (argv) =>
  runCommand(async () => {
    const args = parseArgs(argv);
    const ballotDir = openBallot(process.cwd(), args.ballot);
    // Under the ballot lock, which every save and log append also takes, so
    // none is ever half seen.
    return withLock(ballotDir, () => reviewList(ballotDir, args));
  });

module.exports = { claimKey, entryKey, hasAllegation, isVerbatim, main, ready };
