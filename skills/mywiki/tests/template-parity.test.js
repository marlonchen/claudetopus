"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

// SKILL.md:36 asserts an invariant that nothing else in this repo checks:
// "The two are identical except that Thursday's carries a Weekly Reflection
// section in place of Reflections." Markdown lint checks each template file
// in isolation, so it cannot see the two drift apart from each other. This
// invariant has already broken once during development of the Thursday
// template (a heading-level mismatch on Habit, and a dropped Not-to-do List
// section that would have broken that list's weekly carry-forward) — both
// caught by hand in review, neither catchable by lint:md. These tests make
// the invariant mechanical.

const REFS_DIR = path.join(__dirname, "..", "references");
const DAILY = fs.readFileSync(path.join(REFS_DIR, "daily-entry-template.md"), "utf8");
const THURSDAY = fs.readFileSync(path.join(REFS_DIR, "thursday-entry-template.md"), "utf8");

// Everything before the Reflections/Weekly Reflection section is the part
// the invariant says must be byte-identical between the two templates.
function reflectionsSplit(content, heading) {
  const marker = `## ${heading}`;
  const idx = content.indexOf(marker);
  assert.ok(idx !== -1, `expected "${marker}" section`);
  return { head: content.slice(0, idx), tail: content.slice(idx) };
}

describe("TemplateParity", () => {
  it("daily and thursday templates are identical up to the Reflections section", () => {
    const daily = reflectionsSplit(DAILY, "Reflections");
    const thursday = reflectionsSplit(THURSDAY, "Weekly Reflection");
    assert.strictEqual(
      thursday.head,
      daily.head,
      "daily-entry-template.md and thursday-entry-template.md diverge before the " +
        "Reflections/Weekly Reflection section — SKILL.md:36 says they should not",
    );
  });

  it("each template uses Reflections or Weekly Reflection, never both or neither", () => {
    assert.match(DAILY, /^## Reflections$/m, 'daily-entry-template.md missing "## Reflections"');
    assert.doesNotMatch(
      DAILY,
      /^## Weekly Reflection$/m,
      "daily-entry-template.md should not carry a Weekly Reflection section",
    );

    assert.match(
      THURSDAY,
      /^## Weekly Reflection$/m,
      'thursday-entry-template.md missing "## Weekly Reflection"',
    );
    assert.doesNotMatch(
      THURSDAY,
      /^## Reflections$/m,
      "thursday-entry-template.md should not carry a plain Reflections section",
    );
  });

  // SKILL.md's "New Entry" step 3 names these sections/subsections by heading
  // text. If a template drops one, or demotes/promotes its heading level, the
  // agent instructions silently stop matching what it finds in the file.
  const SECTIONS = ["Weekly Big Three", "Habit", "Tasks", "Meetings"];
  const SUBSECTIONS = ["Top 3", "Stretch Goals", "Not-to-do List"];

  for (const heading of SECTIONS) {
    it(`both templates carry "## ${heading}" at the same heading level`, () => {
      const re = new RegExp(`^## ${heading}$`, "m");
      assert.match(DAILY, re, `daily-entry-template.md missing "## ${heading}"`);
      assert.match(THURSDAY, re, `thursday-entry-template.md missing "## ${heading}"`);
    });
  }

  for (const heading of SUBSECTIONS) {
    it(`both templates carry "### ${heading}" under Tasks`, () => {
      const re = new RegExp(`^### ${heading}$`, "m");
      assert.match(DAILY, re, `daily-entry-template.md missing "### ${heading}"`);
      assert.match(THURSDAY, re, `thursday-entry-template.md missing "### ${heading}"`);
    });
  }
});
