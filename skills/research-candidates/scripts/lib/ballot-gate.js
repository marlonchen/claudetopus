"use strict";

// publish's ballot gate (SKILL.md step 6.1), which refuses the whole publish:
// ballot-check passes, every snapshot matches snapshots.sha256, and review/,
// tiers.yaml, snapshots.sha256 and search-log/ are exactly as committed, so
// every acceptance, tier, hash and search is in one of the researcher's
// commits. The caller holds the ballot lock. Failures are `location code
// [key]` lines (Rule 5): a path is named only by its area, or by a contest id
// of ballot.yaml, never by any other file name, which a planted file can take
// from private text.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { check: checkBallot } = require("./ballot-check");
const { readContests } = require("./coverage");
const { Failure, Failures } = require("./output");
const { verifyManifest } = require("./snapshot-hash");

// Room for a long history's output, which spawnSync caps at 1MB by default.
const MAX_OUTPUT = 1024 * 1024 * 1024;
// Replace refs can change the parents and trees git reports.
const GIT_ENV = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };

// git in the data repo: its result, `input` sent to its stdin.
const runGit = (root, args, input) =>
  spawnSync("git", args, { cwd: root, input, env: GIT_ENV, maxBuffer: MAX_OUTPUT });
// Does git succeed (a path is tracked, HEAD exists)?
const gitSays = (root, args) => runGit(root, args).status === 0;
const gitFailed = () => new Failure(".", "git-failed");
// git's output as a Buffer, or git-failed.
const git = (root, args, input) => {
  const result = runGit(root, args, input);
  if (result.status !== 0 || result.error) throw gitFailed();
  return result.stdout;
};

// The areas that must be committed, each as its location and its path from
// the repo root.
const areasOf = (ballot) => [
  { at: "review", path: `${ballot}/review` },
  { at: "tiers.yaml", path: "tiers.yaml" },
  { at: "snapshots.sha256", path: `${ballot}/snapshots.sha256` },
  { at: "search-log", path: `${ballot}/search-log` },
];
// Is a repo path the area itself or under it? `fold` compares in any case.
const within = (file, area, fold = false) => {
  const [f, a] = fold ? [file.toLowerCase(), area.path.toLowerCase()] : [file, area.path];
  return f === a || f.startsWith(`${a}/`);
};
// A pathspec that matches the area in any case, so an area git tracks as
// `Review/` is still seen where a case-insensitive filesystem reads it.
const anyCase = (area) => `:(icase)${area.path}`;

// The areas not exactly as committed: `area-invalid` when one is a symlink,
// or is named in another case on disk or in git; `uncommitted` when one holds
// a change, staged or not, an untracked or ignored file (`git status
// --porcelain --ignored`, so an ignore rule cannot fake "committed"), or a
// file git is told to assume unchanged or skip.
const uncommitted = (root, ballot) => {
  const areas = areasOf(ballot);
  const specs = areas.map(anyCase);
  const misnamed = new Set();
  const dirty = new Set();
  for (const area of areas) {
    const file = path.join(root, area.path);
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) misnamed.add(area);
    const name = path.basename(file);
    const names = fs.existsSync(path.dirname(file)) ? fs.readdirSync(path.dirname(file)) : [];
    if (names.some((n) => n !== name && n.toLowerCase() === name.toLowerCase())) misnamed.add(area);
  }
  const areaOf = (file) => areas.find((area) => within(file, area, true));
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ...specs,
  ]);
  for (const entry of status.toString("utf8").split("\0").filter(Boolean))
    dirty.add(areaOf(entry.slice(3)));
  // A lowercase tag is assume-unchanged, S is skip-worktree: both hide edits.
  const listed = git(root, ["ls-files", "-v", "-z", "--", ...specs]);
  for (const entry of listed.toString("utf8").split("\0").filter(Boolean)) {
    const file = entry.slice(2);
    if (!areas.some((area) => within(file, area))) misnamed.add(areaOf(file));
    if (/^([a-z]|S) /.test(entry)) dirty.add(areaOf(file));
  }
  return areas.flatMap((area) => [
    ...(misnamed.has(area) ? [new Failure(area.at, "area-invalid").line] : []),
    ...(dirty.has(area) ? [new Failure(area.at, "uncommitted").line] : []),
  ]);
};

// Each blob's bytes, by its hash, read through one `git cat-file --batch`.
const readBlobs = (root, hashes) => {
  const blobs = new Map();
  if (!hashes.length) return blobs;
  const out = git(root, ["cat-file", "--batch"], `${hashes.join("\n")}\n`);
  let at = 0;
  for (const hash of hashes) {
    const end = out.indexOf(0x0a, at);
    const [, type, size] = out.toString("utf8", at, end).split(" ");
    if (type !== "blob") throw gitFailed();
    const start = end + 1;
    blobs.set(hash, out.toString("utf8", start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
};

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const RAW =
  /^:[0-7]{6} [0-7]{6} ([0-9a-f]{40}(?:[0-9a-f]{24})?) ([0-9a-f]{40}(?:[0-9a-f]{24})?) [A-Z][0-9]*$/;
const ZERO = /^0+$/;

// `git diff-tree -z --raw` output as { commit, old, new, path } changes, old
// and new being blob hashes, null where the file is absent. With no `commit`,
// each commit's changes follow its hash, as `--stdin` prints them. Anything
// else fails git-failed, so output the gate cannot read is never taken as no
// change.
const parseRaw = (out, commit) => {
  const tokens = out.toString("utf8").split("\0");
  if (tokens.pop() !== "") throw gitFailed();
  const changes = [];
  let at = commit;
  for (let i = 0; i < tokens.length; i++) {
    const raw = RAW.exec(tokens[i]);
    if (raw && at && i + 1 < tokens.length) {
      const [old, now] = [raw[1], raw[2]].map((h) => (ZERO.test(h) ? null : h));
      changes.push({ commit: at, old, new: now, path: tokens[++i] });
    } else if (commit === undefined && HASH.test(tokens[i])) at = tokens[i];
    else throw gitFailed();
  }
  return changes;
};

// What each commit may do to an append-only file, by its path in the ballot
// directory in lower case: its kind, the contest it is named for, and where
// a failure is located (the file for a contest of ballot.yaml, else its area).
const ruleOf = (rel, ids) => {
  if (rel === "snapshots.sha256") return { kind: "log", at: rel };
  const named = (kind, contest, area) => ({ kind, contest, at: ids.has(contest) ? rel : area });
  let m = /^search-log\/([^/]+)\.tsv$/.exec(rel);
  if (m) return named("log", m[1], "search-log");
  m = /^review\/([^/]+)\.(accepted|baseline)$/.exec(rel);
  if (m) return named(m[2], m[1], "review");
  return null;
};

// The text up to its last newline: a torn last line is not a line yet.
const completeLines = (text) => text.slice(0, text.lastIndexOf("\n") + 1);
// Does `after` still hold every complete line of `before`, as many times?
const keepsLines = (before, after) => {
  const left = new Map();
  for (const line of after.split("\n")) left.set(line, (left.get(line) ?? 0) + 1);
  return completeLines(before)
    .split("\n")
    .slice(0, -1)
    .every((line) => {
      const n = left.get(line) ?? 0;
      left.set(line, n - 1);
      return n > 0;
    });
};

// Every commit reachable from HEAD that lost a line of an append-only file,
// or changed a baseline outside a `reset review <contest>` commit that
// removes it, compared with each of its parents, located by the file and
// keyed by the commit. Against a merge's first parent each file must begin
// with all its text from it; against any other parent it must keep each of
// its lines. A merge changes a baseline only when it matches no parent's.
const history = (root, ballot, ids, refresh) => {
  if (!gitSays(root, ["rev-parse", "--verify", "-q", "HEAD"])) return [];
  // A shallow clone's oldest commit looks like a root, hiding the history before it.
  if (git(root, ["rev-parse", "--is-shallow-repository"]).toString().trim() !== "false")
    return [new Failure(".", "history-shallow").line];
  const commits = git(root, ["rev-list", "--topo-order", "--reverse", "--parents", "HEAD"])
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "));
  if (!commits.every((c) => c.every((h) => HASH.test(h)))) throw gitFailed();
  const specs = ["snapshots.sha256", "search-log", "review"].map((p) => `:(icase)${ballot}/${p}`);
  const diff = ["diff-tree", "-r", "--raw", "-z", "--no-renames", "--no-abbrev"];
  // Commits with one parent through one diff-tree; a merge once per parent.
  const changes = [];
  const single = commits.filter((c) => c.length === 2).map((c) => c[0]);
  if (single.length) {
    const out = git(root, [...diff, "--stdin", "--", ...specs], `${single.join("\n")}\n`);
    changes.push(...parseRaw(out).map((c) => ({ ...c, parent: 0 })));
  }
  for (const [commit, ...parents] of commits.filter((c) => c.length > 2)) {
    refresh();
    for (const [i, parent] of parents.entries()) {
      const out = git(root, [...diff, parent, commit, "--", ...specs]);
      changes.push(...parseRaw(out, commit).map((c) => ({ ...c, parent: i })));
    }
  }
  refresh();
  const order = new Map(commits.map(([c, ...parents], i) => [c, { i, parents: parents.length }]));
  const ruled = changes
    // A mode-only change keeps the blob.
    .filter((c) => c.old !== c.new)
    .map((c) => ({ ...c, rule: ruleOf(c.path.slice(ballot.length + 1).toLowerCase(), ids) }))
    .filter((c) => c.rule)
    .sort((a, b) => order.get(a.commit).i - order.get(b.commit).i || a.parent - b.parent);
  const blobs = readBlobs(root, [...new Set(ruled.flatMap((c) => [c.old, c.new]).filter(Boolean))]);
  const subjects = new Map();
  const subjectOf = (commit) => {
    if (!subjects.has(commit)) {
      const out = git(root, ["log", "-1", "--no-show-signature", "--format=%s", commit, "--"]);
      subjects.set(commit, out.toString("utf8").replace(/\n$/, ""));
    }
    return subjects.get(commit);
  };
  // review-list.md, Accepted keys: a reset commit removes the files.
  const isReset = (c) => c.new === null && subjectOf(c.commit) === `reset review ${c.rule.contest}`;
  const lines = new Set();
  for (const c of ruled) {
    if (c.old === null || (c.rule.kind !== "log" && isReset(c))) continue;
    const before = blobs.get(c.old);
    const after = c.new === null ? "" : blobs.get(c.new);
    if (c.rule.kind === "baseline") {
      const differs = ruled.filter((d) => d.commit === c.commit && d.path === c.path).length;
      if (differs === order.get(c.commit).parents)
        lines.add(new Failure(c.rule.at, "baseline-changed", c.commit).line);
      continue;
    }
    const kept = c.rule.kind === "accepted" ? completeLines(before) : before;
    const keeps = c.parent === 0 ? after.startsWith(kept) : keepsLines(before, after);
    if (!keeps) lines.add(new Failure(c.rule.at, "history-lost-line", c.commit).line);
  }
  return [...lines];
};

// The contest ids of ballot.yaml, which history failures may name; none when
// it cannot be read, which ballot-check reports.
const contestIds = (ballotDir) => {
  try {
    return new Set(readContests(ballotDir).keys());
  } catch (error) {
    if (error instanceof Failure) return new Set();
    throw error;
  }
};

// Throws Failures holding every refusal found, or returns nothing. `refresh`
// keeps the ballot lock fresh between its steps.
const ballotGate = (root, ballot, ballotDir, refresh) => {
  const lines = [];
  try {
    checkBallot(root, ballot, ballotDir, /* show */ false);
  } catch (error) {
    if (!(error instanceof Failures || error instanceof Failure)) throw error;
    // ballot-check's own lines say why; running it shows them.
    lines.push(new Failure("ballot.yaml", "ballot-check-failed").line);
  }
  refresh();
  lines.push(...verifyManifest(ballotDir).map((f) => f.line));
  refresh();
  lines.push(...uncommitted(root, ballot));
  lines.push(...history(root, ballot, contestIds(ballotDir), refresh));
  if (lines.length) throw new Failures(lines);
};

module.exports = { ballotGate };
