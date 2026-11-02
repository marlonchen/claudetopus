"use strict";

// publish --push, SKILL.md steps 6.4-6.6: check the Pages repo, copy the page
// publish scanned into it as <slug>/index.html, show the researcher what
// changes and what becomes public, and commit and push it only after their
// yes at their own terminal. The page URL is printed only once the push
// succeeds; a rejected push is reported and its commit left for them.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DEVICE_CHECK, PAGE_BUDGET, SOURCE_REPO_ID } = require("./constants");
const { Failure } = require("./output");
const { githubRepo, remoteUrls, repoFacts } = require("./repo-guard");
const { withLock, writeSynced } = require("./snapshot-store");
const { confirm, printable } = require("./terminal");

const WHERE = "pages_dir";
// The ballot's record of the slugs it has published (SKILL.md Layout).
const RECORD = "published.log";
const LOCK = "research-candidates-publish.lock";
const SKILL_FILE = /^skills\/[^/]+\/SKILL\.md$/i;
const PAGES_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

// git in the Pages repo. Its diff of a whole page can be large.
const git = (dir, args, options = {}) =>
  spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
// stdout, or null when git fails.
const run = (dir, args) => {
  const result = git(dir, args);
  return result.status === 0 && !result.error ? result.stdout : null;
};
const must = (dir, args) => {
  const out = run(dir, args);
  if (out === null) throw new Failure(WHERE, "git-failed");
  return out;
};
// git with the researcher's terminal, for the steps that may ask for a
// credential or a signing passphrase; true when it succeeds.
const interactive = (dir, args) => git(dir, args, { stdio: "inherit" }).status === 0;

// publish.yaml's Pages fields, each checked before it is used.
const pagesConfig = (config) => {
  const invalid = (key) => new Failure("publish.yaml", "publish-invalid", key);
  const { pages_repo: repo, pages_dir: dir, branch } = config;
  if (typeof repo !== "string" || !PAGES_REPO.test(repo) || /\.git$/i.test(repo))
    throw invalid("pages_repo");
  if (typeof dir !== "string" || dir.trim() === "") throw invalid("pages_dir");
  if (
    typeof branch !== "string" ||
    branch.startsWith("-") ||
    run(process.cwd(), ["check-ref-format", "--branch", branch]) === null
  )
    throw invalid("branch");
  return { repo, dir, branch };
};

// pages_dir with ~ expanded, resolved to a real path, and the top level of
// its own git repo.
const resolvePagesDir = (root, given) => {
  const expanded = given === "~" || given.startsWith("~/") ? os.homedir() + given.slice(1) : given;
  let dir;
  try {
    dir = fs.realpathSync(path.resolve(root, expanded));
  } catch {
    throw new Failure(WHERE, "pages-not-repo");
  }
  const top = run(dir, ["rev-parse", "--show-toplevel"]);
  if (top === null || fs.realpathSync(top.trim()) !== dir)
    throw new Failure(WHERE, "pages-not-repo");
  return dir;
};

const commonDir = (dir) =>
  fs.realpathSync(path.resolve(dir, must(dir, ["rev-parse", "--git-common-dir"]).trim()));
const rootCommits = (dir) =>
  must(dir, ["rev-list", "--max-parents=0", "--all"]).split("\n").filter(Boolean);

// Does a commit's tree hold a skills/*/SKILL.md? null when it cannot be read.
const treeHoldsSkill = (dir, commit) => {
  const names = run(dir, ["ls-tree", "-r", "-z", "--name-only", commit]);
  return names === null ? null : names.split("\0").some((name) => SKILL_FILE.test(name));
};
const refuseSkillAt = (dir, commit, ref) => {
  const holds = treeHoldsSkill(dir, commit);
  if (holds === null) throw new Failure(WHERE, "pages-ref-unread", ref);
  if (holds) throw new Failure(WHERE, "pages-holds-skill", ref);
};

// Does the working tree hold a skills/*/SKILL.md, in any letter case, as the
// tree check reads it?
const worktreeHoldsSkill = (dir) => {
  const entries = (at) => {
    try {
      return fs.readdirSync(at, { withFileTypes: true });
    } catch {
      return [];
    }
  };
  return entries(dir)
    .filter((top) => top.isDirectory() && /^skills$/i.test(top.name))
    .flatMap((top) => entries(path.join(dir, top.name)).filter((e) => e.isDirectory()))
    .some((skill) =>
      entries(path.join(skill.parentPath, skill.name)).some((f) => /^SKILL\.md$/i.test(f.name)),
    );
};

// HEAD's commit, or null on an unborn branch.
const headCommit = (dir) =>
  run(dir, ["rev-parse", "--verify", "-q", "HEAD^{commit}"])?.trim() || null;

// Step 6.4: refuse a Pages repo that could take the page anywhere but a
// clean, current clone of pages_repo. Returns origin/<branch>'s commit, which
// HEAD is at, or null for a new, empty Pages repo.
const checkPages = (root, { repo, dir: given, branch }) => {
  const dir = resolvePagesDir(root, given);
  if (dir === fs.realpathSync(root) || commonDir(dir) === commonDir(root))
    throw new Failure(WHERE, "pages-is-data-repo");
  // Root commits, never a fetch of one repo into the other.
  const dataRoots = new Set(rootCommits(root));
  if (rootCommits(dir).some((commit) => dataRoots.has(commit)))
    throw new Failure(WHERE, "pages-shares-history");
  const origin = remoteUrls(dir, "origin");
  if (
    !origin?.length ||
    origin.some((url) => githubRepo(url)?.toLowerCase() !== repo.toLowerCase())
  )
    throw new Failure(`${WHERE}:remote:origin`, "pages-wrong-origin");
  // Fork-network roots by id (Rule 8), for pages_repo and every remote URL.
  const repos = [["publish.yaml", repo, "pages_repo"]];
  for (const name of must(dir, ["remote"]).split("\n").filter(Boolean)) {
    const urls = remoteUrls(dir, name);
    if (!urls) throw new Failure(`${WHERE}:remote:${name}`, "pages-root-unread");
    for (const url of urls) repos.push([`${WHERE}:remote:${name}`, githubRepo(url)]);
  }
  for (const [location, name, key] of repos) {
    const rootId = name && repoFacts(dir, name).rootId;
    if (!rootId) throw new Failure(location, "pages-root-unread", key);
    if (rootId === SOURCE_REPO_ID) throw new Failure(location, "pages-skill-source", key);
  }
  if (worktreeHoldsSkill(dir)) throw new Failure(WHERE, "pages-holds-skill");
  if (run(dir, ["symbolic-ref", "-q", "HEAD"])?.trim() !== `refs/heads/${branch}`)
    throw new Failure(WHERE, "pages-wrong-branch");
  if (must(dir, ["status", "--porcelain"]) !== "") throw new Failure(WHERE, "pages-dirty");

  if (!interactive(dir, ["fetch", "-q", "origin"])) throw new Failure(WHERE, "pages-fetch-failed");
  const tracking = `refs/remotes/origin/${branch}`;
  let tip = null;
  if (run(dir, ["show-ref", "--verify", "-q", tracking]) !== null) {
    tip = run(dir, ["rev-parse", "--verify", "-q", `${tracking}^{commit}`])?.trim();
    if (!tip) throw new Failure(WHERE, "pages-ref-unread", `origin/${branch}`);
    refuseSkillAt(dir, tip, `origin/${branch}`);
  }
  // The remote's live default branch, which GitHub may serve from.
  const symref = run(dir, ["ls-remote", "--symref", "origin", "HEAD"]);
  if (symref === null) throw new Failure(WHERE, "pages-ref-unread", "origin/HEAD");
  const live = /^([0-9a-f]{40,64})\tHEAD$/m.exec(symref);
  if (live) refuseSkillAt(dir, live[1], "origin/HEAD");
  // A new, empty Pages repo has neither: no origin/<branch> and an unborn branch.
  if (headCommit(dir) !== tip) throw new Failure(WHERE, "pages-not-at-origin");
  return tip;
};

// The Pages repo's lock, in its git directory so the worktree stays clean.
// One run holds it from the checks to the push. A lock whose process is gone
// is taken over, by one run at a time: the taker holds a second lock while it
// reads the dead one and replaces it, so two runs never both take it.
const withPagesLock = async (dir, body) => {
  const lock = path.join(commonDir(dir), LOCK);
  const mine = `${process.pid} ${crypto.randomBytes(8).toString("hex")}\n`;
  const create = (file) => {
    try {
      fs.writeFileSync(file, mine, { flag: "wx" });
      return true;
    } catch (error) {
      if (error.code === "EEXIST") return false;
      throw error;
    }
  };
  if (!create(lock)) {
    const breaker = `${lock}.break`;
    if (!create(breaker)) throw new Failure(WHERE, "pages-locked");
    try {
      let seen = "";
      try {
        seen = fs.readFileSync(lock, "utf8");
      } catch {}
      if (alive(Number.parseInt(seen, 10))) throw new Failure(WHERE, "pages-locked");
      fs.rmSync(lock, { force: true });
      if (!create(lock)) throw new Failure(WHERE, "pages-locked");
    } finally {
      fs.rmSync(breaker, { force: true });
    }
  }
  try {
    return await body();
  } finally {
    let held = "";
    try {
      held = fs.readFileSync(lock, "utf8");
    } catch {}
    if (held === mine) fs.rmSync(lock, { force: true });
  }
};
const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

const recordedSlugs = (ballotDir) => {
  try {
    return fs.readFileSync(path.join(ballotDir, RECORD), "utf8").split("\n");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
};

const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// Copy the scanned bytes to <slug>/index.html, re-hash the copy and the blob
// git staged, and stage only that path. Returns the blob's id and `restore`,
// which undoes both.
const stagePage = (dir, target, bytes) => {
  const file = path.join(dir, target);
  const existed = run(dir, ["cat-file", "-e", `HEAD:${target}`]) !== null;
  const restore = () => {
    if (existed) {
      run(dir, ["checkout", "-q", "HEAD", "--", target]);
    } else {
      run(dir, ["rm", "-q", "--cached", "--ignore-unmatch", "--", target]);
      fs.rmSync(file, { force: true });
      // The slug's folder too, when this run made it.
      try {
        fs.rmdirSync(path.dirname(file));
      } catch {}
    }
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeSynced(tmp, bytes, "w");
  fs.renameSync(tmp, file);
  try {
    if (sha256(fs.readFileSync(file)) !== sha256(bytes)) throw new Failure(target, "copy-mismatch");
    must(dir, ["add", "--", target]);
    // A clean filter or line-ending rule would stage other bytes than these.
    const blob = must(dir, ["hash-object", "--no-filters", "--", target]).trim();
    if (must(dir, ["rev-parse", `:${target}`]).trim() !== blob)
      throw new Failure(target, "copy-mismatch");
    return { blob, restore };
  } catch (error) {
    restore();
    throw error;
  }
};

// https://<owner>.github.io/<repo>/<slug>/, or a user site's own root.
const pageUrl = (repo, slug) => {
  const [owner, name] = repo.split("/");
  const host = `${owner.toLowerCase()}.github.io`;
  return name.toLowerCase() === host
    ? `https://${host}/${slug}/`
    : `https://${host}/${name}/${slug}/`;
};

const say = (text = "") => process.stdout.write(`${printable(text)}\n`);
const ident = (dir, variable) =>
  must(dir, ["var", variable]).replace(/ [0-9]+ [+-][0-9]{4}\n?$/, "");

// Steps 6.5-6.6 once the Pages repo has passed 6.4: copy, show, ask, commit,
// push. `page` is the scanned html; `contests` its { title, ready } list.
const pushPage = async ({ root, ballotDir, config, slug, page, contests, deviceCheck }) => {
  const pages = pagesConfig(config);
  const target = `${slug}/index.html`;
  const dir = resolvePagesDir(root, pages.dir);
  return withPagesLock(dir, async () => {
    const tip = checkPages(root, pages);
    const folder = fs.lstatSync(path.join(dir, slug), { throwIfNoEntry: false });
    const file = fs.lstatSync(path.join(dir, target), { throwIfNoEntry: false });
    // Never write through a link, or over something that is not a page.
    if ((folder && !folder.isDirectory()) || (file && !file.isFile()))
      throw new Failure(target, "pages-slug-invalid");
    // Another ballot's page, or one from before this ballot took the slug.
    if (file && !recordedSlugs(ballotDir).includes(slug))
      throw new Failure(target, "slug-unrecorded");
    const bytes = Buffer.from(page, "utf8");
    const { blob, restore } = stagePage(dir, target, bytes);
    try {
      say(`Changes to ${target}:`);
      for (const line of must(dir, [
        "diff",
        "--cached",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--",
        target,
      ]).split("\n"))
        say(line);
      say("Contests on the page, in ballot order:");
      for (const { title, ready } of contests)
        say(`  ${title}: ${ready ? "ready" : "Not ready yet"}`);
      say(`${target}: ${bytes.length} bytes`);
      if (bytes.length > PAGE_BUDGET) say("Warning: the page is over its 1MB budget (page.md).");
      say(
        "Once pushed, these are public for good, even after a later change: the contest list and " +
          "the candidate order, which can narrow down where a voter lives (some states rotate " +
          `candidate order by precinct); the display name ${config.display_name}; and the commit's author ` +
          `${ident(dir, "GIT_AUTHOR_IDENT")} and committer ${ident(dir, "GIT_COMMITTER_IDENT")}.`,
      );
      if (!folder || deviceCheck) {
        say("Device check (page.md), on real phones:");
        for (const [i, item] of DEVICE_CHECK.entries()) say(`  ${i + 1}. ${item}`);
        if (!(await confirm("Did the page pass every check? [y/N] ")))
          throw new Failure("device-check", "not-confirmed");
      }
      if (!(await confirm(`Commit ${target} and push it to ${pages.repo} ${pages.branch}? [y/N] `)))
        throw new Failure(target, "not-confirmed");
      // The push sends every commit HEAD has over origin/<branch>, so one
      // made in pages_dir while the questions were open would go public too.
      if (headCommit(dir) !== tip) throw new Failure(WHERE, "pages-not-at-origin");
    } catch (error) {
      restore();
      throw error;
    }
    // Recorded before the commit, so a crash after it never strands the slug.
    withLock(ballotDir, () => {
      if (!recordedSlugs(ballotDir).includes(slug))
        writeSynced(path.join(ballotDir, RECORD), `${slug}\n`, "a");
    });
    if (!interactive(dir, ["commit", "-q", "-m", `publish ${slug}`, "--", target])) {
      restore();
      throw new Failure(WHERE, "git-failed");
    }
    // The commit re-reads the file and runs the Pages repo's hooks: push it
    // only if it changed nothing but the page, to the bytes that were scanned,
    // and sits right on origin/<branch>, so it is all the push sends.
    const changed = must(dir, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "-r",
      "-z",
      "--name-only",
      "HEAD",
    ]);
    const parent = run(dir, ["rev-parse", "--verify", "-q", "HEAD^"])?.trim() || null;
    if (
      changed !== `${target}\0` ||
      must(dir, ["rev-parse", `HEAD:${target}`]).trim() !== blob ||
      parent !== tip
    )
      throw new Failure(target, "copy-mismatch");
    if (!interactive(dir, ["push", "origin", `HEAD:refs/heads/${pages.branch}`]))
      throw new Failure(target, "push-rejected");
    return [`${target} pushed`, pageUrl(pages.repo, slug)];
  });
};

module.exports = { pushPage };
