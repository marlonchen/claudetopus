"use strict";

// publish's ballot gate (SKILL.md step 6.1), which refuses the whole publish:
// ballot-check passes, every snapshot matches snapshots.sha256, and review/,
// tiers.yaml, snapshots.sha256 and search-log/ are exactly as committed, so
// every acceptance, tier, hash and search is in one of the researcher's
// commits. The caller holds the ballot lock. Failures are `location code
// [key]` lines (Rule 5): a path is named only by its area, never by a file
// name, which a planted file can take from private text.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { check: checkBallot } = require("./ballot-check");
const { Failure, Failures } = require("./output");
const { verifyManifest } = require("./snapshot-hash");

// Room for a long history's output, which spawnSync caps at 1MB by default.
const MAX_OUTPUT = 1024 * 1024 * 1024;

// git in the data repo: its result, `input` sent to its stdin.
const runGit = (root, args, input) =>
  spawnSync("git", args, { cwd: root, input, maxBuffer: MAX_OUTPUT });
// Does git succeed (a path is tracked, HEAD exists)?
const gitSays = (root, args) => runGit(root, args).status === 0;
// git's output as a Buffer, or git-failed.
const git = (root, args, input) => {
  const result = runGit(root, args, input);
  if (result.status !== 0 || result.error) throw new Failure(".", "git-failed");
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
// Is a repo path the area itself or under it?
const within = (file, area) => file === area.path || file.startsWith(`${area.path}/`);

// The areas holding anything not exactly as committed: a change, staged or
// not, an untracked or ignored file (`git status --porcelain --ignored`, so an
// ignore rule cannot fake "committed"), a file git is told to assume
// unchanged or skip, or a file present that git does not track.
const uncommitted = (root, ballot) => {
  const areas = areasOf(ballot);
  const paths = areas.map((a) => a.path);
  const dirty = new Set();
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
    "--no-renames",
    "--",
    ...paths,
  ]);
  for (const entry of status.toString("utf8").split("\0").filter(Boolean))
    dirty.add(entry.slice(3).replace(/\/$/, ""));
  // A lowercase tag is assume-unchanged, S is skip-worktree: both hide edits.
  const listed = git(root, ["ls-files", "-v", "-z", "--", ...paths]);
  for (const entry of listed.toString("utf8").split("\0").filter(Boolean))
    if (/^([a-z]|S) /.test(entry)) dirty.add(entry.slice(2));
  for (const area of areas) {
    if (!fs.lstatSync(path.join(root, area.path), { throwIfNoEntry: false })?.isFile()) continue;
    if (!gitSays(root, ["ls-files", "--error-unmatch", "--", area.path])) dirty.add(area.path);
  }
  return areas
    .filter((area) => [...dirty].some((file) => within(file, area)))
    .map((area) => new Failure(area.at, "uncommitted").line);
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
    if (type !== "blob") throw new Failure(".", "git-failed");
    const start = end + 1;
    blobs.set(hash, out.toString("utf8", start, start + Number(size)));
    at = start + Number(size) + 1;
  }
  return blobs;
};

// The append-only files whose history the gate reads, by their path in the
// ballot directory: what each one's commits may do to it.
const ID = "[a-z0-9]+(?:-[a-z0-9]+)*";
const LOGGED = [
  // snapshots.sha256 and each search log only grow (SKILL.md step 6.1).
  { pattern: /^snapshots\.sha256$/, kind: "log" },
  { pattern: new RegExp(`^search-log/${ID}\\.tsv$`), kind: "log" },
  // .accepted only grows, but the next append drops a torn last line, and a
  // reset commit removes it (review-list.md, Accepted keys).
  { pattern: new RegExp(`^review/(${ID})\\.accepted$`), kind: "accepted" },
  // The baseline is written once; only a reset commit changes it.
  { pattern: new RegExp(`^review/(${ID})\\.baseline$`), kind: "baseline" },
];

// The text up to its last newline: a torn last line is not a line yet.
const completeLines = (text) => text.slice(0, text.lastIndexOf("\n") + 1);

// Every commit reachable from HEAD that lost a line of an append-only file,
// or changed a baseline outside a `reset review <contest>` commit, compared
// with the commit before it (a merge with its first parent), located by the
// file and keyed by the commit.
const history = (root, ballot) => {
  if (!gitSays(root, ["rev-parse", "--verify", "-q", "HEAD"])) return [];
  const log = git(root, [
    "log",
    "--diff-merges=first-parent",
    "--topo-order",
    "--reverse",
    "--no-renames",
    "--raw",
    "--no-abbrev",
    "-z",
    "--format=%x01%H%x00%s",
    "--",
    `${ballot}/snapshots.sha256`,
    `${ballot}/search-log`,
    `${ballot}/review`,
  ]).toString("utf8");
  // Each change as { commit, subject, rel, rule, contest, old, new }, old and
  // new being blob hashes, null where the file is absent.
  const changes = [];
  const ZERO = /^0+$/;
  for (const record of log.split("\x01").filter(Boolean)) {
    const [commit, subject, ...rest] = record.split("\0");
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const [, , oldHash, newHash] = rest[i].trim().slice(1).split(" ");
      const rel = rest[i + 1].slice(ballot.length + 1);
      const rule = LOGGED.find((r) => r.pattern.test(rel));
      if (!rule) continue;
      changes.push({
        commit,
        subject,
        rel,
        kind: rule.kind,
        contest: rule.pattern.exec(rel)[1],
        old: ZERO.test(oldHash) ? null : oldHash,
        new: ZERO.test(newHash) ? null : newHash,
      });
    }
  }
  const blobs = readBlobs(root, [
    ...new Set(changes.flatMap((c) => [c.old, c.new]).filter(Boolean)),
  ]);
  const lines = [];
  for (const c of changes) {
    if (c.old === null) continue;
    const reset = c.subject === `reset review ${c.contest}`;
    const before = blobs.get(c.old);
    const after = c.new === null ? "" : blobs.get(c.new);
    if (c.kind === "baseline" && !reset)
      lines.push(new Failure(c.rel, "baseline-changed", c.commit).line);
    const kept = c.kind === "accepted" ? completeLines(before) : before;
    if ((c.kind === "log" || (c.kind === "accepted" && !reset)) && !after.startsWith(kept))
      lines.push(new Failure(c.rel, "history-lost-line", c.commit).line);
  }
  return lines;
};

// Throws Failures holding every refusal found, or returns nothing.
const ballotGate = (root, ballot, ballotDir) => {
  const lines = [];
  try {
    checkBallot(root, ballot, ballotDir, /* show */ false);
  } catch (error) {
    if (!(error instanceof Failures || error instanceof Failure)) throw error;
    // ballot-check's own lines say why; running it shows them.
    lines.push(new Failure("ballot.yaml", "ballot-check-failed").line);
  }
  lines.push(...verifyManifest(ballotDir).map((f) => f.line));
  lines.push(...uncommitted(root, ballot));
  lines.push(...history(root, ballot));
  if (lines.length) throw new Failures(lines);
};

module.exports = { ballotGate };
