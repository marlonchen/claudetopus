"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, before, describe, it } = require("node:test");

const SCRIPT = path.join(__dirname, "..", "scripts", "check_evidence.js");
const EXAMPLES_DIR = path.join(__dirname, "..", "examples");

const RAW_CONTENT = `# Ghostty Update

> Source: https://example.com/ghostty
> Collected: 2026-04-17
> Published: 2026-04-16

Ghostty reached 42K stars on GitHub in April 2026.
The maintainer said "the terminal should feel invisible to users" in the interview.
Daily active users reached 10,000 by March.
`;

const ARTICLE_CONTENT = `# Ghostty

> Sources: Example, 2026-04-16
> Raw: [ghostty](../../raw/ai-research/2026-04-17-ghostty.md)

## Overview

Ghostty has 42K stars and reached 10,000 daily active users.
The maintainer said "the terminal should feel invisible to users".

## Growth

Forks grew to 3,020 last week.
Install with \`--limit 9000\` after downloading.

\`\`\`
example 78K and 9,999
\`\`\`

> **Status: Outdated** (2026-07-23)
> The forks situation changed after this was written.
`;

const SENTENCE_FINAL_RAW = `# Numbers

> Source: https://example.com/numbers
> Collected: 2026-06-01
> Published: Unknown

Revenue hit 42K. Uptime was 99.9%. The round closed on 2026-06-15.
`;

const SENTENCE_FINAL_ARTICLE = `# Sentence final

> Sources: Example, 2026-06-01
> Raw: [numbers](../../raw/t/numbers.md)

Revenue hit 42K and uptime was 99.9%. The round closed on 2026-06-15.
`;

const STATUS_EXPLANATION_ARTICLE = `# Status article

> Sources: Example, 2026-04-16
> Raw: [ghostty](../../raw/ai-research/2026-04-17-ghostty.md)

Ghostty has 42K stars.

> **Status: Outdated** (2026-07-23)
> Superseded by the 2026-07-18 report, which restated the count as 55K.
`;

const FENCE_VARIANTS_ARTICLE = `# Fences

> Sources: Example, 2026-04-16
> Raw: [ghostty](../../raw/ai-research/2026-04-17-ghostty.md)

~~~text
not a factual claim: 777K
~~~

\`\`\`\`text
also not a claim: 888K
\`\`\`\`
`;

const BODY_ARCHIVED_ARTICLE = `# Ordinary article

> Sources: Example, 2026-01-01

Some paragraph first.

> Archived: 2025-01-01

The release reached 321K users.
`;

const RAW_WITH_BODY_METADATA_LINE = `# Source

> Source: https://example.com/x
> Collected: 2026-06-01
> Published: Unknown

First paragraph.
> Updated: The release reached 999K users.
`;

const BODY_METADATA_ARTICLE = `# Body metadata

> Sources: Example, 2026-06-01
> Raw: [src](../../raw/t/src.md)

The release reached 999K users.
`;

const ESCAPE_ARTICLE = `# Escape

> Sources: Example, 2026-01-01
> Raw: [support](../../notes/support.md)

The release reached 654K users.
`;

const DEDUP_ARTICLE = `# Dedup

> Sources: Example, 2026-04-16
> Raw: [ghostty](../../raw/ai-research/2026-04-17-ghostty.md)

Missing value 88,123 appears here and again as 88,123 elsewhere.
`;

const BOUNDARY_RAW = `# Numbers

> Source: https://example.com/numbers
> Collected: 2026-06-01
> Published: Unknown

Ghostty reached 142K stars. Uptime was 95.5%. Forks: 13,020.
`;

const BOUNDARY_ARTICLE = `# Boundary

> Sources: Example, 2026-06-01
> Raw: [numbers](../../raw/t/numbers.md)

Ghostty has 42K stars and uptime of 5.5%. Forks grew to 3,020.
`;

const PLAIN_RAW = `# Plain

> Source: https://example.com/plain
> Collected: 2026-06-01
> Published: Unknown

No numeric facts here at all.
`;

const PLAIN_ARTICLE = `# Plain numbers

> Sources: Example, 2026-06-01
> Raw: [plain](../../raw/t/plain.md)

There were 42 users; the ratio was 3.14; founded in 2026.
`;

const ARCHIVE_ARTICLE = `# Old answer

> Sources: [Ghostty](ghostty.md)
> Archived: 2026-07-01

At the time, Ghostty had 999K stars and the maintainer said "totally made up quote here".
`;

const NO_RAW_ARTICLE = `# No raw

> Sources: Example, 2026-06-01

This ordinary article forgot its Raw field and claims 999K users.
`;

const BROKEN_RAW_ARTICLE = `# Broken

> Sources: Example, 2026-06-01
> Raw: [gone](../../raw/t/nonexistent.md)

Claims 999K users with no evidence anywhere.
`;

const SECOND_RAW = `# Unrelated Notes

> Source: https://example.com/notes
> Collected: 2026-05-01
> Published: Unknown

Nothing here is compiled anywhere.
`;

const PLAIN_CLAIM = "There were 42 users; the ratio was 3.14; founded in 2026.";
const PLAIN_RAW_CLAIM = "No numeric facts here at all.";

// --- harness --------------------------------------------------------------

function write(root, rel, content) {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function makeWiki(root, log = "") {
  write(root, "raw/ai-research/2026-04-17-ghostty.md", RAW_CONTENT);
  write(root, "raw/misc/notes.md", SECOND_RAW);
  write(root, ".wiki/ai-research/ghostty.md", ARTICLE_CONTENT);
  write(root, ".wiki/index.md", "# Knowledge Base Index\n");
  write(root, ".wiki/log.md", log || "# Wiki Log\n");
}

function plainWiki(root, articleName, article, { raw = PLAIN_RAW, rawName = "src.md" } = {}) {
  write(root, `raw/t/${rawName}`, raw);
  write(root, `.wiki/t/${articleName}`, article);
  write(root, ".wiki/index.md", "# Knowledge Base Index\n");
  write(root, ".wiki/log.md", "# Wiki Log\n");
}

function runChecker(root, args = [], { cwd } = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, root, ...args], {
    encoding: "utf8",
    cwd,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function has(haystack, needle) {
  assert.ok(
    haystack.includes(needle),
    `expected to find ${JSON.stringify(needle)} in:\n${haystack}`,
  );
}

function hasNot(haystack, needle) {
  assert.ok(
    !haystack.includes(needle),
    `expected NOT to find ${JSON.stringify(needle)} in:\n${haystack}`,
  );
}

/**
 * Per-suite temp root. node:test runs `it` bodies within a `describe`
 * sequentially, so a single before/after pair per suite is enough and keeps
 * setup cost close to the unittest original.
 */
function tempRoot() {
  const box = { root: null };
  before(() => {
    box.root = fs.mkdtempSync(path.join(os.tmpdir(), "mywiki-"));
  });
  after(() => {
    fs.rmSync(box.root, { recursive: true, force: true });
  });
  return box;
}

/** A fresh root for one test, cleaned up immediately after. */
function withRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mywiki-"));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- tests ----------------------------------------------------------------

describe("FidelityCheck", () => {
  const box = tempRoot();
  before(() => makeWiki(box.root));

  it("flags value absent from raw", () => {
    has(runChecker(box.root).stdout, "3,020");
  });

  it("passes values and quotes present in raw", () => {
    const out = runChecker(box.root).stdout;
    hasNot(out.replaceAll("3,020", ""), "42K");
    hasNot(out, "10,000");
    hasNot(out, "invisible to users");
  });

  it("ignores numbers in code", () => {
    const out = runChecker(box.root).stdout;
    hasNot(out, "9000");
    hasNot(out, "78K");
    hasNot(out, "9,999");
  });

  it("ignores status block marker date", () => {
    hasNot(runChecker(box.root).stdout, "2026-07-23");
  });
});

describe("BoundaryMatching", () => {
  it("substring of larger number does not pass", () => {
    withRoot((root) => {
      write(root, "raw/t/numbers.md", BOUNDARY_RAW);
      write(root, ".wiki/t/a.md", BOUNDARY_ARTICLE);
      write(root, ".wiki/index.md", "# Knowledge Base Index\n");
      write(root, ".wiki/log.md", "# Wiki Log\n");
      const out = runChecker(root).stdout;
      has(out, "42K");
      has(out, "5.5%");
      has(out, "3,020");
    });
  });
});

describe("DateBoundary", () => {
  it("missing date does not also report its year", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "Released on 2031-09-12.");
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      const out = runChecker(root).stdout;
      has(out, "- 2031-09-12");
      hasNot(out, "- 2031\n");
    });
  });

  it("month does not match prefix of full date", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "Released on 2026-03-19.");
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "Released in 2026-03.");
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "- 2026-03");
    });
  });
});

describe("NumberCoverage", () => {
  const box = tempRoot();
  before(() => {
    write(box.root, "raw/t/plain.md", PLAIN_RAW);
    write(box.root, ".wiki/t/a.md", PLAIN_ARTICLE);
    write(box.root, ".wiki/index.md", "# Knowledge Base Index\n");
    write(box.root, ".wiki/log.md", "# Wiki Log\n");
  });

  it("flags decimals and long numbers", () => {
    const out = runChecker(box.root).stdout;
    has(out, "3.14");
    has(out, "2026");
  });

  it("small plain integers are out of scope", () => {
    const out = runChecker(box.root).stdout;
    hasNot(out, "42 users");
    for (const line of out.split("\n")) {
      assert.notStrictEqual(line.trim(), "- 42", `small int flagged: ${line}`);
    }
  });
});

describe("EvidenceError", () => {
  it("archive page without raw is legitimate", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/old-answer.md", ARCHIVE_ARTICLE);
      const out = runChecker(root).stdout;
      hasNot(out, "999K");
      hasNot(out, "old-answer");
    });
  });

  it("ordinary article without raw is an evidence error", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/no-raw.md", NO_RAW_ARTICLE);
      const out = runChecker(root).stdout;
      has(out, "no-raw");
      has(out, "no Raw field");
    });
  });

  it("broken raw link is an evidence error", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/broken.md", BROKEN_RAW_ARTICLE);
      const out = runChecker(root).stdout;
      has(out, "broken");
      has(out, "unresolvable Raw link");
    });
  });
});

describe("Cli", () => {
  const box = tempRoot();
  before(() => makeWiki(box.root));

  it("article args resolve against root not cwd", () => {
    const result = runChecker(box.root, [".wiki/ai-research/ghostty.md"], { cwd: "/" });
    assert.strictEqual(result.status, 0);
    has(result.stdout, "3,020");
  });

  it("missing article is a warning not a traceback", () => {
    const result = runChecker(box.root, [".wiki/nope.md"]);
    assert.strictEqual(result.status, 0);
    has(result.stderr, ".wiki/nope.md");
    hasNot(result.stderr, "Traceback");
    hasNot(result.stderr, "at Object.");
  });
});

describe("SentenceFinal", () => {
  it("sentence final values pass", () => {
    withRoot((root) => {
      plainWiki(root, "a.md", SENTENCE_FINAL_ARTICLE, { raw: SENTENCE_FINAL_RAW });
      fs.unlinkSync(path.join(root, "raw/t/src.md"));
      write(root, "raw/t/numbers.md", SENTENCE_FINAL_RAW);
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });
});

describe("StatusBlock", () => {
  it("status block explanation is not checked", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/statused.md", STATUS_EXPLANATION_ARTICLE);
      const out = runChecker(root).stdout;
      hasNot(out, "2026-07-18");
      hasNot(out, "55K");
    });
  });
});

describe("FenceVariants", () => {
  it("tilde and long backtick fences are stripped", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/fences.md", FENCE_VARIANTS_ARTICLE);
      const out = runChecker(root).stdout;
      hasNot(out, "777K");
      hasNot(out, "888K");
    });
  });
});

describe("HeaderScope", () => {
  it("archived marker in body does not exempt", () => {
    withRoot((root) => {
      plainWiki(root, "a.md", BODY_ARCHIVED_ARTICLE);
      has(runChecker(root).stdout, "no Raw field");
    });
  });

  it("raw body metadata line remains evidence", () => {
    withRoot((root) => {
      plainWiki(root, "a.md", BODY_METADATA_ARTICLE, { raw: RAW_WITH_BODY_METADATA_LINE });
      hasNot(runChecker(root).stdout, "999K");
    });
  });
});

describe("RawEscape", () => {
  it("raw link outside raw dir is an evidence error", () => {
    withRoot((root) => {
      fs.mkdirSync(path.join(root, "raw"));
      write(root, "notes/support.md", "The release reached 654K users.\n");
      write(root, ".wiki/t/a.md", ESCAPE_ARTICLE);
      write(root, ".wiki/index.md", "# Knowledge Base Index\n");
      write(root, ".wiki/log.md", "# Wiki Log\n");
      has(runChecker(root).stdout, "escapes raw/");
    });
  });
});

describe("NoMaterialParsing", () => {
  it("heading inside fence does not suppress", () => {
    withRoot((root) => {
      write(root, "raw/t/orphan.md", "# Orphan\n");
      write(root, ".wiki/index.md", "# Knowledge Base Index\n");
      write(
        root,
        ".wiki/log.md",
        "# Wiki Log\n\n```markdown\n" +
          "## [2026-01-01] ingest | no material: raw/t/orphan.md\n" +
          "- Disposition: No material\n```\n",
      );
      has(runChecker(root).stdout, "raw/t/orphan.md");
    });
  });

  it("prose mention in lint entry does not suppress", () => {
    withRoot((root) => {
      write(root, "raw/t/orphan.md", "# Orphan\n");
      write(root, ".wiki/index.md", "# Knowledge Base Index\n");
      write(
        root,
        ".wiki/log.md",
        "# Wiki Log\n\n" +
          "## [2026-01-01] lint | 1 issues found, 0 auto-fixed\n" +
          "- Note: investigate no material: raw/t/orphan.md\n",
      );
      has(runChecker(root).stdout, "raw/t/orphan.md");
    });
  });
});

describe("Dedup", () => {
  it("candidate reported once without trailing space", () => {
    withRoot((root) => {
      makeWiki(root);
      write(root, ".wiki/ai-research/dedup.md", DEDUP_ARTICLE);
      const out = runChecker(root).stdout;
      assert.strictEqual(out.split("- 88,123").length - 1, 1);
    });
  });
});

describe("ExplicitArgs", () => {
  it("index and log are skipped even when passed explicitly", () => {
    withRoot((root) => {
      makeWiki(root);
      hasNot(runChecker(root, [".wiki/log.md"]).stdout, "no Raw field");
    });
  });
});

describe("TokenizerClosedForm", () => {
  it("version numbers match as whole", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "After v2.1.80, everything changed.");
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "After v2.1.80, everything changed.");
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });

  it("version number absent flagged as whole", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "After v2.1.80, everything changed.");
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      const out = runChecker(root).stdout;
      has(out, "- 2.1.80");
      hasNot(out, "- 2.1\n");
    });
  });

  it("prose commas do not create candidates", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(
        PLAIN_CLAIM,
        "There were 42, then 17, and finally 9 items.",
      );
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });
});

describe("RawLinksHeaderScope", () => {
  it("fence template raw line is ignored", () => {
    withRoot((root) => {
      const article =
        "# A\n\n> Sources: Example, 2026-01-01\n> Raw: [src](../../raw/t/src.md)\n\n" +
        "Value 42K.\n\n```markdown\n> Raw: [template](../../raw/topic/filename.md)\n```\n";
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "Value 42K confirmed.");
      plainWiki(root, "a.md", article, { raw });
      hasNot(runChecker(root).stdout, "unresolvable Raw link");
    });
  });

  it("body raw line does not count", () => {
    withRoot((root) => {
      const article =
        "# A\n\n> Sources: Example, 2026-01-01\n\n" +
        "Claims 42% growth.\n\n> Raw: [src](../../raw/t/src.md)\n";
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "42% growth confirmed.");
      plainWiki(root, "a.md", article, { raw });
      has(runChecker(root).stdout, "no Raw field");
    });
  });
});

describe("DocumentStructure", () => {
  it("fence between h1 and body raw does not create header", () => {
    withRoot((root) => {
      const article =
        "# A\n\n```text\nthis is body content\n```\n\n" +
        "> Raw: [src](../../raw/t/src.md)\n\nValue 42K.\n";
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "Value 42K.");
      plainWiki(root, "a.md", article, { raw });
      has(runChecker(root).stdout, "article has no Raw field");
    });
  });

  it("archived marker in fence before real h1 does not exempt", () => {
    withRoot((root) => {
      const article =
        "```markdown\n# Fake\n> Archived: 2026-01-01\n```\n\n" +
        "# Real article\n\n> Sources: Example, 2026-01-01\n\nValue 777K.\n";
      plainWiki(root, "a.md", article);
      has(runChecker(root).stdout, "article has no Raw field");
    });
  });

  it("title candidates are checked", () => {
    withRoot((root) => {
      const article =
        "# GPT 9.7 Migration Notes\n\n" +
        "> Sources: Example, 2026-01-01\n" +
        "> Raw: [src](../../raw/t/src.md)\n\nNo other claim.\n";
      plainWiki(root, "a.md", article);
      has(runChecker(root).stdout, "- 9.7");
    });
  });

  it("fence closer with trailing text does not close", () => {
    withRoot((root) => {
      const article =
        "# A\n\n> Sources: Example, 2026-01-01\n" +
        "> Raw: [src](../../raw/t/src.md)\n\n" +
        "```text\ninside 777K\n``` trailing text\nstill inside 888K\n```\n";
      plainWiki(root, "a.md", article);
      const out = runChecker(root).stdout;
      hasNot(out, "777K");
      hasNot(out, "888K");
    });
  });

  it("backtick in info string does not open fence", () => {
    withRoot((root) => {
      const article =
        "# A\n\n> Sources: Example, 2026-01-01\n" +
        "> Raw: [src](../../raw/t/src.md)\n\n" +
        "```lang`bad\nUnsupported 666K claim.\n```\n";
      plainWiki(root, "a.md", article);
      has(runChecker(root).stdout, "- 666K");
    });
  });
});

describe("QuotePairing", () => {
  it("multiline quote is checked within paragraph", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(
        PLAIN_CLAIM,
        'The maintainer said "the terminal should\nfeel invisible to users".\n',
      );
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      has(runChecker(root).stdout, "the terminal should feel invisible to users");
    });
  });

  it("short quote pairs do not create phantom quote", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(
        PLAIN_RAW_CLAIM,
        "Accuracy is high on paper but reliability is low in practice.",
      );
      const article = PLAIN_ARTICLE.replace(
        PLAIN_CLAIM,
        'Accuracy is "high" but reliability is "low".',
      );
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      hasNot(runChecker(root).stdout, "but reliability is");
    });
  });
});

describe("NestedIndexLog", () => {
  it("article named index in topic dir is checked", () => {
    withRoot((root) => {
      const article = BODY_METADATA_ARTICLE.replace("999K users", "888K users");
      plainWiki(root, "index.md", article);
      has(runChecker(root).stdout, "888K");
    });
  });

  it("article named log in topic dir is checked", () => {
    withRoot((root) => {
      const article = BODY_METADATA_ARTICLE.replace("999K users", "888K users");
      plainWiki(root, "log.md", article);
      has(runChecker(root).stdout, "888K");
    });
  });
});

describe("BlockquoteQuote", () => {
  it("short blockquote number is checked", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "> 999K users\n");
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      has(runChecker(root).stdout, "- 999K");
    });
  });

  it("blockquote link target is not part of quote", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(
        PLAIN_RAW_CLAIM,
        "The terminal should feel invisible to users.",
      );
      const article = PLAIN_ARTICLE.replace(
        PLAIN_CLAIM,
        "> The [terminal](https://example.com) should feel invisible to users.\n",
      );
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });

  it("fabricated blockquote quote is flagged", () => {
    withRoot((root) => {
      const article = PLAIN_ARTICLE.replace(
        PLAIN_CLAIM,
        "As the review put it:\n\n> This fabricated quotation is definitely absent.\n",
      );
      plainWiki(root, "a.md", article, { rawName: "plain.md" });
      has(runChecker(root).stdout, "fabricated quotation");
    });
  });

  it("verbatim blockquote quote passes", () => {
    withRoot((root) => {
      const article = ARTICLE_CONTENT.replace(
        "Forks grew to 3,020 last week.",
        "> the terminal should feel invisible to users\n",
      );
      makeWiki(root);
      write(root, ".wiki/ai-research/ghostty.md", article);
      hasNot(runChecker(root).stdout, "invisible to users");
    });
  });
});

describe("FenceIndent", () => {
  it("four space indented backticks are not a fence", () => {
    withRoot((root) => {
      const article =
        "# A\n\n> Sources: Example, 2026-01-01\n> Raw: [src](../../raw/t/src.md)\n\n" +
        "    ```\n    some indented text\n\nUnsupported claim 777K here.\n";
      plainWiki(root, "a.md", article);
      has(runChecker(root).stdout, "777K");
    });
  });
});

describe("BacktickNoMaterial", () => {
  it("backticked path still suppresses", () => {
    withRoot((root) => {
      const log =
        "# Wiki Log\n\n" +
        "## [2026-05-01] ingest | no material: `raw/misc/notes.md`\n" +
        "- Disposition: No material\n";
      makeWiki(root, log);
      hasNot(runChecker(root).stdout, "notes.md");
    });
  });
});

describe("SpacedSuffix", () => {
  it("word after number is not a suffix", () => {
    withRoot((root) => {
      const claim = "The product reached 10 Million users and used 42 Kilobytes.";
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, claim);
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, claim);
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });

  it("same spaced suffix in article and raw passes", () => {
    withRoot((root) => {
      const claim = "Uptime hit 99.9 % last week.";
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, claim);
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, claim);
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "0 fidelity suspect(s)");
    });
  });

  it("suffix does not match prefix of word", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "The package weighs 42Kg.");
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "The package weighs 42K.");
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "- 42K");
    });
  });

  it("spaced suffix does not match different raw spelling", () => {
    withRoot((root) => {
      const raw = PLAIN_RAW.replace(PLAIN_RAW_CLAIM, "Uptime hit 99.9% last week.");
      const article = PLAIN_ARTICLE.replace(PLAIN_CLAIM, "Uptime hit 99.9 % last week.");
      plainWiki(root, "a.md", article, { raw, rawName: "plain.md" });
      has(runChecker(root).stdout, "- 99.9 %");
    });
  });
});

describe("ExamplesSmoke", () => {
  it("examples have zero suspects", () => {
    withRoot((root) => {
      const rawName = "2026-03-19-claude-code-statusline-landscape.md";
      const articleName = "claude-code-statusline-landscape.md";
      write(
        root,
        `raw/ai-coding-tools/${rawName}`,
        fs.readFileSync(path.join(EXAMPLES_DIR, rawName), "utf8"),
      );
      write(
        root,
        `.wiki/ai-coding-tools/${articleName}`,
        fs.readFileSync(path.join(EXAMPLES_DIR, articleName), "utf8"),
      );
      write(root, ".wiki/index.md", "# Knowledge Base Index\n");
      write(root, ".wiki/log.md", "# Wiki Log\n");
      const out = runChecker(root).stdout;
      has(out, "0 fidelity suspect(s)");
      has(out, "0 evidence error(s)");
    });
  });
});

describe("RawInventory", () => {
  it("reports raw file never compiled", () => {
    withRoot((root) => {
      makeWiki(root);
      has(runChecker(root).stdout, "raw/misc/notes.md");
    });
  });

  it("no material disposition suppresses report", () => {
    withRoot((root) => {
      const log =
        "# Wiki Log\n\n" +
        "## [2026-05-01] ingest | no material: raw/misc/notes.md\n" +
        "- Disposition: No material\n";
      makeWiki(root, log);
      hasNot(runChecker(root).stdout, "notes.md");
    });
  });

  it("no material does not suppress same name elsewhere", () => {
    withRoot((root) => {
      write(root, "raw/other/notes.md", SECOND_RAW);
      const log =
        "# Wiki Log\n\n" +
        "## [2026-05-01] ingest | no material: raw/misc/notes.md\n" +
        "- Disposition: No material\n";
      makeWiki(root, log);
      const out = runChecker(root).stdout;
      hasNot(out, "raw/misc/notes.md");
      has(out, "raw/other/notes.md");
    });
  });
});

describe("RawConfig", () => {
  // raw.config: source directory selection and include/exclude filtering.
  function writeWiki(root, source) {
    write(root, `${source}/t/src.md`, "# Src\n\nGhostty reached 42K stars.\n");
    write(
      root,
      ".wiki/t/a.md",
      "# A\n\n> Sources: Example, 2026-01-01\n" +
        `> Raw: [src](../../${source}/t/src.md)\n\nGhostty reached 42K stars.\n`,
    );
    write(root, ".wiki/index.md", "# Knowledge Base Index\n");
    write(root, ".wiki/log.md", "# Wiki Log\n");
  }

  it("missing config defaults to raw", () => {
    withRoot((root) => {
      writeWiki(root, "raw");
      const out = runChecker(root).stdout;
      has(out, "0 fidelity suspect(s)");
      has(out, "0 evidence error(s)");
    });
  });

  it("source directive relocates the source directory", () => {
    withRoot((root) => {
      write(root, "raw.config", "# sources live elsewhere\nsource notes/\n");
      writeWiki(root, "notes");
      const out = runChecker(root).stdout;
      has(out, "0 evidence error(s)");
      has(out, "0 fidelity suspect(s)");
    });
  });

  it("escape message names the configured source", () => {
    withRoot((root) => {
      write(root, "raw.config", "source notes\n");
      writeWiki(root, "notes");
      write(root, "elsewhere/x.md", "# X\n");
      write(
        root,
        ".wiki/t/b.md",
        "# B\n\n> Sources: Example, 2026-01-01\n" + "> Raw: [x](../../elsewhere/x.md)\n\nClaim.\n",
      );
      has(runChecker(root).stdout, "escapes notes/");
    });
  });

  it("exclude drops a file from the orphan inventory", () => {
    withRoot((root) => {
      write(root, "raw.config", "exclude drafts/*\n");
      writeWiki(root, "raw");
      write(root, "raw/drafts/wip.md", "# WIP\n");
      write(root, "raw/t/kept.md", "# Kept\n");
      const out = runChecker(root).stdout;
      hasNot(out, "raw/drafts/wip.md");
      has(out, "raw/t/kept.md");
    });
  });

  it("exclude glob crosses directory separators", () => {
    withRoot((root) => {
      write(root, "raw.config", "exclude drafts/*\n");
      writeWiki(root, "raw");
      write(root, "raw/drafts/nested/deep.md", "# Deep\n");
      write(root, "raw/t/kept.md", "# Kept\n");
      const out = runChecker(root).stdout;
      hasNot(out, "raw/drafts/nested/deep.md");
      has(out, "raw/t/kept.md");
    });
  });

  it("include restricts the orphan inventory", () => {
    withRoot((root) => {
      write(root, "raw.config", "include t/*\n");
      writeWiki(root, "raw");
      write(root, "raw/other/x.md", "# X\n");
      write(root, "raw/t/kept.md", "# Kept\n");
      const out = runChecker(root).stdout;
      hasNot(out, "raw/other/x.md");
      has(out, "raw/t/kept.md");
    });
  });

  it("include takes precedence over exclude", () => {
    withRoot((root) => {
      write(root, "raw.config", "exclude drafts/*\ninclude drafts/keep.md\n");
      writeWiki(root, "raw");
      write(root, "raw/drafts/keep.md", "# Keep\n");
      write(root, "raw/drafts/drop.md", "# Drop\n");
      const out = runChecker(root).stdout;
      has(out, "raw/drafts/keep.md");
      hasNot(out, "raw/drafts/drop.md");
    });
  });

  it("unknown directive warns without failing", () => {
    withRoot((root) => {
      write(root, "raw.config", "bogus value\nsource raw\n");
      writeWiki(root, "raw");
      const result = runChecker(root);
      has(result.stderr, "unknown directive");
      has(result.stdout, "0 evidence error(s)");
    });
  });

  it("missing wiki directory names the dot wiki path", () => {
    withRoot((root) => {
      has(runChecker(root).stdout, ".wiki/ directory");
    });
  });
});
