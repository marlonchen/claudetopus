"use strict";

// What Rule 5 relies on outside the skill, which upgrading the skill cannot
// change: the data repo's Claude Code settings and its git attributes
// (README.md, Data-repo settings). ballot-check fails while either falls
// short, so research never starts on settings older than the session-guard
// the skill ships. It does not check the agents copied into .claude/agents/.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Failure } = require("./output");

const SETTINGS = ".claude/settings.json";
const WANTED = path.join(__dirname, "..", "..", "data-repo-settings.json");

// The tools matched by the groups in `groups` that run `command`.
const toolsRunning = (groups, command) =>
  groups
    .filter((group) => group.hooks.some((hook) => hook.command === command))
    .flatMap((group) => group.matcher.split("|"));

// Does the data repo hold every deny rule, and run every hook on every tool,
// of data-repo-settings.json? Settings it cannot read hold none.
const settingsCurrent = (root) => {
  const wanted = JSON.parse(fs.readFileSync(WANTED, "utf8"));
  try {
    const have = JSON.parse(fs.readFileSync(path.join(root, SETTINGS), "utf8"));
    const deny = new Set(have.permissions.deny);
    return (
      wanted.permissions.deny.every((rule) => deny.has(rule)) &&
      Object.entries(wanted.hooks).every(([event, groups]) =>
        groups.every(({ hooks, matcher }) => {
          const tools = toolsRunning(have.hooks[event], hooks[0].command);
          return matcher.split("|").every((tool) => tools.includes(tool));
        }),
      )
    );
  } catch {
    return false;
  }
};

// Does git treat the private files, and those session-guard keeps from the main
// session, as binary, so that its output holds no line of any? check-attr reads
// only a path, so one name stands for a directory's files.
const privateDiffHidden = (root, ballot) => {
  const files = [
    `${ballot}/private.yaml`,
    `${ballot}/sources/_ballot/sample-ballot.md`,
    `${ballot}/unfetchable.md`,
    "downloads/ballot.pdf",
  ];
  const result = spawnSync("git", ["check-attr", "diff", "--", ...files], {
    cwd: root,
    encoding: "utf8",
  });
  const lines = result.stdout.split("\n").filter(Boolean);
  return lines.length === files.length && lines.every((line) => line.endsWith(": diff: unset"));
};

const dataRepoSetupFailures = (root, ballot) => [
  ...(settingsCurrent(root) ? [] : [new Failure(SETTINGS, "settings-outdated")]),
  ...(privateDiffHidden(root, ballot) ? [] : [new Failure(".gitattributes", "private-diff-shown")]),
];

module.exports = { dataRepoSetupFailures };
