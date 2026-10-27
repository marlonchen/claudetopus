"use strict";

// Rule 8: run only in the private data repo. Before any command writes, the
// project root must hold publish.yaml, must not be a clone of this skill's
// source repo, and every fetch and push URL of every remote must be a private
// GitHub repo outside the source repo's fork network. A remote that cannot be
// confirmed private counts as public. Failures name the remote, never its URL.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { SOURCE_REPO_ID } = require("./constants");
const { Failure } = require("./output");

const run = (cmd, args, cwd) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return result.status === 0 && !result.error ? result.stdout : null;
};

// owner/repo from a GitHub remote URL (https, ssh or scp-like), or null.
const githubRepo = (url) => {
  const m =
    url.match(/^https:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
    url.match(/^ssh:\/\/git@github\.com(?::22)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i) ||
    url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
};

const remoteUrls = (root, name) => {
  const fetchUrls = run("git", ["remote", "get-url", "--all", name], root);
  const pushUrls = run("git", ["remote", "get-url", "--push", "--all", name], root);
  if (fetchUrls === null || pushUrls === null) return null;
  return [...fetchUrls.split("\n"), ...pushUrls.split("\n")].filter(Boolean);
};

const checkRemote = (root, name) => {
  const location = `remote:${name}`;
  const urls = remoteUrls(root, name);
  if (!urls) throw new Failure(location, "guard-remote-not-private");
  for (const url of urls) {
    const repo = githubRepo(url);
    if (!repo) throw new Failure(location, "guard-remote-not-private");
    const rootId = run("gh", ["api", `repos/${repo}`, "--jq", ".source.id // .id"], root);
    if (rootId === null || rootId.trim() === "") {
      throw new Failure(location, "guard-remote-not-private");
    }
    if (rootId.trim() === SOURCE_REPO_ID) throw new Failure(location, "guard-skill-source-remote");
    const visibility = run(
      "gh",
      ["repo", "view", repo, "--json", "visibility", "--jq", ".visibility"],
      root,
    );
    if (visibility === null || visibility.trim() !== "PRIVATE") {
      throw new Failure(location, "guard-remote-not-private");
    }
  }
};

const guardRepo = (root) => {
  // Every check below is relative to the project root, so it must be the repo's top level.
  const top = run("git", ["rev-parse", "--show-toplevel"], root);
  if (top === null) throw new Failure(".", "guard-not-git-repo");
  if (fs.realpathSync(top.trim()) !== fs.realpathSync(root)) {
    throw new Failure(".", "guard-not-repo-root");
  }
  if (!fs.statSync(path.join(root, "publish.yaml"), { throwIfNoEntry: false })?.isFile()) {
    throw new Failure("publish.yaml", "guard-no-publish-yaml");
  }
  const skillSource = "skills/research-candidates/SKILL.md";
  if (fs.existsSync(path.join(root, skillSource))) {
    throw new Failure(skillSource, "guard-skill-source-clone");
  }
  const remotes = run("git", ["remote"], root);
  if (remotes === null) throw new Failure(".", "guard-not-git-repo");
  for (const name of remotes.split("\n").filter(Boolean)) checkRemote(root, name);
};

module.exports = { guardRepo, githubRepo };
