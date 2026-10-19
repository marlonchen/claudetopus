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
// ballot.yaml contest type -> its section table in sections.md.
const TYPE_TABLES = {
  candidate: "Candidate contests",
  retention: "Retention contests",
  measure: "Measures",
};
const TABLES = Object.values(TYPE_TABLES);

const cells = (line) =>
  line
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());

// The first table under "## <heading>": its header cells and its data rows.
// Every data row must name a lettered section ("A. On the ballot"), so a
// mistyped row fails here instead of silently dropping out of every check.
function sectionTable(heading) {
  const start = SECTIONS.indexOf(`## ${heading}\n`);
  assert.ok(start !== -1, `sections.md is missing "## ${heading}"`);
  const next = SECTIONS.indexOf("\n## ", start + 1);
  const lines = SECTIONS.slice(start, next === -1 ? undefined : next)
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

describe("ChecklistReferences", () => {
  it("checklist items cited in sections.md exist in source-tiers.md", () => {
    const items = new Set([...TIERS.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]));
    const table = sectionTable("Candidate contests");
    const cited = column(table, "Discovery checklist");
    let count = 0;
    for (const row of table.rows) {
      for (const item of row[cited].match(/\d+/g) || []) {
        count++;
        assert.ok(
          items.has(item),
          `${row[0]} cites checklist item ${item}, not in source-tiers.md`,
        );
      }
    }
    assert.ok(count > 0, "no checklist items cited in the Candidate contests table");
  });
});

describe("Links", () => {
  it("every relative .md link in the skill resolves", () => {
    const files = [
      "SKILL.md",
      "README.md",
      ...fs.readdirSync(REFS_DIR).map((f) => path.join("references", f)),
    ];
    let count = 0;
    for (const file of files) {
      const text = fs.readFileSync(path.join(SKILL_DIR, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#<\s]+\.md)(#[^)]*)?\)/g)) {
        // ../sources/ links are placeholders inside format examples.
        if (target.startsWith("../sources/")) continue;
        count++;
        const resolved = path.join(SKILL_DIR, path.dirname(file), target);
        assert.ok(fs.existsSync(resolved), `${file} links to missing ${target}`);
      }
    }
    assert.ok(count > 0, "no relative .md links found to check");
  });
});

const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
const SPEC_TEXTS = [SKILL, ...fs.readdirSync(REFS_DIR).map(read)];

describe("Exemptions", () => {
  it("the judicial exemption names a real candidate section", () => {
    const prose = SECTIONS.slice(SECTIONS.indexOf("## Not part of this office's job"));
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
      read("ballot-format.md"),
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
    const BALLOT = read("ballot-format.md");
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
    const declared = read("snapshot-format.md").match(/^tier: \w+ +# ([^,]+)/m);
    assert.ok(declared, "snapshot-format.md no longer declares the tier enum");
    const enumTiers = declared[1].split("|").map((tier) => tier.trim());
    const start = TIERS.indexOf("| Tier |");
    assert.ok(start !== -1, "source-tiers.md is missing the tier table");
    const tableTiers = TIERS.slice(start, TIERS.indexOf("\n\n", start))
      .split("\n")
      .filter((l) => /^\| T\d/.test(l))
      .map((l) => cells(l)[0].match(/^T\d/)[0]);
    assert.deepStrictEqual(
      [...new Set(tableTiers)].sort(),
      [...enumTiers].sort(),
      "snapshot-format.md tier enum differs from the source-tiers.md tier table",
    );
  });
});

describe("ClaimTags", () => {
  it("every claim tag used in the spec is defined in source-tiers.md", () => {
    const start = TIERS.indexOf("## Claim tags");
    assert.ok(start !== -1, 'source-tiers.md is missing "## Claim tags"');
    const table = TIERS.slice(start, TIERS.indexOf("\n## ", start + 1));
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
    const declared = read("snapshot-format.md").match(/^role: \w+ +# (.+)$/m);
    assert.ok(declared, "snapshot-format.md no longer declares the role enum");
    const roles = new Set(declared[1].split("|").map((role) => role.trim()));
    const used = [...read("ballot-format.md").matchAll(/`role: (\w+)`/g)].map((m) => m[1]);
    assert.ok(used.length > 0, "ballot-format.md uses no snapshot roles");
    for (const role of used) {
      assert.ok(roles.has(role), `ballot-format.md uses role ${role}, not in snapshot-format.md`);
    }
  });
});

const WORKFLOW = SKILL.slice(SKILL.indexOf("## Workflow"));

// Assert that workflow step "N" (a "### N. " heading) or "N.M" (item "M. " in
// that step's body) exists in SKILL.md.
function assertStep(step, where) {
  const [major, minor] = step.split(".");
  const heading = WORKFLOW.indexOf(`\n### ${major}. `);
  assert.ok(heading !== -1, `${where} refers to step ${step}, which does not exist`);
  if (minor) {
    const end = WORKFLOW.indexOf("\n### ", heading + 1);
    const body = WORKFLOW.slice(heading, end === -1 ? undefined : end);
    assert.match(body, new RegExp(`\\n${minor}\\. `), `${where}: no step ${step}`);
  }
}

describe("Scripts", () => {
  const tableStart = SKILL.indexOf("## Scripts");
  const rows = SKILL.slice(tableStart, SKILL.indexOf("\n## ", tableStart + 1))
    .split("\n")
    .filter((line) => line.startsWith("| `"))
    .map(cells);

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
    const files = [
      ["SKILL.md", SKILL],
      ...fs.readdirSync(REFS_DIR).map((f) => [path.join("references", f), read(f)]),
    ];
    let count = 0;
    for (const [file, text] of files) {
      const refs = [
        ...[...text.matchAll(/\b[Ss]teps? (\d(?:\.\d)?)\b/g)].map((m) => [m[1]]),
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
    for (const file of ["sections.md", "article-format.md"]) {
      assert.match(read(file), /the On the ballot section only/, `${file} lost the withdrawn rule`);
    }
  });

  it("article-format.md example headings are candidate sections", () => {
    const names = new Set(sectionTable("Candidate contests").rows.map((row) => row[0]));
    const headings = [...read("article-format.md").matchAll(/^### ([A-Z]\. .+)$/gm)];
    assert.ok(headings.length > 0, "article-format.md example has no section headings");
    for (const [, heading] of headings) {
      assert.ok(names.has(heading), `article-format.md heading "${heading}" is not in sections.md`);
    }
  });
});

describe("ChecklistMapping", () => {
  it("every discovery checklist item fills some candidate section", () => {
    const items = [...TIERS.matchAll(/^(\d+)\. \*\*/gm)].map((match) => match[1]);
    assert.ok(items.length > 0, "no numbered checklist items in source-tiers.md");
    const table = sectionTable("Candidate contests");
    const cited = column(table, "Discovery checklist");
    const used = new Set(table.rows.flatMap((row) => row[cited].match(/\d+/g) || []));
    for (const item of items) {
      assert.ok(used.has(item), `checklist item ${item} fills no candidate section`);
    }
  });
});

describe("CandidateStatus", () => {
  it("statuses named in the spec are in the ballot.yaml status enum", () => {
    const BALLOT = read("ballot-format.md");
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
    const SNAPSHOT = read("snapshot-format.md");
    const declared = SNAPSHOT.match(/matches `\/(.+?)\/(\w*)`/);
    assert.ok(declared, "snapshot-format.md no longer gives the key-parameter pattern");
    const pattern = new RegExp(declared[1], declared[2]);
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

describe("PrivateDataIgnored", () => {
  it("this public repo ignores every private data file the Layout names", () => {
    const { execFileSync } = require("node:child_process");
    const repoRoot = path.join(SKILL_DIR, "..", "..");
    // Extended by /ship test coverage audit.
    // Value: protects=every file the SKILL.md Layout names is gitignored here;
    //   fails_when=Layout gains a private file the .gitignore misses; why_new=the path list
    //   was hand-copied, so a new Layout entry went unchecked; seam=none
    const block = SKILL.slice(SKILL.indexOf("## Layout")).match(/```text\n([\s\S]*?)```/);
    assert.ok(block, "SKILL.md Layout has no text block");
    const fill = {
      "<project root>/": "",
      "<election>": "2026-general",
      "<ballot-id>": "ballot-a",
      "<contest>": "us-house-07",
      "<candidate>": "jane-example",
    };
    const entries = [];
    const stack = [];
    for (const line of block[1].split("\n").filter((l) => l.trim())) {
      const indent = line.length - line.trimStart().length;
      let entry = line.trim().replace(/\s+#.*$/, "");
      for (const [from, to] of Object.entries(fill)) entry = entry.replaceAll(from, to);
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const full = (stack.at(-1)?.path ?? "") + entry;
      if (full.endsWith("/")) stack.push({ indent, path: full });
      entries.push(full);
    }
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
    // Only this repo's .gitignore counts: a developer's global excludes must not make it pass.
    const out = execFileSync(
      "git",
      ["-c", "core.excludesFile=/dev/null", "check-ignore", "-v", "--no-index", ...all],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    const sources = new Map(
      out
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [source, file] = line.split("\t");
          return [file, source];
        }),
    );
    for (const p of all) {
      assert.ok(sources.has(p), `${p} is not ignored; private data could be committed here`);
      assert.match(sources.get(p), /^\.gitignore:/, `${p} is ignored only by ${sources.get(p)}`);
    }
  });
});

// Added by /ship pre-landing review.
// Value: protects=every "Rule N" cited in the spec names a real numbered rule; fails_when=a
//   rule is renumbered or inserted and citations are missed; why_new=StepReferences checks
//   steps only; seam=none
describe("RuleReferences", () => {
  it("every Rule N cited in the spec exists in SKILL.md", () => {
    const rulesBlock = SKILL.slice(
      SKILL.indexOf("## Rules that never bend"),
      SKILL.indexOf("## Scripts"),
    );
    const rules = new Set([...rulesBlock.matchAll(/^(\d+)\. \*\*/gm)].map((m) => m[1]));
    assert.ok(rules.size >= 8, `only ${rules.size} rules parsed`);
    let count = 0;
    for (const text of SPEC_TEXTS) {
      for (const [, n] of text.matchAll(/\bRules? (\d+)\b/g)) {
        count++;
        assert.ok(rules.has(n), `Rule ${n} is cited but not defined`);
      }
    }
    assert.ok(count >= 4, `only ${count} Rule citations found`);
  });
});
