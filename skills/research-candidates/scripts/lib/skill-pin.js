"use strict";

// publish's installed-skill check, part of its ballot gate (SKILL.md step
// 6.1): the installed skill must be the source repo's tree at skill_commit,
// read through `gh api repositories/<id>/...` by its recorded id (Rule 8).
// It catches accidental drift, never a hostile edit to publish itself.
// Failures are `location code [key]` lines (Rule 5).

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { spawnSync } = require("node:child_process");
const { SOURCE_REPO_ID } = require("./constants");
const { load } = require("./deps");
const { Failure } = require("./output");
const { printable } = require("./terminal");

const SKILL = ".claude/skills/research-candidates";
const SOURCE_DIR = "skills/research-candidates/";
// Room for the source repo's whole tree.
const MAX_OUTPUT = 64 * 1024 * 1024;

// Operating-system and editor leftovers, which the check skips when they
// are regular files outside the tree.
const isLeftover = (rel) => /(?:^|\/)(?:\.DS_Store|Thumbs\.db|[^/]*\.swp)$/.test(rel);

const unread = () => new Failure("publish.yaml", "skill-commit-unread", "skill_commit");

// One `gh api` call to the source repo by its recorded id, as parsed JSON;
// skill-commit-unread when gh fails or prints anything else.
const sourceApi = (root, endpoint) => {
  const result = spawnSync("gh", ["api", `repositories/${SOURCE_REPO_ID}${endpoint}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: MAX_OUTPUT,
  });
  if (result.status !== 0 || result.error) throw unread();
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw unread();
  }
};

// The skill's files at `commit`, as a Map from each path under the skill to
// its blob hash.
const sourceTree = (root, commit) => {
  const tree = sourceApi(root, `/commits/${commit}`)?.commit?.tree?.sha;
  if (typeof tree !== "string" || !/^[0-9a-f]{40}$/.test(tree)) throw unread();
  const listing = sourceApi(root, `/git/trees/${tree}?recursive=1`);
  if (listing?.truncated !== false || !Array.isArray(listing.tree)) throw unread();
  const files = new Map();
  for (const entry of listing.tree)
    if (entry.type === "blob" && entry.path.startsWith(SOURCE_DIR))
      files.set(entry.path.slice(SOURCE_DIR.length), entry.sha);
  return files;
};

// A blob's bytes, by its hash.
const sourceBlob = (root, sha) => {
  const blob = sourceApi(root, `/git/blobs/${sha}`);
  if (blob?.encoding !== "base64" || typeof blob.content !== "string") throw unread();
  return Buffer.from(blob.content, "base64");
};

// A file's git blob hash, as `git hash-object --no-filters` computes it.
const blobHash = (bytes) =>
  crypto.createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

// SKILL.md's parsed front matter and its body with blank lines at its start
// removed, or null when it has no front matter YAML can read.
const FRONT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const splitSkillMd = (text) => {
  const m = FRONT.exec(text);
  if (!m) return null;
  try {
    const front = load("yaml").parse(m[1]);
    if (front === null || typeof front !== "object" || Array.isArray(front)) return null;
    return { front, body: text.slice(m[0].length).replace(/^(?:[ \t]*\r?\n)+/, "") };
  } catch {
    return null;
  }
};

// Does the installed SKILL.md differ from the source's only as gh skill
// install rewrites it: the front matter re-serialized with a `metadata` key
// added, and the blank line after it dropped?
const installedAs = (installed, source) => {
  const [a, b] = [splitSkillMd(installed.toString("utf8")), splitSkillMd(source.toString("utf8"))];
  if (!a || !b) return false;
  const { metadata, ...front } = a.front;
  return a.body === b.body && isDeepStrictEqual(front, b.front);
};

// Every file and symlink under `dir`, ignored ones included, by its path
// from `dir` with `/` separators: [path, lstat] pairs, sorted.
const onDisk = (dir) => {
  const found = [];
  const walk = (rel) => {
    for (const name of fs.readdirSync(path.join(dir, rel)).sort()) {
      const sub = rel ? `${rel}/${name}` : name;
      const stat = fs.lstatSync(path.join(dir, sub));
      if (stat.isDirectory()) walk(sub);
      else found.push([sub, stat]);
    }
  };
  walk("");
  return found;
};

// The skill's files on disk, against its tree at `commit`: each one changed,
// extra, missing or a symlink, by its path.
const drift = (root, commit) => {
  const tree = sourceTree(root, commit);
  const dir = path.join(root, SKILL);
  const found = [];
  const seen = new Set();
  for (const [rel, stat] of onDisk(dir)) {
    seen.add(rel);
    if (stat.isSymbolicLink()) {
      found.push([rel, "skill-symlink"]);
      continue;
    }
    const sha = tree.get(rel);
    if (sha === undefined) {
      if (!(isLeftover(rel) && stat.isFile())) found.push([rel, "skill-extra"]);
      continue;
    }
    // A FIFO or socket is never read, which could wait forever.
    const bytes = stat.isFile() ? fs.readFileSync(path.join(dir, rel)) : null;
    if (bytes && blobHash(bytes) === sha) continue;
    if (bytes && rel === "SKILL.md" && installedAs(bytes, sourceBlob(root, sha))) continue;
    found.push([rel, "skill-changed"]);
  }
  for (const rel of tree.keys()) if (!seen.has(rel)) found.push([rel, "skill-missing"]);
  return found
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([rel, code]) => new Failure(`${SKILL}/${printable(rel)}`, code).line);
};

// Is the skill installed as a real directory, reached through no symlink
// below .claude? A refusal when not.
const notInstalled = (root) => {
  for (const at of [".claude/skills", SKILL]) {
    const stat = fs.lstatSync(path.join(root, at), { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) return new Failure(at, "skill-symlink");
    if (!stat?.isDirectory()) return new Failure(SKILL, "skill-not-installed");
  }
  return null;
};

// git in the data repo, its output as text, or git-failed. Replace refs can
// change what git reports.
const git = (root, args) => {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    maxBuffer: MAX_OUTPUT,
  });
  if (result.status !== 0 || result.error) throw new Failure(".", "git-failed");
  return result.stdout;
};

// Does the installed skill hold a change git has not committed: staged or
// not, an untracked or ignored file (so an ignore rule cannot fake
// "committed"), or a file git is told to assume unchanged or skip? The
// leftovers the tree check skips are skipped here too.
const uncommitted = (root) => {
  const spec = `:(icase)${SKILL}`;
  const status = git(root, [
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored=matching",
    "--untracked-files=all",
    "--no-renames",
    "--",
    spec,
  ]);
  if (status.split("\0").some((entry) => entry && !isLeftover(entry.slice(3)))) return true;
  // A lowercase tag is assume-unchanged, S is skip-worktree: both hide edits.
  const listed = git(root, ["ls-files", "-v", "-z", "--", spec]);
  return listed.split("\0").some((entry) => /^([a-z]|S) /.test(entry));
};

// skill_commit: a full commit id, never a branch or tag name, which moves, or
// a short id, which can grow ambiguous.
const COMMIT = /^[0-9a-f]{40}$/;

// Is `commit` reachable from the source repo's default branch, as the API
// names it? A commit only on another branch, or only in a fork (whose
// commits the network's parent serves too), is not.
const onDefaultBranch = (root, commit) => {
  const branch = sourceApi(root, "")?.default_branch;
  if (typeof branch !== "string" || branch === "") throw unread();
  const status = sourceApi(root, `/compare/${branch}...${commit}`)?.status;
  return status === "behind" || status === "identical";
};

// Every refusal of the installed skill, as report lines.
const skillPin = (root, config) => {
  const missing = notInstalled(root);
  if (missing) return [missing.line];
  const lines = uncommitted(root) ? [new Failure(SKILL, "skill-uncommitted").line] : [];
  const commit = config.skill_commit;
  if (typeof commit !== "string" || !COMMIT.test(commit))
    return [...lines, new Failure("publish.yaml", "publish-invalid", "skill_commit").line];
  try {
    if (!onDefaultBranch(root, commit))
      return [
        ...lines,
        new Failure("publish.yaml", "skill-commit-off-default", "skill_commit").line,
      ];
    return [...lines, ...drift(root, commit)];
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return [...lines, error.line];
  }
};

module.exports = { skillPin };
