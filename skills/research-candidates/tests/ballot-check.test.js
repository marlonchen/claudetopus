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
const SAMPLE = `${BALLOT}/sources/_ballot/sample-ballot.md`;

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
        `sha256: ${sha256(data.read(`${BALLOT}/ballot.yaml`))}  ballot.yaml`,
        `sha256: ${sha256(data.read(SAMPLE))}  sources/_ballot/sample-ballot.md`,
        "Representative in Congress, 7th District",
        "Vote for one",
        "Jane Example Example Party",
        "John Sample Sample Party",
        "Shall Justice Pat Example of the Supreme Court be retained in office?",
        "Pat Example",
        "",
      ].join("\n"),
    );
    assert.doesNotMatch(data.read(VIEW), /Precinct|OFFICIAL/);
  });

  it("removes a view write a crash cut short", async () => {
    const data = setup({ ballot: edit("contest_count: 2", "contest_count: 3") });
    data.write(`${VIEW}.tmp-1`, "Jane Example Example Party\n");
    assert.equal((await ballotCheck(data)).status, 1);
    assert.ok(!data.exists(`${VIEW}.tmp-1`));
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

  it("reports a name run into a longer hyphenated name as not found", async () => {
    const data = setup({ body: SAMPLE_BODY.replace("John Sample\n", "John Sample-Jones\n") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "name: John Sample")} name-not-found name`,
      ),
      result.stdout,
    );
  });

  it("accounts for a private_strings entry the way the publish scan folds it", async () => {
    const body = SAMPLE_BODY.replace("Precinct 12", "STRASSE 12");
    const priv = PRIVATE.replace("  - Precinct 12", "  - Straße 12");
    assert.equal((await ballotCheck(setup({ body, priv }))).status, 0);
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
      ballot: edit("vote_for: 1", "vote_for: 2"),
      body: SAMPLE_BODY.replace("Vote for one", "VOTE FOR NOT MORE THAN TWO"),
    });
    assert.equal((await ballotCheck(data)).status, 0);
  });

  it("reads a Vote for phrase in brackets, after a colon, or on the title's line", async () => {
    for (const [from, to] of [
      ["Vote for one", "(Vote for 1)"],
      ["Vote for one", "Vote for: 1"],
      ["7th District\nVote for one", "7th District Vote for one"],
    ]) {
      const data = setup({ body: SAMPLE_BODY.replace(from, to) });
      const result = await ballotCheck(data);
      assert.equal(result.status, 0, `${to}\n${result.stdout}`);
    }
  });

  it("skips a Vote for line that gives no count, and one that does not start its line", async () => {
    const body = SAMPLE_BODY.replace(
      "Vote for one",
      "Vote for a write-in by writing the name\nTo vote for 2, see page 3\nVote for one",
    );
    const priv = `${PRIVATE}  - Vote for a write-in by writing the name\n  - To vote for 2, see page 3\n`;
    assert.equal((await ballotCheck(setup({ body, priv }))).status, 0);
  });

  it("reads a contest with no Vote for line as electing one", async () => {
    const body = SAMPLE_BODY.replace("Vote for one\n", "");
    assert.equal((await ballotCheck(setup({ body }))).status, 0);
    const data = setup({ body, ballot: edit("vote_for: 1", "vote_for: 2") });
    const result = await ballotCheck(data);
    assert.ok(
      lines(result).includes(
        `ballot.yaml:${yamlLine(data, "title: Rep")} vote-for-not-found vote_for`,
      ),
      result.stdout,
    );
  });

  it("accepts a printed_count of 0 when every candidate is a certified write-in", async () => {
    const ballot = edit("printed_count: 2", "printed_count: 0").replaceAll(
      "status: on_ballot",
      "status: certified_write_in",
    );
    const body = SAMPLE_BODY.replace(
      "Jane Example\nExample Party\nJohn Sample\nSample Party\n",
      "",
    );
    assert.equal((await ballotCheck(setup({ ballot, body }))).status, 0);
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

  it("replaces format characters that reorder the terminal's text", async () => {
    const body = SAMPLE_BODY.replace("Shall Justice", "Hidden \u202eLine\nShall Justice");
    const data = setup({ body });
    const result = await runInTty("ballot-check", ["--show", BALLOT], {
      cwd: data.root,
      env: data.env,
    });
    assert.match(result.stdout, /Hidden \ufffdLine/);
    assert.doesNotMatch(result.stdout, /\u202e/);
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

  it("reads a last ledger line with no newline, and fails it once", async () => {
    const data = setup();
    const ledger = `${BALLOT}/ballot.ledger`;
    data.write(ledger, data.read(ledger).trimEnd());
    assert.deepEqual(lines(await ballotCheck(data)), ["ballot.ledger:1 ledger-invalid"]);
  });

  it("never prints a _ballot file name fetch-snapshot could not have given", async () => {
    const data = setup();
    data.write(`${BALLOT}/sources/_ballot/x\nballot-view.md written`, "x");
    data.write(`${BALLOT}/sources/_ballot/sample 123 Elm St.pdf`, "x");
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), [
      "sources/_ballot/- ballot-not-in-ledger",
      "sources/_ballot/- ballot-not-in-ledger",
    ]);
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

  it("fails an id another ballot gives a different name, whatever the ballots' order", async () => {
    const data = setup();
    data.write(
      "2025-general/xx-exampleton-1/ballot.yaml",
      DEFAULT_BALLOT.replace("2026-general", "2025-general")
        .replace("k3x9qa", "aa1aa1")
        .replace("name: Jane Example", "name: Jane Q. Example"),
    );
    data.write(
      "2026-general/xx-exampleton-2/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "bb2bb2"),
    );
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), [
      `ballot.yaml:${yamlLine(data, "id: jane-example")} id-name-conflict id`,
    ]);
  });

  it("gives one person one id when counties print the name in another case or quote", async () => {
    const data = setup();
    data.write(
      "2026-general/xx-exampleton-2/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "zz9zz9")
        .replace("name: Jane Example", "name: JANE  EXAMPLE")
        .replace("name: John Sample", "name: John O’Sample"),
    );
    const ballot = edit("name: John Sample", "name: John O'Sample");
    const body = SAMPLE_BODY.replace("John Sample", "John O'Sample");
    data.write(`${BALLOT}/ballot.yaml`, ballot);
    data.write(SAMPLE, data.read(SAMPLE).replace("John Sample", "John O'Sample"));
    data.write(
      `${BALLOT}/snapshots.sha256`,
      `${sha256(data.read(SAMPLE))}  sources/_ballot/sample-ballot.md\n`,
    );
    assert.ok(body);
    const result = await ballotCheck(data);
    assert.equal(result.status, 0, result.stdout);
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
    assert.deepEqual(lines(result), ["- ballot-id-invalid", "- check-each-ballot"]);
    assert.doesNotMatch(result.stdout, /w04/);
  });

  it("fails, located -, another ballot whose id its state and county do not build", async () => {
    const data = setup();
    data.write(
      "2026-general/xx-otherton-1/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "zz9zz9"),
    );
    assert.deepEqual(lines(await ballotCheck(data)), [
      "- ballot-id-mismatch",
      "- check-each-ballot",
    ]);
  });

  it("reports, never crashes on, a state another ballot or this one gives as any text", async () => {
    const data = setup();
    data.write(
      "2026-general/xx-otherton-1/ballot.yaml",
      DEFAULT_BALLOT.replace("k3x9qa", "zz9zz9").replace("state: XX", 'state: "(("'),
    );
    assert.deepEqual(lines(await ballotCheck(data)), [
      "- ballot-id-mismatch",
      "- check-each-ballot",
    ]);
    const own = await ballotCheck(setup({ ballot: edit("state: XX", 'state: "X("') }));
    assert.deepEqual(lines(own), ["ballot.yaml:2 ballot-invalid state"]);
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

  it("fails an unknown key by its line alone, a bad status and a missing office_type, by field", async () => {
    const { result } = await fails(
      edit("vote_for: 1", "vote_for: 1\n    not_reserched: all"),
      (d) => `ballot.yaml:${yamlLine(d, "not_reserched")} ballot-invalid`,
    );
    assert.doesNotMatch(result.stdout, /Exampleton|Jane|reserched/);
    const forged = await fails(
      edit("vote_for: 1", 'vote_for: 1\n    "Pat Voter\\nballot-view.md written": 1'),
      (d) => `ballot.yaml:${yamlLine(d, "Pat Voter")} ballot-invalid`,
    );
    assert.doesNotMatch(forged.result.stdout, /Pat Voter|written/);
    await fails(
      edit("status: on_ballot", "status: running"),
      (d) => `ballot.yaml:${yamlLine(d, "status: running")} ballot-invalid status`,
    );
    await fails(
      edit("    office_type: federal\n", ""),
      (d) => `ballot.yaml:${yamlLine(d, "- id: us-house-07")} ballot-invalid office_type`,
    );
  });

  it("fails a private.yaml with another key, a non-string entry or nothing, never naming a key", async () => {
    for (const priv of [
      "private_strings: [12]\n",
      "private_strings: []\nignore_lines: []\n",
      "Lincoln Elementary Gym: 1\n",
      "",
    ]) {
      const result = await ballotCheck(setup({ priv }));
      assert.equal(lines(result)[0], "private.yaml private-invalid", priv);
    }
  });

  it("fails a contest type that is not one of the three", async () => {
    await fails(
      edit("type: candidate", "type: [candidate]"),
      (d) => `ballot.yaml:${yamlLine(d, "[candidate]")} ballot-invalid type`,
    );
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

// ballot-format.md, Private text, Ids, Ballot ids and Tiers: values that go out
// to web searches or page anchors never carry private text.
describe("ballot-check: private text", () => {
  const failsWith = async (data, expected) => {
    const result = await ballotCheck(data);
    assert.equal(result.status, 1);
    for (const line of expected) assert.ok(lines(result).includes(line), result.stdout);
    assert.ok(!data.exists(VIEW));
    return result;
  };

  it("fails a jurisdiction holding a private string, naming the field, never the text", async () => {
    const data = setup({
      ballot: edit("jurisdiction: XX supreme court", "jurisdiction: XX precinct-12 court"),
    });
    const result = await failsWith(data, [
      `ballot.yaml:${yamlLine(data, "precinct-12")} private-string jurisdiction`,
    ]);
    assert.doesNotMatch(result.stdout, /precinct/i);
  });

  it("fails a contest id that, hyphens read as spaces, holds a private string", async () => {
    const data = setup({ ballot: edit("id: us-house-07", "id: precinct-12-house") });
    await failsWith(data, [`ballot.yaml:${yamlLine(data, "precinct-12-house")} private-string id`]);
  });

  it("fails a jurisdiction or contest id holding a hidden printed title", async () => {
    const hidden = edit(
      "    title: Representative in Congress, 7th District\n",
      "    title: Representative in Congress, 7th District\n    display_title: US House\n",
    )
      .replace(
        "jurisdiction: XX congressional district 7",
        "jurisdiction: XX Representative in Congress, 7th District",
      )
      .replace("id: us-house-07", "id: representative-in-congress-7th-district");
    const data = setup({ ballot: hidden });
    await failsWith(data, [
      `ballot.yaml:${yamlLine(data, "jurisdiction: XX Rep")} private-title jurisdiction`,
      `ballot.yaml:${yamlLine(data, "id: representative")} private-title id`,
    ]);
  });

  it("allows a private string only in the printed title of a contest with a display_title", async () => {
    const priv = PRIVATE.replace(
      "  - Precinct 12\n",
      "  - Precinct 12\n  - Representative in Congress\n",
    );
    const titled = edit(
      "    title: Representative in Congress, 7th District\n",
      "    title: Representative in Congress, 7th District\n    display_title: US House\n",
    );
    const hidden = setup({ ballot: titled, priv });
    assert.deepEqual(lines(await ballotCheck(hidden)), ["ballot-view.md written"]);
    const shown = setup({ priv });
    await failsWith(shown, [
      `ballot.yaml:${yamlLine(shown, "title: Representative")} private-string title`,
    ]);
  });

  it("fails a private string in state or county, with the hint to list the full place name", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", "  - Precinct 12\n  - Exampleton\n"),
    });
    const result = await failsWith(data, [`ballot.yaml:3 private-string county`]);
    assert.match(result.stdout, /^ballot\.yaml:3 private-string county\n- list-full-place-name$/m);
  });

  it("fails a candidate name a private string names, keyed by the field", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", "  - Precinct 12\n  - John Sample\n"),
    });
    await failsWith(data, [
      `ballot.yaml:${yamlLine(data, "name: John Sample")} private-string name`,
    ]);
  });

  it("fails an address or label in a comment, unkeyed", async () => {
    const data = setup({
      ballot: `${DEFAULT_BALLOT}# from the ballot sent to addr-mom\n# at 123 Elm Street\n`,
    });
    const result = await failsWith(data, [
      `ballot.yaml:${yamlLine(data, "addr-mom")} private-label`,
      `ballot.yaml:${yamlLine(data, "Elm Street")} private-address`,
    ]);
    assert.doesNotMatch(result.stdout, /Elm|mom/);
  });

  it("leaves a comment between a contest's fields unkeyed, never keyed by the list", async () => {
    const data = setup({
      ballot: edit(
        "      - id: john-sample\n",
        "      # asked addr-mom\n      - id: john-sample\n",
      ),
    });
    const result = await failsWith(data, [
      `ballot.yaml:${yamlLine(data, "addr-mom")} private-label`,
    ]);
    assert.doesNotMatch(result.stdout, /private-label \S/);
  });

  it("fails an ignored_lines entry holding a private string or address", async () => {
    const data = setup({
      priv: `${PRIVATE}  - Precinct 12 voters only\n  - Mail to 123 Elm Street\n`,
    });
    await failsWith(data, [
      "private.yaml private-string ignored_lines",
      "private.yaml private-address ignored_lines",
    ]);
  });

  it("fails a ballot id whose number equals a private digit run", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", "  - Precinct 12\n  - Ward 01\n"),
    });
    await failsWith(data, ["private.yaml ballot-id-private"]);
  });

  it("reads a private digit run in any script against the ballot id's number", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", "  - Precinct 12\n  - Ward ١\n"),
    });
    await failsWith(data, ["private.yaml ballot-id-private"]);
  });

  it("ends another ballot's private.yaml failure with the check-each-ballot hint", async () => {
    const data = setup();
    data.write("2026-general/xx-exampleton-2/private.yaml", "private_strings: [unclosed\n");
    const result = await failsWith(data, ["- yaml-invalid"]);
    assert.match(result.stdout, /^- yaml-invalid\n- check-each-ballot\n?$/m);
    assert.equal(result.stdout.match(/check-each-ballot/g).length, 1);
  });

  it("warns, and still passes, when a private digit run reads as a year", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", "  - Precinct 2024\n"),
      body: SAMPLE_BODY.replace("Precinct 12", "Precinct 2024"),
    });
    const result = await ballotCheck(data);
    assert.deepEqual(lines(result), ["private.yaml private-year", "ballot-view.md written"]);
    assert.equal(result.status, 0);
  });

  it("fails a private entry with no letter or digit left once normalized", async () => {
    const data = setup({
      priv: PRIVATE.replace("  - Precinct 12\n", '  - Precinct 12\n  - "&amp;"\n'),
      addresses: `addr-mom:\n  address: 123 Elm Street Apt 4, Springfield, XX 99999\n  street: "&nbsp;-"\n`,
    });
    await failsWith(data, [
      "private.yaml private-empty private_strings",
      "addresses.yaml:1 private-empty street",
    ]);
  });

  it("fails a tiers.yaml match holding another ballot's private string, unnamed", async () => {
    const data = setup({
      tiers: `- match: county.example.gov\n  tier: T1\n  owner: third-party\n  source: County\n- match: lakeside-village.example.org\n  tier: T2\n  owner: third-party\n  source: Lakeside news\n`,
    });
    data.write(
      "2026-general/xx-exampleton-2/private.yaml",
      "private_strings:\n  - Lakeside Village\n",
    );
    const result = await failsWith(data, ["tiers.yaml:5 private-string match"]);
    assert.doesNotMatch(result.stdout, /exampleton-2|Lakeside/i);
  });
});
