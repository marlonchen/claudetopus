"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const { figuresBacked } = require("../scripts/lib/figures");

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
// The text files in references/; the wireframe PNG is binary and never read as text.
const REF_FILES = fs.readdirSync(REFS_DIR).filter((f) => /\.(md|html)$/.test(f));
const SECTIONS = read("sections.md");
const REVIEW = read("review-list.md");
const TIERS = read("source-tiers.md");
const BALLOT = read("ballot-format.md");
const SNAPSHOT = read("snapshot-format.md");
const ARTICLE = read("article-format.md");
const PAGE = read("page.md");
// The snapshot role enum snapshot-format.md declares.
const snapshotRoles = () => {
  const declared = SNAPSHOT.match(/^role: \w+ +# (.+)$/m);
  assert.ok(declared, "snapshot-format.md no longer declares the role enum");
  return declared[1].split("|").map((role) => role.trim());
};
// The contest and candidate ids in the ballot.yaml example.
const exampleIds = () => [...BALLOT.matchAll(/^ +-? *id: (\S+)/gm)].map((m) => m[1]);
// A ballot-check pattern ballot-format.md gives as **<name>:** ... `^...$`.
const ballotRule = (name) => {
  const found = ballotRuleLine(name).match(/`(\^[^`]+\$)`/);
  assert.ok(found, `ballot-format.md no longer gives the ${name} pattern`);
  return new RegExp(found[1]);
};
// The wireframe source without comments or the style block.
const wireframeBody = () =>
  read("page-wireframe.html")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style>[\s\S]*?<\/style>/, "");
// The chip labels of the first chip row after the wireframe screen titled `screen`.
const wireframeChips = (screen) => {
  const nav = read("page-wireframe.html").match(
    new RegExp(`${screen}[\\s\\S]*?<nav class="chips"[^>]*>([\\s\\S]*?)<\\/nav>`),
  );
  assert.ok(nav, `the wireframe has no chip row after "${screen}"`);
  return [...nav[1].matchAll(/<a class="chip"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
};
const REPO_ROOT = path.join(SKILL_DIR, "..", "..");
// git check-ignore against this repo's .gitignore only: a developer's global excludes must not
// make a test pass. Exits 0 when any path is ignored, 1 when none is.
const checkIgnore = (flags, paths) =>
  spawnSync(
    "git",
    ["-c", "core.excludesFile=/dev/null", "check-ignore", ...flags, "--no-index", ...paths],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
const RULE_MARKERS = ["", "`says-only`", "`always reviewed`"];
// ballot.yaml contest type -> its section table in sections.md.
const TYPE_TABLES = {
  candidate: "Candidate contests",
  retention: "Retention contests",
  measure: "Measures",
};
const TABLES = Object.values(TYPE_TABLES);

// The text from `heading` up to the next `next` heading (default: the next "## ").
const between = (text, heading, next = "\n## ") => {
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `missing "${heading}"`);
  const end = text.indexOf(next, start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};

// The text from `heading` to the end of `text`.
const from = (text, heading) => {
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `missing "${heading}"`);
  return text.slice(start);
};

// Tiers named in the source-tiers.md tier table ("T1, statements only" counts as T1).
const TABLE_TIERS = new Set([...TIERS.matchAll(/^\| (T\d)\b/gm)].map((m) => m[1]));

const cells = (line) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
// The rows of the table under `heading` whose first cell starts with `prefix`.
const tableRows = (text, heading, prefix = "| `") =>
  between(text, heading)
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map(cells);
// The key-parameter pattern snapshot-format.md gives. A function, so a missing pattern fails the
// test that needs it rather than the whole file.
const keyParamPattern = () => {
  const declared = SNAPSHOT.match(/matches `\/(.+?)\/(\w*)`/);
  assert.ok(declared, "snapshot-format.md no longer gives the key-parameter pattern");
  return new RegExp(declared[1], declared[2]);
};

// The first table under "## <heading>": its header cells and its data rows.
// Every data row must name a lettered section ("A. On the ballot"), so a
// mistyped row fails here instead of silently dropping out of every check.
function sectionTable(heading) {
  const lines = between(SECTIONS, `## ${heading}\n`)
    .split("\n")
    .filter((line) => line.startsWith("|"));
  assert.ok(lines.length > 2, `no table under "## ${heading}"`);
  const [header, , ...data] = lines.map(cells);
  for (const row of data) {
    assert.match(row[0], /^[A-Z]\. \S/, `${heading}: malformed section row "${row[0]}"`);
  }
  return { header, rows: data };
}

// Index of the header column whose name starts with `name`, failing if absent,
// so a reordered or renamed column cannot make a check pass vacuously.
function column(table, name) {
  const index = table.header.findIndex((cell) => cell.startsWith(name));
  assert.ok(index !== -1, `table has no "${name}" column`);
  return index;
}

describe("SectionRules", () => {
  for (const heading of TABLES) {
    it(`${heading} letters run A, B, C... in order`, () => {
      const letters = sectionTable(heading).rows.map((row) => row[0][0]);
      const expected = letters.map((_, i) => String.fromCharCode(65 + i));
      assert.deepStrictEqual(letters, expected, `${heading}: section letters out of order`);
    });

    it(`${heading} rows use only known Rule markers`, () => {
      const table = sectionTable(heading);
      const rule = column(table, "Rule");
      for (const row of table.rows) {
        assert.ok(
          RULE_MARKERS.includes(row[rule]),
          `${heading} ${row[0]}: unknown Rule "${row[rule]}"`,
        );
      }
    });
  }

  it("candidate and retention contests each have an always-reviewed section", () => {
    for (const heading of ["Candidate contests", "Retention contests"]) {
      const table = sectionTable(heading);
      const rule = column(table, "Rule");
      const marked = table.rows.filter((row) => row[rule] === "`always reviewed`");
      assert.ok(
        marked.length > 0,
        `${heading} has no always-reviewed section for review-list to use`,
      );
    }
  });

  it("review-list.md selects sections by marker, not by letter", () => {
    assert.match(REVIEW, /`always reviewed`/);
    assert.doesNotMatch(REVIEW, /\bsection [A-Z]\b/i, "review-list.md names a section by letter");
  });
});

// The SKILL.md Scripts table row for `script`, failing if it is gone.
const scriptRow = (script) => {
  const row = SKILL.split("\n").find((l) => l.startsWith(`| \`${script}\` |`));
  assert.ok(row, `the Scripts table has no ${script} row`);
  return row;
};
// The cells of the article-format.md failure-code row for `code`, failing if it is gone.
const failureCodeRow = (code) => {
  const row = tableRows(ARTICLE, "## Failure codes").find((r) => r[0] === `\`${code}\``);
  assert.ok(row, `the failure-code table has no ${code}`);
  return row;
};
// The first capture of `pattern` in `text`, failing with `what` if it does not match.
const capture = (text, pattern, what) => {
  const found = text.match(pattern);
  assert.ok(found, `${what} is gone`);
  return found[1];
};
// The article-format.md structure example, without its fence.
const articleExample = () =>
  capture(
    ARTICLE,
    /## Structure\n\n```markdown\n([\s\S]*?)```/,
    "article-format.md's structure example",
  );
// The discovery checklist item numbers each sections.md table cites, by table heading.
const checklistItemsBySection = (heading) => {
  const table = sectionTable(heading);
  const cited = column(table, "Discovery checklist");
  return table.rows.map((row) => [row[0], row[cited].match(/\d+/g) || []]);
};
const checklistItemsByTable = () =>
  Object.fromEntries(
    TABLES.map((heading) => [
      heading,
      new Set(checklistItemsBySection(heading).flatMap(([, items]) => items)),
    ]),
  );

describe("ChecklistReferences", () => {
  // Extended for the search log (issue 01).
  // Value: protects=every section that can be Unknown cites the checklist items coverage must
  //   find logged, and each item belongs to one contest type; fails_when=a measure or retention
  //   section cites no item, or two types share one; why_new=only candidate sections cited
  //   items; seam=none; no_claim=coverage (not built yet)
  it("sections.md cites exactly the checklist items source-tiers.md numbers", () => {
    const items = new Set([...TIERS.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]));
    assert.ok(items.size > 0, "no numbered checklist items in source-tiers.md");
    const byTable = checklistItemsByTable();
    const owners = new Map();
    for (const [heading, cited] of Object.entries(byTable)) {
      for (const item of cited) {
        assert.ok(
          items.has(item),
          `${heading} cites checklist item ${item}, not in source-tiers.md`,
        );
        assert.ok(!owners.has(item), `checklist item ${item} is cited by two contest types`);
        owners.set(item, heading);
      }
    }
    for (const item of items)
      assert.ok(owners.has(item), `checklist item ${item} fills no section`);
    // Extended by PR #7 interrogate review.
    // Value: protects=an item whose condition depends on reporting runs after Reporting, and
    //   Record and Money have an item that applies to every office type that has them;
    //   fails_when=the courts item runs before reporting again, or a local office's only Record
    //   and Money items are federal and state; why_new=a premature "does not apply" line was
    //   permanent, and a local Unknown was backed by nothing searched; seam=none
    const reporting = capture(TIERS, /^(\d+)\. \*\*Reporting:\*\*/m, "the Reporting item");
    for (const [, n, text] of TIERS.matchAll(/^(\d+)\. \*\*[^*]+\*\* ([^\n]+)$/gm)) {
      if (/\breporting\b/.test(text) && Number(n) < Number(reporting))
        assert.match(
          text,
          new RegExp(`Run after item ${reporting}\\.`),
          `item ${n} runs too early`,
        );
    }
    assert.match(TIERS, new RegExp(`except that item 3 runs after item ${reporting}`));
    const recordItems = checklistItemsBySection(TYPE_TABLES.candidate)
      .filter(([section]) => /^[CD]\. /.test(section))
      .flatMap(([, items]) => items);
    for (const type of officeTypes().filter((t) => t !== "judicial")) {
      const covers = recordItems.some((item) =>
        new RegExp(
          `^${item}\\. \\*\\*[^*]*\\b${type === "federal" ? "Federal" : type}\\b`,
          "im",
        ).test(TIERS),
      );
      assert.ok(covers, `no Record or Money checklist item applies to ${type} offices`);
    }
    // Every section but the ballot record draws on at least one item, or Unknown could never pass.
    for (const heading of TABLES) {
      for (const [section, items] of checklistItemsBySection(heading)) {
        if (section === "A. On the ballot") continue;
        assert.ok(items.length > 0, `${heading} ${section} cites no checklist item`);
      }
    }
  });
});

// GitHub's anchors for the markdown headings in `text`, outside code fences. Twin of
// headingSlugs in skills/mywiki/tests/readme-install.test.js; change both together.
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

describe("Links", () => {
  // Extended by /ship test coverage audit.
  // Value: protects=every relative link (.md, .png, .html) in the skill resolves;
  //   fails_when=the page wireframe or another non-.md file is renamed or moved;
  //   why_new=the link check read only .md targets; seam=none; no_claim=none beyond protects
  // Extended by /ship test coverage audit.
  // Value: protects=a #anchor on a relative .md link names a heading in its target;
  //   fails_when=the root README's "Install a skill" heading is renamed and README.md's link
  //   breaks; why_new=only the file part of a link was checked; seam=none;
  //   no_claim=GitHub's slug rules beyond letters, digits, spaces and hyphens
  it("every relative link in the skill resolves", () => {
    const files = ["SKILL.md", "README.md", ...REF_FILES.map((f) => path.join("references", f))];
    let count = 0;
    let anchors = 0;
    for (const file of files) {
      const text = fs.readFileSync(path.join(SKILL_DIR, file), "utf8");
      for (const [, target, anchor] of text.matchAll(/\]\(([^)#<\s:]+\.[a-z]+)(#[^)]*)?\)/g)) {
        // ../sources/ links are placeholders inside format examples.
        if (target.startsWith("../sources/")) continue;
        count++;
        const resolved = path.join(SKILL_DIR, path.dirname(file), target);
        assert.ok(fs.existsSync(resolved), `${file} links to missing ${target}`);
        if (!anchor || !target.endsWith(".md")) continue;
        anchors++;
        const slugs = headingSlugs(fs.readFileSync(resolved, "utf8"));
        assert.ok(
          slugs.has(anchor.slice(1)),
          `${file} links to missing heading ${target}${anchor}`,
        );
      }
    }
    assert.ok(count > 0, "no relative links found to check");
    assert.ok(anchors > 0, "no relative heading links found to check");
  });
});

const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const README = fs.readFileSync(path.join(SKILL_DIR, "README.md"), "utf8");
const ROOT_README = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
// Every spec text file as [path from the skill directory, text].
const SPEC_FILES = [
  ["SKILL.md", SKILL],
  ...REF_FILES.map((f) => [path.join("references", f), read(f)]),
];
const SPEC_TEXTS = SPEC_FILES.map(([, text]) => text);

describe("Exemptions", () => {
  it("the judicial exemption names a real candidate section", () => {
    const prose = from(SECTIONS, "## Not part of this office's job");
    const named = prose.match(/its (\w[\w ]*?) section in the state/);
    assert.ok(named, "exemption no longer names a section");
    const names = sectionTable("Candidate contests").rows.map((row) => row[0].slice(3));
    assert.ok(names.includes(named[1]), `exemption names "${named[1]}", not a candidate section`);
  });

  it("the stated candidate section count matches the table", () => {
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];
    const stated = SECTIONS.match(/gets all (\w+)\./);
    assert.ok(stated, 'sections.md no longer says "gets all <n>."');
    assert.strictEqual(
      words.indexOf(stated[1]),
      sectionTable("Candidate contests").rows.length,
      `sections.md says "all ${stated[1]}" but the candidate table has a different count`,
    );
  });

  // Added by /ship test coverage audit.
  // Value: protects=the exemption's ballot.yaml field and value are the ones ballot-format.md
  //   declares; fails_when=office_type or judicial is renamed in one file only;
  //   why_new=no test reads the field coverage keys the exemption on; seam=none
  it("the exemption keys on a field ballot-format.md declares", () => {
    const keyed = SECTIONS.match(/marked `office_type: (\w+)` in `ballot\.yaml`/);
    assert.ok(keyed, "sections.md exemption no longer names its office_type value");
    assert.match(
      BALLOT,
      new RegExp(`^ +office_type: ${keyed[1]}\\b`, "m"),
      `ballot-format.md has no office_type: ${keyed[1]} in its example`,
    );
  });
});

// Added by /ship test coverage audit.
// Value: protects=every ballot.yaml contest type has a sections.md table and the example uses
//   only listed types; fails_when=a type is added, renamed or loses its section table;
//   why_new=nothing else ties the contest types to the section tables; seam=none
describe("ContestTypes", () => {
  it("every contest type has a section table, and the example uses only listed types", () => {
    const line = BALLOT.match(/^Contest types: (.+)$/m);
    assert.ok(line, 'ballot-format.md no longer lists "Contest types:"');
    const listed = [...line[1].matchAll(/`(\w+)`/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      [...listed].sort(),
      Object.keys(TYPE_TABLES).sort(),
      "ballot-format.md contest types differ from the sections.md tables",
    );
    for (const type of listed) sectionTable(TYPE_TABLES[type]);
    const used = [...BALLOT.matchAll(/^ +type: (\w+)/gm)].map((m) => m[1]);
    assert.ok(used.length > 0, "ballot-format.md example has no contest types");
    for (const type of used) {
      assert.ok(listed.includes(type), `example contest type ${type} is not a listed type`);
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=the snapshot tier enum equals the source-tiers.md tier table; fails_when=a
//   tier is added to or dropped from one file only; why_new=ClaimTags checks claim tags, not the
//   snapshot front-matter tier enum; seam=none
describe("Tiers", () => {
  it("the snapshot tier enum matches the source-tiers.md tier table", () => {
    const declared = SNAPSHOT.match(/^tier: \w+ +# ([^,]+)/m);
    assert.ok(declared, "snapshot-format.md no longer declares the tier enum");
    const enumTiers = declared[1].split("|").map((tier) => tier.trim());
    assert.ok(TABLE_TIERS.size > 0, "source-tiers.md is missing the tier table");
    assert.deepStrictEqual(
      [...TABLE_TIERS].sort(),
      [...enumTiers].sort(),
      "snapshot-format.md tier enum differs from the source-tiers.md tier table",
    );
  });
});

describe("ClaimTags", () => {
  it("every claim tag used in the spec is defined in source-tiers.md", () => {
    const table = between(TIERS, "## Claim tags");
    const known = new Set();
    for (const line of table.split("\n").filter((l) => l.startsWith("| `"))) {
      const first = cells(line)[0];
      const tags = [...first.matchAll(/`(T\d[a-z]?)`/g)].map((m) => m[1]);
      const range = first.match(/`T(\d)(\w)` \.\.\. `T(\d)\2`/);
      if (range) {
        for (let n = Number(range[1]); n <= Number(range[3]); n++) tags.push(`T${n}${range[2]}`);
      }
      for (const tag of tags) known.add(tag);
    }
    assert.ok(known.size > 0, "no claim tags parsed from source-tiers.md");
    for (const text of SPEC_TEXTS) {
      for (const [, tag] of text.matchAll(/`(T\d[a-z]?)`/g)) {
        assert.ok(known.has(tag), `claim tag ${tag} is used but not defined in source-tiers.md`);
      }
    }
  });
});

describe("SnapshotRoles", () => {
  it("every snapshot role used in ballot-format.md is in the snapshot-format.md enum", () => {
    const roles = new Set(snapshotRoles());
    const used = [...BALLOT.matchAll(/`role: (\w+)`/g)].map((m) => m[1]);
    assert.ok(used.length > 0, "ballot-format.md uses no snapshot roles");
    for (const role of used) {
      assert.ok(roles.has(role), `ballot-format.md uses role ${role}, not in snapshot-format.md`);
    }
  });
});

const WORKFLOW = from(SKILL, "## Workflow");

// Assert that workflow step "N" (a "### N. " heading) or "N.M" (item "M. " in
// that step's body) exists in SKILL.md.
function assertStep(step, where) {
  const [major, minor] = step.split(".");
  const heading = WORKFLOW.indexOf(`\n### ${major}. `);
  assert.ok(heading !== -1, `${where} refers to step ${step}, which does not exist`);
  if (minor) {
    const body = between(WORKFLOW, `\n### ${major}. `, "\n### ");
    assert.match(body, new RegExp(`\\n${minor}\\. `), `${where}: no step ${step}`);
  }
}

describe("Scripts", () => {
  const rows = tableRows(SKILL, "## Scripts");

  it("every step in the Used in column exists in the workflow", () => {
    assert.ok(rows.length > 0, "no rows in the SKILL.md Scripts table");
    for (const row of rows) {
      for (const step of row
        .at(-1)
        .split(",")
        .map((s) => s.trim())) {
        assertStep(step, `${row[0]} (Scripts table)`);
      }
    }
  });

  it("every script in the table is named in the workflow", () => {
    for (const row of rows) {
      assert.ok(WORKFLOW.includes(row[0]), `${row[0]} is in the Scripts table but no step uses it`);
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=prose step refs (step 6.3, (4.1-4.2), (4.5, 5)) name real workflow steps;
//   fails_when=a workflow or publish step is renumbered and prose refs are missed;
//   why_new=Scripts checks only the table's Used in column; seam=none
describe("StepReferences", () => {
  it("every step number cited in the spec prose exists in the workflow", () => {
    let count = 0;
    for (const [file, text] of SPEC_FILES) {
      const refs = [
        // Extended by /ship pre-landing review: lists joined by "and", "or" or commas
        // ("step 6.2 and 6.3") are checked too.
        ...[
          ...text.matchAll(/\b[Ss]teps? (\d(?:\.\d)?(?:(?:-|, ?| and | or )\d(?:\.\d)?)*)\b/g),
        ].map((m) => m[1].split(/-|, ?| and | or /)),
        ...[...text.matchAll(/\((\d\.\d(?:-\d\.\d)?(?:, ?\d(?:\.\d)?)*)\)/g)].map((m) =>
          m[1].split(/[,-]/),
        ),
      ];
      for (const step of refs.flat().map((s) => s.trim())) {
        count++;
        assertStep(step, file);
      }
    }
    assert.ok(count >= 10, `only ${count} step references found; the patterns may have drifted`);
  });
});

describe("NamedSections", () => {
  it("the first candidate section is On the ballot, which withdrawn candidates keep", () => {
    assert.strictEqual(sectionTable("Candidate contests").rows[0][0], "A. On the ballot");
    assert.match(SECTIONS, /the On the ballot section only/, "sections.md lost the withdrawn rule");
    // The rule lives in sections.md alone; the other specs point to it instead of restating it.
    for (const file of ["article-format.md", "page.md"]) {
      assert.match(
        read(file),
        /withdrawn candidate[^.]*only the sections \[sections\.md\]\(sections\.md\)/,
        `${file} no longer defers the withdrawn rule to sections.md`,
      );
    }
  });

  it("article-format.md example headings are candidate sections", () => {
    const names = new Set(sectionTable("Candidate contests").rows.map((row) => row[0]));
    const headings = [...ARTICLE.matchAll(/^### ([A-Z]\. .+)$/gm)];
    assert.ok(headings.length > 0, "article-format.md example has no section headings");
    for (const [, heading] of headings) {
      assert.ok(names.has(heading), `article-format.md heading "${heading}" is not in sections.md`);
    }
  });
});

describe("CandidateStatus", () => {
  it("statuses named in the spec are in the ballot.yaml status enum", () => {
    const declared = BALLOT.match(/status: \w+ +# (.+)$/m);
    assert.ok(declared, "ballot-format.md no longer declares the status enum");
    const statuses = new Set(declared[1].split("|").map((status) => status.trim()));
    const used = [...BALLOT.matchAll(/`(on_ballot|withdrawn_\w+|certified_\w+)`/g)].map(
      (m) => m[1],
    );
    assert.ok(used.length > 0, "ballot-format.md names no statuses");
    for (const status of used) {
      assert.ok(statuses.has(status), `status ${status} is used but not in the enum`);
    }
  });
});

describe("KeyStripping", () => {
  it("the key-parameter pattern matches every example it names", () => {
    const pattern = keyParamPattern();
    const examples = SNAPSHOT.match(/\(`api_key`[^)]*\)/);
    assert.ok(examples, "snapshot-format.md no longer lists key-parameter examples");
    const names = [...examples[0].matchAll(/`(\w+)`/g)].map((m) => m[1]);
    assert.ok(names.length >= 4, "fewer key-parameter examples than expected");
    for (const name of names) {
      assert.match(name, pattern, `key parameter ${name} is not matched by the pattern`);
    }
    // Ordinary parameters must survive, so an over-broad pattern fails too.
    for (const name of ["keyword", "monkey", "q", "page", "district", "signup"]) {
      assert.doesNotMatch(name, pattern, `ordinary parameter ${name} would be stripped`);
    }
  });
});

// Every path in the SKILL.md Layout tree, relative to the data repo root, with
// each placeholder replaced per `fill` (unfilled placeholders stay literal).
function layoutEntries(fill = {}) {
  const block = from(SKILL, "## Layout").match(/```text\n([\s\S]*?)```/);
  assert.ok(block, "SKILL.md Layout has no text block");
  const entries = [];
  const stack = [];
  for (const line of block[1].split("\n").filter((l) => l.trim())) {
    const indent = line.length - line.trimStart().length;
    let entry = line
      .trim()
      .replace(/\s+#.*$/, "")
      .replace("<project root>/", "");
    for (const [placeholder, value] of Object.entries(fill)) {
      entry = entry.replaceAll(placeholder, value);
    }
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const full = (stack.at(-1)?.path ?? "") + entry;
    if (full.endsWith("/")) stack.push({ indent, path: full });
    entries.push(full);
  }
  return entries;
}

describe("PrivateDataIgnored", () => {
  it("this public repo ignores every private data file the Layout names", () => {
    // Extended by /ship test coverage audit.
    // Value: protects=every file the SKILL.md Layout names is gitignored here;
    //   fails_when=Layout gains a private file the .gitignore misses; why_new=the path list
    //   was hand-copied, so a new Layout entry went unchecked; seam=none
    const entries = layoutEntries({
      "<election>": "2026-general",
      "<ballot-id>": exampleBallotId(),
      "<contest>": "us-house-07",
      "<candidate>": "jane-example",
    });
    // Leaves only: files, plus a file inside each directory with no listed children.
    const paths = entries
      .filter((p) => p !== "" && !entries.some((q) => q !== p && q.startsWith(p)))
      .map((p) => (p.endsWith("/") ? `${p}example.md` : p));
    assert.ok(paths.length >= 10, `only ${paths.length} Layout paths parsed`);
    for (const p of paths) assert.doesNotMatch(p, /[<>]/, `unfilled placeholder in ${p}`);
    // check-ignore prints each ignored path and exits 1 only when none are ignored.
    // Any <election> name must be covered, not only the YYYY-kind example.
    const all = [
      ...paths,
      ...paths
        .filter((p) => p.startsWith("2026-general/"))
        .map((p) => p.replace("2026-general/", "general-2026/")),
    ];
    const result = checkIgnore(["-v"], all);
    assert.strictEqual(result.status, 0, `no Layout path is ignored: ${result.stderr}`);
    const sources = new Map(
      result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split("\t").reverse()),
    );
    for (const p of all) {
      assert.ok(sources.has(p), `${p} is not ignored; private data could be committed here`);
      assert.match(sources.get(p), /^\.gitignore:/, `${p} is ignored only by ${sources.get(p)}`);
    }
  });

  it("skill source directories are not swallowed by the data ignores", () => {
    const probes = [
      ...["sources", "articles", "review", "site"].map(
        (dir) => `skills/research-candidates/${dir}/example.md`,
      ),
      "skills/research-candidates/ballot.ledger",
      "skills/research-candidates/ballot-view.md",
      "skills/research-candidates/snapshots.sha256",
      "skills/research-candidates/search-log/example.tsv",
      // Extended by /ship pre-landing review.
      // Value: protects=every script in the SKILL.md Scripts table, and test fixtures named like
      //   data files, can be committed; fails_when=a generic rule (coverage) or an unanchored data
      //   rule swallows skills/*/scripts/<name> or a fixture; why_new=the probes skipped scripts/
      //   and fixtures; seam=none
      ...tableRows(SKILL, "## Scripts").map(
        (row) => `skills/research-candidates/scripts/${row[0].replaceAll("`", "")}`,
      ),
      ...["ballot.yaml", "private.yaml", "tiers.yaml", "addresses.yaml", "archives.tsv"].map(
        (file) => `skills/research-candidates/tests/fixtures/${file}`,
      ),
    ];
    const result = checkIgnore([], probes);
    assert.strictEqual(result.status, 1, `skill source would be ignored: ${result.stdout}`);
  });

  // Added by /ship pre-landing review.
  // Value: protects=secrets and build output next to a skill's scripts stay ignored in this
  //   public repo; fails_when=a scripts/ negation is widened (scripts/**) and re-includes .env
  //   or node_modules; why_new=the probes above only check what must stay committable; seam=none
  it("secrets and build output under a skill's scripts/ stay ignored", () => {
    const probes = [".env", ".env.local", "node_modules/x.js", "debug.log"].map(
      (file) => `skills/research-candidates/scripts/${file}`,
    );
    const result = checkIgnore(["-v"], probes);
    assert.strictEqual(result.status, 0, `no scripts/ probe is ignored: ${result.stderr}`);
    for (const p of probes) {
      const line = result.stdout.split("\n").find((l) => l.endsWith(`\t${p}`));
      assert.ok(line, `${p} is not ignored`);
      assert.doesNotMatch(line, /:!/, `${p} is re-included by a negation: ${line}`);
    }
  });
});

// The example ballot id step 2 gives ("a `<ballot-id>`: a descriptive label such as `...`").
const exampleBallotId = () => {
  const found = SKILL.match(/a `<ballot-id>`: [^`]*`([^`]+)`/);
  assert.ok(found, "SKILL.md step 2 no longer gives an example ballot id");
  return found[1];
};
// USPS state, district and territory codes; a fictional example id must not start with one.
const STATE_CODES = new Set(
  (
    "al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh " +
    "nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy as gu mp pr vi"
  ).split(" "),
);

// Added by /interrogate review (descriptive ballot ids).
// Value: protects=the ballot id names only state and county, its example is fictional, and the
//   privacy scan and fetch refusal cover it; fails_when=an example names a real place or a
//   precinct, or a refusal list drops the id; why_new=ballot ids changed from opaque labels to
//   descriptive ones; seam=none
describe("BallotIds", () => {
  // Extended by /ship test coverage audit.
  // Value: protects=the Ballot ids pattern enforces the three parts the privacy scan relies on;
  //   fails_when=the pattern is loosened to two parts, or accepts caps, underscores or no state;
  //   why_new=only the example id was matched, never a rejected one; seam=none;
  //   no_claim=ballot-check itself (not built yet; spec text only)
  // Extended by /ship pre-landing review: the suffix is a short ordinal, never free text.
  it("the Ballot ids pattern takes state, county and a 1-2 digit ordinal only", () => {
    const pattern = ballotRule("Ballot ids");
    for (const good of [exampleBallotId(), "xx-new-exampleton-12"]) {
      assert.match(good, pattern, `Ballot ids pattern rejects ${good}`);
    }
    // A free-text suffix can name a township, and reads as prose with hyphens as spaces.
    const bad = ["xx-exampleton", "xx", "XX-exampleton-1", "xx_exampleton_1", "x-a-1"];
    bad.push("xx-exampleton-springfield", "in-marion-county", "xx-exampleton-012");
    bad.push("xx-exampleton-123", "xx-exampleton-0", "xx-12-1");
    for (const id of bad) assert.doesNotMatch(id, pattern, `Ballot ids pattern accepts ${id}`);
  });

  it("the example ballot id is fictional: a made-up state code and a one-word county", () => {
    const segments = exampleBallotId().split("-");
    assert.ok(!STATE_CODES.has(segments[0]), "the example ballot id starts with a real state code");
    // State, county, number: a fourth part would be a free word the pattern cannot vet.
    assert.strictEqual(segments.length, 3, "the example's county is more than one word");
  });

  // Added by /ship pre-landing review (cycle 2).
  // Value: protects=the ballot id holds only ballot.yaml's state and county plus a number;
  //   fails_when=the id may carry free words again, or ballot.yaml drops state/county;
  //   why_new=free county words let a township through as one token; seam=none;
  //   no_claim=ballot-check itself (not built yet; spec text only)
  it("the ballot id is built from ballot.yaml's state and county and nothing else", () => {
    assert.match(BALLOT, /^state: [A-Z]{2}\b/m, "the ballot.yaml example has no state");
    assert.match(BALLOT, /^county: \S/m, "the ballot.yaml example has no county");
    const rule = ballotRuleLine("Ballot ids");
    assert.match(rule, /is exactly `<state>-<county>-<n>`/, "the id is not bound to ballot.yaml");
    // The rule as written turns the ballot.yaml example into the id it names.
    const state = BALLOT.match(/^state: (\S+)/m)[1];
    const county = BALLOT.match(/^county: ([^#\n]+?)\s*(#|$)/m)[1];
    const derived = rule.match(/the example above is `([a-z0-9-]+)`/);
    assert.ok(derived, "the Ballot ids rule no longer names the example's id");
    assert.strictEqual(deriveBallotId(state, county, 1), derived[1], "the example does not derive");
    // The ballot.yaml example is fictional too, and agrees with SKILL.md's example id.
    assert.strictEqual(derived[1], exampleBallotId(), "the two example ids differ");
    assert.match(rule, /relative to the ballot directory/, "ledger paths may hold the ballot id");
  });

  it("an election directory has one stated pattern, and the guard test uses it", () => {
    const pattern = electionPattern();
    assert.match("2026-general", pattern);
    for (const name of [".claude", "downloads", "sources", "2026"]) {
      assert.doesNotMatch(name, pattern, `${name} reads as an election directory`);
    }
    const rule = ballotRuleLine("Ballot ids");
    assert.match(rule, /under every `<election>` directory/, "ballot-check's walk is undefined");
  });

  it("the Layout and README use the same example ballot id, and no opaque one is left", () => {
    const layout = between(SKILL, "## Layout")
      .split("\n")
      .find((l) => l.includes("<ballot-id>/"));
    assert.ok(layout?.includes(exampleBallotId()), "the Layout comment uses another example id");
    assert.ok(README.includes(exampleBallotId()), "README.md uses another example id");
    for (const [file, text] of [...SPEC_FILES, ["README.md", README]]) {
      assert.ok(!text.includes("ballot-a"), `${file} still shows the opaque example \`ballot-a\``);
    }
  });

  it("ballot-check fails a ballot id whose number is part of a private_strings entry", () => {
    const rule = ballotRuleLine("Ballot ids");
    // A part, not the whole entry: "Precinct 12" must stop the number 12. The county words are
    // public through the contest list, and the Private text rule checks the county field.
    assert.match(rule, /whose number equals any digit run of any `private_strings` entry/);
    assert.match(rule, /To rename a ballot id[^.]*`addresses\.yaml`/);
    // Extended by /ship test coverage audit (run 9).
    // Value: protects=the id's number is checked at ballot-check because 6.3 never scans a short
    //   digit run alone, and the example id passes its own rule; fails_when=the example id takes
    //   a private digit run, or 6.3 starts scanning 1-2 digit runs alone; why_new=the rule was
    //   read alone; seam=none; no_claim=ballot-check and publish (not built yet; spec text only)
    const scan = between(SKILL, "3. Privacy scan.", "\n4. ");
    const bullet = scan
      .split("\n")
      .find((l) => /^ +- the digit run of a `private_strings`/.test(l));
    assert.ok(bullet, "6.3 no longer scans a private_strings entry's digit run");
    const alone = Number(bullet.match(/on its own, when it has (\d+) or more digits/)?.[1]);
    const idDigits = Number(rule.match(/a 1-(\d) digit number the researcher picks/)?.[1]);
    assert.ok(alone && idDigits, "6.3 or the Ballot ids rule lost its digit counts");
    // A private run as short as the id's number is never matched alone by 6.3, so only
    // ballot-check keeps it out of every agent-visible path.
    assert.ok(idDigits < alone, "the id's number is now long enough for 6.3 to scan alone");
    const entries = between(BALLOT, "private_strings:\n", "\nignored_lines:")
      .split("\n")
      .map((l) => l.match(/^ +- (.+?)(?:\s+#.*)?$/)?.[1])
      .filter(Boolean);
    const runs = new Set(entries.flatMap((e) => e.match(/\d+/g) ?? []));
    const listed = rule.match(/with `([^`]+)` listed, (\d+) fails/);
    assert.ok(listed, "the Ballot ids rule lost its worked example");
    assert.ok(entries.includes(listed[1]), `${listed[1]} is not in the private_strings example`);
    assert.ok(runs.has(listed[2]), `${listed[2]} is not a digit run of the example entries`);
    const n = exampleBallotId().split("-").pop();
    assert.ok(!runs.has(n), `the example id ${exampleBallotId()} fails its own ballot-check`);
  });

  // Added by /ship test coverage audit.
  // Value: protects=SKILL.md step 2 states the same ballot-id private_strings check as the
  //   ballot-format.md rule (number only); fails_when=step 2 claims a word check the rule
  //   disowns, or the rule starts checking words; why_new=only the rule's own text was read;
  //   seam=none; no_claim=ballot-check itself (not built yet; spec text only)
  it("step 2 and the Ballot ids rule agree that only the id's number is checked", () => {
    const rule = ballotRuleLine("Ballot ids");
    assert.match(rule, /county words are fixed by .{0,80}public through the contest list/);
    assert.match(rule, /Private text rule already fails a `private_strings` entry in `county`/);
    const step2 = between(WORKFLOW, "### 2. ", "\n### ");
    const claim = step2.match(/`ballot-check` fails an id [^.:]*/);
    assert.ok(claim, "SKILL.md step 2 no longer says which ids ballot-check fails");
    assert.doesNotMatch(claim[0], /\bwords?\b/, "step 2 says ballot-check checks the id's words");
    assert.match(claim[0], /\bnumber\b/, "step 2 no longer says the id's number is checked");
  });

  it("every real county shape derives an id the Ballot ids pattern accepts", () => {
    const pattern = ballotRule("Ballot ids");
    assert.match(ballotRuleLine("Ballot ids"), /letters folded to ASCII/, "Doña Ana has no id");
    for (const county of [
      "Doña Ana County",
      "Prince George's County",
      "Miami-Dade County",
      "St. Louis city",
      "Matanuska-Susitna Borough",
      "Orleans Parish",
      "Juneau City and Borough",
      "Bethel Census Area",
      "Anchorage Municipality",
    ]) {
      const id = deriveBallotId("XX", county, 1);
      assert.match(id, pattern, `${county} derives ${id}, which the pattern refuses`);
    }
  });

  // Added by /ship pre-landing review (run 7).
  // Value: protects=every Census county suffix is dropped, and either apostrophe, so a script and
  //   a hand-made id agree; fails_when=the rule loses an Alaska suffix or the curly apostrophe;
  //   why_new=only County, Parish and Borough were covered; seam=none;
  //   no_claim=ballot-check itself (not built yet; spec text only)
  it("the Ballot ids rule drops every county suffix and either apostrophe", () => {
    const rule = ballotRuleLine("Ballot ids");
    for (const suffix of ["City and Borough", "Census Area", "Municipality", "Parish"]) {
      assert.ok(rule.includes(suffix), `the Ballot ids rule keeps a trailing ${suffix}`);
    }
    assert.match(rule, /longest first/, "Juneau City and Borough keeps 'city-and'");
    assert.match(rule, /Juneau City and Borough gives ak-juneau-1/);
    // The rule's worked examples, run through the helper, so the two cannot drift apart.
    const examples = [...rule.matchAll(/([A-Z][\p{L} ]+?) gives ([a-z]{2})-([a-z-]+)-(\d+)/gu)];
    assert.ok(examples.length >= 2, `only ${examples.length} worked examples in the rule`);
    for (const [, county, state, words, n] of examples) {
      const want = `${state}-${words}-${n}`;
      assert.strictEqual(deriveBallotId(state.toUpperCase(), county, Number(n)), want, county);
    }
    assert.strictEqual(deriveBallotId("MD", "Prince George’s County", 1), "md-prince-georges-1");
    assert.match(rule, /apostrophes \(' or ’\) dropped/, "a pasted ’ splits the county name");
  });

  // Added by /ship pre-landing review (run 7).
  // Value: protects=the page shows a full party name even when the ballot prints an abbreviation,
  //   and that name comes from an official source; fails_when=page.md drops party_name, the
  //   example loses its abbreviation case, or ballot-check stops checking either field;
  //   why_new=page.md required "exactly as printed" and "never abbreviated" at once; seam=none;
  //   no_claim=ballot-check itself (not built yet; spec text only)
  it("an abbreviated printed party shows its official full name", () => {
    const rule = ballotRuleLine("Party names");
    const shape = rule.match(
      /fails, with no `party_name`, a `party` with any word written as an abbreviation: all capitals \(([^)]+)\), or holding a period, slash or hyphen \(([^)]+)\)\. A full name such as (.+?) passes/,
    );
    assert.ok(shape, "ballot-format.md no longer says which printed parties need party_name");
    const abbreviatedWord = /^(?:[A-Z]+|\S*[./-]\S*)$/;
    const isAbbreviated = (party) => party.split(/\s+/).some((w) => abbreviatedWord.test(w));
    const examples = (list) => [...list.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    const caught = [...examples(shape[1]), ...examples(shape[2])];
    assert.ok(
      caught.some((p) => /\s/.test(p)),
      "the rule has no multi-word abbreviation example",
    );
    for (const p of caught) assert.ok(isAbbreviated(p), `the rule's example ${p} is not caught`);
    for (const p of examples(shape[3])) assert.ok(!isAbbreviated(p), `full name ${p} is caught`);
    assert.match(rule, /a `party_name` that no `_ballot\/` snapshot contains/);
    // Ballots often print every party in capitals: those need party_name, matched ignoring case.
    assert.match(rule, /printed in capitals \(`GREEN PARTY`\) needs a `party_name`/);
    assert.match(rule, /contains it ignores case/);
    const example = BALLOT.match(/^ +party: ([A-Z]{2,5}) .*\n +party_name: \S/m);
    assert.ok(example, "the ballot.yaml example has no abbreviated party with a party_name");
    const line = PAGE.split("\n").find((l) => /^- name, then party/.test(l));
    assert.ok(line, "page.md no longer says how the party is shown");
    // An all-caps full name needs party_name too, so the page shows it whenever it is set.
    assert.match(line, /`party_name` from `ballot\.yaml` whenever it is set/);
    assert.match(line, /abbreviated or in all capitals needs one/);
    assert.match(line, /never abbreviated/);
    // Extended by /ship test coverage audit.
    // Value: protects=the wireframe heading shows the full party name over a printed DEM excerpt,
    //   as page.md's example does; fails_when=a wireframe .party span shows an abbreviation, or
    //   the abbreviated excerpt case is dropped; why_new=only page.md text was read; seam=none;
    //   no_claim=the rendered page (no renderer yet)
    const pairing = line.match(/\("(\S+ \S+) · (\w+)"\)[\s\S]*\("\1 ([A-Z]{1,5})"\)/);
    assert.ok(pairing, "page.md no longer pairs a full party name with a printed abbreviation");
    const [, name, full, abbr] = pairing;
    const wire = read("page-wireframe.html");
    const parties = [...wire.matchAll(/<span class="party">· ([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.ok(parties.length > 0, "the wireframe shows no party");
    for (const p of parties) assert.ok(!isAbbreviated(p), `wireframe party "${p}" abbreviated`);
    const block = wire.match(
      new RegExp(
        `<h3>${escapeRegExp(name)} <span class="party">· ([^<]+)</span></h3>\\s*<blockquote>“${escapeRegExp(name)} (\\S+)”`,
      ),
    );
    assert.ok(block, `the wireframe has no On the ballot block for ${name}`);
    assert.strictEqual(block[1], full, `the wireframe heading shows ${block[1]}, not ${full}`);
    assert.strictEqual(block[2], abbr, "the wireframe excerpt no longer quotes the abbreviation");
  });

  it("ballot-check names the field when a private string equals a public field", () => {
    assert.match(BALLOT, /names the field's key/, "a voter who is a candidate fails silently");
  });

  // Added by /ship pre-landing review (run 8).
  // Value: protects=a bare township word that is also the county's fails at ballot-check with
  //   its fix, not at publish; fails_when=state/county become exempt or the fix hint is dropped;
  //   why_new=only the ballot id's county words were covered; seam=none;
  //   no_claim=ballot-check (not built yet)
  it("a private entry inside state or county fails early and says how to fix it", () => {
    const rule = ballotRuleLine("Private text");
    assert.doesNotMatch(rule, /outside two places/, "state and county are exempt again");
    assert.match(
      rule,
      /when an entry appears in the `state` or `county` field, `ballot-check` fails, names that field, and says to list the township's full name/,
    );
    const ids = ballotRuleLine("Ballot ids");
    assert.doesNotMatch(ids, /not checked against `private_strings`/, "Ballot ids contradicts it");
  });

  // Added by /ship pre-landing review (cycle 3).
  // Value: protects=a private digit run shaped like a year never strips true facts by itself;
  //   fails_when=the 6.3 digit-run rule drops its year carve-out; why_new=4-digit precinct codes
  //   like 2024 matched every "elected in 2024"; seam=none; no_claim=publish (spec text only)
  it("a year-shaped private digit run matches only beside the entry's other words", () => {
    const rule = between(SKILL, "3. Privacy scan.", "\n4. ");
    assert.match(rule, /1900 to 2099/, "year-shaped digit runs still match alone");
    assert.match(rule, /receipt fetch dates/, "receipt dates may refuse the whole page");
    // Extended by /ship test coverage audit (run 9).
    // Value: protects=6.3's alone/next-to-words split, computed from its own numbers, sorts the
    //   bullet's and ballot-format.md's examples as written; fails_when=the year range, length
    //   cut-off or ballot-check warning drift from the examples; why_new=only phrases were
    //   matched; seam=none; no_claim=publish and ballot-check (not built yet; spec text only)
    const bullet = rule
      .split("\n")
      .find((l) => /^ +- the digit run of a `private_strings`/.test(l));
    const min = Number(bullet.match(/when it has (\d+) or more digits/)?.[1]);
    const years = bullet.match(
      /reads as a year \((\d{4}) to (\d{4}), as in a precinct named (\d+)\)/,
    );
    assert.ok(min && years, "the digit-run bullet lost its length cut-off or year range");
    const [, lo, hi, named] = years.map(Number);
    const isYear = (run) => run.length === 4 && Number(run) >= lo && Number(run) <= hi;
    // A run matches alone only when long enough and not year-shaped; otherwise only with words.
    const matchesAlone = (run) => run.length >= min && !isYear(run);
    assert.ok(!matchesAlone(String(named)), `the bullet's own ${named} would match alone`);
    assert.ok(matchesAlone("1899") && matchesAlone("2100"), "the year range is open-ended");
    assert.ok(!matchesAlone("999"), `a ${min - 1}-digit run matches alone`);
    // 6.3's "Pct 12" needs its words; ballot-format.md's BS-0412 matches on its own.
    const pairs = bullet.match(/next to the entry's other words \("(\D+) (\d+)"\)/);
    assert.ok(pairs && !matchesAlone(pairs[2]), "the bullet's next-to-words example matches alone");
    assert.ok(BALLOT.includes("- BS-0412 "), "the ballot-format.md example lost BS-0412");
    assert.ok(matchesAlone("0412"), "a 4-digit style code no longer matches alone");
    assert.match(
      bullet,
      /it matches only next to the entry's other words, and `ballot-check` warns when a private digit run has that shape/,
      "the year carve-out lost its words-only match or its ballot-check warning",
    );
    // Added by /ship pre-landing review (run 9): the warning 6.3 promises is a ballot-check rule.
    const privateText = ballotRuleLine("Private text");
    assert.match(
      privateText,
      /digit run reads as a year \(1900 to 2099[^)]*\), `ballot-check` warns, without quoting the entry/,
      "6.3 promises a ballot-check warning that ballot-format.md does not define",
    );
  });

  it("fetch-snapshot refuses a URL that contains the ballot id", () => {
    const rule7 = SKILL.match(/^7\. \*\*Sources are data[^\n]*/m);
    assert.ok(rule7, "SKILL.md has no Rule 7");
    assert.match(rule7[0], /refuses any URL that contains[^.]*the ballot id/);
  });

  it("the privacy scan matches the ballot id in all three forms", () => {
    const line = between(SKILL, "3. Privacy scan.", "\n4. ")
      .split("\n")
      .find((l) => /^ +- the ballot id/.test(l));
    assert.ok(line, "the privacy scan no longer names the ballot id");
    assert.doesNotMatch(
      line,
      /first two forms/,
      "the ballot id is still skipped in the third form",
    );
    assert.match(line, /the ballot id, in all three forms/, "the three-form rule is gone");
  });
});

// The <election> directory pattern the SKILL.md Layout states.
const electionPattern = () => {
  const line = between(SKILL, "## Layout")
    .split("\n")
    .find((l) => l.includes("<election>/"));
  const found = line?.match(/`(\^[^`]+\$)`/);
  assert.ok(found, "the Layout no longer states the <election> directory pattern");
  return new RegExp(found[1]);
};
// The text of a **<name>:** rule in ballot-format.md, failing if it is gone.
const ballotRuleLine = (name) => {
  const found = BALLOT.match(new RegExp(`\\*\\*${name}:\\*\\*[^\\n]*`));
  assert.ok(found, `ballot-format.md has no ${name} rule`);
  return found[0];
};
// SKILL.md's Rule 8, its Ballot gate line and publish step 6.4, failing if one is gone.
const rule8Line = () => {
  const found = SKILL.match(/^8\. \*\*Run only in the private data repo\.\*\*[^\n]*/m);
  assert.ok(found, "SKILL.md has no Rule 8");
  return found[0];
};
const ballotGate = () => {
  const found = SKILL.match(/\*\*Ballot gate\*\*[^\n]*/);
  assert.ok(found, "SKILL.md has no ballot gate");
  return found[0];
};
const step64 = () => between(SKILL, "\n4. Before any fetch, refuse if `pages_dir`", "\n5. ");
// Text escaped for use inside a RegExp (RegExp.escape needs Node 24).
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// The ballot id ballot-format.md derives from state and county, as its Ballot ids rule says.
const deriveBallotId = (state, county, n) => {
  const words = county
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/ (City and Borough|Borough|Census Area|Municipality|County|Parish)$/, "")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
  return [state.toLowerCase(), ...words, n].join("-");
};
// The data repo next to this one, if this machine has it.
const DATA_REPO = process.env.RESEARCH_DATA_REPO ?? path.join(REPO_ROOT, "..", "elections");
// Real ballot ids: the directories under each <election> directory of the data repo. Reads names only.
const realBallotIds = () => {
  const election = electionPattern();
  return fs
    .readdirSync(DATA_REPO, { withFileTypes: true })
    .filter((e) => e.isDirectory() && election.test(e.name))
    .flatMap((e) =>
      fs
        .readdirSync(path.join(DATA_REPO, e.name), { withFileTypes: true })
        .filter((b) => b.isDirectory())
        .map((b) => b.name),
    );
};

// Added by /interrogate review (descriptive ballot ids).
// Value: protects=no real ballot id from the private data repo is in this public repo's working
//   tree or index; fails_when=a real id is pasted in as an example; why_new=a real id was staged
//   as the spec's example; seam=the sibling data repo, skipped when absent (CI);
//   no_claim=history (git log -S) and other forms of the id
// Fixed by /ship pre-landing review: untracked files are searched too (a new file was missed).
// Extended for issue 01: case-insensitive, in contents and paths alike.
// Extended by PR #7 interrogate review: every separator the publish scan reads as a space
//   (pa_x_1, pa x 1, pa/x/1, pa.x.1, pa+x+1), and a directory that is not a ballot id fails
//   loudly instead of matching everywhere.
const ID_SEPARATORS = ["-", "_", " ", "/", ".", "+"];
const realBallotIdForms = () =>
  realBallotIds().flatMap((id) => {
    assert.match(id, ballotRule("Ballot ids"), "a data-repo ballot directory is not a ballot id");
    return ID_SEPARATORS.map((sep) => id.replaceAll("-", sep));
  });
describe("RealBallotIdsStayPrivate", () => {
  const skip = !fs.existsSync(DATA_REPO) && "no data repo next to this one";
  it("no real ballot id appears in this repo's files or index", { skip }, () => {
    const patterns = realBallotIdForms().flatMap((form) => ["-e", form]);
    if (patterns.length === 0) return;
    // Tracked and untracked (not ignored) files, then the index.
    for (const where of ["--untracked", "--cached"]) {
      const result = spawnSync("git", ["grep", "-l", "-i", "-F", where, ...patterns], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      });
      // git grep exits 1 on no match; an error must fail the test, not pass it silently.
      assert.ifError(result.error);
      assert.ok(result.status <= 1, `git grep ${where} failed: ${result.stderr}`);
      // A count only, never the file names: a file named for a ballot holds its id (Rule 5).
      const count = result.stdout.split("\n").filter(Boolean).length;
      assert.strictEqual(count, 0, `${count} files contain a real ballot id`);
    }
  });

  it("no real ballot id appears in a path in this repo", { skip }, () => {
    const ids = realBallotIds();
    // Any separator the scan reads as a space, folded to a hyphen.
    const fold = (p) => p.toLowerCase().replace(/[-_ /.+]/g, "-");
    const files = spawnSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    assert.strictEqual(files.status, 0, `git ls-files failed: ${files.stderr}`);
    const hits = files.stdout.split("\0").filter((p) => ids.some((id) => fold(p).includes(id)));
    // A count only, never the path: the path holds the id (Rule 5).
    assert.strictEqual(hits.length, 0, `${hits.length} paths contain a real ballot id`);
  });
});

// Added by /ship pre-landing review.
// Value: protects=every "Rule N" cited in the spec names a real numbered rule; fails_when=a
//   rule is renumbered or inserted and citations are missed; why_new=StepReferences checks
//   steps only; seam=none
describe("RuleReferences", () => {
  it("every Rule N cited in the spec exists in SKILL.md", () => {
    const rulesBlock = between(SKILL, "## Rules that never bend");
    const rules = new Set([...rulesBlock.matchAll(/^(\d+)\. \*\*/gm)].map((m) => m[1]));
    assert.ok(rules.size >= 8, `only ${rules.size} rules parsed`);
    let count = 0;
    for (const text of SPEC_TEXTS) {
      for (const [, list] of text.matchAll(/\bRules? (\d+(?:(?:, ?| and | or |-)\d+)*)\b/g)) {
        for (const n of list.split(/\D+/)) {
          count++;
          assert.ok(rules.has(n), `Rule ${n} is cited but not defined`);
        }
      }
    }
    assert.ok(count >= 4, `only ${count} Rule citations found`);
  });
});

// Added by /ship test coverage audit.
// Value: protects=every failure code the spec names is in the article-format.md table, once;
//   fails_when=a code is renamed or added in SKILL.md or a reference but not in the table;
//   why_new=no test reads the failure-code table; seam=none
describe("FailureCodes", () => {
  it("every kebab-case code named in the spec is in the failure-code table", () => {
    const table = between(ARTICLE, "## Failure codes");
    const codes = tableRows(ARTICLE, "## Failure codes").map(
      (row) => row[0].match(/^`([a-z-]+)`$/)?.[1],
    );
    assert.ok(codes.length >= 10, `only ${codes.length} failure codes parsed`);
    assert.ok(codes.every(Boolean), "a failure-code row is not a single backticked code");
    assert.strictEqual(new Set(codes).size, codes.length, "a failure code is listed twice");
    // Other kebab-case tokens the spec uses: script names, Rule markers, example ids and labels.
    const scripts = tableRows(SKILL, "## Scripts").map((row) => row[0].replaceAll("`", ""));
    const ids = exampleIds();
    // fetch-snapshot's own output codes, listed in snapshot-format.md's Command line section.
    const fetchCodes = [
      ...between(SNAPSHOT, "## Command line").matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g),
    ].map((m) => m[1]);
    assert.ok(fetchCodes.length >= 10, `only ${fetchCodes.length} fetch-snapshot codes parsed`);
    // ballot-check's own output codes, listed in ballot-format.md's Command line section.
    const ballotCodes = [
      ...between(BALLOT, "## Command line").matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g),
    ].map((m) => m[1]);
    assert.ok(ballotCodes.length >= 10, `only ${ballotCodes.length} ballot-check codes parsed`);
    // review-list's own output codes and item reasons, listed in review-list.md's Command line section.
    const reviewCodes = [
      ...between(REVIEW, "## Command line").matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g),
    ].map((m) => m[1]);
    assert.ok(reviewCodes.length >= 10, `only ${reviewCodes.length} review-list codes parsed`);
    const known = new Set([
      ...codes,
      ...fetchCodes,
      ...ballotCodes,
      ...reviewCodes,
      ...scripts,
      ...ids,
      "says-only",
      "addr-mom",
      // The tiers.yaml owner value for a source no candidate controls.
      "third-party",
      // ballot-format.md's example id for a second person with the same name.
      "john-smith-2",
      // A Claude Code SKILL.md front-matter key the ballot gate names, not a failure code.
      "allowed-tools",
      exampleBallotId(),
      // ballot-format.md derives the ballot.yaml example's id.
      ...[...BALLOT.matchAll(/the example above is `([a-z0-9-]+)`/g)].map((m) => m[1]),
    ]);
    let cited = 0;
    const texts = [
      SKILL,
      ...REF_FILES.map((f) => (f === "article-format.md" ? read(f).replace(table, "") : read(f))),
    ];
    for (const text of texts) {
      for (const [, token] of text.matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
        if (codes.includes(token)) cited++;
        assert.ok(known.has(token), `\`${token}\` reads as a failure code but is not in the table`);
      }
    }
    assert.ok(cited > 0, "no failure code is cited outside its table");
  });
});

// Added by /ship test coverage audit.
// Value: protects=every data-repo file the spec names appears in the SKILL.md Layout tree;
//   fails_when=a reference adds a data file (a log, a ledger) the Layout and its gitignore
//   check never see; why_new=PrivateDataIgnored checks only paths the Layout lists; seam=none
// Extended by /ship test coverage audit.
// Value: protects=data files with any extension (archives.tsv) are held to the same Layout rule;
//   fails_when=a data file with an unlisted extension is named in the spec but missing from the
//   Layout and its ignores; why_new=the token pattern listed extensions; seam=none;
//   no_claim=none beyond protects
describe("LayoutComplete", () => {
  it("every data file or directory named in the spec is in the Layout", () => {
    const entries = layoutEntries().map((entry) => `/${entry}`);
    const named = new Set();
    // Any extension counts, so a data file with a new one (.json, .csv) is checked by default.
    const pattern = /`((?:<ballot-id>\/)?(?:[\w.<>-]+\/)*[\w.<>-]*(?:\.[a-z]+|\/))`/g;
    for (const text of SPEC_TEXTS) {
      for (const [, token] of text.matchAll(pattern)) named.add(token.replace("<ballot-id>/", ""));
    }
    // Snapshot and source names are examples or placeholders, <slug>/ is in the Pages repo,
    // and scripts/ is in this skill.
    const data = [...named].filter(
      // Hosts in tiers.yaml examples, the `official.name` field path, paths in the skill's
      // source repo (skills/...) and the OS leftover the ballot gate skips are not data files.
      (t) =>
        !/<name>|<subject>|<slug>|^fec-totals|^\.\.\/|^scripts\/$|\.(gov|com|org)$|^official\.name$|^skills\/|^Thumbs\.db$/.test(
          t,
        ),
    );
    assert.ok(data.length >= 10, `only ${data.length} data paths named in the spec`);
    for (const token of data) {
      assert.ok(
        // A bare suffix (`.accepted`) names any Layout file ending with it.
        entries.some((entry) =>
          token.startsWith(".") ? entry.endsWith(token) : entry.includes(`/${token}`),
        ),
        `${token} is named in the spec but missing from the SKILL.md Layout`,
      );
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=the ballot.yaml example passes the ballot-check id, slug, jurisdiction and
//   display_title rules, and the slug command and README length match the slug pattern;
//   fails_when=one file changes the slug length or id pattern; why_new=no test reads them; seam=none
describe("BallotExample", () => {
  it("every example id matches the Ids pattern, which never matches _race or _ballot", () => {
    const pattern = ballotRule("Ids");
    const ids = exampleIds();
    assert.ok(ids.length >= 5, `only ${ids.length} ids in the ballot.yaml example`);
    for (const id of ids) assert.match(id, pattern, `example id ${id} fails the Ids pattern`);
    // "--" joins a contest id and a section in page anchors, so ids never hold it.
    for (const reserved of ["_race", "_ballot", "Jane", "../x", "-a", "a--b", "a-"]) {
      assert.doesNotMatch(reserved, pattern, `Ids pattern accepts ${reserved}`);
    }
  });

  it("the slug example, SKILL.md slug command and README agree with the Slug pattern", () => {
    const pattern = ballotRule("Slug");
    const slug = BALLOT.match(/^slug: (\S+)/m);
    assert.ok(slug, "ballot.yaml example has no slug");
    assert.match(slug[1], pattern, `example slug ${slug[1]} fails the Slug pattern`);
    const length = Number(pattern.source.match(/\{(\d+)\}/)?.[1]);
    const command = SKILL.match(/`LC_ALL=C tr -dc ([a-z0-9-]+) <\/dev\/urandom \| head -c(\d+)`/);
    assert.ok(command, "SKILL.md step 3 no longer gives the slug command");
    assert.strictEqual(Number(command[2]), length, "slug command length differs from the pattern");
    assert.ok(pattern.source.includes(`[${command[1]}]`), "slug command charset differs");
    const stated = README.match(/The slug is (\d+) random lowercase letters and digits/);
    assert.ok(stated, "README.md no longer states the slug length");
    assert.strictEqual(Number(stated[1]), length, "README slug length differs");
  });

  it("every example contest has a jurisdiction, and display_title differs from title", () => {
    const contests = between(BALLOT, "contests:", "\n```\n")
      .split(/\n {2}- id: /)
      .slice(1);
    assert.ok(contests.length >= 3, "ballot.yaml example has fewer than 3 contests");
    const value = (block, key) =>
      block.match(new RegExp(`^ +${key}: (.+?)(?: +#.*)?$`, "m"))?.[1]?.replace(/^"(.*)"$/, "$1");
    for (const block of contests) {
      const id = block.split("\n")[0];
      assert.ok(value(block, "jurisdiction"), `example contest ${id} has no jurisdiction`);
      const display = value(block, "display_title");
      if (display) {
        const title = value(block, "title");
        assert.notStrictEqual(display, title, `${id}: same titles`);
        for (const key of ["jurisdiction", "search_terms"]) {
          const text = value(block, key) ?? "";
          assert.ok(!text.includes(title), `${id}: ${key} holds the printed title`);
        }
      }
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=the allegation word list compiles to whole-word matches that catch every
//   listed form but not "in charge of" or "settled in"; fails_when=a bare stem such as charg or
//   settle joins the list; why_new=no test reads the word list; seam=none
describe("AllegationWords", () => {
  it("the allegation list matches its own forms and not the stated false hits", () => {
    const bullet = REVIEW.split("\n").find((line) => line.includes("allegation word"));
    assert.ok(bullet, "review-list.md no longer gives the allegation word list");
    const list = bullet.split("Bare stems")[0];
    const items = [...list.matchAll(/`([a-z]+)(?:\(([a-z|]+)\))?`/g)];
    assert.ok(items.length >= 20, `only ${items.length} allegation words parsed`);
    const forms = items.flatMap(([, stem, endings]) =>
      endings ? endings.split("|").map((end) => stem + end) : [stem],
    );
    const pattern = new RegExp(
      `\\b(?:${items
        .map(([, stem, endings]) => (endings ? `${stem}(?:${endings})?` : stem))
        .join("|")})\\b`,
      "i",
    );
    for (const form of forms) assert.match(`was ${form.toUpperCase()} in`, pattern, form);
    for (const text of [
      "in charge of",
      "settled in",
      "she settles",
      "the chargers",
      "Sue Smith said",
    ]) {
      assert.doesNotMatch(text, pattern, `allegation list matches "${text}"`);
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=the tiers.yaml example uses only table tiers and marks every T4 entry
//   statements_only, which fetch-snapshot requires to load it; fails_when=the example or the
//   tier table drifts; why_new=Tiers checks the snapshot enum, not tiers.yaml; seam=none
describe("TiersYaml", () => {
  it("the tiers.yaml example is one fetch-snapshot would load", () => {
    const block = TIERS.match(/```yaml\n([\s\S]*?)```/);
    assert.ok(block, "source-tiers.md has no tiers.yaml example");
    const entries = block[1].split(/^- /m).slice(1);
    assert.ok(entries.length >= 2, "tiers.yaml example has fewer than 2 entries");
    for (const entry of entries) {
      assert.match(entry, /^match: \S+/, `tiers.yaml entry has no match: ${entry}`);
      const tier = entry.match(/^ +tier: (\S+)/m)?.[1];
      assert.ok(TABLE_TIERS.has(tier), `tiers.yaml example uses tier ${tier}, not in the table`);
      if (tier === "T4") {
        assert.match(entry, /^ +statements_only: true\b/m, "T4 entry lacks statements_only: true");
      }
      // Extended for issue 01.
      // Value: protects=every example entry carries the owner and source fetch-snapshot copies,
      //   and a candidate-owned entry is a T4 campaign site of an example id; fails_when=an
      //   entry loses either field or owns a site under a made-up id; why_new=both fields are
      //   new; seam=none; no_claim=fetch-snapshot's loader (not built yet)
      const owner = entry.match(/^ +owner: (\S+)/m)?.[1];
      assert.ok(owner, `tiers.yaml entry has no owner: ${entry}`);
      assert.ok(
        owner === "third-party" || exampleIds().includes(owner),
        `tiers.yaml owner ${owner} is neither third-party nor a ballot.yaml example id`,
      );
      if (owner !== "third-party") {
        assert.strictEqual(tier, "T4", "a candidate-owned entry is not T4, statements only");
      }
      assert.match(entry, /^ +source: \S/m, `tiers.yaml entry has no source name: ${entry}`);
    }
    assert.ok(
      entries.some((e) => /owner: third-party/.test(e)),
      "no third-party example entry",
    );
    assert.ok(
      entries.some((e) => !/owner: third-party/.test(e)),
      "no candidate-owned example entry",
    );
  });
});

// Added by /ship test coverage audit.
// Value: protects=every snake_case field or value the spec names is declared in a code
//   example or enum, and in the format file it links to; fails_when=a reference cites a
//   ballot.yaml field (vote_for) its linked file does not declare; why_new=no test ties named
//   fields to their formats; seam=none;
//   no_claim=that the scripts read the field (no scripts exist yet)
describe("FieldNames", () => {
  it("every snake_case field or value named in the spec is declared in an example", () => {
    // Keyed by bare file name, the form a citation links to.
    const files = SPEC_FILES.filter(([file]) => file.endsWith(".md")).map(([file, text]) => [
      path.basename(file),
      text,
    ]);
    const texts = files.map(([, text]) => text);
    // Declarations per file, so a field cited with a link to its format file must be declared there.
    const declaredIn = new Map();
    const declared = new Set();
    for (const [file, text] of files) {
      const own = new Set();
      for (const [, block] of text.matchAll(/```\w*\n([\s\S]*?)```/g)) {
        for (const [, key] of block.matchAll(/^\s*-?\s*([a-z][a-z_]*):/gm)) own.add(key);
        for (const [, list] of block.matchAll(/#\s*([a-z_]+(?:\s*\|\s*[a-z_]+)+)/g)) {
          for (const value of list.split("|")) own.add(value.trim());
        }
      }
      declaredIn.set(file, own);
      for (const key of own) declared.add(key);
    }
    assert.ok(declared.size >= 20, `only ${declared.size} declared fields parsed`);
    const isKeyParam = keyParamPattern();
    let count = 0;
    for (const text of texts) {
      for (const [, token, linked] of text.matchAll(
        /`([a-z]+(?:_[a-z]+)+)`(?:[^.\n`]*?\(\[([\w-]+\.md)\]\(\2\)\))?/g,
      )) {
        count++;
        if (isKeyParam.test(token)) continue;
        assert.ok(
          declared.has(token),
          `\`${token}\` is named in the spec but no example declares it`,
        );
        if (linked && declaredIn.has(linked)) {
          assert.ok(
            declaredIn.get(linked).has(token),
            `\`${token}\` cites ${linked}, which does not declare it`,
          );
        }
      }
    }
    assert.ok(count >= 20, `only ${count} snake_case fields named in the spec`);
  });
});

// Added by /ship test coverage audit.
// Value: protects=page.md color tokens equal the wireframe's, and each stated contrast recomputes
//   by the WCAG formula; fails_when=a token changes in one file only, or a color change leaves a
//   stale contrast; why_new=no test reads page.md; seam=none; no_claim=rendered page colors
//   (no renderer exists yet)
describe("PageTokens", () => {
  const rows = tableRows(PAGE, "## Tokens", "| `--");
  const tokens = Object.fromEntries(
    rows.map((row) => [row[0].replaceAll("`", ""), [row[1], row[2]].map((c) => c.slice(1, 8))]),
  );

  it("the wireframe uses the page.md token values, light and dark", () => {
    assert.ok(rows.length >= 7, `only ${rows.length} token rows in page.md`);
    const html = read("page-wireframe.html");
    const vars = (block) =>
      Object.fromEntries(
        [...block.matchAll(/(--[\w-]+):(#[0-9a-f]{3,6})\b/g)].map(([, name, hex]) => [
          name,
          hex.length === 4 ? `#${[...hex.slice(1)].map((h) => h + h).join("")}` : hex,
        ]),
      );
    const light = vars(html.match(/:root\{([^}]*)\}/)?.[1] ?? "");
    const dark = vars(html.match(/prefers-color-scheme:dark\)\{[^{]*\{([^}]*)\}/)?.[1] ?? "");
    for (const [name, [lightHex, darkHex]] of Object.entries(tokens)) {
      assert.strictEqual(light[name], lightHex, `wireframe light ${name} differs from page.md`);
      assert.strictEqual(dark[name], darkHex, `wireframe dark ${name} differs from page.md`);
    }
  });

  it("every stated contrast ratio recomputes with the WCAG formula", () => {
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5]
        .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    let count = 0;
    for (const row of rows) {
      const name = row[0].replaceAll("`", "");
      for (const part of row[3].split(";")) {
        const m = part.match(/^\s*(?:`(--[\w-]+)` )?(\d+\.\d) \/ (\d+\.\d)(?: on `(--[\w-]+)`)?/);
        if (!m) continue;
        const [fg, bg] = m[1] ? [m[1], name] : [name, m[4] ?? "--bg"];
        assert.ok(tokens[fg] && tokens[bg], `${name}: unknown token in "${part.trim()}"`);
        [m[2], m[3]].forEach((stated, mode) => {
          count++;
          const actual = Math.round(ratio(tokens[fg][mode], tokens[bg][mode]) * 10) / 10;
          assert.strictEqual(
            actual.toFixed(1),
            stated,
            `${fg} on ${bg} (${mode ? "dark" : "light"}): page.md says ${stated}, WCAG gives ${actual}`,
          );
        });
      }
    }
    assert.ok(count >= 12, `only ${count} contrast ratios parsed`);
  });
});

// Added by /ship test coverage audit.
// Value: protects=the race-screen chips name the candidate sections of sections.md, in order;
//   fails_when=a candidate section is added, dropped or renamed without the page spec;
//   why_new=no test reads page.md's chip list; seam=none; no_claim=rendered chips (no renderer yet)
describe("PageChips", () => {
  it("the race-screen chips are the candidate sections, in order", () => {
    const line = PAGE.match(
      /chips that jump to each section in \[sections\.md\]\(sections\.md\): ([^.]+)\./,
    );
    assert.ok(line, "page.md no longer lists the race-screen chips");
    const chips = line[1].split(",").map((chip) => chip.trim());
    assert.ok(chips.every(Boolean), "page.md chip list has an empty entry");
    const sections = sectionTable("Candidate contests").rows.map((row) => row[0].slice(3));
    assert.strictEqual(chips.length, sections.length, "chip count differs from candidate sections");
    chips.forEach((chip, i) => {
      assert.ok(
        // A chip is the section name or its first word ("Record" for "Record in public office").
        chip === sections[i] || chip === sections[i].split(" ")[0],
        `chip "${chip}" does not name section "${sections[i]}"`,
      );
    });
    // Extended by /ship pre-landing review: the wireframe's race screen shows the same chips.
    assert.deepStrictEqual(
      wireframeChips("One race, by topic"),
      chips,
      "wireframe race chips differ from page.md",
    );
  });

  // Extended by /ship pre-landing review.
  // Value: protects=the measure and retention stacks in page.md name the sections.md sections, in
  //   order, and the wireframe measure chips match; fails_when=a page label drifts from
  //   sections.md (Cost for Fiscal effect); why_new=PageChips read only candidate races;
  //   seam=none; no_claim=rendered pages (no renderer yet)
  for (const [heading, label, lead] of [
    ["Measures", "Measures:", ""],
    ["Retention contests", "Retention:", "then "],
  ]) {
    it(`the ${heading.toLowerCase()} stack names its sections.md sections, in order`, () => {
      const prefix = `- **${label}**`;
      const line = PAGE.split("\n").find((l) => l.startsWith(prefix));
      assert.ok(line, `page.md has no ${label} stack`);
      const at = line.indexOf(lead, prefix.length);
      assert.ok(at !== -1, `page.md ${label} stack lost "${lead}"`);
      const list = line.slice(at + lead.length).split(". ")[0];
      const named = list.split("·").map((s) => s.replace(/\(.*?\)/g, "").trim());
      const sections = sectionTable(heading).rows.map((row) => row[0].slice(3));
      assert.deepStrictEqual(named, sections, `page.md ${label} stack differs from sections.md`);
      if (heading === "Measures") {
        assert.deepStrictEqual(
          wireframeChips("A ballot question"),
          sections,
          "wireframe measure chips differ from sections.md",
        );
      }
    });
  }
});

// Added by /ship test coverage audit.
// Value: protects=the _ballot roles ballot-view.md lists and step 2 saves are the snapshot-format.md
//   role enum; fails_when=a role is added to the enum but not to the ballot view or step 2;
//   why_new=SnapshotRoles checks only `role: x` uses in ballot-format.md; seam=none;
//   no_claim=that ballot-check writes ballot-view.md (no scripts exist yet)
describe("BallotRoles", () => {
  it("the ballot view and step 2 cover every snapshot role", () => {
    const roles = snapshotRoles();
    const view = BALLOT.match(/whose role is ([^.]+?), the only `_ballot` files/);
    assert.ok(view, "ballot-format.md no longer lists the ballot-view roles");
    const listed = [...view[1].matchAll(/`(\w+)`/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      ["sample_ballot", ...listed].sort(),
      [...roles].sort(),
      "ballot-view roles plus sample_ballot differ from the snapshot role enum",
    );
    const step2 = between(SKILL, "### 2. ", "\n### ");
    const saved = [...step2.matchAll(/`(?:role: )?([a-z]+(?:_[a-z]+)*)`[,)]/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      [...new Set(saved)].sort(),
      [...roles].sort(),
      "SKILL.md step 2 roles differ from the snapshot role enum",
    );
  });
});

// Added by /ship test coverage audit.
// Value: protects=the section-state literals sections.md and the article example use are the
//   states article-format.md defines; fails_when=a state is reworded in one file only;
//   why_new=Exemptions reads the sections.md heading, not the state literal coverage matches;
//   seam=none; no_claim=that coverage enforces the states (no scripts exist yet)
describe("SectionStates", () => {
  it("every section state named in the spec is an article-format.md state", () => {
    const states = new Set(
      [...between(ARTICLE, "## Section states").matchAll(/^- `([^`]+)`:/gm)].map((m) => m[1]),
    );
    assert.ok(states.size >= 2, `only ${states.size} section states parsed`);
    const exempt = SECTIONS.match(/in the state `([^`]+)`/);
    assert.ok(exempt, "sections.md no longer names the exemption state");
    assert.ok(states.has(exempt[1]), `sections.md state "${exempt[1]}" is not defined`);
    const bare = articleExample()
      .split("\n")
      .filter((line) => /^[A-Z]/.test(line));
    assert.ok(bare.length > 0, "article-format.md example shows no section state");
    for (const line of bare) assert.ok(states.has(line), `example state "${line}" is not defined`);
  });
});

// Added by /ship test coverage audit.
// Value: protects=page.md gives a source label for every plain claim tier, and the wireframe
//   badges are page.md labels; fails_when=a plain tier is added, or a label the wireframe shows
//   is renamed in one file only (News and Analysis have no wireframe badge);
//   why_new=no test reads the source labels; seam=none; no_claim=rendered labels (no renderer yet)
describe("SourceLabels", () => {
  it("every plain claim tier has a page label, and the wireframe uses only page labels", () => {
    const para = PAGE.match(/\*\*Source labels\.\*\*([^\n]+)/);
    assert.ok(para, "page.md no longer gives the source labels");
    const mapped = [...para[1].matchAll(/"([^"]+)" \((T\d)\b/g)];
    const plain = between(TIERS, "## Claim tags")
      .split("\n")
      .find((line) => line.startsWith("| `T1`"));
    assert.ok(plain, "source-tiers.md has no plain claim tag row");
    const plainTiers = [...cells(plain)[0].matchAll(/`(T\d)`/g)].map((m) => m[1]);
    assert.deepStrictEqual(
      mapped.map((m) => m[2]).sort(),
      plainTiers.sort(),
      "page.md source labels do not cover exactly the plain claim tiers",
    );
    const labels = new Set([...para[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
    const badges = [
      ...read("page-wireframe.html").matchAll(/<span class="badge">([^<]+)<\/span>/g),
    ].map((m) => m[1].replaceAll("&#39;", "'"));
    assert.ok(badges.length > 0, "the wireframe shows no source labels");
    for (const badge of badges) {
      assert.ok(labels.has(badge), `wireframe label "${badge}" is not a page.md source label`);
    }
  });
});

// Added by /ship test coverage audit.
// Value: protects=the excerpt length bounds in the claim rules and the excerpt-length code agree,
//   and the page's quote cut falls inside them; fails_when=one bound changes without the other;
//   why_new=FailureCodes checks code names only; seam=none; no_claim=check enforces the bounds
describe("ExcerptLength", () => {
  it("the excerpt bounds agree across the claim rules, failure code and page cut", () => {
    const rule = ARTICLE.match(/The excerpt is (\d+) to (\d+) characters/);
    assert.ok(rule, "article-format.md no longer states the excerpt bounds");
    const code = ARTICLE.match(/`excerpt-length` \| The excerpt is under (\d+) or over (\d+)/);
    assert.ok(code, "the excerpt-length row no longer states its bounds");
    assert.deepStrictEqual(code.slice(1), rule.slice(1), "excerpt-length bounds differ");
    const cut = PAGE.match(/An excerpt over (\d+) characters shows its first ~(\d+)/);
    assert.ok(cut, "page.md no longer states the excerpt cut");
    assert.strictEqual(cut[1], cut[2], "page.md excerpt cut threshold and length differ");
    const [min, max, at] = [rule[1], rule[2], cut[1]].map(Number);
    assert.ok(min < at && at < max, `page cut ${at} is outside the excerpt bounds ${min}-${max}`);
    const aim = ARTICLE.match(/compile step keeps an excerpt under (\d+) characters/);
    assert.ok(aim, "article-format.md no longer states the compile step's excerpt aim");
    assert.ok(at < aim[1] && aim[1] < max, `excerpt aim ${aim[1]} is not between ${at} and ${max}`);
  });
});

// The wireframe's visible text: comments and tags dropped, entities decoded, whitespace collapsed.
const wireframeText = () =>
  wireframeBody()
    .replace(/<[^>]+>/g, "")
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ");

// Added by /ship test coverage audit.
// Value: protects=the fixed reader-facing lines page.md gives (trust header, banners, not-ready
//   note, receipt line) are the ones the wireframe shows; fails_when=one is reworded in one file
//   only; why_new=no test reads page.md copy; seam=none; no_claim=rendered page copy (no renderer)
describe("PageCopy", () => {
  for (const phrase of [
    "Not affiliated with any campaign or party. Facts only, every one with its source.",
    "Updated Oct 24, 2026 · Not affiliated with any campaign or party · About this guide ↑",
    "6 contests on your ballot · 4 ready to read",
    "Tap a race to compare the candidates",
    "Official text and fiscal note saved",
    "Not ready yet. Every candidate gets the same research before anything shows here. Check back; this link stays the same.",
    "The quote above was saved on Oct 19, 2026 from the official record this link shows.",
    "○ Unknown: no source found",
    "Not researched yet. Research on this topic is still to come, for every candidate at once. Check back; this link stays the same.",
    "3 of 3 candidates on the official ballot · 1 topic not researched yet",
    "Next on your ballot:",
    "← All races",
  ]) {
    it(`page.md and the wireframe both show "${phrase.slice(0, 40)}"`, () => {
      assert.ok(PAGE.includes(phrase), `page.md no longer says "${phrase}"`);
      assert.ok(wireframeText().includes(phrase), `the wireframe does not show "${phrase}"`);
    });
  }

  // The wireframe's race has a section not researched yet, so it shows the banner without
  // "covered"; page.md still gives the fully covered form.
  it('page.md gives the "covered" banner, which a not-researched section drops', () => {
    assert.ok(
      PAGE.includes('("3 of 3 candidates on the official ballot covered";'),
      "page.md lost the fully covered banner",
    );
    assert.match(PAGE, /`Not researched yet` section never counts as covered/);
  });

  it("the wireframe trust header fills page.md's display_name template", () => {
    const template = PAGE.match(/"Made by <`display_name` from `publish\.yaml`> ([^"]+)"/);
    assert.ok(template, "page.md trust header no longer names display_name");
    const escaped = escapeRegExp(template[1]);
    assert.match(wireframeText(), new RegExp(`Made by \\S+ ${escaped}`), "trust header differs");
  });
});

// Added by /ship test coverage audit.
// Value: protects=the page CSP loosens only style-src 'unsafe-inline' and font-src data:, as
//   SKILL.md 6.2 states; fails_when=a script-src, 'self' or https: source is added to the CSP;
//   why_new=no test reads the CSP; seam=none; no_claim=that publish emits this CSP (no script)
describe("PageCsp", () => {
  it("every CSP directive but style-src and font-src is 'none', and no script-src exists", () => {
    const meta = SKILL.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
    assert.ok(meta, "SKILL.md step 6.2 no longer gives the page CSP");
    const directives = Object.fromEntries(
      meta[1].split(";").map((d) => {
        const [name, ...sources] = d.trim().split(/\s+/);
        return [name, sources.join(" ")];
      }),
    );
    assert.strictEqual(directives["default-src"], "'none'", "default-src is not 'none'");
    assert.ok(!("script-src" in directives), "the CSP allows scripts");
    const loosened = SKILL.match(/`font-src ([^`]+)` exists only for the embedded fonts/);
    assert.ok(loosened, "SKILL.md no longer limits font-src to the embedded fonts");
    const allowed = { "style-src": "'unsafe-inline'", "font-src": loosened[1] };
    for (const [name, sources] of Object.entries(directives)) {
      assert.strictEqual(sources, allowed[name] ?? "'none'", `CSP ${name} is loosened: ${sources}`);
    }
    assert.match(SKILL, /- `<script`, any `src` or `href` that is external/, "scan lost <script");
  });
});

// Added by /ship test coverage audit.
// Value: protects=every decorative glyph page.md lists sits in an aria-hidden span in the
//   wireframe, source-line dots included; fails_when=a glyph is added bare and screen readers
//   speak it; why_new=no test reads the a11y list; seam=none; no_claim=rendered markup
describe("PageGlyphs", () => {
  it("the wireframe hides every decorative glyph from screen readers", () => {
    const listed = PAGE.match(/Decorative glyphs \(([^)]+)\)/);
    assert.ok(listed, "page.md no longer lists the decorative glyphs");
    const glyphs = listed[1]
      .split(",")
      .map((g) => g.trim())
      .filter((g) => [...g].length === 1);
    assert.ok(glyphs.length >= 8, `only ${glyphs.length} glyphs parsed`);
    const body = wireframeBody();
    let count = 0;
    for (const glyph of glyphs) {
      for (const m of body.matchAll(new RegExp(glyph, "g"))) {
        count++;
        const before = body.slice(0, m.index);
        assert.match(
          before,
          /<span[^>]*aria-hidden="true"[^>]*>$/,
          `wireframe glyph ${glyph} at offset ${m.index} is not in an aria-hidden span`,
        );
      }
    }
    assert.ok(count >= 10, `only ${count} glyphs found in the wireframe`);
    // The source line's "·" is listed in words, not as a bare glyph.
    assert.match(listed[1], /the source line's "·"/, "page.md no longer hides the source-line dot");
    // Lazy, so each capture ends just before the dot span's own closing tag.
    const labs = [...body.matchAll(/<span class="lab">([\s\S]*?)<\/span><\/span>/g)];
    assert.ok(labs.length > 0, "the wireframe has no source lines");
    for (const [, lab] of labs) {
      assert.match(lab, /<span aria-hidden="true">·$/, `source-line dot not hidden: ${lab}`);
    }
  });
});

// Added by /ship pre-landing review (cycle 2).
// Value: protects=the wireframe's in-page links land, it has one <main>, and only links that
//   leave the page turn --visited; fails_when=a chip points at a section the sketch never
//   draws, or a frame becomes a second landmark; why_new=chips pointed at missing ids;
//   seam=none; no_claim=the rendered page (no renderer yet)
describe("WireframeStructure", () => {
  const html = () => read("page-wireframe.html");
  it("every in-page link in the wireframe lands on an element", () => {
    const ids = new Set([...html().matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const hrefs = [...html().matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    for (const href of hrefs) assert.ok(ids.has(href), `wireframe link #${href} lands nowhere`);
  });

  it("the wireframe has one <main> landmark", () => {
    assert.strictEqual((html().match(/<main\b/g) ?? []).length, 1);
  });

  it("only links that leave the page use --visited", () => {
    assert.match(html(), /a\[href\^="http"\]:visited\{color:var\(--visited\)\}/);
    for (const [, selector] of html().matchAll(/([^{}\s,]*):visited/g)) {
      assert.strictEqual(selector, 'a[href^="http"]', `in-page links turn --visited: ${selector}`);
    }
    assert.strictEqual((html().match(/var\(--visited\)/g) ?? []).length, 1, "--visited reused");
    assert.match(PAGE, /Links that leave the page use `--visited` once visited/);
  });

  // Added by /ship pre-landing review (run 8).
  // Value: protects=every ballot-list row link opens a drawn race, never the list itself;
  //   fails_when=a row links to #ballot or to a race with no frame; why_new=WireframeStructure
  //   only fails a link that lands on no id, and #ballot exists; seam=none; no_claim=the page
  it("every ballot-list row link opens a drawn race", () => {
    const source = html();
    const races = new Set([...source.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => m[1]));
    const list = source.match(/<main [^>]*id="ballot"[^>]*>([\s\S]*?)<\/main>/);
    assert.ok(list, "the wireframe has no ballot list");
    const rows = [...list[1].matchAll(/<a class="row" href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(rows.length >= 2, `only ${rows.length} linked rows`);
    for (const id of rows)
      assert.ok(races.has(id), `a ballot-list row links to #${id}, not a race`);
  });

  // Added by /ship pre-landing review (run 8, cycle 3).
  // Value: protects=the ballot-list banner counts the rows the list draws and the rows marked
  //   Ready, and page.md's banners agree; fails_when=a row is added or its status changes
  //   without the banner, or one page.md banner keeps an old count; why_new=PageCopy compares
  //   page.md and wireframe text only; seam=none; no_claim=counts on a real ballot
  it("the ballot-list banner counts the list's rows and its Ready rows", () => {
    const list = html().match(/<main [^>]*id="ballot"[^>]*>([\s\S]*?)<\/main>/);
    assert.ok(list, "the wireframe has no ballot list");
    const rows = list[1].match(/<li>/g)?.length ?? 0;
    const ready = list[1].match(/class="st ok">Ready/g)?.length ?? 0;
    const banner = list[1].match(/(\d+) contests on your ballot · <b>(\d+) ready to read<\/b>/);
    assert.ok(banner, "the wireframe list has no contests banner");
    assert.deepStrictEqual([Number(banner[1]), Number(banner[2])], [rows, ready]);
    const counts = [...PAGE.matchAll(/"(\d+) contests on your ballot · /g)].map((m) => m[1]);
    assert.ok(counts.length >= 2, "page.md lost a banner example");
    for (const n of counts) assert.strictEqual(Number(n), rows, `a page.md banner says ${n}`);
  });

  // Added by /ship pre-landing review (run 8).
  // Value: protects=hidden receipt text reads "Source for <who>, <section> section" for every
  //   section, as page.md says; fails_when=the "on <section>" form returns ("on On the ballot");
  //   why_new=no test read the hidden text; seam=none; no_claim=what a screen reader speaks
  it("hidden receipt text names the section the way page.md does", () => {
    assert.match(PAGE, /reads "Candidate's own words\. Source for Cand\. A, Money section"/);
    const hidden = [...html().matchAll(/<span class="vh"> for ([^<]+)<\/span>/g)].map((m) => m[1]);
    assert.ok(hidden.length >= 5, `only ${hidden.length} hidden receipt texts`);
    // Extended for Positions issues (issue 01).
    // Value: protects=hidden receipt text under Positions names the issue too; fails_when=the
    //   issue suffix appears outside Positions or page.md drops it; why_new=one Positions
    //   section now holds several issues; seam=none; no_claim=what a screen reader speaks
    assert.match(
      PAGE,
      /Under Positions it adds the issue: "Source for Cand\. A, Positions section, ([^"]+)"/,
    );
    for (const text of hidden)
      assert.match(
        text,
        /^[^,]+, (?:(?!Positions )[^,]+ section|Positions section, [^,]+)$/,
        `hidden text "${text}"`,
      );
  });

  // Added by /ship test coverage audit.
  // Value: protects=each drawn race's "Next on your ballot" link goes to the next drawn race in
  //   ballot-list order, and the last race links only back to the list; fails_when=a Next link
  //   skips or repeats a race, the list is reordered without its Next links, or the last race
  //   gains a Next link; why_new=link tests only checked that targets exist; seam=none;
  //   no_claim=the rendered page's race order (no renderer yet)
  it("each drawn race's Next link goes to the next drawn race in ballot-list order", () => {
    assert.match(PAGE, /the last race on the ballot has no Next link/);
    const source = html();
    const sections = [...source.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => ({
      id: m[1],
      at: m.index,
    }));
    const drawn = new Set(sections.map((s) => s.id));
    const list = source.match(/<main [^>]*id="ballot"[^>]*>([\s\S]*?)<\/main>/);
    assert.ok(list, "the wireframe has no ballot list");
    const order = [...list[1].matchAll(/<a class="row" href="#([^"]+)"/g)]
      .map((m) => m[1])
      .filter((id) => drawn.has(id));
    assert.deepStrictEqual(new Set(order), drawn, "a drawn race is missing from the ballot list");
    assert.ok(order.length >= 2, `only ${order.length} drawn races in the list`);
    // A frame without an id ("Same race, ...") belongs to the last race frame above it.
    const nexts = new Map();
    for (const m of source.matchAll(/<div class="next">([\s\S]*?)<\/div>/g)) {
      const owner = sections.filter((s) => s.at < m.index).at(-1);
      assert.ok(owner, "a .next block sits before any race");
      assert.ok(!nexts.has(owner.id), `${owner.id} has more than one .next block`);
      nexts.set(
        owner.id,
        [...m[1].matchAll(/href="#([^"]+)"/g)].map((h) => h[1]),
      );
    }
    order.forEach((id, i) => {
      const links = nexts.get(id);
      assert.ok(links, `race ${id} has no .next block`);
      const expected = i + 1 < order.length ? [order[i + 1], "ballot"] : ["ballot"];
      assert.deepStrictEqual(links, expected, `race ${id}'s .next links are ${links}`);
    });
  });

  // Added by /ship test coverage audit.
  // Value: protects=page.md's frame list (ballot list, race in four frames, question in two, a
  //   not-ready race, greyed My weights) matches the wireframe labels; fails_when=a frame is
  //   added, dropped or reordered in one file only; why_new=no test read the frame labels;
  //   seam=none; no_claim=the PNG export (binary, not read)
  it("page.md's frame list matches the wireframe frame labels", () => {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };
    const intro = PAGE.match(
      /It shows (the ballot list); a candidate race in (\w+) frames, in page order \(([^)]+)\); (a race that is not ready yet); and a ballot question in (\w+) frames, the last race on the ballot\./,
    );
    assert.ok(intro, "page.md no longer lists the wireframe frames");
    assert.match(PAGE, /The My weights screen is greyed out because it comes later/);
    const raceParts = intro[3].split(/, (?:and )?/);
    const labels = [...html().matchAll(/<div class="label">([^<]+)<\/div>/g)].map((m) => m[1]);
    const groups = new Map();
    for (const label of labels) {
      const n = label.match(/^(\d+)[a-z]? · /);
      assert.ok(n, `wireframe label "${label}" has no frame number`);
      groups.set(n[1], [...(groups.get(n[1]) ?? []), label]);
    }
    assert.deepStrictEqual(
      [...groups.values()].map((g) => g.length),
      [1, words[intro[2]], 1, words[intro[5]], 1],
      `wireframe frame groups are ${[...groups.keys()]}`,
    );
    assert.strictEqual(raceParts.length, words[intro[2]], "the race frame list and count differ");
    const race = groups.get("2");
    // Each race frame is named the same way in both files, in the same order.
    const keys = [/\btop\b|One race/, /Money section/, /Positions/, /last section/];
    keys.forEach((key, i) => {
      assert.match(raceParts[i], key, `page.md race frame ${i + 1} is "${raceParts[i]}"`);
      assert.match(race[i], key, `wireframe race frame ${i + 1} is "${race[i]}"`);
    });
    assert.match(race[1], /receipt open/);
    assert.match(groups.get("1")[0], /Your ballot/);
    assert.match(groups.get("3")[0], /not ready yet/);
    assert.match(groups.get("4")[0], /ballot question/);
    assert.match(groups.get("5")[0], /^5 · My weights · LATER/);
    assert.match(html(), /<section class="phone later">/, "the My weights frame is not greyed out");
  });
});

// Added by /ship test coverage audit.
// Value: protects=the ballot-list anchor page.md names is the id ballot-format.md reserves, and
//   wireframe links use it, <contest> or <contest>--<section>; fails_when=the list anchor is renamed in one
//   file only; why_new=Ids test covers _race/_ballot, not ballot; seam=none; no_claim=page anchors
describe("PageAnchors", () => {
  it("the reserved ballot anchor agrees across page.md, ballot-format.md and the wireframe", () => {
    const anchor = PAGE.match(/The ballot list's anchor is `#([a-z-]+)`/);
    assert.ok(anchor, "page.md no longer names the ballot list anchor");
    const reserved = BALLOT.match(/A contest id may not be `([a-z-]+)`/);
    assert.ok(reserved, "ballot-format.md no longer reserves a contest id");
    assert.strictEqual(reserved[1], anchor[1], "reserved contest id differs from the list anchor");
    const ids = exampleIds();
    assert.ok(!ids.includes(anchor[1]), `example contest id uses the reserved ${anchor[1]}`);
    const html = read("page-wireframe.html");
    assert.match(html, new RegExp(`<main [^>]*id="${anchor[1]}"`), "wireframe list lacks anchor");
    const idPattern = ballotRule("Ids");
    const hrefs = [...html.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    assert.ok(hrefs.length >= 10, `only ${hrefs.length} wireframe anchor links`);
    // Races the wireframe draws: a race container's id, or a contest with section anchors. A
    // bare race link must name one, so a link left on the old list anchor after a rename fails.
    const races = new Set([
      ...[...html.matchAll(/<section [^>]*id="([^"]+)"/g)].map((m) => m[1]),
      ...hrefs.filter((h) => h.includes("--")).map((h) => h.split("--")[0]),
    ]);
    for (const href of hrefs) {
      if (href === anchor[1]) continue;
      // A race anchor is the bare contest id; a section anchor adds --<section> (page.md).
      const [contest, section, extra] = href.split("--");
      assert.ok(
        section !== "" && extra === undefined,
        `wireframe link #${href} is not <contest> or <contest>--<section>`,
      );
      assert.match(contest, idPattern, `wireframe link #${href} has a bad contest id`);
      if (section === undefined) {
        assert.ok(races.has(contest), `wireframe link #${href} names no race on the page`);
      }
    }
  });
});

// A --pin naming a commit (the README's <commit> placeholder or a hex SHA), never a moving ref.
// Twin of the pin regex in skills/mywiki/tests/readme-install.test.js; change both together.
const PINNED = /--pin (<commit>|[0-9a-f]{7,40})(\s|$)/;
// An installer flag that installs for every project rather than the current repo.
const USER_SCOPE = /--scope[= ]user|(^|\s)(-g|--global)(\s|=|$)/;

// Added by /ship test coverage audit.
// Value: protects=README.md's install commands install this skill, at project scope only;
//   fails_when=a command copied from another skill's README names that skill, or a user-scope
//   flag is added; why_new=no test read the install block; seam=none;
//   no_claim=that gh skill or npx skills accept these flags (no installer is run)
describe("InstallCommands", () => {
  // Extended by /ship pre-landing review: gh only and pinned, since the rules are the privacy
  //   boundary and the install runs inside the private data repo.
  it("every install command is a pinned gh install of this skill at project scope", () => {
    const skill = path.basename(SKILL_DIR);
    assert.doesNotMatch(README, /npx skills add/, "README.md offers an unpinned npx install");
    const commands = README.split("\n").filter((l) => /\bgh skill install\b/.test(l));
    assert.ok(commands.length >= 1, "README.md no longer gives the gh install command");
    for (const line of commands) {
      const named = line.match(/gh skill install (\S+) (\S+)/);
      assert.ok(named, `install command names no skill: ${line}`);
      assert.strictEqual(named[2], skill, "install command names another skill");
      assert.match(line, PINNED, "install command is not pinned to a commit");
      // The ballot gate checks the copy at .claude/skills/research-candidates.
      assert.match(line, /--agent claude-code(\s|$)/, `not a Claude Code install: ${line}`);
      // Rule 8: the skill runs only in the private data repo.
      assert.doesNotMatch(line, USER_SCOPE, "an install command is user scope");
    }
  });

  // Added by /ship pre-landing review (cycle 2).
  // Value: protects=Rule 8, 6.4 and the ballot gate say how the skill's source repo and the
  //   installed copy are checked; fails_when=a check falls back to a name match or vanishes;
  //   why_new=copied installs broke Rule 8's "own repo" test; seam=none;
  //   no_claim=the scripts themselves (not built yet; spec text only)
  it("Rule 8 checks for the skill's source repo concretely, not as 'its own repo'", () => {
    const rule8 = rule8Line();
    assert.doesNotMatch(rule8, /is not this skill's own repo/, "Rule 8 still reads ambiguously");
    assert.match(rule8, /`skills\/research-candidates\/SKILL\.md`/);
    // The root of the fork network, so a fork of a fork is caught too.
    assert.match(rule8, /`\.source\.id \/\/ \.id`/);
    // Extended by /ship test coverage audit (run 9).
    // Value: protects=Rule 8 checks every fetch AND push URL of every remote is PRIVATE, an
    //   unconfirmable remote counts as public, and step 1 runs it first; fails_when=the push-URL
    //   check or the fail-closed clause is dropped, or step 1 stops checking Rule 8 first;
    //   why_new=only the source-repo half of Rule 8 was read; seam=none;
    //   no_claim=the Rule 8 check itself (not built yet; spec text only)
    assert.match(rule8, /every fetch and push URL of every remote/, "Rule 8 skips push URLs");
    assert.match(rule8, /`git remote get-url --all <name>`/);
    assert.match(rule8, /`git remote get-url --push --all <name>`/, "a pushurl can go public");
    assert.match(rule8, /`gh repo view --json visibility` reports `PRIVATE`/);
    assert.match(
      rule8,
      /cannot be confirmed `PRIVATE` \(not on GitHub, an error, empty output\) counts as public/,
      "Rule 8 no longer fails closed on an unreadable remote",
    );
    assert.match(rule8, /Before any step writes a file/, "Rule 8 runs after a write");
    const step1 = between(WORKFLOW, "### 1. ", "\n### ");
    assert.match(step1, /^Check Rule 8 first\./m, "step 1 no longer checks Rule 8 first");
  });

  // Added by /ship pre-landing review (run 7).
  // Extended by /ship test coverage audit.
  // Value: protects=every source-repo check uses one recorded numeric id, never a name lookup;
  //   fails_when=the id is dropped, differs between Rule 8, 6.1 and 6.4, or a name lookup returns
  //   (a `gh api repos/marlonchen/claudetopus` path anywhere in SKILL.md); why_new=a renamed or
  //   re-registered repo would pass a lookup by name, and only the id's presence was checked;
  //   seam=none; no_claim=that 1373776339 is still marlonchen/claudetopus on GitHub (no network
  //   call)
  it("Rule 8, the ballot gate and 6.4 share one recorded source repo id", () => {
    assert.doesNotMatch(
      SKILL,
      /gh api repos\/marlonchen\/claudetopus/,
      "SKILL.md looks the source repo up by name",
    );
    const rule8 = rule8Line();
    const id = rule8.match(/that repo's id, `(\d+)`/);
    assert.ok(id, "Rule 8 does not record the source repo's id");
    assert.match(rule8, new RegExp(`\`gh api repositories/${id[1]}/\\.\\.\\.\``));
    assert.match(rule8, /never a lookup by name/);
    const gate = ballotGate();
    assert.match(gate, /by its recorded id \(Rule 8\)/);
    assert.ok(gate.includes(`repositories/${id[1]}/compare/`), "the gate's id differs from Rule 8");
    const step = step64();
    assert.match(step, /the recorded id \(Rule 8\)/, "6.4 does not use Rule 8's id");
    const all = [...SKILL.matchAll(/repositories\/(\d+)/g)].map((m) => m[1]);
    assert.ok(all.length >= 3, `only ${all.length} recorded-id API paths`);
    for (const n of all) assert.strictEqual(n, id[1], `SKILL.md queries repository ${n}`);
    assert.ok(gate.includes(`\`gh api repositories/${id[1]} --jq .default_branch\``));
  });

  it("step 6.4 compares repo ids and the remote's default branch, not names", () => {
    const step = step64();
    assert.match(step, /`\.source\.id \/\/ \.id`/, "6.4 matches the source repo by name");
    // origin/HEAD goes stale; ask the remote, and check the branch that is pushed to.
    assert.match(step, /`git ls-remote --symref origin HEAD`/, "6.4 trusts a stale origin/HEAD");
    assert.match(step, /`origin\/<branch>`/, "6.4 skips the branch it pushes to");
    assert.doesNotMatch(step, /origin\/HEAD`/, "6.4 still reads origin/HEAD");
  });

  // Added by /ship pre-landing review (run 7).
  // Extended by /ship test coverage audit.
  // Value: protects=6.4 checks origin's URLs before it fetches, fetches once, and refuses a
  //   remote whose fork root cannot be read; fails_when=a URL check moves after the fetch or
  //   its phrase is dropped, a second fetch appears, or the unreadable case is dropped;
  //   why_new=6.4 fetched from an unchecked origin, and a dropped phrase (index -1) passed the
  //   order check; seam=none; no_claim=publish itself (not built yet; spec text only)
  it("step 6.4 checks origin before one fetch and refuses an unreadable fork root", () => {
    const step = step64();
    assert.strictEqual(step.match(/git fetch origin/g)?.length, 1, "6.4 fetches more than once");
    const fetch = step.indexOf("git fetch origin");
    const origin = step.indexOf("is not `pages_repo`");
    const fork = step.indexOf("fork-network root");
    assert.ok(origin >= 0, "6.4 no longer checks origin against pages_repo");
    assert.ok(fork >= 0, "6.4 no longer checks origin's fork-network root");
    assert.ok(origin < fetch, "6.4 fetches before checking origin");
    assert.ok(fork < fetch, "6.4 fetches before the fork check");
    assert.match(step, /fork-network root that cannot be read \(not on GitHub, an error, empty/);
    assert.strictEqual(
      step.indexOf("fork-network root", fetch),
      -1,
      "a fork check follows the fetch",
    );
  });

  it("the ballot gate refuses an installed skill that differs from its pinned commit", () => {
    const gate = ballotGate();
    assert.match(gate, /`\.claude\/skills\/research-candidates`/);
    assert.match(gate, /`skill_commit`/);
    // Set equality on disk, ignored files and symlinks included, not only the upstream list.
    assert.match(gate, /every file on disk/, "the gate misses files added after install");
    assert.match(gate, /symlink/, "the gate allows symlinks");
    // Run 8 review: a Finder .DS_Store must not refuse election-week publish as if tampered with,
    // and any other extra file must be named so the researcher can remove it.
    assert.match(
      gate,
      /except regular files that are operating-system and editor leftovers \(`\.DS_Store`/,
    );
    assert.match(gate, /nothing under it may be a symlink/, "a skipped leftover may be a symlink");
    // The uncommitted-changes check comes first, so it must skip the same leftovers.
    assert.match(gate, /no uncommitted changes, apart from the leftover files named below/);
    assert.match(gate, /any other extra file refuses with its path named/);
    // gh skill install rewrites SKILL.md's front matter, so that file is compared by content.
    assert.match(gate, /front matter/, "SKILL.md can never hash-match after install");
    // gh drops the blank line after the front matter and adds only `metadata` (seen on both a
    // --from-local and a --pin install); any other key, such as allowed-tools, must fail.
    assert.match(gate, /blank lines at its start ignored/, "every real install fails the body");
    assert.match(gate, /once the `metadata` key the install adds is removed/);
    assert.match(gate, /`allowed-tools`, fails/, "added front matter keys pass the gate");
    // A SHA that exists only in a fork is served by the parent repo's API too.
    assert.match(gate, /reachable from that repo's default branch/, "fork-only commits pass");
    // Extended by /ship test coverage audit.
    // Value: protects=the gate compares skill_commit against the branch the API names as default;
    //   fails_when=compare uses a hard-coded branch, or <default> loses its API source;
    //   why_new=only the jq phrase was checked, so compare/main... passed; seam=none;
    //   no_claim=that GitHub's compare API returns behind/identical as stated (no network call)
    const compare = [...gate.matchAll(/compare\/([^.`]+)\.\.\.<skill_commit>/g)].map((m) => m[1]);
    assert.deepStrictEqual(compare, ["<default>"], `the gate compares against ${compare}`);
    assert.match(
      gate,
      /where `<default>` is `gh api repositories\/\d+ --jq \.default_branch`/,
      "the gate's <default> no longer comes from the API",
    );
    assert.match(gate, /reports `behind` or `identical`/, "the gate accepts a commit ahead of it");
    // The check runs inside publish, so it catches drift, not a hostile edit to publish.
    assert.match(gate, /accidental drift/, "the gate overstates what it can catch");
    const rule7 = SKILL.match(/^7\. \*\*Sources are data[\s\S]*?\n8\. /m)[0];
    assert.match(rule7, /never edits a review file, `tiers\.yaml` or `publish\.yaml`/);
    assert.match(between(SKILL, "`publish.yaml` names the Pages target"), /^skill_commit: /m);
  });

  // Added by /ship pre-landing review.
  // Value: protects=publish refuses a Pages target that is this skill's own public source repo;
  //   fails_when=the source repo is renamed in README or 6.4 alone, or 6.4 drops the refusal;
  //   why_new=copy installs no longer reveal the source repo; seam=none;
  //   no_claim=publish itself (not built yet; spec text only)
  it("publish step 6.4 refuses the skill's source repo the README installs from", () => {
    const source = README.match(/gh skill install (\S+) /);
    assert.ok(source, "README.md no longer names the source repo");
    const step = step64();
    assert.ok(step.includes(`\`${source[1]}\``), `step 6.4 does not refuse ${source[1]}`);
    assert.match(
      step,
      /`skills\/\*\/SKILL\.md`/,
      "step 6.4 does not refuse a clone of a skill repo",
    );
  });

  // Extended by /ship test coverage audit.
  // Value: protects=the root README's non-dev install commands are pinned Claude Code installs
  //   at project scope; fails_when=a gh skill install line without --from-local loses its pin or
  //   --agent claude-code, or gains a user-scope flag; why_new=only the prose rule was read, not
  //   the commands beside it; seam=none; no_claim=that gh accepts these flags (no installer is run)
  it("the root README tells readers this skill installs only pinned, with gh", () => {
    const section = between(ROOT_README, "## Install a skill");
    assert.match(section, /research-candidates install\s+only with `gh`, pinned to a commit/);
    const commands = section
      .split("\n")
      .filter((l) => /\bgh skill install\b/.test(l) && !/--from-local/.test(l));
    assert.ok(commands.length >= 1, "the root README no longer gives a pinned install command");
    for (const line of commands) {
      assert.match(line, PINNED, `root README install is not pinned: ${line}`);
      assert.match(line, /--agent claude-code(\s|$)/, `not a Claude Code install: ${line}`);
      assert.doesNotMatch(line, USER_SCOPE, `root README install is user scope: ${line}`);
    }
  });

  // Added by /ship pre-landing review (cycle 3).
  // Extended by /ship test coverage audit.
  // Value: protects=the root README's --from-local dev install targets only a throwaway repo;
  //   fails_when=the dev paragraph drops "never one that holds private data" or the command
  //   leaves its section; why_new=only the skill README's from-local rule was read;
  //   seam=none; no_claim=that gh accepts --from-local (no installer is run)
  it("local dev installs never target the real data repo, and upgrades never use update --all", () => {
    assert.match(README, /never run `--from-local` into the real data repo/);
    assert.match(
      ROOT_README,
      /never run `gh skill update --all` in a repo that holds private data/,
    );
    const section = between(ROOT_README, "## Install a skill");
    assert.match(section, /--from-local/, "the root README lost its local dev install");
    assert.match(section, /throwaway repo \(never one that\s+holds private data\)/);
  });

  // Added by /ship test coverage audit.
  // Value: protects=README's Repos table keeps data private and names the Pages repo publish.yaml
  //   uses; fails_when=a row's visibility flips, or the Pages repo is renamed in one file only;
  //   why_new=no test read the Repos table; seam=none; no_claim=real GitHub visibility (Rule 8)
  it("the README Repos table keeps data private and agrees with publish.yaml", () => {
    const rows = Object.fromEntries(
      tableRows(README, "## Repos").map((row) => [row[0].replaceAll("`", "").split(" ")[0], row]),
    );
    assert.strictEqual(rows.claudetopus?.[1], "Public", "the Repos table lost the source repo");
    assert.strictEqual(rows.elections?.[1], "Private", "the data repo is not listed as private");
    assert.match(rows.elections[2], /all research data/);
    const pagesRepo = between(SKILL, "`publish.yaml` names the Pages target").match(
      /^pages_repo: <user>\/(\S+)/m,
    );
    assert.ok(pagesRepo, "the publish.yaml example has no pages_repo");
    const pages = rows[pagesRepo[1]];
    assert.ok(pages, `the Repos table has no row for pages_repo ${pagesRepo[1]}`);
    assert.strictEqual(pages[1], "Public");
    assert.ok(pages[2].includes(`.github.io/${pagesRepo[1]}/<slug>/`), "Pages URL differs");
    assert.match(README, /GitHub Pages is off for it/, "this repo may serve ballot pages");
  });

  // Added by /ship pre-landing review (cycle 3).
  // Extended by /ship test coverage audit.
  // Value: protects=test fixtures that model a data repo (.claude/, coverage/) stay tracked,
  //   while per-user settings.local.json under them stays out of this public repo;
  //   fails_when=an unanchored ignore rule swallows them, or the settings.local.json rule is
  //   dropped from .gitignore and only a personal global ignore hides the file;
  //   why_new=.claude/ and coverage matched at any depth, and the re-included .claude/ was
  //   never checked for local settings; seam=none; no_claim=fixtures that do not exist yet
  it("no ignore rule swallows files under skills/*/tests", () => {
    const probes = [
      "skills/research-candidates/tests/fixtures/repo/.claude/settings.json",
      "skills/research-candidates/tests/coverage/example.md",
    ];
    const result = checkIgnore([], probes);
    assert.strictEqual(result.status, 1, `ignored under tests/: ${result.stdout.trim()}`);
    const local = "skills/research-candidates/tests/fixtures/repo/.claude/settings.local.json";
    const ignored = checkIgnore(["-v"], [local]);
    assert.strictEqual(ignored.status, 0, `${local} is not ignored: ${ignored.stderr}`);
    const line = ignored.stdout.split("\n").find((l) => l.endsWith(`\t${local}`));
    assert.ok(line, `${local} is not ignored`);
    assert.match(line, /^\.gitignore:/, `${local} is ignored only by ${line}`);
    assert.doesNotMatch(line, /:!/, `${local} is re-included by a negation: ${line}`);
  });

  // Added by /ship test coverage audit.
  // Value: protects=README tells the installer to pin a commit on the default branch, as the
  //   ballot gate requires; fails_when=README drops the default-branch rule or names another
  //   branch; why_new=only the pin's shape was checked; seam=none;
  //   no_claim=that main is still the GitHub default branch (no network call)
  it("README pins a commit on the default branch the ballot gate checks", () => {
    const install = between(README, "## Install");
    assert.match(
      install,
      /Pin a commit of this repo you have read that is on its default branch \(`main`; publish refuses a commit only on another branch or a fork\)/,
    );
    assert.match(SKILL, /`skill_commit` must be reachable from that repo's default branch/);
  });

  // Added by /ship test coverage audit.
  // Value: protects=README's upgrade order: delete the old copy, reinstall the new commit, set
  //   skill_commit to it, commit both; fails_when=a step is dropped or reordered;
  //   why_new=only "never update --all" was checked; seam=none; no_claim=gh install behaviour
  it("README upgrades by delete, reinstall, set skill_commit, then commit both", () => {
    const install = between(README, "## Install");
    const steps = [
      "To upgrade, read the diff",
      "delete `.claude/skills/research-candidates`",
      "run the install again with the new commit",
      "set `skill_commit` in `publish.yaml` to it",
      "commit both",
    ].map((step) => [step, install.indexOf(step)]);
    for (const [step, at] of steps) assert.ok(at >= 0, `README upgrade lost "${step}"`);
    for (let i = 1; i < steps.length; i++) {
      assert.ok(
        steps[i - 1][1] < steps[i][1],
        `"${steps[i][0]}" comes before "${steps[i - 1][0]}"`,
      );
    }
    assert.match(install, /record it as `skill_commit` in `publish\.yaml`/);
  });

  it("the pin check takes only a commit, never a branch or tag name", () => {
    for (const pin of ["<commit>", "53e4838", "53e4838d1cf47f5c7e832b1be56f3b3dfd01ac4d"]) {
      assert.match(`gh skill install o/r x --pin ${pin}`, PINNED, `--pin ${pin} is refused`);
    }
    for (const pin of ["main", "latest", "v1.0.0"]) {
      assert.doesNotMatch(`gh skill install o/r x --pin ${pin}`, PINNED, `--pin ${pin} passes`);
    }
  });

  it("the user-scope check catches every spelling of user scope", () => {
    for (const flag of ["--scope user", "--scope=user", "-g", "--global"]) {
      assert.match(`npx skills add o/r --skill x ${flag}`, USER_SCOPE, `${flag} is not caught`);
    }
    assert.doesNotMatch("gh skill install o/r x --scope project --agent claude-code", USER_SCOPE);
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=6.2's receipt link cases, page.md's four receipt lines and the Wayback rule
//   agree: _ballot gets the county origin and no saved copy, a query or API url gets no link;
//   fails_when=one file adds a link case, drops one, or lets _ballot or a query url reach
//   Wayback; why_new=no test read receipt links or Saved copies; seam=none;
//   no_claim=publish's renderer and fetch-snapshot (not built yet; spec text only)
describe("ReceiptLinks", () => {
  it("6.2's link cases, page.md's receipt lines and the Wayback rule agree", () => {
    const step62 = between(SKILL, "\n2. Before rendering,", "\n3. Privacy scan.");
    assert.match(
      step62,
      /Receipt links allow only `http` and `https` URLs and carry no query string or fragment/,
    );
    assert.match(
      step62,
      /original-page link is the snapshot's `public_url` when it has one, otherwise its `url`/,
    );
    // The two no-link cases, each with page.md's line for it.
    assert.match(step62, /a `url` with a query string and no `public_url` gets no original-page/);
    assert.match(step62, /a `method: api` snapshot with no `public_url`/);
    // The saved copy is rebuilt from the snapshot, never taken from the append-only log.
    assert.match(
      step62,
      /rebuilt as `https:\/\/web\.archive\.org\/web\/<timestamp>\/<url>` from the snapshot's own cleaned `url` and the line's 14-digit timestamp, never copied from `archives\.tsv`/,
    );
    // The per-ballot path can encode the precinct or ballot style.
    assert.match(step62, /A `_ballot` receipt links only to the county site's origin/);
    assert.match(step62, /never the per-ballot path[^.]*\. It gets no saved-copy link\./);

    // fetch-snapshot asks Wayback only for snapshots whose original-page link is their own url.
    const saved = between(SNAPSHOT, "## Saved copies");
    for (const condition of [
      "that is not `_ballot`",
      "whose `method` is not `api`",
      "whose cleaned `url` has no query string",
      "that has no `public_url`",
    ]) {
      assert.ok(
        saved.includes(condition),
        `Saved copies no longer requires a snapshot ${condition}`,
      );
    }
    assert.match(saved, /`_ballot` snapshots are never submitted/);
    const stamp = saved.match(/14-digit capture timestamp \(`([A-Za-z]+)`\)/);
    assert.ok(stamp, "Saved copies no longer gives the timestamp shape");
    assert.strictEqual(stamp[1].length, 14, `${stamp[1]} is not 14 digits`);

    // page.md: one receipt line per link case, and its stated count matches.
    const receipts = PAGE.split("\n").find((l) => l.startsWith("**Receipts.**"));
    assert.ok(receipts, "page.md has no Receipts paragraph");
    const cases = {
      "A `public_url` link": /from the official record this link shows/,
      "A `_ballot` receipt, whose link is the county origin": /opens the county election site/,
      "A receipt with no link": /its address can't be shared/,
      "An API source with no `public_url`": /official data service, which has no page to link/,
    };
    for (const [lead, line] of Object.entries(cases)) {
      const at = receipts.indexOf(`${lead}: "The quote above was saved on`);
      assert.ok(at >= 0, `page.md has no receipt line for "${lead}"`);
      assert.match(receipts.slice(at, receipts.indexOf('"', receipts.indexOf('"', at) + 1)), line);
    }
    const count = receipts.match(/: "The quote above was saved on/g)?.length ?? 0;
    assert.strictEqual(count, Object.keys(cases).length, "page.md has an unlisted receipt line");
    const words = { Three: 3, Four: 4, Five: 5, Six: 6 };
    const stated = receipts.match(/(\w+) receipts use a different line instead/);
    assert.ok(stated, "page.md no longer states how many receipts differ");
    assert.strictEqual(
      words[stated[1]],
      count,
      `page.md says ${stated[1]} receipts, lists ${count}`,
    );
    assert.match(receipts, /Which links a receipt gets, if any, is set by SKILL\.md step 6\.2/);
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=--show and --ballot never run inside the session (no TTY or CLAUDECODE set),
//   and the agents' fetch tool rejects every researcher-only fetch-snapshot mode;
//   fails_when=a refusal condition is dropped, or a mode is added to the Scripts table without
//   joining the reject list; why_new=no test read Rule 5's terminal guard; seam=none;
//   no_claim=the scripts and the data repo's settings (not built yet; spec text only)
describe("ResearcherOnlyModes", () => {
  it("--show and --ballot refuse in the session, and agents' fetch rejects every mode", () => {
    const rule5 = SKILL.match(/^5\. \*\*Private data stays private\.\*\*[^\n]*/m);
    assert.ok(rule5, "SKILL.md has no Rule 5");
    assert.match(rule5[0], /`--show` and `--ballot` print or prompt with private text/);
    assert.match(
      rule5[0],
      /refuse when stdout is not a terminal or the `CLAUDECODE` environment variable is set/,
      "the terminal guard lost a condition",
    );
    assert.match(rule5[0], /never through the session or its `!` prefix/);
    assert.match(rule5[0], /settings deny them to every Bash call/);
    assert.match(rule5[0], /`--show`, which only the researcher runs and the model never does/);
    // Every other --show in the spec is the researcher's, under Rule 5.
    for (const [file, text] of SPEC_FILES) {
      for (const line of text.split("\n").filter((l) => l.includes("--show"))) {
        if (file === "SKILL.md" && line === rule5[0]) continue;
        assert.match(line, /researcher[^.]*`[^`]*--show` \(Rule 5\)/, `${file}: --show not Rule 5`);
      }
    }
    // The agents' fetch tool rejects every mode the Scripts table gives fetch-snapshot.
    const row = scriptRow("fetch-snapshot");
    const modes = new Set([...row.matchAll(/`(?:--\w+ )?(--\w+)`/g)].map((m) => m[1]));
    assert.ok(modes.size >= 2, `only ${[...modes]} fetch-snapshot modes found`);
    const rejects = SNAPSHOT.match(/The fetch tool given to agents rejects ([^.]+)\./);
    assert.ok(rejects, "snapshot-format.md no longer says what the agents' fetch tool rejects");
    const rejected = new Set([...rejects[1].matchAll(/`(--\w+)`/g)].map((m) => m[1]));
    // Extended for the search log (issue 01).
    // Value: protects=agents get exactly one fetch-snapshot mode, --searched, bound to their
    //   contest, and every other mode stays rejected; fails_when=a mode is both allowed and
    //   rejected, or another mode joins the allow list; why_new=discovery must log the items it
    //   ran; seam=none; no_claim=the agent tool configuration (not built yet)
    const allows = SNAPSHOT.match(
      /It allows only a plain fetch and ([^.]+?), both bound to the agent's own contest[.:]/,
    );
    assert.ok(allows, "snapshot-format.md no longer says what the agents' fetch tool allows");
    const allowed = new Set([...allows[1].matchAll(/`(--\w+)`/g)].map((m) => m[1]));
    assert.deepStrictEqual([...allowed], ["--searched"], "agents' fetch tool allows another mode");
    for (const mode of modes) {
      assert.ok(
        rejected.has(mode) !== allowed.has(mode),
        `agents' fetch tool ${mode}: not exactly one of rejected or allowed`,
      );
    }
    assert.match(
      SKILL,
      /the fetch tool given to agents rejects it/,
      "Rule 7 lost the --ballot ban",
    );
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=every value Rule 7's fetch refusal names is one the 6.3 privacy scan defines a
//   match for, and the scan keeps its ZIP, address and title items; fails_when=Rule 7 names a
//   value 6.3 no longer scans, or 6.3 drops an item; why_new=only the ballot-id item and the
//   year carve-out were read; seam=none; no_claim=fetch-snapshot and publish (not built yet)
describe("PrivacyScanItems", () => {
  it("Rule 7's fetch refusal matches only values the 6.3 privacy scan defines", () => {
    const rule7 = SKILL.match(/^7\. \*\*Sources are data[^\n]*/m)[0];
    const refusal = rule7.match(/refuses any URL that contains (.+?), matched as in the publish/);
    assert.ok(refusal, "Rule 7 no longer bases its fetch refusal on the privacy scan");
    const scan = between(SKILL, "3. Privacy scan.", "\n4. ");
    const items = scan.split("\n").filter((l) => /^ {3}- /.test(l));
    assert.ok(items.length >= 6, `only ${items.length} privacy scan items`);
    // Word boundaries, so "address" never matches inside `addresses.yaml`.
    for (const value of ["the ballot id", "address", "street line", "ZIP code", "label"]) {
      const word = new RegExp(`\\b${value}\\b(?!es)`);
      assert.match(refusal[1], word, `Rule 7 no longer refuses a URL with ${value}`);
      assert.ok(
        items.some((i) => word.test(i)),
        `6.3 does not scan ${value}, so Rule 7's match is undefined`,
      );
    }
    assert.ok(refusal[1].includes("`private_strings` entry"));
    assert.ok(items.some((i) => i.includes("`private_strings` entry")));
    // The scan's own items that Rule 7 does not need.
    assert.ok(items.some((i) => /ZIP code from `addresses\.yaml` as a standalone 5-digit/.test(i)));
    assert.ok(
      items.some((i) => /printed `title` of any contest that has a `display_title`/.test(i)),
    );
    assert.match(scan, /whole-phrase match on word boundaries, never a substring/);
    assert.match(scan, /`fetch-snapshot` and `ballot-check` match `private_strings` the same way/);
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=a missing review file next to a baseline is never a first run, so no edited
//   claim is re-baselined; publish refuses it; resets need one exact commit message;
//   fails_when=SKILL.md and review-list.md disagree on the missing-file case, the baseline
//   loses its neutrality precondition, or the reset message drifts; why_new=no test read
//   Accepted keys; seam=none; no_claim=review-list and publish (not built yet)
describe("ReviewAcceptance", () => {
  it("a baseline is written once, after the neutrality pass, and never by a rebuild", () => {
    const accepted = between(REVIEW, "## Accepted keys");
    assert.match(
      accepted,
      /A missing review file next to an existing baseline is rebuilt from the articles, the baseline and `\.accepted`, and is never a first run/,
    );
    assert.match(
      SKILL,
      /A review file missing next to an existing baseline makes `publish` refuse; run `review-list` to rebuild it/,
    );
    assert.match(accepted, /Running `review-list` again never accepts anything by itself/);
    // The baseline waits for the neutrality file whose first line it reads.
    const gate = accepted.match(/its `(\w+)` line holds exactly the current article's claim keys/);
    assert.ok(gate, "the baseline no longer waits for the neutrality pass");
    assert.ok(
      REVIEW.includes(`a first line \`<!-- ${gate[1]}: <key> <key> ... -->\``),
      `the neutrality file has no ${gate[1]} line`,
    );
    // Every reset names the same commit message.
    const resets = [...REVIEW.matchAll(/reset review[^`]*`/g)].map((m) => m[0]);
    assert.ok(resets.length >= 2, "review-list.md lost a reset rule");
    for (const r of resets) assert.strictEqual(r, "reset review <contest>`");
    // ready is defined once, in review-list.md, and publish recomputes it.
    assert.match(
      REVIEW,
      /A contest is `ready` when `check` and `coverage` pass, no box is unchecked \(unfetchable entries included\), and every claim key in the article is accepted/,
    );
    assert.match(SKILL, /a contest is rendered only when it is `ready` \(\[review-list\.md\]/);
    assert.match(
      accepted,
      /`publish` ignores the comment and recomputes the set from the two files/,
    );
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=publish stages only <slug>/index.html, commits `publish <slug>`, pushes an
//   explicit refspec to the origin 6.4 checked, and runs the device check before that;
//   fails_when=the push becomes bare or loses its refspec, staging widens, or page.md's device
//   check trigger drifts; why_new=no test read step 6.5; seam=none; no_claim=publish (not built yet)
describe("PublishPush", () => {
  const step65 = () => between(SKILL, "\n5. Copy only that file", "\n6. ");

  it("step 6.5 stages one file and pushes HEAD to origin's branch, never a bare push", () => {
    const step = step65();
    assert.match(
      step,
      /Copy only that file to `<slug>\/index\.html` in `pages_dir`, and stage only that path/,
    );
    // The commit message holds only the public slug (Rule 5 keeps ballot ids out of commits).
    assert.match(step, /committing with the message `publish <slug>`/);
    assert.match(SKILL.match(/^5\. \*\*Private data[^\n]*/m)?.[0], /ballot ids.*a commit message/);
    const push = step.match(/pushing with `(git push [^`]+)`/);
    assert.ok(push, "step 6.5 no longer names its push command");
    // Remote and full destination ref are explicit, so pushRemote, pushDefault and push.default
    // cannot redirect it.
    assert.strictEqual(push[1], "git push origin HEAD:refs/heads/<branch>");
    assert.match(step, /never a bare `git push`, which may follow `pushRemote` or `pushDefault`/);
    // The remote it names is the one 6.4 confirmed is pages_repo, on the branch 6.4 checked.
    assert.match(step64(), /any fetch or push URL of its `origin` is not `pages_repo`/);
    assert.match(step64(), /if it is not on `branch`/);
    // No other spec text states another push form.
    for (const [file, text] of [...SPEC_FILES, ["README.md", README]]) {
      for (const [cmd] of text.matchAll(/`git push[^`]*`/g)) {
        assert.ok(
          cmd === `\`${push[1]}\`` ||
            (cmd === "`git push`" && text.includes("never a bare `git push`")),
          `${file} states another push form: ${cmd}`,
        );
      }
    }
    // Asking comes after the diff is shown (Rule 6).
    assert.ok(step.indexOf("Show the diff") < step.indexOf("Ask before committing"));
  });

  it("the device check runs before a slug's first publish and on request, as page.md says", () => {
    const step = step65();
    assert.match(
      step,
      /Before the first publish of a slug \(no `<slug>\/` folder in `pages_dir` yet\), and whenever the researcher runs `publish --device-check`, print the device check in \[page\.md\]\(references\/page\.md\) and wait for its confirmation/,
    );
    // It is asked before the commit, so a failed check leaves nothing to push.
    assert.ok(step.indexOf("device check") < step.indexOf("Ask before committing"));
    const check = PAGE.match(/\*\*Publish device check\*\*, ([^\n]+)\n\n((?:\d+\. [^\n]+\n)+)/);
    assert.ok(check, "page.md has no numbered Publish device check list");
    assert.match(check[1], /before the first publish of each ballot/);
    assert.match(check[1], /through `publish --device-check`/);
    assert.match(
      check[1],
      /`publish` prints this list and waits for confirmation \(SKILL\.md step 6\.5\)/,
    );
    assert.ok(check[2].trim().split("\n").length >= 3, "the device check list is nearly empty");
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=a review key hashes every field the spec says changes it, and the item line
//   shows the per-claim fields review-list recomputes it from; fails_when=a field (candidate id,
//   file hash) leaves the key while its re-list promise stays; why_new=no test read Item keys;
//   seam=none; no_claim=review-list's hash (not built yet; spec text only)
describe("ReviewItemKeys", () => {
  it("every promised re-list trigger maps to a field in the key", () => {
    const keys = between(REVIEW, "## Item keys");
    const fields = keys.match(
      /The key is the first 16 hex digits \(64 bits\) of a sha256 hash of (.+?)\. Snapshots are write-once/,
    )?.[1];
    assert.ok(fields, "review-list.md no longer lists the key's fields");
    const want = [
      "the candidate id (the retention official's id, or the contest id for a measure)",
      "the section heading text as written in [sections.md](sections.md)",
      "the claim text",
      "its tag",
      "the excerpt",
      "the snapshot path",
      "a hash of the whole snapshot file",
    ];
    for (const f of want) assert.ok(fields.includes(f), `the key no longer hashes ${f}`);
    // Each change the spec promises re-lists an item is backed by one hashed field.
    assert.match(keys, /Two candidates with the same claim text get different keys/);
    const swaps = keys.match(/swapping only (.+?) changes the key/)?.[1];
    assert.strictEqual(swaps, "the excerpt, the tag, the source or the snapshot's contents");
    const backs = { excerpt: "the excerpt", tag: "its tag", source: "the snapshot path" };
    for (const [swap, field] of Object.entries(backs)) {
      assert.ok(swaps.includes(swap) && fields.includes(field), `${swap} has no key field`);
    }
    // The file hash is what makes Rule 3 checkable; every snapshot field it names exists.
    assert.match(SKILL, /^3\. \*\*Snapshots are write-once\.\*\*/m);
    assert.match(keys, /Snapshots are write-once \(SKILL\.md Rule 3\); the file hash/);
    const edited = keys.match(/any later edit to a cited snapshot \(([^)]+)\)/)?.[1];
    assert.ok(edited, "review-list.md no longer says which snapshot edits re-list a claim");
    for (const name of ["source", "url", "public_url", "tier"]) {
      assert.ok(edited.includes(name), `${name} is not named`);
      assert.match(SNAPSHOT, new RegExp(`^${name}: `, "m"), `snapshots have no ${name} field`);
    }
    // The item line carries the claim, tag, link and excerpt the key is recomputed from.
    const item = keys.match(/```text\n([\s\S]*?)```/)?.[1];
    assert.match(
      item,
      /^- \[ \] <claim text> `(T\d\w*)` \[s\d+\]\(\.\.\/sources\/[^)]*\) <!-- id:[0-9a-f]+ -->\n {2}> <excerpt>\n$/,
    );
    assert.ok(TABLE_TIERS.has(item.match(/`(T\d)/)[1]), "the item's tag is not a known tier");
    assert.match(
      keys,
      /recomputes each key from the item's fields rather than trusting the comment/,
    );
    // The section heading is hashed as sections.md writes it, the form the article uses.
    assert.match(SECTIONS, /^\| A\. On the ballot \|/m);
    assert.match(ARTICLE, /^### A\. On the ballot$/m);
  });
});

// Added by /ship test coverage audit (run 9).
// Value: protects=the Figures rule's worked examples hold under the shipped matcher
//   (lib/figures.js), and the rule agrees with the Wording rules' raw figures; fails_when=an
//   example or the matcher changes so a stated match no longer holds; why_new=no test read
//   Figures; seam=lib; no_claim=the matcher's edge cases (tests/figures.test.js)
describe("FigureExamples", () => {
  it("the Figures rule's worked examples hold: figures are copied, never rounded", () => {
    const rule = between(ARTICLE, "## Figures");
    assert.match(rule, /never rounded or rescaled/);
    assert.match(ARTICLE, /Money and vote figures are shown raw, as the excerpt gives them/);
    const examples = rule.match(
      /"([^"]+)" matches `([^`]+)`, but "([^"]+)" does not, and "([^"]+)" does not match `([^`]+)`/,
    );
    assert.ok(examples, "the Figures rule lost its worked examples");
    const [, claim, excerpt, rescaled, rounded, raw] = examples;
    assert.ok(figuresBacked(claim, excerpt), `${claim} does not match ${excerpt}`);
    assert.ok(!figuresBacked(rescaled, excerpt), `${rescaled} matches ${excerpt}`);
    assert.ok(!figuresBacked(rounded, raw), `${rounded} matches ${raw}`);
    // The stretches the rule names.
    assert.match(rule, /"\$1 million" never stands for 500,000/);
    assert.ok(!figuresBacked("$1 million", "500,000") && !figuresBacked("$5 B", "5"));
  });
});

// Added by /ship pre-landing review (run 9, adversarial findings 1 and 2).
// Value: protects=a private line is accounted for by its parts, each listed as its own entry,
//   and the privacy scan folds curly quotes and dashes as excerpt matching does, so a place
//   name never escapes the whole-phrase match; fails_when=the accounting rule again needs the
//   whole line as one entry, or the scan stops folding quotes or dashes; why_new=no test read
//   either rule; seam=none; no_claim=ballot-check and publish (not built yet; spec text only)
describe("PrivateLineParts", () => {
  it("a private header line is accounted for by listing each part as its own entry", () => {
    const rule = ballotRuleLine("Official to listed");
    assert.doesNotMatch(rule, /is exactly a `private_strings` entry/, "whole-line entries return");
    assert.match(
      rule,
      /made up wholly of `private_strings` entries joined by spaces or punctuation/,
    );
    const example = rule.match(
      /a header line such as "([^"]+)" is accounted for by listing `([^`]+)` and `([^`]+)`/,
    );
    assert.ok(example, "the rule lost its split-line example");
    assert.strictEqual(
      `${example[2]} ${example[3]}`,
      example[1],
      "the parts do not make up the line",
    );
    for (const part of example.slice(2)) {
      assert.ok(BALLOT.includes(`  - ${part} `), `${part} is not in the private_strings example`);
    }
    assert.match(rule, /The publish scan matches each entry whole, never a part of one/);
  });

  // Extended by /ship pre-landing review (run 10).
  // Value: protects=the scan checks NFKC and ignorable variants and refuses on any, so a ligature,
  //   filler or superscript next to a private place name cannot hide it, and excerpt matching's
  //   folds stay a subset of the scan's; fails_when=a variant or the refuse-on-any rule is
  //   dropped, the dash fold narrows to a list, or the excerpt fold list changes without the
  //   scan; why_new=the test pinned only the quote and dash fold and missed NFKC; seam=none;
  //   no_claim=publish (not built yet; spec text only)
  // Value: protects=a private phrase split at a pdftotext hyphen break and quoted unjoined
  //   (`Spring-field`) passes check, so publish must read it whole; fails_when=the unjoined form
  //   is accepted without the scan's hyphen-removed reading, or an excerpt is joined itself;
  //   why_new=the hyphen-join gap in TODOS; seam=none; no_claim=publish (not built yet)
  it("the scan reads claims and excerpts with hyphens removed, since check accepts the unjoined form", () => {
    const matching = between(ARTICLE, "## Matching", "\n## ");
    assert.match(matching, /an excerpt may take either form at each break/);
    assert.match(matching, /An excerpt is one line, so it is never joined/);
    assert.match(
      matching,
      /also scans each claim and excerpt with every hyphen between two letters removed/,
    );
    assert.match(
      between(SKILL, "2. Before rendering,", "\n3. "),
      /scan them again with every hyphen between two letters removed, and with each value searched for also matched with its own hyphens removed/,
    );
    assert.match(matching, /the scan also matches each value with its own hyphens removed/);
  });

  it("the privacy scan checks every normalization variant and refuses on any", () => {
    const scan = between(SKILL, "3. Privacy scan.", "\n4. ");
    const steps = between(ARTICLE, "## Matching").match(/^\d+\. .*/gm);
    assert.deepStrictEqual(
      steps.map((step) => step.split(/[,.]/)[1].trim()),
      [
        "Unicode NFKC",
        "Remove default-ignorable code points",
        "Collapse runs of whitespace to one space",
        "Map curly quotes to straight quotes",
        "Join `pdftotext` hyphenated line breaks",
      ],
      "excerpt matching's folds changed; update the scan variants to match",
    );
    assert.match(
      scan,
      /curly quotes mapped to straight quotes and every dash to `-` \(Unicode category Pd plus the minus sign U\+2212/,
    );
    assert.match(
      scan,
      /default-ignorable characters \([^)]*\) either removed or read as spaces, and then Unicode NFKC either applied or not\. A match in any variant refuses\./,
    );
  });
});

// Added for the owner decisions of 2026-10-23 (no address lookups, mechanical baseline,
//   researcher review of privacy matches outside a claim).
// Value: protects=the model never looks up an address, the first-run baseline accepts only
//   claims a script can check, and a privacy match outside a claim reaches the researcher;
//   fails_when=a lookup mode such as --geocode comes back, the baseline again rests on the
//   neutrality pass, or the whole-page refusal loses its review path; why_new=these rules are
//   new; seam=none; no_claim=fetch-snapshot, review-list and publish (not built yet)
describe("OwnerDecisions", () => {
  it("no script looks up an address; step 2 hands the researcher links", () => {
    for (const [file, text] of SPEC_FILES) {
      assert.doesNotMatch(text, /--geocode|Census Geocoder/, `${file} still looks up an address`);
    }
    const rule5 = SKILL.match(/^5\. \*\*Private data stays private\.\*\*[^\n]*/m)[0];
    assert.match(rule5, /The model never sees an address and never looks one up/);
    assert.match(rule5, /No script looks up an address/);
    const step2 = between(SKILL, "### 2. Find the ballot", "\n### ");
    assert.match(step2, /Never look up the address\. Give the researcher links instead/);
    assert.match(step2, /never fetch a lookup result/);
  });

  it("the first-run baseline accepts only claims found whole in their own excerpt", () => {
    const accepted = between(REVIEW, "## Accepted keys");
    assert.match(
      accepted,
      /accepted as the baseline only when a script can check its wording itself/,
    );
    assert.match(accepted, /is found whole in its own excerpt, on word boundaries/);
    assert.match(accepted, /so its silence accepts nothing/);
    // The list itself carries the claims the baseline turns away.
    const list = between(REVIEW, "## What goes on it");
    assert.match(
      list,
      /on the first run, every claim whose text is not found whole in its own excerpt/,
    );
  });

  it("a privacy match outside a claim refuses the page and goes to the researcher", () => {
    assert.match(
      SKILL,
      /Any other match \([^)]*\) refuses the whole page and goes to the researcher for review/,
    );
    assert.match(SKILL, /This first phase has no override; the final rule is open in TODOS\.md/);
  });
});

// The Positions issue table in sections.md: office type -> its issues, in order.
const positionsIssues = () => {
  const rows = tableRows(SECTIONS, "## Positions issues");
  assert.ok(rows.length >= 2, "sections.md has no Positions issue table");
  return Object.fromEntries(
    rows.map((row) => {
      const type = row[0].match(/^`(\w+)`$/)?.[1];
      assert.ok(type, `Positions issue row "${row[0]}" is not one backticked office type`);
      return [type, row[2]];
    }),
  );
};
// The office_type enum the ballot.yaml example declares.
const officeTypes = () => {
  const declared = BALLOT.match(/^ +office_type: \w+ +# ((?:\w+ \| )+\w+);/m);
  assert.ok(declared, "ballot-format.md no longer declares the office_type enum");
  return declared[1].split(" | ");
};

// Added for issue 01 (D4, fixed issues per office).
// Value: protects=every office type has a fixed Positions issue list of 4-7 distinct issues
//   (the judicial type none, by its exemption), the article example and the page use issues from
//   it, and the keys hash the issue; fails_when=an office type is added without a list, a list
//   grows past seven or repeats an issue, or the example uses an issue no list has;
//   why_new=Positions was one flat section; seam=none; no_claim=coverage (not built yet)
describe("PositionsIssues", () => {
  it("every office type has an issue list, and only judicial has none", () => {
    const lists = positionsIssues();
    assert.deepStrictEqual(Object.keys(lists).sort(), officeTypes().sort(), "office types differ");
    const sections = new Set(TABLES.flatMap((h) => sectionTable(h).rows.map((r) => r[0].slice(3))));
    for (const [type, cell] of Object.entries(lists)) {
      if (type === "judicial") {
        assert.match(cell, /`Not part of this office's job`/, "judicial Positions is not exempt");
        continue;
      }
      const issues = cell.split("; ");
      assert.ok(issues.length >= 4 && issues.length <= 7, `${type} has ${issues.length} issues`);
      assert.strictEqual(new Set(issues).size, issues.length, `${type} repeats an issue`);
      for (const issue of issues) {
        assert.match(issue, /^[A-Z][a-z]+(?: [a-z]+)*$/, `${type} issue "${issue}" is malformed`);
        assert.ok(!sections.has(issue), `${type} issue "${issue}" is also a section name`);
      }
    }
    // The exemption sections.md keys on is the one judicial office type.
    assert.match(SECTIONS, /marked `office_type: judicial` in `ballot\.yaml` has its Positions/);
    assert.match(BALLOT, /Every candidate contest carries an `office_type`/);
  });

  it("the article example, page and keys use the issues of one office type, in order", () => {
    const lists = positionsIssues();
    const example = articleExample();
    // Only the headings under Positions, which the example ends with.
    const used = [...from(example, "### E. Positions").matchAll(/^#### (.+)$/gm)].map((m) => m[1]);
    assert.ok(used.length >= 2, "the article example shows fewer than two Positions issues");
    const contestType = capture(BALLOT, /^ +office_type: (\w+) /m, "the example office_type");
    const issues = lists[contestType].split("; ");
    assert.deepStrictEqual(
      used,
      issues.slice(0, used.length),
      "example issues are not its list's first",
    );
    // The issue headings sit under Positions and nowhere else.
    assert.match(example, /### E\. Positions\n\n#### /, "example issues are not under Positions");
    const hidden = PAGE.match(/"Source for Cand\. A, Positions section, ([^"]+)"/)?.[1];
    assert.ok(issues.includes(hidden), `page.md receipt issue "${hidden}" is not on the list`);
    const wireframe = [...read("page-wireframe.html").matchAll(/<h3 class="issue">([^<]+)</g)];
    assert.ok(wireframe.length > 0, "the wireframe draws no Positions issue");
    for (const [, issue] of wireframe)
      assert.ok(issues.includes(issue), `wireframe issue ${issue}`);
    assert.match(REVIEW, /\(under Positions, followed by the issue heading\)/);
    assert.match(PAGE, /Under Positions, h3 is an issue and h4 a candidate/);
  });
});

// Added for issue 01 (owner answer to the schedule fallback, office-hours R2-8).
// Value: protects="Not researched yet" is a state of its own, never Unknown: equal for every
//   candidate, never in On the ballot, needing no search-log line, and worded on the page as
//   research still to come with no ○; fails_when=the state is reworded in one file, starts using
//   the Unknown glyph, or loses its equal-depth rule; why_new=the state is new; seam=none;
//   no_claim=coverage and publish (not built yet)
describe("NotResearched", () => {
  const state = () => {
    assert.ok(ARTICLE.includes("\n- `Not part"), "the state after Not researched yet is gone");
    return between(ARTICLE, "- `Not researched yet`:", "\n- `Not part");
  };
  it("article-format.md defines the state with its coverage rule", () => {
    assert.match(state(), /in any section but On the ballot/);
    assert.match(state(), /for every candidate block of the contest/);
    assert.match(state(), /it never stands in for Unknown/);
    assert.match(state(), /It needs no search-log line/);
    assert.match(state(), /Under Positions it covers the whole section/);
    assert.match(
      ARTICLE,
      /`Not researched yet` is used for some candidates in a section but not all/,
    );
    assert.match(
      SKILL,
      /`Not researched yet` for every candidate, never `Unknown, no source found`/,
    );
  });

  it("the page says research is pending, apart from Unknown, at section and contest level", () => {
    const section = PAGE.match(/\*\*Not researched yet\.\*\*[^\n]*?"(Not researched yet\.[^"]+)"/);
    assert.ok(section, "page.md has no Not researched section line");
    assert.match(section[1], /still to come/);
    assert.doesNotMatch(section[1], /○|no source found/, "the line reads as Unknown");
    assert.match(PAGE, /It carries no ○, so it never reads as "we looked and found nothing"/);
    const contest = PAGE.match(/with no chips: "(Not researched yet\.[^"]+)"/);
    assert.ok(contest, "page.md has no not-researched contest note");
    assert.match(contest[1], /we haven't researched it yet/);
    assert.match(PAGE, /shows "Not researched yet" on the ballot list and is not counted as ready/);
    assert.match(PAGE, /"Not researched yet" means we haven't looked yet\./);
    const list = capture(
      read("page-wireframe.html"),
      /<main [^>]*id="ballot"[^>]*>([\s\S]*?)<\/main>/,
      "the wireframe ballot list",
    );
    assert.match(list, /class="st">Not researched yet</, "the wireframe list shows no such row");
  });

  // Added by PR #7 interrogate review.
  // Value: protects=only the researcher's not_researched list in ballot.yaml puts a section in
  //   the state, coverage matches it exactly both ways, On the ballot is never left for later,
  //   and the article and ballot examples agree; fails_when=the compile agent can declare the
  //   state alone again, or the list stops being checked against sections.md;
  //   why_new=nothing recorded the researcher's decision, so the state bypassed both the search
  //   log and the review list; seam=none; no_claim=coverage and ballot-check (not built yet)
  it("only the researcher's not_researched list puts a section in the state", () => {
    assert.match(
      state(),
      /Only the researcher decides that, by listing the section under the contest's `not_researched` in `ballot\.yaml`/,
    );
    assert.match(state(), /exactly where that list names the section/);
    assert.match(
      failureCodeRow("section-state")[1],
      /in a section the contest's `not_researched` does not list, or a listed section is in another state/,
    );
    assert.match(
      BALLOT,
      /The model never supplies contests, candidates, counts or `not_researched`\./,
    );
    assert.match(
      BALLOT,
      /Any contest may carry `not_researched`, which only the researcher writes/,
    );
    assert.match(
      BALLOT,
      /`ballot-check` fails a name that is not a section of the contest's type, and On the ballot/,
    );
    assert.match(SKILL, /they list it under the contest's `not_researched` in `ballot\.yaml`/);
    assert.match(ARTICLE, /A contest whose `not_researched` is `all`/);
    // The ballot.yaml example lists sections by their sections.md names, and the article
    // example shows each of them in the state.
    const listed = capture(
      BALLOT,
      /^ +not_researched: \[([^\]]+)\]/m,
      "the not_researched example",
    ).split(", ");
    const names = new Set(sectionTable(TYPE_TABLES.candidate).rows.map((r) => r[0].slice(3)));
    for (const name of listed) {
      assert.ok(names.has(name), `not_researched example "${name}" is not a candidate section`);
      assert.match(articleExample(), new RegExp(`### [A-Z]\\. ${name}\n\nNot researched yet\n`));
    }
    // On the ballot is never a gap.
    assert.match(
      ARTICLE,
      /On the ballot always holds claims, never `Unknown, no source found` or `Not researched yet`/,
    );
    assert.match(state(), /for every candidate block of the contest that has the section/);
  });

  // Added by PR #7 interrogate review.
  // Value: protects=the banner's plural, multi-seat, write-in, measure and retention forms, the
  //   measure wording of both notes, and what the ready-to-read count counts; fails_when=a form
  //   is dropped or the count goes back to every ready contest; why_new=only the one-topic
  //   single-seat form was defined; seam=none; no_claim=publish (not built yet)
  it("the banner, notes and ready count cover every race shape", () => {
    assert.match(PAGE, /drops "covered", from the write-in count too \("\+1 certified write-in"\)/);
    assert.match(PAGE, /"1 topic" or "N topics"/);
    assert.match(PAGE, /"6 of 6 candidates · Vote for up to 3 · 2 topics not researched yet"/);
    assert.match(PAGE, /"Official text and fiscal note saved · 1 topic not researched yet"/);
    assert.match(
      PAGE,
      /On a measure, which has no candidates, the line drops ", for every candidate at once"/,
    );
    assert.match(PAGE, /shows the note alone, without its sentence about candidates/);
    assert.match(PAGE, /the second counts `ready` contests that are not not-researched contests/);
    assert.match(PAGE, /is not counted as ready to read, though it is `ready`/);
  });
});

// Added for issue 01 (TODOS: prove a search ran before "Unknown, no source found").
// Value: protects=the search log is in the Layout, has exactly the four no-free-text fields,
//   uses the checklist item numbers sections.md cites per contest type, and backs the new
//   coverage code; fails_when=a free-text field is added, an item range drifts from the
//   checklist, or the code is renamed in one file; why_new=the log is new; seam=none;
//   no_claim=fetch-snapshot --searched and coverage (not built yet)
describe("SearchLog", () => {
  const log = () => between(SNAPSHOT, "## Search log");
  it("the Layout has the per-contest log, and its line has four fixed fields", () => {
    assert.ok(
      layoutEntries().some((e) => e.endsWith("/search-log/<contest>.tsv")),
      "the Layout has no search-log/<contest>.tsv",
    );
    assert.match(log(), /appends one line to `<ballot-id>\/search-log\/<contest>\.tsv`/);
    const line = log().match(/```text\n(.+)\n```/)?.[1];
    assert.strictEqual(line, "<contest>\t<subject>\t<item>\t<searched>", "search-log line fields");
    const fields = [...log().matchAll(/^- `<(\w+)>`:/gm)].map((m) => m[1]);
    assert.deepStrictEqual(fields, ["contest", "subject", "item", "searched"]);
    assert.match(log(), /no free text/);
    assert.match(log(), /never a caller's value/, "the date is not the script's own");
  });

  // Added by PR #7 interrogate review.
  // Value: protects=the --searched signature names its contest, which the agents' tool fixes,
  //   and a measure's log subject is the _race subject its snapshots are filed under;
  //   fails_when=the contest argument is dropped again, or the log and the snapshot front matter
  //   name a measure's subject differently; why_new=the unbound form had no contest and a
  //   measure had two subject names; seam=none; no_claim=fetch-snapshot (not built yet)
  it("--searched names its contest, and a measure logs under _race as its snapshots do", () => {
    assert.match(log(), /^`fetch-snapshot --searched <contest> <subject> <item>` appends/m);
    assert.match(log(), /The agents' fetch tool fixes `<contest>` to its own contest/);
    assert.match(SKILL, /`fetch-snapshot --searched`; its tool fixes the contest/);
    assert.match(log(), /^- `<subject>`:[^\n]*or `_race` for a measure/m);
    assert.match(SNAPSHOT, /^subject: \S+ +# [^\n]*_race \(also every measure source\)/m);
    assert.ok(
      layoutEntries().some((e) => e.endsWith("/_race/")),
      "the Layout has no _race directory",
    );
    assert.match(SKILL, /sources\/<contest>\/_race\/ +# [^\n]*every measure source/);
    assert.doesNotMatch(log(), /contest id for a measure/, "a measure logs under its contest id");
  });

  it("each contest type logs exactly the checklist items its sections cite", () => {
    const stated = log().match(
      /1-5 for a candidate contest, (\d+) for a measure, (\d+) for a retention contest/,
    );
    assert.ok(stated, "the search log no longer states each type's items");
    const byTable = checklistItemsByTable();
    assert.deepStrictEqual([...byTable[TYPE_TABLES.candidate]].sort(), ["1", "2", "3", "4", "5"]);
    assert.deepStrictEqual([...byTable[TYPE_TABLES.measure]], [stated[1]]);
    assert.deepStrictEqual([...byTable[TYPE_TABLES.retention]], [stated[2]]);
    assert.match(
      TIERS,
      new RegExp(
        `item ${stated[1]} for every measure, and item ${stated[2]} for every retention official`,
      ),
    );
  });

  // Extended by PR #7 interrogate review.
  // Value: protects=an Unknown Positions issue needs log lines too, both files ask for every
  //   item, and a malformed log line fails; fails_when=the row or the log narrows to whole
  //   sections, says "one of" the items, or a bad line passes silently; why_new=the row said
  //   "one of" while the log said "each", and both stayed green; seam=none; no_claim=coverage
  it("an Unknown without a log line fails with the coverage code in the table", () => {
    const row = failureCodeRow("search-not-logged");
    assert.match(
      row[1],
      /^Reported by `coverage`: a section or Positions issue is `Unknown, no source found`/,
    );
    assert.match(log(), /a section, or a Positions issue, in the state `Unknown, no source found`/);
    // Both files require every item the section draws on, never any one of them.
    assert.match(row[1], /a line for its subject and each checklist item the section draws on/);
    assert.match(log(), /a line for its subject and each checklist item/);
    for (const text of [row[1], log()]) assert.doesNotMatch(text, /one of the checklist items/);
    assert.match(row[1], /or the log has a malformed line/);
    assert.match(log(), /It also fails with `search-not-logged`, located by log line/);
    assert.match(log(), /has a `<contest>` that is not the file's name/);
    assert.match(log(), /Each line is one append ending in a newline/);
    assert.match(log(), /or it fails with `search-not-logged`/);
    assert.match(
      between(ARTICLE, "## Section states"),
      /only when the search log backs it \(`search-not-logged`\)/,
    );
    assert.match(scriptRow("coverage"), /fails an Unknown the search log does not back/);
  });
});

// Added for issue 01 (D12, deny rule plus hash manifest).
// Value: protects=the sha256 manifest is in the Layout, appended by fetch-snapshot for every
//   snapshot, and verified by check and publish with its own failure code; fails_when=a step
//   stops verifying it or the code is renamed in one file; why_new=write-once rested on prose;
//   seam=none; no_claim=the hashing (not built yet)
describe("SnapshotManifest", () => {
  it("fetch-snapshot appends it, and check and publish verify it", () => {
    assert.ok(
      layoutEntries().some((e) => e.endsWith("/<ballot-id>/snapshots.sha256")),
      "the Layout has no snapshots.sha256",
    );
    const manifest = between(SNAPSHOT, "## Manifest");
    assert.match(manifest, /Every snapshot `fetch-snapshot` saves, `_ballot` ones included/);
    assert.match(manifest, /a line is never changed or removed/);
    assert.match(
      manifest,
      /`check` and `publish` hash every file under `sources\/` and fail with `snapshot-hash`/,
    );
    const row = failureCodeRow("snapshot-hash");
    assert.match(row[1], /^Reported by `check` and `publish`/);
    assert.match(
      ballotGate(),
      /every file under `sources\/` must match its line in `snapshots\.sha256`/,
    );
    assert.match(scriptRow("fetch-snapshot"), /append its hash to `snapshots\.sha256`/);
    assert.match(scriptRow("check"), /every snapshot matches `snapshots\.sha256`/);
    assert.match(SKILL, /^3\. \*\*Snapshots are write-once\.\*\*[^\n]*`snapshots\.sha256`/m);
  });

  // Added by PR #7 interrogate review.
  // Value: protects=a crash mid-save is repaired by the next run, a duplicate or malformed line
  //   fails, leftovers are skipped as the skill check skips them, a snapshot can be retired only
  //   by the researcher, and the manifest and search log are denied to the model, committed and
  //   only grow; fails_when=a step of the save order, a failure case or a guard is dropped;
  //   why_new=a crash, a duplicate line or a deleted junk snapshot blocked publish for good, and
  //   nothing guarded the manifest itself; seam=none; no_claim=fetch-snapshot, check, publish
  it("a crash, a duplicate line and a retired snapshot each have one defined outcome", () => {
    const manifest = between(SNAPSHOT, "## Manifest");
    assert.ok(
      layoutEntries().some((e) => e.endsWith("/<ballot-id>/.partial/")),
      "the Layout has no .partial/",
    );
    assert.match(
      manifest,
      /writes the snapshot to `<ballot-id>\/\.partial\/<sha256>` and syncs it to disk, appends the manifest line as one write ending in a newline, then moves the file to its path under `sources\/`, refusing if that path exists/,
    );
    assert.match(manifest, /every run finishes an interrupted save/);
    assert.match(manifest, /the researcher appends `- {2}<path>`, a hyphen in place of the hash/);
    assert.match(manifest, /the model never writes the manifest \(Rule 3\)/);
    const cases = [...manifest.matchAll(/^- (.+);?$/gm)].map((m) => m[1]).join("\n");
    for (const failure of [
      /a file with no line, or a file whose path is retired/,
      /a line whose file is gone, unless a retire line for its path follows it/,
      /more than one hash line or more than one retire line for one path/,
      /a line in neither form/,
      /a symlink anywhere under `sources\/`/,
    ])
      assert.match(cases, failure);
    assert.match(
      manifest,
      /They skip only regular files that are operating-system and editor leftovers \(`\.DS_Store`, `Thumbs\.db`, `\*\.swp`\)/,
    );
    assert.match(
      ballotGate(),
      /\(`\.DS_Store`, `Thumbs\.db`, `\*\.swp`\)/,
      "the two leftover lists differ",
    );
    const row = failureCodeRow("snapshot-hash");
    assert.match(
      row[1],
      /a path has more than one hash or retire line, a manifest line is malformed/,
    );
    // The trust anchors are guarded like what they protect.
    assert.match(
      SKILL,
      /^3\. [^\n]*the data repo's Claude Code settings deny the model's own writes to all four/m,
    );
    assert.match(
      ballotGate(),
      /`review\/`, `tiers\.yaml`, `snapshots\.sha256` and `search-log\/` must have no uncommitted changes/,
    );
    assert.match(
      ballotGate(),
      /`snapshots\.sha256` and each search log must begin with all of their lines from the commit before/,
    );
    assert.match(
      SKILL,
      /the researcher commits `review\/`, `tiers\.yaml`, `snapshots\.sha256` and `search-log\/`/,
    );
  });
});

// Added for issue 01 (TODOS: source metadata the agent chooses must not decide attribution).
// Value: protects=a snapshot's owner and source name come from tiers.yaml, never the caller,
//   and review-list's attribution rule reads owner, not the agent-chosen subject;
//   fails_when=the attribution rule goes back to subject, or a fetch option sets owner;
//   why_new=the fields are new; seam=none; no_claim=fetch-snapshot and review-list (not built)
describe("SnapshotOwner", () => {
  it("owner and source are copied from tiers.yaml and decide attribution", () => {
    assert.match(SNAPSHOT, /^owner: third-party +# from tiers\.yaml: /m);
    assert.match(SNAPSHOT, /^source: .+# from tiers\.yaml: the matched entry's source name/m);
    assert.match(SNAPSHOT, /`fetch-snapshot` takes no option that sets them/);
    assert.match(
      TIERS,
      /copies the tier, `statements_only`, `owner` and `source` of the most specific match/,
    );
    const rule = REVIEW.split("\n").find((l) => l.includes("misattribution risk"));
    assert.ok(rule, "review-list.md lost its attribution rule");
    assert.match(rule, /cited snapshot's `owner` is not the candidate/);
    assert.match(rule, /never from the subject directory the discovery agent chose/);
    assert.doesNotMatch(rule, /`subject`/, "attribution reads the subject field again");
    assert.match(between(REVIEW, "## Item keys"), /tier, owner or body\)/);
  });

  // Added by PR #7 interrogate review.
  // Value: protects=a redirect cannot change whose words a snapshot holds, the loader refuses a
  //   candidate-owned entry that is not T4 statements only or names no listed id, an owner id
  //   names one person across ballots, and a claim filed under a rival is still reviewed
  //   whatever its tag; fails_when=any of these rules is dropped or weakened; why_new=owner was
  //   unspecified across hops, the T4 rule held only in the example, and the old subject check
  //   was deleted with nothing in its place for non-Says claims; seam=none;
  //   no_claim=fetch-snapshot, ballot-check, review-list (not built yet)
  it("redirects, the loader and ids keep owner sound, and misfiled claims are reviewed", () => {
    assert.match(
      TIERS,
      /Across redirects, the tier is the strictest any hop's most specific match gives, `owner` must be the same at every hop, and `source` is the final URL's/,
    );
    assert.match(TIERS, /refused and logged with the reason `owner changes across redirects`/);
    assert.match(
      TIERS,
      /an entry whose `owner` is not `third-party` unless it is T4 with `statements_only: true`/,
    );
    assert.match(TIERS, /an `owner` that no `ballot\.yaml` in the data repo lists/);
    // The example's candidate-owned entries obey the loader rule the sentence states.
    for (const [, entry] of TIERS.matchAll(/^- match: [^\n]*\n((?: {2}[^\n]*\n)+)/gm)) {
      if (/^ {2}owner: third-party\b/m.test(entry)) continue;
      assert.match(entry, /^ {2}tier: T4\b/m, "a candidate-owned example entry is not T4");
      assert.match(entry, /^ {2}statements_only: true\b/m);
    }
    assert.match(ballotRuleLine("Ids"), /A candidate or official id names one person across/);
    assert.match(
      ballotRuleLine("Ids"),
      /fails an id that two `ballot\.yaml` files give different printed names/,
    );
    const misfiled = REVIEW.split("\n").find((l) => l.includes("misfiling risk"));
    assert.ok(misfiled, "review-list.md lost its misfiled-claim rule");
    assert.match(
      misfiled,
      /^- every claim, whatever its tag, whose cited snapshot is filed under another candidate or official of the contest/,
    );
    assert.match(misfiled, /The subject directory cannot clear a claim, only add one/);
  });
});
