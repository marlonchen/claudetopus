"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");

// The reference files depend on each other in ways markdown lint cannot see:
// review-list.md and coverage pick sections by the Rule markers in
// sections.md, sections.md cites the discovery checklist items numbered in
// source-tiers.md, and every file links to the others. The scripts the spec
// describes will be built from these files, so a rename or renumber in one
// file that the others miss would silently point those scripts at the wrong
// section. These tests make the cross-file invariants mechanical.

const SKILL_DIR = path.join(__dirname, "..");
const REFS_DIR = path.join(SKILL_DIR, "references");
const read = (file) => fs.readFileSync(path.join(REFS_DIR, file), "utf8");
const SECTIONS = read("sections.md");
const REVIEW = read("review-list.md");
const TIERS = read("source-tiers.md");
const RULE_MARKERS = ["", "`says-only`", "`always reviewed`"];

// Rows of the first table under "## <heading>" whose first cell is a lettered
// section ("A. On the ballot"), as arrays of trimmed cells.
function sectionRows(heading) {
  const start = SECTIONS.indexOf(`## ${heading}\n`);
  assert.ok(start !== -1, `sections.md is missing "## ${heading}"`);
  const next = SECTIONS.indexOf("\n## ", start + 1);
  const block = SECTIONS.slice(start, next === -1 ? undefined : next);
  return block
    .split("\n")
    .filter((line) => /^\| [A-Z]\. /.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
}

describe("SectionRules", () => {
  for (const heading of ["Candidate contests", "Retention contests", "Measures"]) {
    it(`${heading} rows use only known Rule markers`, () => {
      const rows = sectionRows(heading);
      assert.ok(rows.length > 0, `no section rows under "## ${heading}"`);
      for (const row of rows) {
        const rule = row[row.length - 1];
        assert.ok(RULE_MARKERS.includes(rule), `${heading} ${row[0]}: unknown Rule "${rule}"`);
      }
    });
  }

  it("candidate and retention contests each have an always-reviewed section", () => {
    for (const heading of ["Candidate contests", "Retention contests"]) {
      const marked = sectionRows(heading).filter((row) => row.at(-1) === "`always reviewed`");
      assert.ok(
        marked.length > 0,
        `${heading} has no always-reviewed section for review-list to use`,
      );
    }
  });

  it("review-list.md selects sections by marker, not by letter", () => {
    assert.match(REVIEW, /`always reviewed`/);
    assert.doesNotMatch(REVIEW, /\bsection [A-F]\b/, "review-list.md names a section by letter");
  });
});

describe("ChecklistReferences", () => {
  it("checklist items cited in sections.md exist in source-tiers.md", () => {
    const items = new Set([...TIERS.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]));
    for (const row of sectionRows("Candidate contests")) {
      for (const item of row[2].match(/\d+/g) || []) {
        assert.ok(
          items.has(item),
          `${row[0]} cites checklist item ${item}, not in source-tiers.md`,
        );
      }
    }
  });
});

describe("Links", () => {
  it("every relative .md link in the skill resolves", () => {
    const files = [
      "SKILL.md",
      "README.md",
      ...fs.readdirSync(REFS_DIR).map((f) => path.join("references", f)),
    ];
    for (const file of files) {
      const text = fs.readFileSync(path.join(SKILL_DIR, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#<]+\.md)\)/g)) {
        // ../sources/ links are placeholders inside format examples.
        if (target.startsWith("../sources/")) continue;
        const resolved = path.join(SKILL_DIR, path.dirname(file), target);
        assert.ok(fs.existsSync(resolved), `${file} links to missing ${target}`);
      }
    }
  });
});
