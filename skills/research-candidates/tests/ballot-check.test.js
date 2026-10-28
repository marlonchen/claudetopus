"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT, makeDataRepo, runCli, runInTty } = require("./harness");

// ballot-check (ballot-format.md, Ballot check and Command line), run as a
// subprocess against a temp data repo (seam 1).

const repos = [];
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SAMPLE_BODY = `OFFICIAL SAMPLE BALLOT
Precinct 12
Representative in Congress,
7th District
Vote for one
Jane Example
Example Party
John Sample
Sample Party
Shall Justice Pat Example of the Supreme Court
be retained in office?
Yes
No`;

const PRIVATE = `private_strings:
  - Precinct 12
ignored_lines:
  - OFFICIAL SAMPLE BALLOT
  - Vote for one
  - "Yes"
  - "No"
`;

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const snapshot = (role, body) => `---
source: Exampleton County elections
url: https://county.example.gov/
fetched: 2026-10-20
method: pdf
tier: T1
statements_only: false
subject: _ballot
owner: third-party
role: ${role}
---
${body}
`;

// Save a _ballot snapshot as --ballot would: manifest line, ledger line, file.
// `ledger: false` leaves out the ledger line, `manifest: false` the hash.
const plant = (data, name, role, body, { ledger = true, manifest = true } = {}) => {
  const rel = `sources/_ballot/${name}.md`;
  const text = snapshot(role, body);
  if (manifest) appendTo(data, "snapshots.sha256", `${sha256(text)}  ${rel}\n`);
  if (ledger) appendTo(data, "ballot.ledger", `${rel}\t${role}\turl\tnone\t2026-10-20\n`);
  data.write(`${BALLOT}/${rel}`, text);
  return rel;
};

const appendTo = (data, rel, line) => {
  const file = `${BALLOT}/${rel}`;
  data.write(file, (data.exists(file) ? data.read(file) : "") + line);
};

// A data repo whose ballot passes, with options for each part.
const setup = ({ ballot = DEFAULT_BALLOT, priv = PRIVATE, body = SAMPLE_BODY, ...rest } = {}) => {
  const data = makeDataRepo({ ballot, private: priv, ...rest });
  repos.push(data);
  if (body !== null) plant(data, "sample-ballot", "sample_ballot", body);
  return data;
};

const ballotCheck = (data, args = [BALLOT]) =>
  runCli("ballot-check", args, { cwd: data.root, env: data.env });

const lines = (result) => result.stdout.split("\n").filter(Boolean);

const VIEW = "2026-general/xx-exampleton-1/ballot-view.md";

describe("ballot-check: a ballot that matches its sample ballot", () => {
  it("passes and writes ballot-view.md with only the matched spans, in ballot order", async () => {
    const data = setup();
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), ["ballot-view.md written"]);
    assert.equal(result.status, 0);
    assert.equal(
      data.read(VIEW),
      [
        "link: sources/_ballot/sample-ballot.md",
        "Representative in Congress, 7th District",
        "Jane Example Example Party",
        "John Sample Sample Party",
        "Shall Justice Pat Example of the Supreme Court be retained in office?",
        "Pat Example",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(data.read(VIEW), /Precinct|OFFICIAL|Vote for/);
  });
});

// The body's first line is line 12 of the file: ten front matter lines and two fences.
const FIRST = 12;
const bodyLine = (text) => FIRST + SAMPLE_BODY.split("\n").indexOf(text);
const yamlLine = (data, text) =>
  data
    .read(`${BALLOT}/ballot.yaml`)
    .split("\n")
    .findIndex((l) => l.includes(text)) + 1;
const edit = (from, to) => DEFAULT_BALLOT.replace(from, to);

describe("ballot-check: listed to official", () => {
  it("fails a title that is not in the sample ballot", async () => {
    const data = setup({ ballot: edit("7th District", "8th District") });
    const result = await ballotCheck(data);
    assert.equal(result.status, 1);
    assert.ok(
      lines(result).includes(`ballot.yaml:${yamlLine(data, "8th District")} title-not-found title`),
    );
  });

  it("fails titles listed out of ballot order", async () => {
    const swapped = DEFAULT_BALLOT.replace("  - id: us-house-07", "  - id: placeholder");
    // The retention contest first, then the House contest.
    const [head, rest] = swapped.split("contests:\n");
    const [house, retention] = rest.split(/(?= {2}- id: supreme-court-retention-a)/);
    const data = setup({
      ballot: `${head}contests:\n${retention}${house.replace("placeholder", "us-house-07")}`,
    });
    const result = await ballotCheck(data);
    assert.equal(result.status, 1);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "Representative in Congress")} title-not-found title`,
      ),
      result.stdout,
    );
  });

  it("fails a candidate whose name is printed under another contest", async () => {
    const body = SAMPLE_BODY.replace("John Sample\nSample Party\n", "").replace(
      "No",
      "No\nJohn Sample\nSample Party",
    );
    const data = setup({ body });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: John Sample")} name-not-found name`,
      ),
    );
  });

  it("fails a name that is only a prefix of a longer printed name", async () => {
    const data = setup({ body: SAMPLE_BODY.replace("John Sample\n", "John Samples\n") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: John Sample")} name-not-found name`,
      ),
    );
  });

  it("fails a party not printed after the name", async () => {
    const data = setup({ ballot: edit("party: Sample Party", "party: Other Party") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: John Sample")} party-not-found party`,
      ),
    );
  });

  it("fails a party printed on the ballot but not right after the name", async () => {
    const body = SAMPLE_BODY.replace("Example Party", "TEMP")
      .replace("Sample Party", "Example Party")
      .replace("TEMP", "Sample Party");
    const data = setup({ body });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: John Sample")} party-not-found party`,
      ),
    );
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: Jane Example")} party-not-found party`,
      ),
    );
  });

  it("matches names and titles case-sensitively", async () => {
    const data = setup({ body: SAMPLE_BODY.replace("Jane Example\n", "JANE EXAMPLE\n") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: Jane Example")} name-not-found name`,
      ),
    );
  });

  it("accepts an entry on one line, a party in parentheses and curly quotes", async () => {
    const body = SAMPLE_BODY.replace(
      "Jane Example\nExample Party",
      "Jane O’Example (Example Party)",
    );
    const data = setup({ body, ballot: edit("name: Jane Example", "name: Jane O'Example") });
    const result = await ballotCheck(data);
    assert.equal(result.status, 0, result.stdout);
    assert.match(data.read(VIEW), /^Jane O'Example \(Example Party\)$/m);
  });

  it("skips the printed-ballot check for a certified write-in", async () => {
    const ballot = edit(
      "        status: on_ballot\n  - id: supreme",
      "        status: on_ballot\n      - id: wendy-write\n        name: Wendy Write\n        status: certified_write_in\n  - id: supreme",
    );
    const result = await ballotCheck(setup({ ballot }));
    assert.equal(result.status, 0, result.stdout);
  });
});

describe("ballot-check: counts", () => {
  it("fails a contest_count that is not the number of contests listed", async () => {
    const data = setup({ ballot: edit("contest_count: 2", "contest_count: 3") });
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), [
      `ballot.yaml:${yamlLine(data, "contest_count")} contest-count-mismatch contest_count`,
    ]);
  });

  it("fails a printed_count that is not the printed candidates listed", async () => {
    const data = setup({ ballot: edit("printed_count: 2", "printed_count: 3") });
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), [
      `ballot.yaml:${yamlLine(data, "printed_count")} printed-count-mismatch printed_count`,
    ]);
  });

  it("fails a vote_for the printed Vote for line does not give", async () => {
    const data = setup({ ballot: edit("vote_for: 1", "vote_for: 2") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "title: Rep")} vote-for-mismatch vote_for`,
      ),
    );
  });

  it("reads a Vote for count written as a word, in capitals, with 'not more than'", async () => {
    const data = setup({
      ballot: edit("vote_for: 1", "vote_for: 2").replace("printed_count: 2", "printed_count: 2"),
      body: SAMPLE_BODY.replace("Vote for one", "VOTE FOR NOT MORE THAN TWO"),
      priv: PRIVATE.replace("Vote for one", "VOTE FOR NOT MORE THAN TWO"),
    });
    assert.equal((await ballotCheck(data)).status, 0);
  });

  it("fails a candidate contest with no Vote for line", async () => {
    const data = setup({ body: SAMPLE_BODY.replace("Vote for one\n", "") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "title: Rep")} vote-for-not-found vote_for`,
      ),
    );
  });
});

describe("ballot-check: official to listed", () => {
  it("lists every unaccounted line by number only", async () => {
    const body = SAMPLE_BODY.replace("Shall Justice", "County Sheriff\nSam Sheriff\nShall Justice");
    const data = setup({ body });
    const result = await ballotCheck(data);
    const at = FIRST + body.split("\n").indexOf("County Sheriff");
    assert.deepEqual(lines(result), [
      `sources/_ballot/sample-ballot.md:${at} line-unaccounted`,
      `sources/_ballot/sample-ballot.md:${at + 1} line-unaccounted`,
    ]);
    assert.doesNotMatch(result.stdout, /Sheriff/);
    assert.ok(!data.exists(VIEW));
  });

  it("accounts for a line made up wholly of private_strings entries", async () => {
    const body = SAMPLE_BODY.replace("Precinct 12", "SPRINGFIELD TOWNSHIP - Precinct 12");
    const priv = PRIVATE.replace("  - Precinct 12", "  - Precinct 12\n  - Springfield Township");
    assert.equal((await ballotCheck(setup({ body, priv }))).status, 0);
  });

  it("does not account for a line that only starts with a private_strings entry", async () => {
    const body = SAMPLE_BODY.replace("Precinct 12", "Precinct 12 Mayor");
    const result = await ballotCheck(setup({ body }));
    assert.deepEqual(lines(result), [
      `sources/_ballot/sample-ballot.md:${bodyLine("Precinct 12")} line-unaccounted`,
    ]);
  });

  it("accounts for an ignored_lines entry only as a whole line", async () => {
    const body = SAMPLE_BODY.replace("OFFICIAL SAMPLE BALLOT", "OFFICIAL SAMPLE BALLOT Governor");
    const result = await ballotCheck(setup({ body }));
    assert.deepEqual(lines(result), [`sources/_ballot/sample-ballot.md:${FIRST} line-unaccounted`]);
  });

  it("does not account for a line that holds a name and more", async () => {
    const body = SAMPLE_BODY.replace("Sample Party", "Sample Party Mayor Lee");
    const result = await ballotCheck(setup({ body }));
    assert.deepEqual(lines(result), [
      `sources/_ballot/sample-ballot.md:${bodyLine("Sample Party")} line-unaccounted`,
    ]);
  });
});

describe("ballot-check --show", () => {
  it("refuses outside a terminal before reading anything", async () => {
    const data = setup({
      body: SAMPLE_BODY.replace("Shall Justice", "Hidden Line\nShall Justice"),
    });
    const result = await ballotCheck(data, ["--show", BALLOT]);
    assert.deepEqual(lines(result), ["- not-a-terminal"]);
    assert.equal(result.status, 1);
  });

  it("refuses at a terminal when CLAUDECODE is set", async () => {
    const data = setup();
    const result = await runInTty("ballot-check", ["--show", BALLOT], {
      cwd: data.root,
      env: { ...data.env, CLAUDECODE: "1" },
    });
    assert.match(result.stdout, /- not-a-terminal/);
  });

  it("prints each unaccounted line's text under it, at the researcher's terminal", async () => {
    const body = SAMPLE_BODY.replace("Shall Justice", "Hidden \u001b[2JLine\nShall Justice");
    const data = setup({ body });
    const result = await runInTty("ballot-check", ["--show", BALLOT], {
      cwd: data.root,
      env: data.env,
    });
    const at = FIRST + body.split("\n").indexOf("Hidden \u001b[2JLine");
    assert.equal(result.status, 1);
    assert.equal(
      result.stdout.trim(),
      `sources/_ballot/sample-ballot.md:${at} line-unaccounted\n    Hidden �[2JLine`,
    );
  });
});

describe("ballot-check: the sample ballot must be in ballot.ledger", () => {
  it("fails a planted _ballot snapshot with no ledger line", async () => {
    const data = setup();
    plant(data, "pamphlet", "pamphlet", "Voter pamphlet", { ledger: false });
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), ["sources/_ballot/pamphlet.md ballot-not-in-ledger"]);
  });

  it("fails a planted sample ballot, and never uses it", async () => {
    const data = setup({ body: null });
    plant(data, "sample-ballot", "sample_ballot", SAMPLE_BODY, { ledger: false });
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), [
      "sources/_ballot/sample-ballot.md ballot-not-in-ledger",
      "sources/_ballot no-sample-ballot",
    ]);
  });

  it("fails a snapshot whose role differs from its ledger line", async () => {
    const data = setup();
    const rel = plant(data, "candidate-list", "candidate_list", "Candidates", { ledger: false });
    data.write(
      `${BALLOT}/ballot.ledger`,
      `${data.read(`${BALLOT}/ballot.ledger`)}${rel}\tpamphlet\turl\tnone\t2026-10-20\n`,
    );
    assert.deepEqual(lines(await ballotCheck(data)), [`${rel} ledger-mismatch`]);
  });

  it("fails a malformed ledger line by its line number", async () => {
    const data = setup();
    data.write(`${BALLOT}/ballot.ledger`, `${data.read(`${BALLOT}/ballot.ledger`)}not a line\n`);
    assert.deepEqual(lines(await ballotCheck(data)), ["ballot.ledger:2 ledger-invalid"]);
  });

  it("fails two sample ballots", async () => {
    const data = setup();
    plant(data, "sample-ballot-2", "sample_ballot", SAMPLE_BODY);
    assert.deepEqual(lines(await ballotCheck(data)), ["sources/_ballot sample-ballot-not-unique"]);
  });

  it("fails a sample ballot edited after it was saved", async () => {
    const data = setup();
    const file = `${BALLOT}/sources/_ballot/sample-ballot.md`;
    data.write(file, data.read(file).replace("Jane Example", "Jane Exemplar"));
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes("sources/_ballot/sample-ballot.md snapshot-hash"),
      result.stdout,
    );
  });

  it("skips operating-system leftovers", async () => {
    const data = setup();
    data.write(`${BALLOT}/sources/_ballot/.DS_Store`, "x");
    assert.equal((await ballotCheck(data)).status, 0);
  });
});

describe("ballot-check: ballot.yaml fields", () => {
  const fails = async (ballot, expected, setupOptions = {}) => {
    const data = setup({ ballot, ...setupOptions });
    const result = await ballotCheck(data);
    assert.equal(result.status, 1);
    const want = typeof expected === "function" ? expected(data) : expected;
    assert.ok(lines(result).includes(want), `${want} not in\n${result.stdout}`);
    return { data, result };
  };

  it("fails an id that is not lower-case kebab", async () => {
    await fails(
      edit("id: jane-example", "id: Jane_Example"),
      (d) => `ballot.yaml:${yamlLine(d, "Jane_Example")} id-invalid id`,
    );
  });

  it("fails the contest id ballot, the page's own anchor", async () => {
    await fails(
      edit("id: us-house-07", "id: ballot"),
      (d) => `ballot.yaml:${yamlLine(d, "id: ballot")} id-invalid id`,
    );
  });

  it("fails two people with one id in a contest", async () => {
    await fails(
      edit("id: john-sample", "id: jane-example"),
      (d) => `ballot.yaml:${yamlLine(d, "name: John Sample") - 1} id-duplicate id`,
    );
  });

  it("fails a slug that is not six lower-case letters or digits", async () => {
    await fails(edit("slug: k3x9qa", "slug: K3X9QA"), "ballot.yaml:4 slug-invalid slug");
    await fails(edit("slug: k3x9qa", "slug: my-mom"), "ballot.yaml:4 slug-invalid slug");
  });

  it("fails a slug another ballot.yaml uses, and an id another gives a different name", async () => {
    const data = setup();
    data.write(
      "2026-general/xx-exampleton-2/ballot.yaml",
      DEFAULT_BALLOT.replace("name: Jane Example", "name: Jane Q. Example"),
    );
    const result = await ballotCheck(data);
    assert.ok(lines(result).includes("ballot.yaml:4 slug-duplicate slug"), result.stdout);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "id: jane-example")} id-name-conflict id`,
      ),
    );
    assert.doesNotMatch(result.stdout, /exampleton-2/);
  });

  it("accepts the same id with the same name on another ballot, under another election", async () => {
    const data = setup();
    data.write(
      "2025-general/xx-exampleton-1/ballot.yaml",
      DEFAULT_BALLOT.replace("2026-general", "2025-general").replace("k3x9qa", "zz9zz9"),
    );
    assert.equal((await ballotCheck(data)).status, 0);
  });

  it("fails, located -, another ballot directory whose name is not a ballot id", async () => {
    const data = setup();
    data.write(
      "2026-general/pa-delaware-np-w04-p01/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "zz9zz9"),
    );
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), ["- ballot-id-invalid"]);
    assert.doesNotMatch(result.stdout, /w04/);
  });

  it("fails, located -, another ballot whose id its state and county do not build", async () => {
    const data = setup();
    data.write(
      "2026-general/xx-otherton-1/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "zz9zz9"),
    );
    assert.deepEqual(lines(await ballotCheck(data)), ["- ballot-id-mismatch"]);
  });

  it("fails a ballot id its own state and county do not build", async () => {
    await fails(
      edit("county: Exampleton County", "county: Otherton County"),
      "ballot.yaml:3 ballot-id-mismatch county",
    );
  });

  it("fails an election field that is not the directory's", async () => {
    await fails(
      edit("election: 2026-general", "election: 2026-primary"),
      "ballot.yaml:1 election-mismatch election",
    );
  });

  it("fails a display_title equal to its title", async () => {
    const ballot = edit(
      "    title: Representative in Congress, 7th District\n",
      "    title: Representative in Congress, 7th District\n    display_title: Representative in Congress, 7th District\n",
    );
    await fails(
      ballot,
      (d) => `ballot.yaml:${yamlLine(d, "display_title")} display-title-same display_title`,
    );
  });

  it("fails not_researched naming On the ballot, or a section of another contest type", async () => {
    for (const list of ["[On the ballot]", "[Discipline]", "[Money, Money]", "everything"]) {
      await fails(
        edit("    vote_for: 1\n", `    vote_for: 1\n    not_researched: ${list}\n`),
        (d) => `ballot.yaml:${yamlLine(d, "not_researched")} not-researched-invalid not_researched`,
      );
    }
  });

  it("accepts not_researched sections of the contest's type, or all", async () => {
    for (const list of ["[Money, Positions]", "all"]) {
      const ballot = edit("    vote_for: 1\n", `    vote_for: 1\n    not_researched: ${list}\n`);
      assert.equal((await ballotCheck(setup({ ballot }))).status, 0, list);
    }
  });

  it("fails an unknown key, a bad status and a missing office_type, by field", async () => {
    const { result } = await fails(
      edit("vote_for: 1", "vote_for: 1\n    not_reserched: all"),
      (d) => `ballot.yaml:${yamlLine(d, "not_reserched")} ballot-invalid not_reserched`,
    );
    assert.doesNotMatch(result.stdout, /Exampleton|Jane/);
    await fails(
      edit("status: on_ballot", "status: running"),
      (d) => `ballot.yaml:${yamlLine(d, "status: running")} ballot-invalid status`,
    );
    await fails(
      edit("    office_type: federal\n", ""),
      (d) => `ballot.yaml:${yamlLine(d, "- id: us-house-07")} ballot-invalid office_type`,
    );
  });

  it("fails a private.yaml with another key or a non-string entry", async () => {
    for (const priv of ["private_strings: [12]\n", "private_strings: []\nignore_lines: []\n"]) {
      const result = await ballotCheck(setup({ priv }));
      assert.match(lines(result)[0], /^private\.yaml private-invalid/);
    }
  });

  it("still reports every ballot.yaml and ledger failure when private.yaml cannot be read", async () => {
    const data = setup({ priv: false, ballot: edit("contest_count: 2", "contest_count: 3") });
    plant(data, "pamphlet", "pamphlet", "Voter pamphlet", { ledger: false });
    assert.deepEqual(lines(await ballotCheck(data)), [
      "private.yaml file-missing",
      `ballot.yaml:${yamlLine(data, "contest_count")} contest-count-mismatch contest_count`,
      "sources/_ballot/pamphlet.md ballot-not-in-ledger",
    ]);
  });

  it("never reports two missing slugs as a duplicate", async () => {
    const data = setup({ ballot: edit("slug: k3x9qa\n", "") });
    data.write(
      "2026-general/xx-exampleton-2/ballot.yaml",
      DEFAULT_BALLOT.replace("slug: k3x9qa\n", ""),
    );
    assert.deepEqual(lines(await ballotCheck(data)), ["ballot.yaml:1 slug-invalid slug"]);
  });

  it("removes a ballot-view.md an earlier pass wrote once the ballot fails", async () => {
    const data = setup();
    assert.equal((await ballotCheck(data)).status, 0);
    data.write(`${BALLOT}/ballot.yaml`, edit("printed_count: 2", "printed_count: 3"));
    assert.equal((await ballotCheck(data)).status, 1);
    assert.ok(!data.exists(VIEW));
  });
});

describe("ballot-check: arguments and Rule 8", () => {
  it("fails a bad ballot argument and a missing ballot", async () => {
    const data = setup();
    assert.deepEqual(lines(await ballotCheck(data, ["2026-general/Exampleton"])), ["- bad-ballot"]);
    assert.deepEqual(lines(await ballotCheck(data, ["2026-general/xx-exampleton-9"])), [
      "2026-general/xx-exampleton-9 unknown-ballot",
    ]);
    assert.deepEqual(lines(await ballotCheck(data, [])), ["- usage"]);
  });

  it("refuses outside a private data repo", async () => {
    const data = setup({ publish: false });
    assert.deepEqual(lines(await ballotCheck(data)), ["publish.yaml guard-no-publish-yaml"]);
  });
});
