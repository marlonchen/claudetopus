"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { parseArticle } = require("../scripts/lib/article");

// Seam 2: the shared article parser (article-format.md, Structure, Claim lines
// and Section states), which check, coverage and review-list read.

const ARTICLE = `# us-house-07

## Jane Example

### A. On the ballot

- Listed on the ballot \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > Jane Example Example Party

### B. Background

Unknown, no source found

### C. Record in public office

Not researched yet

### E. Positions

#### Taxes and spending

- Says: "No new taxes." \`T4\` [s2](../sources/us-house-07/jane-example/site.md)
  > No new taxes, and no new fees, for working families.

#### Economy and jobs

Not part of this office's job
`;

describe("article-format.md: the article parser", () => {
  it("reads the title, blocks, sections, issues and their states", () => {
    const { title, blocks, failures } = parseArticle(ARTICLE);
    assert.deepStrictEqual(failures, []);
    assert.deepStrictEqual(title, { text: "us-house-07", line: 1 });
    assert.strictEqual(blocks.length, 1);
    const [block] = blocks;
    assert.strictEqual(block.name, "Jane Example");
    assert.strictEqual(block.line, 3);
    assert.deepStrictEqual(
      block.sections.map((s) => [s.name, s.line, s.states.map((x) => x.state)]),
      [
        ["A. On the ballot", 5, []],
        ["B. Background", 10, ["Unknown, no source found"]],
        ["C. Record in public office", 14, ["Not researched yet"]],
        ["E. Positions", 18, []],
      ],
    );
    const positions = block.sections[3];
    assert.deepStrictEqual(
      positions.issues.map((i) => [i.name, i.line, i.states.map((x) => x.state), i.claims.length]),
      [
        ["Taxes and spending", 20, [], 1],
        ["Economy and jobs", 25, ["Not part of this office's job"], 0],
      ],
    );
  });

  it("reads each claim's text, tag, link and excerpt, with their lines", () => {
    const { claims } = parseArticle(ARTICLE);
    assert.deepStrictEqual(
      claims.map((c) => ({
        ...c,
        block: c.block.name,
        section: c.section.name,
        issue: c.issue?.name,
      })),
      [
        {
          line: 7,
          text: "Listed on the ballot",
          tag: "T1",
          label: "s1",
          target: "../sources/_ballot/sample-ballot.md",
          excerpt: "Jane Example Example Party",
          excerptLine: 8,
          block: "Jane Example",
          section: "A. On the ballot",
          issue: undefined,
        },
        {
          line: 22,
          text: 'Says: "No new taxes."',
          tag: "T4",
          label: "s2",
          target: "../sources/us-house-07/jane-example/site.md",
          excerpt: "No new taxes, and no new fees, for working families.",
          excerptLine: 23,
          block: "Jane Example",
          section: "E. Positions",
          issue: "Taxes and spending",
        },
      ],
    );
    assert.strictEqual(parseArticle(ARTICLE).blocks[0].sections[0].claims.length, 1);
  });

  it("fails a claim with no link, no tag or no excerpt as claim-format, by its line", () => {
    const { claims, failures } = parseArticle(`# c

## Jane Example

### A. On the ballot

- No link here \`T1\`
  > an excerpt long enough to count
- No tag here [s1](../sources/c/jane-example/a.md)
  > an excerpt long enough to count
- No excerpt \`T1\` [s1](../sources/c/jane-example/a.md)

- Excerpt not on the next line \`T1\` [s1](../sources/c/jane-example/a.md)

  > an excerpt long enough to count
`);
    assert.deepStrictEqual(failures, [
      { line: 7, code: "claim-format" },
      { line: 8, code: "claim-format" },
      { line: 9, code: "claim-format" },
      { line: 10, code: "claim-format" },
      { line: 11, code: "claim-format" },
      { line: 13, code: "claim-format" },
      { line: 15, code: "claim-format" },
    ]);
    assert.deepStrictEqual(claims, []);
  });

  it("fails any line that is not a heading, claim, excerpt, state or blank", () => {
    const { failures } = parseArticle(`# c

## Jane Example

### B. Background

Jane grew up nearby.
<!-- a note -->
- ok \`T1\` [s1](../sources/c/jane-example/a.md)
  > an excerpt long enough to count
  > a second excerpt line
Unknown, no source found.
`);
    assert.deepStrictEqual(failures, [
      { line: 7, code: "claim-format" },
      { line: 8, code: "claim-format" },
      { line: 11, code: "claim-format" },
      { line: 12, code: "claim-format" },
    ]);
  });
});

describe("article-format.md: what the parser leaves outside the section tree", () => {
  it("lists every # heading in order, the first as the title", () => {
    const { title, titles } = parseArticle("## Jane Example\n\n# us-house-07\n\n# other\n");
    assert.deepStrictEqual(title, { text: "us-house-07", line: 3 });
    assert.deepStrictEqual(titles, [title, { text: "other", line: 5 }]);
  });

  it("lists, as strays, a heading, state or claim with no section or block to sit in", () => {
    const text = `# us-house-07

Unknown, no source found

### A. On the ballot

## Jane Example

- Listed on the ballot \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > Jane Example Example Party

#### Health care

### B. Background

Unknown, no source found
`;
    const { strays, blocks } = parseArticle(text);
    assert.deepStrictEqual(strays, [3, 5, 9, 12]);
    assert.deepStrictEqual(
      blocks[0].sections.map((s) => s.name),
      ["B. Background"],
    );
  });

  it("lists a state under a #### that has no section as a stray too", () => {
    const text = "# c\n\n## Jane\n\n#### Foo\n\nUnknown, no source found\n\n### A. On the ballot\n";
    assert.deepStrictEqual(parseArticle(text).strays, [5, 7]);
  });

  it("keeps a claim line with no tag or link as a rejected claim of its section", () => {
    const text = `## Jane Example

### B. Background

- Served two terms [s1](../sources/us-house-07/jane-example/bio.md)
  > She served two terms on the Exampleton school board
`;
    const { blocks, rejected, failures } = parseArticle(text);
    const entry = { line: 5, target: null };
    assert.deepStrictEqual(rejected, [entry]);
    assert.deepStrictEqual(blocks[0].sections[0].rejected, [entry]);
    // check's failures are as before: the claim line and the excerpt with no claim.
    assert.deepStrictEqual(
      failures.map((f) => f.line),
      [5, 6],
    );
  });
});
