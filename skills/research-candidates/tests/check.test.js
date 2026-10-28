"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, makeDataRepo, runCli } = require("./harness");

// check (article-format.md, Command line), run as a subprocess against a temp
// data repo (seam 1).

const repos = [];
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const snapshot = (subject, body, extra = "") => `---
source: Example News
url: https://news.example.com/story
fetched: 2026-10-20
method: html
tier: T2
statements_only: false
subject: ${subject}
owner: third-party
${extra}---
${body}
`;

const BIO = `Jane Example grew up in Exampleton and taught school for twelve years.
She served two terms on the Exampleton school board, from 2014 to
2022, and chaired its finance com-
mittee from 2018.`;

const SAMPLE = `OFFICIAL SAMPLE BALLOT
Representative in Congress, 7th District
Vote for one
Jane Example
Example Party`;

// A data repo whose us-house-07 article passes check. `article` replaces it.
const setup = ({ article } = {}) => {
  const data = makeDataRepo();
  repos.push(data);
  plant(data, "sources/us-house-07/jane-example/bio.md", snapshot("jane-example", BIO));
  plant(
    data,
    "sources/_ballot/sample-ballot.md",
    snapshot("_ballot", SAMPLE, "role: sample_ballot\n"),
  );
  data.write(
    `${BALLOT}/ballot-view.md`,
    `link: sources/_ballot/sample-ballot.md
sha256: ${"0".repeat(64)}  ballot.yaml
sha256: ${"1".repeat(64)}  sources/_ballot/sample-ballot.md
Representative in Congress, 7th District
Vote for one
Jane Example Example Party
`,
  );
  data.write(`${BALLOT}/articles/us-house-07.md`, article ?? ARTICLE);
  return data;
};

// Save a snapshot as fetch-snapshot would: its manifest line, then the file.
const plant = (data, rel, text, { manifest = true } = {}) => {
  if (manifest) appendTo(data, "snapshots.sha256", `${sha256(text)}  ${rel}\n`);
  data.write(`${BALLOT}/${rel}`, text);
};

const appendTo = (data, rel, line) => {
  const file = `${BALLOT}/${rel}`;
  data.write(file, (data.exists(file) ? data.read(file) : "") + line);
};

const ARTICLE = `# us-house-07

## Jane Example

### A. On the ballot

- On the ballot for the Example Party \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > Jane Example Example Party

### B. Background

- Served two terms on the school board \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > She served two terms on the Exampleton school board, from 2014 to 2022

- Chaired the board's finance committee \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > and chaired its finance committee from 2018.
`;

const check = (data, args = [BALLOT]) => runCli("check", args, { cwd: data.root, env: data.env });

describe("check: a passing ballot", () => {
  it("prints the manifest and each article as checked and exits 0", async () => {
    const data = setup();
    const result = await check(data);
    assert.strictEqual(
      result.stdout,
      "snapshots.sha256 checked\narticles/us-house-07.md checked\n",
    );
    assert.strictEqual(result.status, 0);
  });
});

// The passing article with `from` replaced by `to`.
const edited = (from, to) => {
  assert.ok(ARTICLE.includes(from), `${from} is not in the article`);
  return ARTICLE.replace(from, to);
};

const failsWith = async (data, lines) => {
  const result = await check(data);
  assert.strictEqual(result.stdout, lines.map((l) => `${l}\n`).join(""));
  assert.strictEqual(result.status, 1);
};

describe("check: excerpts against their own snapshot", () => {
  it("fails an excerpt the linked snapshot does not hold, by its claim line", async () => {
    const data = setup({
      article: edited("from 2014 to 2022", "from 2010 to 2022"),
    });
    await failsWith(data, ["articles/us-house-07.md:12 excerpt-not-found"]);
  });

  it("reads hyphen breaks in a snapshot of any method", async () => {
    for (const method of ["html", "pdf", "api"]) {
      const data = setup();
      data.write(`${BALLOT}/snapshots.sha256`, "");
      plant(
        data,
        "sources/_ballot/sample-ballot.md",
        snapshot("_ballot", SAMPLE, "role: sample_ballot\n"),
      );
      plant(
        data,
        "sources/us-house-07/jane-example/bio.md",
        snapshot("jane-example", BIO).replace("method: html", `method: ${method}`),
      );
      const result = await check(data);
      assert.strictEqual(result.status, 0, `${method}: ${result.stdout}`);
    }
  });

  it("never matches an excerpt against another snapshot the article cites", async () => {
    const data = setup();
    plant(
      data,
      "sources/us-house-07/jane-example/other.md",
      snapshot("jane-example", "She chaired the Exampleton library board for six years."),
    );
    data.write(
      `${BALLOT}/articles/us-house-07.md`,
      `${ARTICLE}
- Chaired the library board \`T2\` [s3](../sources/us-house-07/jane-example/bio.md)
  > She chaired the Exampleton library board for six years.

- Chaired the library board \`T2\` [s3](../sources/us-house-07/jane-example/other.md)
  > She chaired the Exampleton library board for six years.
`,
    );
    await failsWith(data, ["articles/us-house-07.md:18 excerpt-not-found"]);
  });

  it("never matches the front matter", async () => {
    const data = setup({
      article: `${ARTICLE}
- Fetched from the news site \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > url: https://news.example.com/story
`,
    });
    await failsWith(data, ["articles/us-house-07.md:18 excerpt-not-found"]);
  });

  it("fails an excerpt under 20 or over 400 characters", async () => {
    const long = `${"x ".repeat(200)}x`;
    const data = setup({
      article: `${ARTICLE}
- Short \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > taught school for

- Exactly twenty \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > taught school for tw

- Long \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)
  > ${long}
`,
    });
    await failsWith(data, [
      "articles/us-house-07.md:18 excerpt-length",
      "articles/us-house-07.md:21 excerpt-not-found",
      "articles/us-house-07.md:24 excerpt-length",
      "articles/us-house-07.md:24 excerpt-not-found",
    ]);
  });
});

describe("check: sample-ballot excerpts", () => {
  it("accepts a whole ballot-view.md span of any length, and nothing else", async () => {
    const data = setup({
      article: `${ARTICLE}
- Runs for this office \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > Vote for one

- Part of a span \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > Representative in Congress

- In the ballot but not a span \`T1\` [s1](../sources/_ballot/sample-ballot.md)
  > OFFICIAL SAMPLE BALLOT
`,
    });
    await failsWith(data, [
      "articles/us-house-07.md:21 ballot-excerpt",
      "articles/us-house-07.md:24 ballot-excerpt",
    ]);
  });

  it("fails a claim citing another sample ballot, or any while ballot-view.md is missing", async () => {
    const data = setup();
    plant(
      data,
      "sources/_ballot/sample-ballot-2.md",
      snapshot("_ballot", SAMPLE, "role: sample_ballot\n"),
    );
    data.write(
      `${BALLOT}/articles/us-house-07.md`,
      edited("_ballot/sample-ballot.md", "_ballot/sample-ballot-2.md"),
    );
    await failsWith(data, ["articles/us-house-07.md:7 ballot-excerpt"]);

    data.write(`${BALLOT}/articles/us-house-07.md`, ARTICLE);
    fs.rmSync(data.file(`${BALLOT}/ballot-view.md`));
    await failsWith(data, ["articles/us-house-07.md:7 ballot-excerpt"]);
  });

  it("fails a claim citing a _ballot snapshot whose companion role cannot be read", async () => {
    const BODY = "Jane Example, 12 Main St, Example Party nominee";
    for (const [name, text] of [
      ["no-front-matter", `${BODY}\n`],
      ["crlf", snapshot("_ballot", BODY, "role: candidate_list\n").replace(/\n/g, "\r\n")],
      ["no-role", snapshot("_ballot", BODY)],
      ["bad-yaml", snapshot("_ballot", BODY, "role: [\n")],
      ["unknown-role", snapshot("_ballot", BODY, "role: candidate-list\n")],
    ]) {
      const data = setup();
      plant(data, `sources/_ballot/${name}.md`, text);
      data.write(
        `${BALLOT}/articles/us-house-07.md`,
        `${ARTICLE}
- Nominee \`T1\` [s3](../sources/_ballot/${name}.md)
  > ${BODY}
`,
      );
      await failsWith(data, ["articles/us-house-07.md:18 ballot-excerpt"]);
    }
  });

  it("matches a companion _ballot snapshot like any other source", async () => {
    const data = setup();
    plant(
      data,
      "sources/_ballot/candidate-list.md",
      snapshot(
        "_ballot",
        "Jane Example, 12 Main St, Example Party nominee",
        "role: candidate_list\n",
      ),
    );
    data.write(
      `${BALLOT}/articles/us-house-07.md`,
      `${ARTICLE}
- Nominee \`T1\` [s3](../sources/_ballot/candidate-list.md)
  > Party nominee

- Nominee \`T1\` [s3](../sources/_ballot/candidate-list.md)
  > Jane Example, 12 Main St, Example Party nominee
`,
    );
    await failsWith(data, ["articles/us-house-07.md:18 excerpt-length"]);
  });
});

describe("check: claim lines", () => {
  it("fails a claim with no link or no excerpt, and a stray line", async () => {
    const data = setup({
      article: `${ARTICLE}
- No link \`T2\`
  > She served two terms on the Exampleton school board

- No excerpt \`T2\` [s2](../sources/us-house-07/jane-example/bio.md)

Jane is a teacher.
`,
    });
    await failsWith(data, [
      "articles/us-house-07.md:18 claim-format",
      "articles/us-house-07.md:19 claim-format",
      "articles/us-house-07.md:21 claim-format",
      "articles/us-house-07.md:23 claim-format",
    ]);
  });

  it("fails a link to a missing (or retired), unnamed or outside snapshot, never printing it", async () => {
    const targets = [
      "../sources/us-house-07/jane-example/gone.md",
      "../sources/us-house-07/jane-example/Precinct-12.md",
      "../ballot.yaml",
      "../../xx-exampleton-2/sources/us-house-07/jane-example/bio.md",
      "https://news.example.com/story",
      "/etc/passwd",
      "../sources/us-house-07/jane-example/bio%2emd",
    ];
    const extra = targets
      .map(
        (t) =>
          `\n- A claim \`T2\` [s9](${t})\n  > She served two terms on the Exampleton school board\n`,
      )
      .join("");
    const data = setup({ article: ARTICLE + extra });
    const result = await check(data);
    assert.deepStrictEqual(
      result.stdout.trim().split("\n"),
      targets.map((_, i) => `articles/us-house-07.md:${18 + 3 * i} claim-format`),
    );
    assert.ok(!result.stdout.includes("Precinct"));
    assert.strictEqual(result.status, 1);
  });
});

describe("check: arguments and articles", () => {
  it("checks only the contests given, and fails one with no article", async () => {
    const data = setup();
    data.write(`${BALLOT}/articles/supreme-court-retention-a.md`, "stray text\n");
    let result = await check(data, [BALLOT, "us-house-07"]);
    assert.strictEqual(
      result.stdout,
      "snapshots.sha256 checked\narticles/us-house-07.md checked\n",
    );
    result = await check(data, [BALLOT, "us-house-07", "state-senate-12"]);
    assert.strictEqual(result.stdout, "articles/state-senate-12.md file-missing\n");
    assert.strictEqual(result.status, 1);
    await failsWith(data, ["articles/supreme-court-retention-a.md:1 claim-format"]);
  });

  it("checks a contest given twice once", async () => {
    const data = setup();
    const result = await check(data, [BALLOT, "us-house-07", "us-house-07"]);
    assert.strictEqual(
      result.stdout,
      "snapshots.sha256 checked\narticles/us-house-07.md checked\n",
    );
  });

  it("refuses bad arguments and runs Rule 8 first", async () => {
    const data = setup();
    for (const args of [[], ["--show", BALLOT], [BALLOT, "Bad_Contest"]]) {
      const result = await check(data, args);
      assert.strictEqual(result.stdout, "- usage\n");
    }
    assert.strictEqual(
      (await check(data, ["2026-general/xx-other-1"])).stdout,
      "2026-general/xx-other-1 unknown-ballot\n",
    );
    fs.rmSync(data.file("publish.yaml"));
    const result = await check(data);
    assert.match(result.stdout, /guard-no-publish-yaml/);
    assert.strictEqual(result.status, 1);
  });
});

describe("check: every snapshot matches snapshots.sha256 (snapshot-hash)", () => {
  const BIO_PATH = "sources/us-house-07/jane-example/bio.md";
  const manifest = (data) => data.read(`${BALLOT}/snapshots.sha256`);
  const setManifest = (data, text) => data.write(`${BALLOT}/snapshots.sha256`, text);

  it("fails an edited snapshot", async () => {
    const data = setup();
    data.write(`${BALLOT}/${BIO_PATH}`, snapshot("jane-example", `${BIO}\nEdited.`));
    await failsWith(data, [`${BIO_PATH} snapshot-hash`]);
  });

  it("fails an unlisted snapshot, and locates one fetch-snapshot could not have named by its parent", async () => {
    const data = setup();
    plant(data, "sources/us-house-07/jane-example/notes.md", "planted\n", { manifest: false });
    plant(data, "sources/us-house-07/Precinct 12/x.md", "planted\n", { manifest: false });
    plant(data, "sources/us-house-07/loose.md", "planted\n", { manifest: false });
    const result = await check(data);
    assert.deepStrictEqual(result.stdout.trim().split("\n").sort(), [
      "sources/us-house-07/- snapshot-hash",
      "sources/us-house-07/- snapshot-hash",
      "sources/us-house-07/jane-example/notes.md snapshot-hash",
    ]);
    assert.ok(!result.stdout.includes("Precinct"));
  });

  it("fails a retired snapshot whose file is still there, and passes one that is gone", async () => {
    const data = setup();
    appendTo(data, "snapshots.sha256", `-  ${BIO_PATH}\n`);
    let result = await check(data, [BALLOT, "supreme-court-retention-a"]);
    assert.strictEqual(
      result.stdout,
      `${BIO_PATH} snapshot-hash\narticles/supreme-court-retention-a.md file-missing\n`,
    );
    fs.rmSync(data.file(`${BALLOT}/${BIO_PATH}`));
    data.write(`${BALLOT}/articles/us-house-07.md`, `# us-house-07\n`);
    result = await check(data);
    assert.strictEqual(
      result.stdout,
      "snapshots.sha256 checked\narticles/us-house-07.md checked\n",
    );
  });

  it("fails a line whose file is gone and not retired", async () => {
    const data = setup();
    fs.rmSync(data.file(`${BALLOT}/${BIO_PATH}`));
    data.write(`${BALLOT}/articles/us-house-07.md`, `# us-house-07\n`);
    await failsWith(data, [`${BIO_PATH} snapshot-hash`]);
  });

  it("fails two hash lines or two retire lines for one path, and a retire line before its hash", async () => {
    let data = setup();
    appendTo(data, "snapshots.sha256", `${"a".repeat(64)}  ${BIO_PATH}\n`);
    await failsWith(data, ["snapshots.sha256:3 snapshot-hash"]);

    data = setup();
    fs.rmSync(data.file(`${BALLOT}/${BIO_PATH}`));
    data.write(`${BALLOT}/articles/us-house-07.md`, `# us-house-07\n`);
    appendTo(data, "snapshots.sha256", `-  ${BIO_PATH}\n-  ${BIO_PATH}\n`);
    await failsWith(data, ["snapshots.sha256:4 snapshot-hash"]);

    data = setup();
    setManifest(data, `-  ${BIO_PATH}\n${manifest(data)}`);
    await failsWith(data, ["snapshots.sha256:1 snapshot-hash"]);
  });

  it("fails a malformed line and a last line with no newline, by line number", async () => {
    const data = setup();
    const lines = manifest(data);
    setManifest(
      data,
      `${lines}\nnot a manifest line\n${"b".repeat(64)} ${BIO_PATH}\n${"c".repeat(64)}  sources/../ballot.yaml\n${"d".repeat(64)}  sources/x/y/z.md`,
    );
    await failsWith(data, [
      "snapshots.sha256:3 snapshot-hash",
      "snapshots.sha256:4 snapshot-hash",
      "snapshots.sha256:5 snapshot-hash",
      "snapshots.sha256:6 snapshot-hash",
      "snapshots.sha256:7 snapshot-hash",
    ]);
  });

  it("fails any symlink under sources/, even one named like a leftover", async () => {
    const data = setup();
    fs.symlinkSync(
      data.file(`${BALLOT}/${BIO_PATH}`),
      data.file(`${BALLOT}/sources/us-house-07/jane-example/link.md`),
    );
    fs.symlinkSync("/tmp", data.file(`${BALLOT}/sources/us-house-07/.DS_Store`));
    const result = await check(data);
    assert.deepStrictEqual(result.stdout.trim().split("\n"), [
      "sources/us-house-07/- snapshot-hash",
      "sources/us-house-07/jane-example/link.md snapshot-hash",
    ]);
  });

  it("skips .DS_Store, Thumbs.db and *.swp files", async () => {
    const data = setup();
    for (const name of [".DS_Store", "Thumbs.db", ".bio.md.swp"]) {
      data.write(`${BALLOT}/sources/us-house-07/jane-example/${name}`, "leftover\n");
    }
    const result = await check(data);
    assert.strictEqual(
      result.stdout,
      "snapshots.sha256 checked\narticles/us-house-07.md checked\n",
    );
  });

  it("reports manifest failures with every claim failure", async () => {
    const data = setup({ article: edited("from 2014 to 2022", "from 2010 to 2022") });
    data.write(`${BALLOT}/sources/us-house-07/jane-example/notes.md`, "planted\n");
    await failsWith(data, [
      "sources/us-house-07/jane-example/notes.md snapshot-hash",
      "articles/us-house-07.md:12 excerpt-not-found",
    ]);
  });
});
