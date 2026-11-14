"use strict";

// publish's installed-skill check, part of its ballot gate (SKILL.md step
// 6.1): the installed skill must be the source repo's tree at skill_commit,
// read through `gh api repositories/<id>/...` by its recorded id (Rule 8).
// It catches accidental drift, never a hostile edit to publish itself.
// Failures are `location code [key]` lines (Rule 5). A path is named only when
// it comes from the source repo's public tree; a file or directory found only
// on disk, whose name a researcher or tool chose and which can hold private
// text, is located by its area alone, and only `--show` lists it (ADR 0006).

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
// One gh call gives up after this long, so a stalled one refuses rather than
// hangs publish; the ballot lock is refreshed after each call.
const GH_TIMEOUT_MS = 10_000;

// Operating-system and editor leftovers, which the check skips when they
// are regular files outside the tree.
const isLeftover = (rel) => /(?:^|\/)(?:\.DS_Store|Thumbs\.db|[^/]*\.swp)$/.test(rel);

const unread = () => new Failure("publish.yaml", "skill-commit-unread", "skill_commit");

// A function making one `gh api` call to the source repo on github.com by
// its recorded id, whatever GH_HOST says, and returning its parsed JSON;
// skill-commit-unread when gh fails, times out or prints anything else.
// `refresh` runs after each call.
const sourceApi = (root, refresh) => (endpoint) => {
  const result = spawnSync(
    "gh",
    ["api", "--hostname", "github.com", `repositories/${SOURCE_REPO_ID}${endpoint}`],
    { cwd: root, encoding: "utf8", maxBuffer: MAX_OUTPUT, timeout: GH_TIMEOUT_MS },
  );
  refresh();
  if (result.status !== 0 || result.error) throw unread();
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw unread();
  }
};

// The skill's files at `commit`, as a Map from each path under the skill to
// its blob hash.
const sourceTree = (api, commit) => {
  const tree = api(`/commits/${commit}`)?.commit?.tree?.sha;
  if (typeof tree !== "string" || !/^[0-9a-f]{40}$/.test(tree)) throw unread();
  const listing = api(`/git/trees/${tree}?recursive=1`);
  if (listing?.truncated !== false || !Array.isArray(listing.tree)) throw unread();
  const files = new Map();
  for (const entry of listing.tree)
    if (entry.type === "blob" && entry.path.startsWith(SOURCE_DIR))
      files.set(entry.path.slice(SOURCE_DIR.length), entry.sha);
  return files;
};

// A blob's bytes, by its hash.
const sourceBlob = (api, sha) => {
  const blob = api(`/git/blobs/${sha}`);
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

// The keys gh skill install adds under `metadata` (gh 2.103.3).
const GH_METADATA = new Set([
  "github-path",
  "github-pinned",
  "github-ref",
  "github-repo",
  "github-tree-sha",
]);

// Does the installed SKILL.md differ from the source's only as gh skill
// install rewrites it: the front matter re-serialized with gh's keys added
// under `metadata`, and the blank line after it dropped? Any other key under
// `metadata` must be the source's own.
const installedAs = (installed, source) => {
  const [a, b] = [splitSkillMd(installed.toString("utf8")), splitSkillMd(source.toString("utf8"))];
  if (!a || !b) return false;
  const { metadata, ...front } = a.front;
  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
    const kept = Object.entries(metadata).filter(([key]) => !GH_METADATA.has(key));
    if (kept.length) front.metadata = Object.fromEntries(kept);
  }
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

// A refusal located by `at` alone for paths found on disk, whose names can
// hold private text: its line and, with `show`, each path from the repo root
// on an indented line, with control characters replaced. None when `paths` is
// empty.
const byArea = (at, code, paths, show) =>
  paths.length
    ? [new Failure(at, code).line, ...(show ? paths.map((p) => `    ${printable(p)}`) : [])]
    : [];

// The skill's files on disk, against its tree at `commit`: each tree file
// changed or missing by its path, then any extra file or symlink by the
// skill's area alone (byArea).
const drift = (api, root, commit, show) => {
  const tree = sourceTree(api, commit);
  const dir = path.join(root, SKILL);
  const named = [];
  const extra = [];
  const linked = [];
  const seen = new Set();
  for (const [rel, stat] of onDisk(dir)) {
    seen.add(rel);
    if (stat.isSymbolicLink()) {
      linked.push(`${SKILL}/${rel}`);
      continue;
    }
    const sha = tree.get(rel);
    if (sha === undefined) {
      if (!(isLeftover(rel) && stat.isFile())) extra.push(`${SKILL}/${rel}`);
      continue;
    }
    // A FIFO or socket is never read, which could wait forever.
    const bytes = stat.isFile() ? fs.readFileSync(path.join(dir, rel)) : null;
    if (bytes && blobHash(bytes) === sha) continue;
    if (bytes && rel === "SKILL.md" && installedAs(bytes, sourceBlob(api, sha))) continue;
    named.push([rel, "skill-changed"]);
  }
  for (const rel of tree.keys()) if (!seen.has(rel)) named.push([rel, "skill-missing"]);
  return [
    ...byArea(SKILL, "skill-extra", extra, show),
    ...byArea(SKILL, "skill-symlink", linked, show),
    ...named
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([rel, code]) => new Failure(`${SKILL}/${printable(rel)}`, code).line),
  ];
};

// Is the skill installed as a real directory, reached through no symlink
// from the data repo's root? A refusal when not. A symlinked .claude would
// leave git tracking only the link, so the skill would be committed nowhere.
const notInstalled = (root) => {
  for (const at of [".claude", ".claude/skills", SKILL]) {
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

// The other directories under .claude/skills whose SKILL.md names itself
// research-candidates, such as a copy an upgrade renamed rather than
// deleted, by their paths from the repo root: Claude Code could load either.
const duplicates = (root) => {
  const skills = path.join(root, ".claude/skills");
  const found = [];
  for (const name of fs.readdirSync(skills).sort()) {
    if (name === path.basename(SKILL)) continue;
    const file = path.join(skills, name, "SKILL.md");
    // A FIFO or socket is never read, which could wait forever.
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    if (splitSkillMd(fs.readFileSync(file, "utf8"))?.front.name === path.basename(SKILL))
      found.push(`.claude/skills/${name}`);
  }
  return found;
};

// skill_commit: a full commit id, never a branch or tag name, which moves, or
// a short id, which can grow ambiguous.
const COMMIT = /^[0-9a-f]{40}$/;

// Is `commit` reachable from the source repo's default branch, as the API
// names it? A commit only on another branch, or only in a fork (whose
// commits the network's parent serves too), is not.
const onDefaultBranch = (api, commit) => {
  const branch = api("")?.default_branch;
  if (typeof branch !== "string" || branch === "") throw unread();
  const status = api(`/compare/${branch}...${commit}`)?.status;
  return status === "behind" || status === "identical";
};

// Every refusal of the installed skill, as report lines. `refresh` keeps the
// ballot lock fresh between gh calls; `show` (publish --show, researcher
// only) lists the paths a refusal located by its area found.
const skillPin = (root, config, { refresh, show }) => {
  const missing = notInstalled(root);
  if (missing) return [missing.line];
  const lines = uncommitted(root) ? [new Failure(SKILL, "skill-uncommitted").line] : [];
  lines.push(...byArea(".claude/skills", "skill-duplicate", duplicates(root), show));
  const commit = config.skill_commit;
  if (typeof commit !== "string" || !COMMIT.test(commit))
    return [...lines, new Failure("publish.yaml", "publish-invalid", "skill_commit").line];
  const api = sourceApi(root, refresh);
  try {
    if (!onDefaultBranch(api, commit))
      return [
        ...lines,
        new Failure("publish.yaml", "skill-commit-off-default", "skill_commit").line,
      ];
    return [...lines, ...drift(api, root, commit, show)];
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    return [...lines, error.line];
  }
};

module.exports = { skillPin };
