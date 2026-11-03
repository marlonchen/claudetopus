"use strict";

const assert = require("node:assert");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, articlePage, runCli, startServer } = require("./harness");
const { checkedBallot, repos } = require("./publish-fixture");

// The discovery agent's fetch tool (SKILL.md Rule 7): agent-bind binds one
// contest after ballot-check passes, and discovery-fetch, given only the token
// it printed, fills in the ballot and contest, run as subprocesses against a
// temp data repo (seam 1).

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const run = (data, script, args) => runCli(script, args, { cwd: data.root, env: data.env });

// Bind `contest` and return its token.
const bind = async (data, contest) => {
  const result = await run(data, "agent-bind", [BALLOT, contest]);
  assert.strictEqual(result.status, 0, result.stdout);
  const m = result.stdout.match(new RegExp(`^${contest} bound ([0-9a-f]{32})\\n$`));
  assert.ok(m, result.stdout);
  return m[1];
};

describe("agent-bind and discovery-fetch --brief", () => {
  // Value: protects=Rule 7: the discovery agent's whole prompt is the contest id, its jurisdiction, the candidate names and ids, the tiers.yaml domains and the items its type runs, read from the bound contest, never from the main session; fails_when=the brief adds a title, party, private value or other contest, or drops a field; why_new=new; seam=cli; no_claim=what the agent does with it (five-trap eval)
  it("prints only the bound contest's ids, names, jurisdiction, items and domains", async () => {
    const data = await checkedBallot();
    const token = await bind(data, "us-house-07");
    const brief = await run(data, "discovery-fetch", [token, "--brief"]);
    assert.strictEqual(brief.status, 0, brief.stdout);
    assert.strictEqual(
      brief.stdout,
      [
        "contest: us-house-07",
        "type: candidate",
        "office_type: federal",
        "jurisdiction: XX congressional district 7",
        "items: 1 2 3 4 5",
        "candidate: jane-example Jane Example",
        "candidate: john-sample John Sample",
        "domain: county.example.gov",
        "domain: news.example.com",
        "domain: janeexample.com",
        "",
      ].join("\n"),
    );
  });

  // Value: protects=step 4.1: discovery gets the tiers.yaml domains only once ballot-check passes, which keeps private text out of jurisdiction, search_terms and tiers.yaml; fails_when=bind or the brief stops running ballot-check, or bind writes a binding first; why_new=new; seam=cli; no_claim=ballot-check's own rules (ballot-check.test.js)
  it("binds nothing, and briefs nothing, while ballot-check fails", async () => {
    const data = await checkedBallot();
    const token = await bind(data, "us-house-07");
    // A jurisdiction holding a private string fails ballot-check.
    const ballot = `${BALLOT}/ballot.yaml`;
    data.write(
      ballot,
      data.read(ballot).replace("XX congressional district 7", "XX Springfield Township"),
    );
    const bound = await run(data, "agent-bind", [BALLOT, "us-house-07"]);
    assert.strictEqual(bound.stdout, `${ballot} ballot-check-failed\n`);
    assert.strictEqual(bound.status, 1);
    assert.deepStrictEqual(data.list(".bindings"), [token]);
    const brief = await run(data, "discovery-fetch", [token, "--brief"]);
    assert.strictEqual(brief.stdout, `${ballot} ballot-check-failed\n`);
    assert.strictEqual(brief.status, 1);
  });

  // Value: protects=the binding: the main session names only a contest ballot.yaml lists, and a token the agent makes up or mistypes reaches nothing; fails_when=bind takes an unlisted contest, or fetch falls back to some binding; why_new=new; seam=cli; no_claim=a token the agent reads from elsewhere (it has no file tools)
  it("refuses an unlisted contest and an unknown or malformed token", async () => {
    const data = await checkedBallot();
    const unlisted = await run(data, "agent-bind", [BALLOT, "us-senate"]);
    assert.strictEqual(unlisted.stdout, `${BALLOT}/ballot.yaml unknown-contest\n`);
    assert.deepStrictEqual(data.list(".bindings"), []);
    const unknown = await run(data, "discovery-fetch", ["0".repeat(32), "--brief"]);
    assert.strictEqual(unknown.stdout, "- unknown-token\n");
    const malformed = await run(data, "discovery-fetch", ["../ballot.yaml", "--brief"]);
    assert.strictEqual(malformed.stdout, "- usage\n");
    assert.strictEqual(malformed.status, 1);
  });

  // Value: protects=the binding: agent-bind runs only at the project root (Rule 8), so its tokens land where session-guard looks for them; fails_when=a bind from a subdirectory writes a binding there; why_new=review found the hook and the script reading the root from different places; seam=cli; no_claim=Rule 8's other checks (repo-guard tests)
  it("binds nothing from below the project root", async () => {
    const data = await checkedBallot();
    const below = await runCli("agent-bind", [BALLOT, "us-house-07"], {
      cwd: `${data.root}/${BALLOT}`,
      env: data.env,
    });
    assert.strictEqual(below.stdout, ". guard-not-repo-root\n");
    assert.strictEqual(below.status, 1);
    assert.strictEqual(data.exists(`${BALLOT}/.bindings`), false);
    assert.deepStrictEqual(data.list(".bindings"), []);
  });

  // Value: protects=the brief of a measure and a retention contest: search_terms and _race for one, the official for the other, and each type's own items; fails_when=a type's fields or items go missing; why_new=new; seam=cli; no_claim=none
  it("briefs a measure with its search terms and a retention contest with its official", async () => {
    const data = await checkedBallot();
    const measure = await run(data, "discovery-fetch", [await bind(data, "question-1"), "--brief"]);
    assert.strictEqual(
      measure.stdout.split("\n").slice(0, 6).join("\n"),
      [
        "contest: question-1",
        "type: measure",
        "jurisdiction: XX Exampleton County",
        "search_terms: library levy",
        "items: 6",
        "subject: _race",
      ].join("\n"),
    );
    assert.ok(!measure.stdout.includes("Question 1"), "the brief holds the printed title");
    const retention = await run(data, "discovery-fetch", [
      await bind(data, "supreme-court-retention-a"),
      "--brief",
    ]);
    assert.match(retention.stdout, /^items: 7\nofficial: pat-example Pat Example\ndomain: /m);
  });
});

describe("discovery-fetch: fetch-snapshot bound to one contest", () => {
  const PAGE = articlePage("Candidates certified", [
    "The county certified two candidates for the 7th District on October 1.",
    "Ballots will be mailed to voters starting October 8.",
  ]);

  // Value: protects=Rule 7: the agent's fetch and search log land under its own contest, the only one it can name, through fetch-snapshot's own rules; fails_when=the contest or ballot comes from the agent's arguments, or the tool skips fetch-snapshot; why_new=new; seam=cli; no_claim=fetch-snapshot's own refusals (fetch-snapshot tests)
  it("saves a page and logs an item under the bound contest", async () => {
    const data = await checkedBallot();
    const token = await bind(data, "us-house-07");
    const web = await startServer({
      "https://county.example.gov/candidates": { status: 200, body: PAGE },
    });
    try {
      const saved = await runCli(
        "discovery-fetch",
        [token, "jane-example", "county-list", "https://county.example.gov/candidates"],
        {
          cwd: data.root,
          env: { ...data.env, RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target },
        },
      );
      assert.strictEqual(saved.stdout, "sources/us-house-07/jane-example/county-list.md saved\n");
    } finally {
      await web.close();
    }
    const logged = await run(data, "discovery-fetch", [token, "--searched", "jane-example", "4"]);
    assert.strictEqual(logged.stdout, "search-log/us-house-07.tsv logged\n");
    assert.match(
      data.read(`${BALLOT}/search-log/us-house-07.tsv`),
      /^us-house-07\tjane-example\t4\t/,
    );
  });

  // Value: protects=Rule 7: the agents' fetch tool rejects --ballot, --file and --keep-short, and never takes a ballot or contest argument of its own; fails_when=a researcher-only mode or an extra argument reaches fetch-snapshot; why_new=new; seam=cli; no_claim=session-guard's own refusal of these commands (session-guard tests)
  it("refuses every other mode and any ballot or contest argument", async () => {
    const data = await checkedBallot();
    const token = await bind(data, "us-house-07");
    for (const args of [
      ["--ballot", BALLOT, "sample_ballot", "https://county.example.gov/"],
      [
        "--ballot",
        "--file",
        BALLOT,
        "sample_ballot",
        "downloads/b.pdf",
        "https://county.example.gov/",
      ],
      ["--keep-short", "_race", "page", "https://county.example.gov/"],
      ["--searched", "us-house-07", "jane-example", "4"],
      [BALLOT, "us-house-07", "_race", "page", "https://county.example.gov/"],
      ["_race", "--keep-short", "https://county.example.gov/"],
      ["--brief", "x"],
      ["--searched", "--file", "x"],
      ["--searched", "jane-example", "--keep-short"],
      [],
    ]) {
      const result = await run(data, "discovery-fetch", [token, ...args]);
      assert.strictEqual(result.stdout, "- usage\n", JSON.stringify(args));
      assert.strictEqual(result.status, 1);
    }
    assert.deepStrictEqual(data.list(`${BALLOT}/sources`), ["_ballot"]);
    assert.strictEqual(data.exists(`${BALLOT}/search-log`), false);
  });
});
