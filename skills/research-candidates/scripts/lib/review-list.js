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
const { allContests, check, resolveTarget, snapshotReader } = require("./check");
const { ALLEGATION_WORDS, ALWAYS_REVIEWED, ID_PATTERN } = require("./constants");
const { coverage, readContests } = require("./coverage");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { normalizeLine, wholeWords } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { readSearchLog } = require("./search-log");
const { walk } = require("./snapshot-hash");
const { appendLine, sha256, withLock } = require("./snapshot-store");

// Item keys: 16 hex digits, 64 bits of a sha256 (review-list.md, Item keys).
const KEY = /^[0-9a-f]{16}$/;
// JSON keeps every field apart, so no two field lists hash the same text, and
// the first field keeps claim and unfetchable keys apart.
const hashKey = (fields) => sha256(JSON.stringify(fields)).slice(0, 16);

// A claim's key: its subject (the candidate's or official's id, or the contest
// id for a measure), section heading, Positions issue, claim text, tag,
// excerpt, snapshot path and the snapshot file's hash.
const claimKey = ({ subject, section, issue, text, tag, excerpt, snapshot, fileHash }) =>
  hashKey(["claim", subject, section, issue ?? "", text, tag, excerpt, snapshot, fileHash]);
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
const hasAllegation = (text) => ALLEGATION.test(normalizeLine(text));

// Is the claim text, without a leading `Says:` and one pair of enclosing
// quotes, found whole in its excerpt once both are normalized (review-list.md,
// Accepted keys)?
const QUOTED = /^(["'])(.*)\1$/;
const isVerbatim = (text, excerpt) => {
  let claim = normalizeLine(text);
  if (claim.startsWith("Says:")) claim = claim.slice("Says:".length).trim();
  const quoted = QUOTED.exec(claim);
  if (quoted) claim = quoted[2].trim();
  return claim !== "" && wholeWords(normalizeLine(excerpt), claim).length > 0;
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
// not exist.
const readKeys = (ballotDir, rel) => {
  const read = readLines(ballotDir, rel, "review-invalid");
  if (!read) return null;
  for (const [i, line] of read.lines.entries()) {
    if (!KEY.test(line) || (i === read.lines.length - 1 && !read.ended))
      throw new Failure(`${rel}:${i + 1}`, "review-invalid");
  }
  return read.lines;
};

// The accepted set: { first, keys }, where first is true when no baseline
// exists yet. An .accepted with no baseline is review-invalid.
const readAccepted = (ballotDir, id) => {
  const baseline = readKeys(ballotDir, `review/${id}.baseline`);
  const accepted = readKeys(ballotDir, `review/${id}.accepted`);
  if (!baseline && accepted) throw new Failure(`review/${id}.accepted`, "review-invalid");
  return { first: !baseline, keys: new Set([...(baseline ?? []), ...(accepted ?? [])]) };
};

// The keys the researcher marked [x] in review/<contest>.md.
const MARK = /^- \[[xX]\] .* <!-- id:([0-9a-f]{16}) -->$/;
const readMarks = (ballotDir, id) => {
  const read = readLines(ballotDir, `review/${id}.md`, "review-invalid");
  return (read?.lines ?? []).map((line) => MARK.exec(line)?.[1]).filter(Boolean);
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
    const marker = [reason, normalizeLine(reason)].some((t) => /<!--|-->/.test(t));
    if (!flag || !reviewed.has(flag[1]) || reason === "" || marker)
      throw new Failure(`${rel}:${i + 2}`, "neutrality-invalid");
    flags.set(flag[1], [...(flags.get(flag[1]) ?? []), reason]);
  }
  return { reviewed, flags };
};

// unfetchable.md's entries, [{ url, where, contest, subject, date, reason }]
// (snapshot-format.md, Unfetchable log). Any other line is unfetchable-invalid.
// An id, unanchored and with no group of its own, so the entry's groups keep their numbers.
const ID = ID_PATTERN.source.slice(1, -1).replaceAll("(", "(?:");
const SUBJECT = `(?:_race|${ID})`;
const ENTRY = new RegExp(
  `^- ([^\\s|<>]+) \\| (_ballot|(${ID})/(${SUBJECT})) \\| ([0-9]{4}-[0-9]{2}-[0-9]{2}) \\| ([^|<>]+)$`,
);
const readUnfetchable = (ballotDir) => {
  const read = readLines(ballotDir, "unfetchable.md", "unfetchable-invalid");
  if (!read) return [];
  return read.lines.map((line, i) => {
    const entry = ENTRY.exec(line);
    if (!entry || (i === read.lines.length - 1 && !read.ended))
      throw new Failure(`unfetchable.md:${i + 1}`, "unfetchable-invalid");
    const [, url, where, contest, subject, date, reason] = entry;
    return { url, where, contest, subject, date, reason };
  });
};

// The contest's unfetchable entries that go on its list: not a domain refusal,
// and not saved since by a snapshot of the same contest and subject whose url
// is the entry's, fetched on or after it. One per key, in log order.
const entryItems = (ballotDir, id, entries, readSnapshot) => {
  const snapshots = walk(ballotDir).filter((s) => s.kind === "file");
  const saved = ({ url, subject, date }) =>
    snapshots.some(({ rel }) => {
      if (!rel.startsWith(`sources/${id}/${subject}/`)) return false;
      const fields = readSnapshot(rel)?.fields;
      return fields?.url === url && String(fields.fetched ?? "") >= date;
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
// The article has passed check and coverage, so every claim sits in a block
// and section of `contest` and cites a snapshot that exists.
const readClaims = (ballotDir, contest, readSnapshot) => {
  const rel = `articles/${contest.id}.md`;
  const article = parseArticle(fs.readFileSync(path.join(ballotDir, rel), "utf8"));
  const ids = new Set(contest.blocks.map((b) => b.subject).filter((s) => s !== "_race"));
  const measure = contest.type === "measure";
  return article.claims.map((claim) => {
    // coverage passed, so the article's blocks are the contest's, in order.
    const block = contest.blocks[article.blocks.indexOf(claim.block)];
    const snapshot = resolveTarget(claim.target);
    const read = readSnapshot(snapshot);
    const section = claim.section.name;
    const name = section.replace(/^[A-Z]\. /, "");
    const [, dir, filedUnder] = snapshot.split("/");
    const reasons = new Set();
    if (!measure && dir !== "_ballot") {
      if (SAYS_TAG.test(claim.tag) && read.fields?.owner !== block.subject)
        reasons.add("attribution");
      if (dir === contest.id && filedUnder !== block.subject && ids.has(filedUnder))
        reasons.add("misfiled");
    }
    if (ALWAYS_REVIEWED[contest.type].includes(name)) reasons.add("always-reviewed");
    if (claim.tag === "T2i") reasons.add("t2i");
    if (hasAllegation(claim.text) || hasAllegation(claim.excerpt)) reasons.add("allegation-word");
    const key = claimKey({
      subject: measure ? contest.id : block.subject,
      section,
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
      verbatim: isVerbatim(claim.text, claim.excerpt),
    };
  });
};

// Does `run` (check or coverage) pass? Its own failures say why; a failure
// that is not one of an article's (deps-missing, a bad ballot.yaml) stops the
// command.
const passes = (run) => {
  try {
    run();
    return true;
  } catch (error) {
    if (error instanceof Failures) return false;
    throw error;
  }
};

// Everything review-list reads of one contest: its claims and unfetchable
// items. Fails when the article is missing or check or coverage fails it.
const loadContest = (ballotDir, contests, id, ctx) => {
  const rel = `articles/${id}.md`;
  const contest = contests.get(id);
  if (!contest) throw new Failure(rel, "unknown-contest");
  if (!lstat(ballotDir, rel)?.isFile()) throw new Failure(rel, "file-missing");
  if (!passes(() => check(ballotDir, [id]))) throw new Failure(rel, "check-failed");
  if (!passes(() => coverage(ballotDir, [id]))) throw new Failure(rel, "coverage-failed");
  return {
    claims: readClaims(ballotDir, contest, ctx.readSnapshot),
    entries: ctx.entries ? entryItems(ballotDir, id, ctx.entries(), ctx.readSnapshot) : [],
  };
};

// The list (review-list.md, What goes on it): one item per key, claims in
// article order, then unfetchable entries. `accepted` is the accepted set and
// `flags` the neutrality pass's; on a first run, a claim not found whole in its
// excerpt goes on too. An item listed only because its key is not accepted
// leaves once it is.
const buildList = ({ claims, entries }, { accepted, flags, first }) => {
  const items = new Map();
  for (const c of claims) {
    const reasons = new Set(c.reasons);
    if (flags.has(c.key)) reasons.add("neutrality");
    if (first && !c.verbatim) reasons.add("not-verbatim");
    const item = items.get(c.key);
    if (item) for (const r of reasons) item.reasons.add(r);
    else items.set(c.key, { ...c, reasons });
  }
  for (const item of items.values())
    if (!first && !item.reasons.size && !accepted.has(item.key)) item.reasons.add("unaccepted");
  return [
    ...[...items.values()].filter((item) => item.reasons.size),
    ...entries.map((e) => ({ ...e, reasons: new Set() })),
  ];
};

// Every claim and unfetchable key accepted (review-list.md, Clearing it);
// check and coverage have passed.
const allAccepted = ({ claims, entries }, accepted) =>
  [...claims, ...entries].every((item) => accepted.has(item.key));

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
      `- ${box} ${text} \`${tag}\` [${label}](../${item.snapshot}) <!-- id:${item.key} -->`,
      `  > ${excerpt}`,
      `  - why: ${why} (${item.at})`,
      ...(flags.get(item.key) ?? []).map((reason) => `  - neutrality: ${reason}`),
    );
  }
  if (list.length) lines.push("");
  lines.push(`<!-- accepted: ${[...accepted].join(" ")} -->`, "");
  return lines.join("\n");
};

// Write one contest's review file (review-list.md, Command line), or fail
// without writing anything.
const writeReview = (ballotDir, contests, id, ctx) => {
  const loaded = loadContest(ballotDir, contests, id, ctx);
  checkReviewDir(ballotDir);
  // Checked before any write, since a first run never reads the file.
  const reviewRel = `review/${id}.md`;
  const existing = lstat(ballotDir, reviewRel);
  if (existing && !existing.isFile()) throw new Failure(reviewRel, "review-invalid");
  const { first, keys: before } = readAccepted(ballotDir, id);
  const neutrality = readNeutrality(ballotDir, id);
  const claimKeys = new Set(loaded.claims.map((c) => c.key));
  const neutralityRel = `review/${id}.neutrality.md`;
  const flags = neutrality?.flags ?? new Map();

  let marks = [];
  if (first) {
    if (!neutrality) throw new Failure(neutralityRel, "neutrality-missing");
    const { reviewed } = neutrality;
    const exact = reviewed.size === claimKeys.size && [...claimKeys].every((k) => reviewed.has(k));
    if (!exact) throw new Failure(`${neutralityRel}:1`, "neutrality-stale");
  } else {
    // A mark counts only for an item on this run's list.
    const listed = new Set(buildList(loaded, { accepted: before, flags, first }).map((i) => i.key));
    marks = [...new Set(readMarks(ballotDir, id))].filter((k) => listed.has(k) && !before.has(k));
  }
  const accepted = new Set([...before, ...marks]);
  const unread = [...claimKeys].filter((k) => !accepted.has(k) && !neutrality?.reviewed.has(k));
  if (unread.length)
    throw new Failure(
      neutrality ? `${neutralityRel}:1` : neutralityRel,
      neutrality ? "neutrality-stale" : "neutrality-missing",
    );

  const list = buildList(loaded, { accepted, flags, first });
  const lines = [];
  fs.mkdirSync(path.join(ballotDir, "review"), { recursive: true });
  if (first) {
    const onList = new Set(list.map((item) => item.key));
    const baseline = [...claimKeys].filter((k) => !onList.has(k));
    for (const k of baseline) accepted.add(k);
    // Written once: an existing file, or a link put in its place, fails.
    fs.writeFileSync(
      path.join(ballotDir, `review/${id}.baseline`),
      baseline.map((k) => `${k}\n`).join(""),
      { flag: "wx" },
    );
    lines.push(`review/${id}.baseline written`);
  }
  if (marks.length)
    appendLine(path.join(ballotDir, `review/${id}.accepted`), marks.map((k) => `${k}\n`).join(""));
  fs.writeFileSync(path.join(ballotDir, reviewRel), render(id, list, accepted, flags));
  lines.push(`${reviewRel} written`);
  lines.push(`articles/${id}.md ${allAccepted(loaded, accepted) ? "ready" : "not-ready"}`);
  return lines;
};

// --keys: each claim's location, whether its key is accepted, and its key.
const printKeys = (ballotDir, contests, id, ctx) => {
  const { claims } = loadContest(ballotDir, contests, id, ctx);
  checkReviewDir(ballotDir);
  const { keys } = readAccepted(ballotDir, id);
  return claims.map((c) => `${c.at} ${keys.has(c.key) ? "accepted" : "unaccepted"} ${c.key}`);
};

// A host name of dot-separated LDH labels, at least two, whose last label is
// not all digits, or null.
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
    host.length <= 253 &&
    labels.length >= 2 &&
    labels.every((label) => LDH_LABEL.test(label)) &&
    !/^[0-9]+$/.test(labels.at(-1));
  return valid ? host : null;
};

// --refused-hosts: the hosts of the current discovery run's domain refusals.
const refusedHosts = (ballotDir, contests, id) => {
  const contest = contests.get(id);
  if (!contest) throw new Failure(`articles/${id}.md`, "unknown-contest");
  const log = readSearchLog(ballotDir, id, contest.type);
  if (log.faults.length) throw new Failure(`search-log/${id}.tsv`, "search-log-invalid");
  const since = log.latest ?? "";
  const hosts = new Set();
  let other = 0;
  for (const entry of readUnfetchable(ballotDir)) {
    if (entry.contest !== id || entry.reason !== DOMAIN_REFUSED || entry.date < since) continue;
    const host = ldhHost(entry.url);
    if (host) hosts.add(host);
    else other++;
  }
  const lines = [...hosts].sort().map((host) => `${id} domain-not-in-tiers ${host}`);
  if (other) lines.push(`${id} other-hosts ${other}`);
  return lines.length ? lines : [`${id} no-refused-hosts`];
};

// Is the contest ready (review-list.md, Clearing it)? publish's contest gate
// calls this holding the ballot lock. Returns { ready, reasons }, reasons
// being the codes that keep it from being ready: unknown-contest,
// file-missing, check-failed, coverage-failed, not-reviewed (no baseline),
// review-missing (a baseline with no review file) or unaccepted.
const ready = (ballotDir, id) => {
  const YAML = load("yaml");
  const contests = readContests(ballotDir);
  const ctx = {
    readSnapshot: snapshotReader(ballotDir, YAML),
    entries: () => readUnfetchable(ballotDir),
  };
  let loaded;
  try {
    loaded = loadContest(ballotDir, contests, id, ctx);
  } catch (error) {
    const own = ["unknown-contest", "file-missing", "check-failed", "coverage-failed"];
    if (error instanceof Failure && own.includes(error.code))
      return { ready: false, reasons: [error.code] };
    throw error;
  }
  checkReviewDir(ballotDir);
  const { first, keys } = readAccepted(ballotDir, id);
  const reasons = [];
  if (first) reasons.push("not-reviewed");
  else if (!lstat(ballotDir, `review/${id}.md`)?.isFile()) reasons.push("review-missing");
  if (!allAccepted(loaded, keys)) reasons.push("unaccepted");
  return { ready: reasons.length === 0, reasons };
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
  // Loaded first, so a missing install is one deps-missing, not a failure per contest.
  const YAML = load("yaml");
  const contests = readContests(ballotDir);
  if (mode === "--refused-hosts") return refusedHosts(ballotDir, contests, given[0]);
  let entries;
  const ctx = {
    readSnapshot: snapshotReader(ballotDir, YAML),
    // Read once, and only by the write form.
    entries: mode ? null : () => (entries ??= readUnfetchable(ballotDir)),
  };
  const run = mode === "--keys" ? printKeys : writeReview;
  const lines = [];
  let failed = false;
  for (const id of given.length ? given : allContests(ballotDir)) {
    try {
      lines.push(...run(ballotDir, contests, id, ctx));
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
    // Under the ballot lock, so a save or log line written now is never half seen.
    return withLock(ballotDir, () => reviewList(ballotDir, args));
  });

module.exports = { claimKey, entryKey, isVerbatim, main, ready };
