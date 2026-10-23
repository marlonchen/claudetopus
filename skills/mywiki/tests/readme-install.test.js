"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

// README.md tells the user how to install this skill into a journal or wiki repo and links to
// the repo root README for local installs. Markdown lint checks neither the skill name in the
// commands nor whether a #heading link still lands on a heading.

const SKILL_DIR = path.join(__dirname, "..");
const README = fs.readFileSync(path.join(SKILL_DIR, "README.md"), "utf8");

// GitHub's anchors for the markdown headings in `text`, outside code fences. Twin of
// headingSlugs in skills/research-candidates/tests/spec-parity.test.js; change both together.
const headingSlugs = (text) =>
  new Set(
    [...text.replace(/^```[\s\S]*?^```/gm, "").matchAll(/^#{1,6} +(.+)$/gm)].map((m) =>
      m[1]
        .trim()
        .toLowerCase()
        .replace(/[^\p{L}\p{N} _-]/gu, "")
        .replace(/ /g, "-"),
    ),
  );

// Added by /ship test coverage audit.
// Value: protects=README.md's install commands install mywiki and its #heading links land;
//   fails_when=a command names another skill, or a linked heading here or in the root README is
//   renamed; why_new=mywiki had no README test; seam=none;
//   no_claim=that gh skill or npx skills accept these flags (no installer is run)
describe("ReadmeInstall", () => {
  it("every install command names this skill", () => {
    const skill = path.basename(SKILL_DIR);
    const commands = README.split("\n").filter((l) => /\bgh skill install\b/.test(l));
    assert.ok(commands.length >= 2, "README.md no longer gives the install commands");
    for (const line of commands) {
      const named = line.match(/gh skill install \S+ (\S+)/);
      assert.ok(named, `install command names no skill: ${line}`);
      assert.strictEqual(named[1], skill, "an install command names another skill");
    }
  });

  // Added by /ship pre-landing review (cycle 2).
  // Value: protects=the journal and wiki repos get a pinned gh install, never unpinned npx;
  //   fails_when=an npx line or an unpinned gh line returns; why_new=installs run inside a
  //   private journal repo; seam=none; no_claim=that gh accepts the pin (no installer is run)
  it("installs into the private journal and wiki repos are pinned gh installs", () => {
    assert.doesNotMatch(README, /npx skills add/, "README.md offers an unpinned npx install");
    for (const line of README.split("\n").filter((l) => /\bgh skill install\b/.test(l))) {
      // Twin of PINNED in skills/research-candidates/tests/spec-parity.test.js; change both.
      assert.match(line, /--pin (<commit>|[0-9a-f]{7,40})(\s|$)/, `unpinned: ${line}`);
      assert.match(line, /--agent claude-code(\s|$)/, `not a Claude Code install: ${line}`);
    }
    const root = fs.readFileSync(path.join(SKILL_DIR, "..", "..", "README.md"), "utf8");
    assert.match(root, /repo that holds private data/, "root README has no private-data rule");
  });

  it("every #heading link in README.md lands on a heading", () => {
    let count = 0;
    for (const [, target, anchor] of README.matchAll(/\]\(([^)#\s:]*)#([^)\s]+)\)/g)) {
      count++;
      const text = target ? fs.readFileSync(path.join(SKILL_DIR, target), "utf8") : README;
      assert.ok(
        headingSlugs(text).has(anchor),
        `README.md links to missing heading ${target}#${anchor}`,
      );
    }
    assert.ok(count >= 3, `only ${count} heading links found to check`);
  });
});
