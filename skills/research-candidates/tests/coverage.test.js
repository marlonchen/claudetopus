"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT, makeDataRepo, runCli } = require("./harness");

// coverage (article-format.md, Command line), run as a subprocess against a
// temp data repo (seam 1).

const repos = [];
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const UNKNOWN = "Unknown, no source found";
const NOT_RESEARCHED = "Not researched yet";
const NOT_JOB = "Not part of this office's job";

// sections.md, Positions issues, for a federal office.
const FEDERAL_ISSUES = [
  "Taxes and spending",
  "Economy and jobs",
  "Health care",
  "Immigration",
  "Abortion",
  "Energy and environment",
  "Foreign policy and defense",
];

// A claim line and its excerpt, citing a snapshot of `contest`/`subject`.
const claim = (
  subject,
  { text = "Served two terms", tag = "T2", contest = "us-house-07" } = {},
) => {
  const target =
    subject === "_ballot"
      ? "../sources/_ballot/sample-ballot.md"
      : `../sources/${contest}/${subject}/bio.md`;
  return `- ${text} \`${tag}\` [s1](${target})\n  > She served two terms on the Exampleton school board`;
};
const says = (subject) => claim(subject, { text: "Says: lower taxes", tag: "T4s" });

const section = (heading, body) => `### ${heading}\n\n${body}\n`;

// A candidate block with every section: claims, an Unknown Record, Positions
// with every federal issue (Health care Unknown) and an Unknown Controversies.
const candidate = (name, id) =>
  [
    `## ${name}\n`,
    section("A. On the ballot", claim("_ballot")),
    section("B. Background", claim(id)),
    section("C. Record in public office", UNKNOWN),
    section("D. Money", claim(id)),
    `### E. Positions\n`,
    ...FEDERAL_ISSUES.map(
      (issue) => `#### ${issue}\n\n${issue === "Health care" ? UNKNOWN : says(id)}\n`,
    ),
    section("F. Controversies and cases", UNKNOWN),
  ].join("\n");

const ARTICLE = `# us-house-07\n\n${candidate("Jane Example", "jane-example")}\n${candidate(
  "John Sample",
  "john-sample",
)}`;

// Every candidate item, run for both candidates.
const FULL_LOG = ["jane-example", "john-sample"]
  .flatMap((id) =>
    ["1", "2", "3", "4", "5"].map((item) => `us-house-07\t${id}\t${item}\t2026-10-20\n`),
  )
  .join("");

// A data repo whose us-house-07 article passes coverage.
const setup = ({ ballot, article = ARTICLE, log = FULL_LOG } = {}) => {
  const data = makeDataRepo(ballot ? { ballot } : {});
  repos.push(data);
  data.write(`${BALLOT}/articles/us-house-07.md`, article);
  if (log !== null) data.write(`${BALLOT}/search-log/us-house-07.tsv`, log);
  return data;
};

const coverage = (data, args = [BALLOT]) =>
  runCli("coverage", args, { cwd: data.root, env: data.env });

describe("coverage: a passing article", () => {
  it("prints the article as covered and exits 0", async () => {
    const data = setup();
    const result = await coverage(data);
    assert.strictEqual(result.stdout, "articles/us-house-07.md covered\n");
    assert.strictEqual(result.status, 0);
  });
});

// The 1-based line of the `nth` line of `text` that equals `line`.
const lineOf = (text, line, nth = 1) => {
  let seen = 0;
  const index = text.split("\n").findIndex((l) => l === line && ++seen === nth);
  assert.ok(index !== -1, `no line ${line} (${nth}) in the article`);
  return index + 1;
};

// The passing article with `from` replaced by `to`.
const edited = (from, to, article = ARTICLE) => {
  assert.ok(article.includes(from), `${from} is not in the article`);
  return article.replace(from, to);
};

const failsWith = async (data, lines) => {
  const result = await coverage(data);
  assert.strictEqual(result.stdout, lines.map((l) => `${l}\n`).join(""));
  assert.strictEqual(result.status, 1);
};

const AT = "articles/us-house-07.md";

describe("coverage: blocks", () => {
  it("fails a # heading that is not the contest id, or a second one", async () => {
    await failsWith(setup({ article: edited("# us-house-07", "# us-house-7") }), [
      `${AT}:1 block-missing`,
    ]);
    const twice = `${ARTICLE}\n# us-house-07\n`;
    await failsWith(setup({ article: twice }), [
      `${AT}:${lineOf(twice, "# us-house-07", 2)} block-missing`,
    ]);
    await failsWith(setup({ article: ARTICLE.replace("# us-house-07\n", "") }), [
      `${AT} block-missing`,
    ]);
  });

  it("fails a missing candidate at the # heading, and an unknown or repeated one at its own", async () => {
    const john = lineOf(ARTICLE, "## John Sample");
    const without = ARTICLE.slice(0, ARTICLE.indexOf("## John Sample"));
    await failsWith(setup({ article: without }), [`${AT}:1 block-missing`]);
    await failsWith(setup({ article: edited("## John Sample", "## John Samples") }), [
      `${AT}:1 block-missing`,
      `${AT}:${john} block-missing`,
    ]);
    const repeated = ARTICLE.replace("## John Sample", "## Jane Example");
    await failsWith(setup({ article: repeated }), [
      `${AT}:1 block-missing`,
      `${AT}:${john} block-missing`,
    ]);
  });

  it("fails a candidate out of ballot order, still checking its sections", async () => {
    const jane = ARTICLE.slice(
      ARTICLE.indexOf("## Jane Example"),
      ARTICLE.indexOf("## John Sample"),
    );
    const john = ARTICLE.slice(ARTICLE.indexOf("## John Sample"));
    const swapped = `# us-house-07\n\n${john}\n${jane.replace("### D. Money", "### D. Moneys")}`;
    await failsWith(setup({ article: swapped }), [
      `${AT}:${lineOf(swapped, "## Jane Example")} block-missing`,
      `${AT}:${lineOf(swapped, "## Jane Example")} section-missing`,
      `${AT}:${lineOf(swapped, "### D. Moneys")} section-missing`,
    ]);
  });
});

describe("coverage: sections and Positions issues", () => {
  it("fails a missing section at its block, and a misnamed, unlettered or repeated one at its own", async () => {
    const jane = lineOf(ARTICLE, "## Jane Example");
    const money = lineOf(ARTICLE, "### D. Money");
    const noMoney = edited("### D. Money\n\n- Served two terms", "- Served two terms");
    await failsWith(setup({ article: noMoney }), [
      `${AT}:${jane} section-missing`,
      `${AT}:${lineOf(noMoney, "### C. Record in public office")} section-state`,
    ]);
    await failsWith(setup({ article: edited("### D. Money", "### Money") }), [
      `${AT}:${jane} section-missing`,
      `${AT}:${money} section-missing`,
    ]);
    await failsWith(setup({ article: edited("### D. Money", "### B. Background") }), [
      `${AT}:${jane} section-missing`,
      `${AT}:${money} section-missing`,
    ]);
  });

  it("fails sections out of order, at each one after the furthest placed", async () => {
    const swapped = edited("### B. Background", "### X")
      .replace("### D. Money", "### B. Background")
      .replace("### X", "### D. Money");
    await failsWith(setup({ article: swapped }), [
      `${AT}:${lineOf(swapped, "### C. Record in public office")} section-missing`,
      `${AT}:${lineOf(swapped, "### B. Background")} section-missing`,
    ]);
  });

  it("fails a missing, extra, repeated or reordered Positions issue", async () => {
    const positions = lineOf(ARTICLE, "### E. Positions");
    const immigration = lineOf(ARTICLE, "#### Immigration");
    await failsWith(setup({ article: edited("#### Immigration", "#### Immigrants") }), [
      `${AT}:${positions} section-missing`,
      `${AT}:${immigration} section-missing`,
    ]);
    const moved = edited("#### Immigration", "#### Abortion");
    await failsWith(setup({ article: moved }), [
      `${AT}:${positions} section-missing`,
      `${AT}:${lineOf(moved, "#### Abortion", 2)} section-missing`,
    ]);
  });

  it("fails an issue heading under a section other than Positions", async () => {
    const article = edited("### E. Positions\n", "#### Health care\n\n### E. Positions\n");
    await failsWith(setup({ article }), [
      `${AT}:${lineOf(article, "#### Health care")} section-missing`,
    ]);
  });

  it("fails a state or claim that sits in no section", async () => {
    const article = edited("## Jane Example\n", `## Jane Example\n\n${UNKNOWN}\n`);
    await failsWith(setup({ article }), [`${AT}:${lineOf(article, UNKNOWN)} section-missing`]);
  });
});

describe("coverage: section states", () => {
  const background = lineOf(ARTICLE, "### B. Background");

  it("fails a section with no state, or with two", async () => {
    const empty = edited(
      "### B. Background\n\n- Served two terms `T2` [s1](../sources/us-house-07/jane-example/bio.md)\n  > She served two terms on the Exampleton school board\n",
      "### B. Background\n",
    );
    await failsWith(setup({ article: empty }), [`${AT}:${background} section-state`]);
    const both = edited("### B. Background\n\n", `### B. Background\n\n${UNKNOWN}\n\n`);
    await failsWith(setup({ article: both }), [`${AT}:${background} section-state`]);
    const twice = edited(
      "### C. Record in public office\n\nUnknown",
      `### C. Record in public office\n\n${UNKNOWN}\n\nUnknown`,
    );
    await failsWith(setup({ article: twice }), [
      `${AT}:${lineOf(twice, "### C. Record in public office")} section-state`,
    ]);
  });

  it("fails On the ballot in any state but claims", async () => {
    const onBallot = lineOf(ARTICLE, "### A. On the ballot");
    const article = edited(
      `### A. On the ballot\n\n${claim("_ballot")}`,
      `### A. On the ballot\n\n${UNKNOWN}`,
    );
    await failsWith(setup({ article }), [`${AT}:${onBallot} section-state`]);
  });

  it("fails Not researched yet or Not part of this office's job where nothing lists them", async () => {
    const record = lineOf(ARTICLE, "### C. Record in public office");
    for (const state of [NOT_RESEARCHED, NOT_JOB]) {
      const article = edited(
        `### C. Record in public office\n\n${UNKNOWN}`,
        `### C. Record in public office\n\n${state}`,
      );
      await failsWith(setup({ article }), [`${AT}:${record} section-state`]);
    }
    const issue = lineOf(ARTICLE, "#### Health care");
    for (const state of [NOT_RESEARCHED, NOT_JOB]) {
      const article = edited(`#### Health care\n\n${UNKNOWN}`, `#### Health care\n\n${state}`);
      await failsWith(setup({ article }), [`${AT}:${issue} section-state`]);
    }
  });

  it("fails a state or claim in Positions outside its issues", async () => {
    const article = edited("### E. Positions\n", `### E. Positions\n\n${UNKNOWN}\n`);
    await failsWith(setup({ article }), [
      `${AT}:${lineOf(article, "### E. Positions")} section-state`,
    ]);
  });
});

describe("coverage: the says-only rule", () => {
  it("fails a Positions claim without an s tag or without Says:", async () => {
    const plain = edited(
      says("jane-example"),
      claim("jane-example", { text: "Says: lower taxes" }),
    );
    const at = lineOf(plain, "#### Taxes and spending") + 2;
    await failsWith(setup({ article: plain }), [`${AT}:${at} says-missing`]);
    const unsaid = edited(
      says("jane-example"),
      claim("jane-example", { text: "Wants lower taxes", tag: "T4s" }),
    );
    await failsWith(setup({ article: unsaid }), [`${AT}:${at} says-missing`]);
  });

  it("leaves claims in other sections to their own tags", async () => {
    const article = edited(claim("jane-example"), says("jane-example"));
    const result = await coverage(setup({ article }));
    assert.strictEqual(result.status, 0);
  });
});

// FULL_LOG without the line for `id` and `item`.
const logWithout = (id, item) => {
  const line = `us-house-07\t${id}\t${item}\t2026-10-20\n`;
  assert.ok(FULL_LOG.includes(line));
  return FULL_LOG.replace(line, "");
};

describe("coverage: an Unknown needs the search log", () => {
  const unknownAt = (heading) => lineOf(ARTICLE, heading) + 2;

  it("fails an Unknown section missing a line for any item it draws on", async () => {
    // Controversies and cases draws on items 2, 3 and 4; Record on 1 and 2.
    await failsWith(setup({ log: logWithout("jane-example", "3") }), [
      `${AT}:${unknownAt("### F. Controversies and cases")} search-not-logged`,
    ]);
    await failsWith(setup({ log: logWithout("john-sample", "2") }), [
      `${AT}:${lineOf(ARTICLE, "### C. Record in public office", 2) + 2} search-not-logged`,
      `${AT}:${lineOf(ARTICLE, "### F. Controversies and cases", 2) + 2} search-not-logged`,
    ]);
  });

  it("backs an Unknown Positions issue with Positions' item, and nothing else needs one", async () => {
    await failsWith(setup({ log: logWithout("jane-example", "5") }), [
      `${AT}:${unknownAt("#### Health care")} search-not-logged`,
    ]);
    // Item 5 also feeds Background, which holds claims here, so nothing else fails.
    const noUnknowns = ARTICLE.replaceAll(
      UNKNOWN,
      claim("jane-example").replace("Served", "Says: served").replace("`T2`", "`T2s`"),
    );
    const result = await coverage(setup({ article: noUnknowns, log: null }));
    assert.strictEqual(result.stdout, `${AT} covered\n`);
  });

  it("reads a line only for its own subject", async () => {
    const swapped = FULL_LOG.replaceAll("jane-example", "pat-example");
    const result = await coverage(setup({ log: swapped }));
    assert.strictEqual(result.status, 1);
    assert.ok(!result.stdout.includes("search-log/"), "a line for another subject failed");
  });

  it("ignores a well-formed line for a subject the contest no longer lists", async () => {
    const result = await coverage(
      setup({ log: `${FULL_LOG}us-house-07\tjim-gone\t4\t2026-10-20\n` }),
    );
    assert.strictEqual(result.stdout, `${AT} covered\n`);
  });

  it("fails each malformed line by its log line, and a last line with no newline", async () => {
    const bad = [
      "us-house-07\tjane-example\t4",
      "us-house-07\tjane-example\t4\t2026-10-20\textra",
      "us-house-08\tjane-example\t4\t2026-10-20",
      "us-house-07\tJane Example\t4\t2026-10-20",
      "us-house-07\tjane-example\t6\t2026-10-20",
      "us-house-07\tjane-example\t04\t2026-10-20",
      "us-house-07\tjane-example\t4\t2026-02-30",
      "us-house-07\tjane-example\t4\t10/20/2026",
      "",
    ];
    const log = `${FULL_LOG}${bad.join("\n")}\nus-house-07\tjane-example\t4\t2026-10-20`;
    const first = FULL_LOG.split("\n").length;
    await failsWith(
      setup({ log }),
      [...bad.map((_, i) => first + i), first + bad.length].map(
        (n) => `search-log/us-house-07.tsv:${n} search-not-logged`,
      ),
    );
  });
});

const ballotWith = (field) =>
  DEFAULT_BALLOT.replace("    vote_for: 1\n", `    vote_for: 1\n    ${field}\n`);

// ARTICLE with section `heading` of each candidate block set to `body`.
const setSection = (article, heading, body) =>
  article.replace(
    new RegExp(`(### ${heading}\\n\\n)[\\s\\S]*?(?=\\n### |\\n## |$)`, "g"),
    `$1${body}\n`,
  );

describe("coverage: Not researched yet", () => {
  it("passes exactly the sections not_researched lists, for every candidate", async () => {
    const article = setSection(ARTICLE, "D. Money", NOT_RESEARCHED);
    const result = await coverage(
      setup({ ballot: ballotWith("not_researched: [Money]"), article }),
    );
    assert.strictEqual(result.stdout, `${AT} covered\n`);
  });

  it("fails a listed section in another state, for any one candidate", async () => {
    const article = setSection(ARTICLE, "D. Money", NOT_RESEARCHED).replace(
      `### D. Money\n\n${NOT_RESEARCHED}`,
      `### D. Money\n\n${UNKNOWN}`,
    );
    await failsWith(setup({ ballot: ballotWith("not_researched: [Money]"), article }), [
      `${AT}:${lineOf(article, "### D. Money")} section-state`,
    ]);
  });

  it("needs no log line, and a Positions section not researched holds no issues", async () => {
    const article = setSection(ARTICLE, "E. Positions", NOT_RESEARCHED);
    const result = await coverage(
      setup({
        ballot: ballotWith("not_researched: [Positions]"),
        article,
        log: FULL_LOG.replaceAll("\t5\t", "\t4\t"),
      }),
    );
    assert.strictEqual(result.stdout, `${AT} covered\n`);
    const withIssue = article.replace(
      `### E. Positions\n\n${NOT_RESEARCHED}\n`,
      `### E. Positions\n\n${NOT_RESEARCHED}\n\n#### Health care\n\n${UNKNOWN}\n`,
    );
    await failsWith(
      setup({ ballot: ballotWith("not_researched: [Positions]"), article: withIssue }),
      [`${AT}:${lineOf(withIssue, "#### Health care")} section-missing`],
    );
  });

  it("takes all as every section but On the ballot", async () => {
    let article = ARTICLE;
    for (const s of [
      "B. Background",
      "C. Record in public office",
      "D. Money",
      "E. Positions",
      "F. Controversies and cases",
    ])
      article = setSection(article, s, NOT_RESEARCHED);
    const result = await coverage(
      setup({ ballot: ballotWith("not_researched: all"), article, log: null }),
    );
    assert.strictEqual(result.stdout, `${AT} covered\n`);
  });
});

const JOHN = ARTICLE.slice(ARTICLE.indexOf("## John Sample"));
const JANE_ONLY = ARTICLE.slice(0, ARTICLE.indexOf("## John Sample"));
const onBallotOnly = (name) => `## ${name}\n\n${section("A. On the ballot", claim("_ballot"))}`;

describe("coverage: withdrawn and write-in candidates", () => {
  const withdrawn = DEFAULT_BALLOT.replace(
    "party: Sample Party\n        status: on_ballot",
    "party: Sample Party\n        status: withdrawn_still_printed",
  );

  it("gives a withdrawn candidate On the ballot alone, and fails any other section", async () => {
    const article = `${JANE_ONLY}${onBallotOnly("John Sample")}`;
    const result = await coverage(setup({ ballot: withdrawn, article }));
    assert.strictEqual(result.stdout, `${AT} covered\n`);
    await failsWith(setup({ ballot: withdrawn }), [
      `${AT}:${lineOf(ARTICLE, "### B. Background", 2)} section-missing`,
      `${AT}:${lineOf(ARTICLE, "### C. Record in public office", 2)} section-missing`,
      `${AT}:${lineOf(ARTICLE, "### D. Money", 2)} section-missing`,
      `${AT}:${lineOf(ARTICLE, "### E. Positions", 2)} section-missing`,
      ...FEDERAL_ISSUES.map((i) => `${AT}:${lineOf(ARTICLE, `#### ${i}`, 2)} section-missing`),
      `${AT}:${lineOf(ARTICLE, "### F. Controversies and cases", 2)} section-missing`,
    ]);
  });

  it("puts certified write-ins after printed candidates, whatever the ballot.yaml order", async () => {
    const ballot = DEFAULT_BALLOT.replace(
      "      - id: john-sample\n",
      "      - id: wanda-writein\n        name: Wanda Writein\n        party: Write Party\n        status: certified_write_in\n      - id: john-sample\n",
    );
    const wanda = candidate("Wanda Writein", "wanda-writein");
    const log = `${FULL_LOG}${["1", "2", "3", "4", "5"].map((i) => `us-house-07\twanda-writein\t${i}\t2026-10-20\n`).join("")}`;
    const inOrder = `${ARTICLE}\n${wanda}`;
    assert.strictEqual(
      (await coverage(setup({ ballot, article: inOrder, log }))).stdout,
      `${AT} covered\n`,
    );
    const yamlOrder = `${JANE_ONLY}${wanda}\n${JOHN}`;
    await failsWith(setup({ ballot, article: yamlOrder, log }), [
      `${AT}:${lineOf(yamlOrder, "## John Sample")} block-missing`,
    ]);
  });
});

describe("coverage: the judicial exemption", () => {
  const judicial = DEFAULT_BALLOT.replace("office_type: federal", "office_type: judicial");
  const exempt = ARTICLE.replace(
    /### E\. Positions\n[\s\S]*?(?=### F\.)/g,
    `### E. Positions\n\n${NOT_JOB}\n\n`,
  );

  it("puts a judicial contest's Positions in Not part of this office's job, with no issues", async () => {
    assert.strictEqual(
      (await coverage(setup({ ballot: judicial, article: exempt }))).stdout,
      `${AT} covered\n`,
    );
    await failsWith(setup({ ballot: judicial }), [
      `${AT}:${lineOf(ARTICLE, "### E. Positions")} section-state`,
      ...FEDERAL_ISSUES.map((i) => `${AT}:${lineOf(ARTICLE, `#### ${i}`)} section-missing`),
      `${AT}:${lineOf(ARTICLE, "### E. Positions", 2)} section-state`,
      ...FEDERAL_ISSUES.map((i) => `${AT}:${lineOf(ARTICLE, `#### ${i}`, 2)} section-missing`),
    ]);
  });

  it("keeps the exemption when not_researched names Positions or is all", async () => {
    const ballot = judicial.replace(
      "    vote_for: 1\n",
      "    vote_for: 1\n    not_researched: [Positions]\n",
    );
    assert.strictEqual(
      (await coverage(setup({ ballot, article: exempt }))).stdout,
      `${AT} covered\n`,
    );
    const nr = exempt.replace(
      `### E. Positions\n\n${NOT_JOB}`,
      `### E. Positions\n\n${NOT_RESEARCHED}`,
    );
    await failsWith(setup({ ballot, article: nr }), [
      `${AT}:${lineOf(nr, "### E. Positions")} section-state`,
    ]);
  });
});

const RETENTION = `# supreme-court-retention-a

## Pat Example

${section("A. On the ballot", claim("_ballot"))}
${section("B. Record in office", UNKNOWN)}
${section("C. Evaluation findings", claim("pat-example", { contest: "supreme-court-retention-a" }))}
${section("D. Discipline", UNKNOWN)}
${section("E. Statements", claim("pat-example", { contest: "supreme-court-retention-a", text: "Says: fair courts", tag: "T1s" }))}`;
const RET_AT = "articles/supreme-court-retention-a.md";

describe("coverage: retention contests", () => {
  const retention = (article, log) => {
    const data = setup();
    data.write(`${BALLOT}/articles/supreme-court-retention-a.md`, article);
    if (log) data.write(`${BALLOT}/search-log/supreme-court-retention-a.tsv`, log);
    return data;
  };
  const LOG7 = "supreme-court-retention-a\tpat-example\t7\t2026-10-20\n";

  it("has one block for the official, backed by item 7", async () => {
    const result = await coverage(retention(RETENTION, LOG7), [
      BALLOT,
      "supreme-court-retention-a",
    ]);
    assert.strictEqual(result.stdout, `${RET_AT} covered\n`);
    const unlogged = await coverage(retention(RETENTION, null), [
      BALLOT,
      "supreme-court-retention-a",
    ]);
    assert.strictEqual(
      unlogged.stdout,
      [lineOf(RETENTION, "### B. Record in office"), lineOf(RETENTION, "### D. Discipline")]
        .map((n) => `${RET_AT}:${n + 2} search-not-logged\n`)
        .join(""),
    );
  });

  it("holds Statements to the says-only rule", async () => {
    const article = RETENTION.replace("Says: fair courts` ", "Fair courts` ").replace(
      "Says: fair courts",
      "Fair courts",
    );
    const result = await coverage(retention(article, LOG7), [BALLOT, "supreme-court-retention-a"]);
    assert.strictEqual(
      result.stdout,
      `${RET_AT}:${lineOf(article, "### E. Statements") + 2} says-missing\n`,
    );
  });
});

const MEASURE_BALLOT = DEFAULT_BALLOT.replace("contest_count: 2", "contest_count: 3").concat(
  `  - id: question-1
    type: measure
    jurisdiction: XX Exampleton County
    search_terms: library levy
    title: "Question 1: Library Levy"
    display_title: Question 1
`,
);
const MEASURE = `# question-1

## question-1

${section("A. What it does", claim("_race", { contest: "question-1" }))}
${section("B. Fiscal effect", UNKNOWN)}
${section("C. Arguments for", claim("_race", { contest: "question-1", text: "Says: more hours", tag: "T1s" }))}
${section("D. Arguments against", claim("_race", { contest: "question-1", text: "Fewer hours", tag: "T1" }))}
${section("E. Independent analysis", UNKNOWN)}`;

describe("coverage: measures", () => {
  const measure = (log) => {
    const data = setup({ ballot: MEASURE_BALLOT });
    data.write(`${BALLOT}/articles/question-1.md`, MEASURE);
    if (log) data.write(`${BALLOT}/search-log/question-1.tsv`, log);
    return data;
  };

  it("has one block titled with the contest id, logged under _race, and says-only arguments", async () => {
    const result = await coverage(measure("question-1\t_race\t6\t2026-10-20\n"), [
      BALLOT,
      "question-1",
    ]);
    assert.strictEqual(
      result.stdout,
      `articles/question-1.md:${lineOf(MEASURE, "### D. Arguments against") + 2} says-missing\n`,
    );
    const unlogged = await coverage(measure(null), [BALLOT, "question-1"]);
    assert.match(unlogged.stdout, /search-not-logged/);
  });
});

describe("coverage: snapshots no claim cites", () => {
  it("lists each uncited snapshot of the contest by path, without failing", async () => {
    const data = setup();
    for (const rel of [
      "sources/us-house-07/jane-example/bio.md",
      "sources/us-house-07/jane-example/old-bio.md",
      "sources/us-house-07/_race/debate.md",
      "sources/us-house-07/Precinct 12/notes.md",
      "sources/us-house-07/jane-example/.DS_Store",
      "sources/supreme-court-retention-a/pat-example/bio.md",
      "sources/_ballot/candidate-list.md",
    ])
      data.write(`${BALLOT}/${rel}`, "body\n");
    const result = await coverage(data);
    assert.strictEqual(
      result.stdout,
      [
        "sources/us-house-07/- uncited",
        "sources/us-house-07/_race/debate.md uncited",
        "sources/us-house-07/jane-example/old-bio.md uncited",
        `${AT} covered`,
      ]
        .map((l) => `${l}\n`)
        .join(""),
    );
    assert.strictEqual(result.status, 0);
  });

  it("lists them after an article's failures too", async () => {
    const data = setup({ article: edited("### D. Money", "### Money") });
    data.write(`${BALLOT}/sources/us-house-07/_race/debate.md`, "body\n");
    const result = await coverage(data);
    assert.match(
      result.stdout,
      /section-missing\nsources\/us-house-07\/_race\/debate\.md uncited\n$/,
    );
    assert.strictEqual(result.status, 1);
  });
});

describe("coverage: arguments and data files", () => {
  it("checks the contests given, once each, or every article", async () => {
    const data = setup();
    data.write(`${BALLOT}/articles/supreme-court-retention-a.md`, RETENTION);
    data.write(
      `${BALLOT}/search-log/supreme-court-retention-a.tsv`,
      "supreme-court-retention-a\tpat-example\t7\t2026-10-20\n",
    );
    const twice = await coverage(data, [BALLOT, "us-house-07", "us-house-07"]);
    assert.strictEqual(twice.stdout, `${AT} covered\n`);
    const all = await coverage(data);
    // Sorted by name, as check reads them.
    assert.strictEqual(all.stdout, `${RET_AT} covered\n${AT} covered\n`);
  });

  it("fails an article for a contest ballot.yaml does not list, and a missing article", async () => {
    const data = setup();
    data.write(`${BALLOT}/articles/us-senate.md`, "# us-senate\n");
    await failsWith(data, [`${AT} covered`, "articles/us-senate.md unknown-contest"]);
    const given = await coverage(data, [BALLOT, "supreme-court-retention-a"]);
    assert.strictEqual(given.stdout, `${RET_AT} file-missing\n`);
    assert.strictEqual(given.status, 1);
  });

  it("refuses bad arguments, a ballot.yaml it cannot read, and a repo Rule 8 refuses", async () => {
    const data = setup();
    for (const args of [[], [BALLOT, "Us_House"], [BALLOT, "--show"], ["xx-exampleton-1"]]) {
      const result = await coverage(data, args);
      assert.match(result.stdout, /^- (usage|bad-ballot)\n$/, args.join(" "));
      assert.strictEqual(result.status, 1);
    }
    const noType = setup({ ballot: DEFAULT_BALLOT.replace("    office_type: federal\n", "") });
    await failsWith(noType, ["ballot.yaml ballot-invalid"]);
    const badList = setup({ ballot: ballotWith("not_researched: [On the ballot]") });
    await failsWith(badList, ["ballot.yaml ballot-invalid"]);
    const unguarded = setup();
    fs.rmSync(unguarded.file("publish.yaml"));
    await failsWith(unguarded, ["publish.yaml guard-no-publish-yaml"]);
  });
});
