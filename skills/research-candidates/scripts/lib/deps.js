"use strict";

// The npm dependencies (Readability, linkedom, yaml) live outside the skill
// directory, so a pinned `gh skill install` stays byte-for-byte its git tree
// (the publish skill-pin gate refuses extra files). scripts/install-deps runs
// `npm ci` from the skill's committed lockfile into a cache directory named by
// the lockfile's hash, so a new lockfile never runs against old modules.
// RESEARCH_CANDIDATES_DEPS overrides the directory.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { Failure } = require("./output");

const SKILL_DIR = path.join(__dirname, "..", "..");
const LOCKFILE = path.join(SKILL_DIR, "package-lock.json");

const depsDir = () => {
  const override = process.env.RESEARCH_CANDIDATES_DEPS;
  if (override) return path.resolve(override);
  const hash = crypto.createHash("sha256").update(fs.readFileSync(LOCKFILE)).digest("hex");
  const cache = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(cache, "research-candidates", hash.slice(0, 16));
};

let requireDep;
const load = (name) => {
  const dir = depsDir();
  requireDep ??= createRequire(path.join(dir, "package.json"));
  try {
    // Node would otherwise look in parent node_modules and NODE_PATH too, so a
    // missing install could load some other copy instead of the pinned one.
    const resolved = requireDep.resolve(name);
    if (path.relative(path.join(dir, "node_modules"), resolved).startsWith("..")) {
      throw new Failure("scripts/install-deps", "deps-missing");
    }
    return requireDep(resolved);
  } catch (error) {
    if (error.code === "MODULE_NOT_FOUND") {
      throw new Failure("scripts/install-deps", "deps-missing");
    }
    throw error;
  }
};

module.exports = { SKILL_DIR, depsDir, load };
