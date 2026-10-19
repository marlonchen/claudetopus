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
// The text files in references/; the wireframe PNG is binary and never read as text.
const REF_FILES = fs.readdirSync(REFS_DIR).filter((f) => /\.(md|html)$/.test(f));
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

// The text from `heading` up to the next `next` heading (default: the next "## ").
const between = (text, heading, next = "\n## ") => {
  const start = text.indexOf(heading);
  assert.ok(start !== -1, `missing "${heading}"`);
  const end = text.indexOf(next, start + 1);
  return text.slice(start, end === -1 ? undefined : end);
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
  const declared = read("snapshot-format.md").match(/matches `\/(.+?)\/(\w*)`/);
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
  // Extended by /ship test coverage audit.
  // Value: protects=every relative link (.md, .png, .html) in the skill resolves;
  //   fails_when=the page wireframe or another non-.md file is renamed or moved;
  //   why_new=the link check read only .md targets; seam=none; no_claim=none beyond protects
  it("every relative link in the skill resolves", () => {
    const files = ["SKILL.md", "README.md", ...REF_FILES.map((f) => path.join("references", f))];
    let count = 0;
    for (const file of files) {
      const text = fs.readFileSync(path.join(SKILL_DIR, file), "utf8");
      for (const [, target] of text.matchAll(/\]\(([^)#<\s:]+\.[a-z]+)(#[^)]*)?\)/g)) {
        // ../sources/ links are placeholders inside format examples.
        if (target.startsWith("../sources/")) continue;
        count++;
        const resolved = path.join(SKILL_DIR, path.dirname(file), target);
        assert.ok(fs.existsSync(resolved), `${file} links to missing ${target}`);
      }
    }
    assert.ok(count > 0, "no relative links found to check");
  });
});

const SKILL = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
// Every spec text file as [path from the skill directory, text].
const SPEC_FILES = [
  ["SKILL.md", SKILL],
  ...REF_FILES.map((f) => [path.join("references", f), read(f)]),
];
const SPEC_TEXTS = SPEC_FILES.map(([, text]) => text);

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
        ...[...text.matchAll(/\b[Ss]teps? (\d(?:\.\d)?(?:-\d(?:\.\d)?)?)\b/g)].map((m) =>
          m[1].split("-"),
        ),
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
  const block = SKILL.slice(SKILL.indexOf("## Layout")).match(/```text\n([\s\S]*?)```/);
  assert.ok(block, "SKILL.md Layout has no text block");
  const entries = [];
  const stack = [];
  for (const line of block[1].split("\n").filter((l) => l.trim())) {
    const indent = line.length - line.trimStart().length;
    let entry = line
      .trim()
      .replace(/\s+#.*$/, "")
      .replace("<project root>/", "");
    for (const [from, to] of Object.entries(fill)) entry = entry.replaceAll(from, to);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const full = (stack.at(-1)?.path ?? "") + entry;
    if (full.endsWith("/")) stack.push({ indent, path: full });
    entries.push(full);
  }
  return entries;
}

describe("PrivateDataIgnored", () => {
  it("this public repo ignores every private data file the Layout names", () => {
    const { execFileSync } = require("node:child_process");
    const repoRoot = path.join(SKILL_DIR, "..", "..");
    // Extended by /ship test coverage audit.
    // Value: protects=every file the SKILL.md Layout names is gitignored here;
    //   fails_when=Layout gains a private file the .gitignore misses; why_new=the path list
    //   was hand-copied, so a new Layout entry went unchecked; seam=none
    const entries = layoutEntries({
      "<election>": "2026-general",
      "<ballot-id>": "ballot-a",
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
        .map((line) => line.split("\t").reverse()),
    );
    for (const p of all) {
      assert.ok(sources.has(p), `${p} is not ignored; private data could be committed here`);
      assert.match(sources.get(p), /^\.gitignore:/, `${p} is ignored only by ${sources.get(p)}`);
    }
  });

  it("skill source directories are not swallowed by the data ignores", () => {
    const { spawnSync } = require("node:child_process");
    const repoRoot = path.join(SKILL_DIR, "..", "..");
    const probes = [
      ...["sources", "articles", "review", "site"].map(
        (dir) => `skills/research-candidates/${dir}/example.md`,
      ),
      "skills/research-candidates/ballot.ledger",
      "skills/research-candidates/ballot-view.md",
    ];
    const result = spawnSync(
      "git",
      ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", ...probes],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.strictEqual(result.status, 1, `skill source would be ignored: ${result.stdout}`);
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
    const table = between(read("article-format.md"), "## Failure codes");
    const codes = tableRows(read("article-format.md"), "## Failure codes").map(
      (row) => row[0].match(/^`([a-z-]+)`$/)?.[1],
    );
    assert.ok(codes.length >= 10, `only ${codes.length} failure codes parsed`);
    assert.ok(codes.every(Boolean), "a failure-code row is not a single backticked code");
    assert.strictEqual(new Set(codes).size, codes.length, "a failure code is listed twice");
    // Other kebab-case tokens the spec uses: script names, Rule markers, example ids and labels.
    const scripts = tableRows(SKILL, "## Scripts").map((row) => row[0].replaceAll("`", ""));
    const ids = [...read("ballot-format.md").matchAll(/^ +-? *id: ([\w-]+)/gm)].map((m) => m[1]);
    const known = new Set([...codes, ...scripts, ...ids, "says-only", "addr-mom", "ballot-a"]);
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
      // Hosts in tiers.yaml examples and the `official.name` field path are not files.
      (t) =>
        !/<name>|<subject>|<slug>|^fec-totals|^\.\.\/|^scripts\/$|\.(gov|com|org)$|^official\.name$/.test(
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
  const BALLOT = read("ballot-format.md");
  const rule = (name) => {
    const found = BALLOT.match(new RegExp(`\\*\\*${name}:\\*\\*[^\\n]*?\`(\\^[^\`]+\\$)\``));
    assert.ok(found, `ballot-format.md no longer gives the ${name} pattern`);
    return new RegExp(found[1]);
  };

  it("every example id matches the Ids pattern, which never matches _race or _ballot", () => {
    const pattern = rule("Ids");
    const ids = [...BALLOT.matchAll(/^ +-? *id: (\S+)/gm)].map((m) => m[1]);
    assert.ok(ids.length >= 5, `only ${ids.length} ids in the ballot.yaml example`);
    for (const id of ids) assert.match(id, pattern, `example id ${id} fails the Ids pattern`);
    for (const reserved of ["_race", "_ballot", "Jane", "../x", "-a"]) {
      assert.doesNotMatch(reserved, pattern, `Ids pattern accepts ${reserved}`);
    }
  });

  it("the slug example, SKILL.md slug command and README agree with the Slug pattern", () => {
    const pattern = rule("Slug");
    const slug = BALLOT.match(/^slug: (\S+)/m);
    assert.ok(slug, "ballot.yaml example has no slug");
    assert.match(slug[1], pattern, `example slug ${slug[1]} fails the Slug pattern`);
    const length = Number(pattern.source.match(/\{(\d+)\}/)?.[1]);
    const command = SKILL.match(/`LC_ALL=C tr -dc ([a-z0-9-]+) <\/dev\/urandom \| head -c(\d+)`/);
    assert.ok(command, "SKILL.md step 3 no longer gives the slug command");
    assert.strictEqual(Number(command[2]), length, "slug command length differs from the pattern");
    assert.ok(pattern.source.includes(`[${command[1]}]`), "slug command charset differs");
    const readme = fs.readFileSync(path.join(SKILL_DIR, "README.md"), "utf8");
    const stated = readme.match(/The slug is (\d+) random lowercase letters and digits/);
    assert.ok(stated, "README.md no longer states the slug length");
    assert.strictEqual(Number(stated[1]), length, "README slug length differs");
  });

  it("every example contest has a jurisdiction, and display_title differs from title", () => {
    const contests = BALLOT.slice(BALLOT.indexOf("contests:"), BALLOT.indexOf("\n```\n"))
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
    }
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
  const PAGE = read("page.md");
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
    const line = read("page.md").match(
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
    const html = read("page-wireframe.html");
    const nav = html.match(/One race, by topic[\s\S]*?<nav class="chips"[^>]*>([\s\S]*?)<\/nav>/);
    assert.ok(nav, "the wireframe has no race-screen chip row");
    const shown = [...nav[1].matchAll(/<a class="chip"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
    assert.deepStrictEqual(shown, chips, "wireframe race chips differ from page.md");
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
      const line = read("page.md")
        .split("\n")
        .find((l) => l.startsWith(`- **${label}**`));
      assert.ok(line, `page.md has no ${label} stack`);
      const list = line.slice(line.indexOf(lead, label.length + 6) + lead.length).split(". ")[0];
      const named = list.split("·").map((s) => s.replace(/\(.*?\)/g, "").trim());
      const sections = sectionTable(heading).rows.map((row) => row[0].slice(3));
      assert.deepStrictEqual(named, sections, `page.md ${label} stack differs from sections.md`);
      if (heading === "Measures") {
        const html = read("page-wireframe.html");
        const nav = html.match(
          /A ballot question[\s\S]*?<nav class="chips"[^>]*>([\s\S]*?)<\/nav>/,
        );
        assert.ok(nav, "the wireframe has no measure chip row");
        const shown = [...nav[1].matchAll(/<a class="chip"[^>]*>([^<]+)<\/a>/g)].map((m) => m[1]);
        assert.deepStrictEqual(shown, sections, "wireframe measure chips differ from sections.md");
      }
    });
  }
});
