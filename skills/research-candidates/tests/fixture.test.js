"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, afterEach, before, describe, it } = require("node:test");
const {
  BALLOT,
  PDFTOTEXT_STUB,
  git,
  makeDataRepo,
  runCli,
  runInTty,
  startServer,
} = require("./harness");

// The fixture ballot (spec, Testing Decisions, D14): one ballot under
// fixtures/ballot-x/ run through all six commands as the workflow runs them
// (SKILL.md steps 2-6.3), ending in a page compared byte for byte with
// golden/index.html. Then each planted leak, in a copy of the finished data
// repo, must make publish drop the contest holding it or refuse the page.
//
// After a deliberate change to the page, rewrite the golden page with
// UPDATE_GOLDEN=1 mise run test, and review its diff like any other.

const FIXTURE = path.join(__dirname, "fixtures", "ballot-x");
const GOLDEN = path.join(FIXTURE, "golden", "index.html");
const SITE = `${BALLOT}/site/index.html`;
// The day the fixture is researched and published, in every run.
const NOW = "2026-10-20T12:00:00Z";

// Each page discovery saved, one per line of web/fetches.tsv: contest,
// subject, name, URL, and the file under web/ the URL serves.
const SOURCES = fs
  .readFileSync(path.join(FIXTURE, "web", "fetches.tsv"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t"));
const WRITE_INS = ["https://county.example.gov/write-ins", "write-ins.html"];
// The checklist items discovery ran (source-tiers.md), by contest and subject.
const SEARCHED = {
  "us-house-07": { "jane-example": "12345", "john-sample": "12345" },
  "school-director": { "ann-able": "12345", "cy-cole": "12345", "di-dunn": "12345" },
  "supreme-court-retention-a": { "pat-example": "7" },
  "question-1": { _race: "6" },
};
const ARTICLES = [
  "us-house-07",
  "county-controller",
  "school-director",
  "supreme-court-retention-a",
  "question-1",
];

const copyTree = (from, to) => fs.cpSync(from, to, { recursive: true });

const commit = (data, message) => {
  git(data.root, "add", "-A");
  git(data.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message);
};

// A fresh data repo holding the fixture's data/ and downloads/, with the
// pdftotext stub on PATH and every command on the fixed clock.
const fixtureRepo = () => {
  const data = makeDataRepo({ ballot: false, tiers: false, addresses: false, publish: false });
  copyTree(path.join(FIXTURE, "data"), data.root);
  copyTree(path.join(FIXTURE, "downloads"), data.file("downloads"));
  fs.writeFileSync(path.join(data.bin, "pdftotext"), PDFTOTEXT_STUB, { mode: 0o755 });
  const clock = JSON.stringify(path.join(__dirname, "fixed-clock.js"));
  Object.assign(data.env, {
    PDFTOTEXT_LOG: path.join(data.bin, "pdftotext.log"),
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require ${clock}`.trim(),
    RESEARCH_CANDIDATES_TEST_NOW: NOW,
    TZ: "UTC",
  });
  return data;
};

const run = (data, script, args, env = {}) =>
  runCli(script, args, { cwd: data.root, env: { ...data.env, ...env } });
const lines = (result) => result.stdout.split("\n").filter(Boolean);
const passes = (result) => assert.strictEqual(result.status, 0, result.stdout + result.stderr);

// Review `contest` as the researcher does (SKILL.md steps 4.5-5): keys, a
// neutrality pass that flags nothing, the first run, every item marked, and
// the run that counts the marks.
const review = async (data, contest) => {
  const keys = await run(data, "review-list", ["--keys", BALLOT, contest]);
  passes(keys);
  const reviewed = lines(keys).map((line) => line.split(" ")[2]);
  data.write(
    `${BALLOT}/review/${contest}.neutrality.md`,
    `<!-- reviewed: ${reviewed.join(" ")} -->\n`,
  );
  passes(await run(data, "review-list", [BALLOT, contest]));
  const file = `${BALLOT}/review/${contest}.md`;
  data.write(file, data.read(file).replaceAll("- [ ] ", "- [x] "));
  const marked = await run(data, "review-list", [BALLOT, contest]);
  passes(marked);
  assert.deepStrictEqual(lines(marked), [
    `review/${contest}.md written`,
    `articles/${contest}.md ready`,
  ]);
};

// SKILL.md steps 2-5 on the fixture, through the local web server: import
// the sample ballot and the write-in list, check the ballot, save every
// source and log every search, then check, cover and review each article
// and commit. Returns the data repo, ready to publish.
const research = async (web) => {
  const data = fixtureRepo();
  data.env.RESEARCH_CANDIDATES_TEST_HTTP_TARGET = web.target;
  const tty = (args) => runInTty("fetch-snapshot", args, { cwd: data.root, env: data.env });

  const sample = await tty([
    "--ballot",
    "--file",
    BALLOT,
    "sample_ballot",
    "downloads/sample-ballot.pdf",
    "https://county.example.gov/ballots/",
  ]);
  assert.strictEqual(sample.status, 0, sample.stdout);
  const writeIns = await tty(["--ballot", BALLOT, "write_in_list", WRITE_INS[0]]);
  assert.strictEqual(writeIns.status, 0, writeIns.stdout);
  const checked = await run(data, "ballot-check", [BALLOT]);
  passes(checked);
  assert.deepStrictEqual(lines(checked), ["ballot-view.md written"]);

  for (const [contest, subject, name, url] of SOURCES) {
    const saved = await run(data, "fetch-snapshot", [BALLOT, contest, subject, name, url]);
    passes(saved);
    assert.deepStrictEqual(lines(saved), [`sources/${contest}/${subject}/${name}.md saved`]);
  }
  for (const [contest, subjects] of Object.entries(SEARCHED)) {
    for (const [subject, items] of Object.entries(subjects)) {
      for (const item of items) {
        passes(await run(data, "fetch-snapshot", ["--searched", BALLOT, contest, subject, item]));
      }
    }
  }

  copyTree(path.join(FIXTURE, "articles"), data.file(`${BALLOT}/articles`));
  const checkedArticles = await run(data, "check", [BALLOT]);
  passes(checkedArticles);
  assert.deepStrictEqual(lines(checkedArticles), [
    "snapshots.sha256 checked",
    ...[...ARTICLES].sort().map((id) => `articles/${id}.md checked`),
  ]);
  const covered = await run(data, "coverage", [BALLOT]);
  passes(covered);
  assert.deepStrictEqual(
    lines(covered),
    [...ARTICLES].sort().map((id) => `articles/${id}.md passed`),
  );
  for (const contest of ARTICLES) await review(data, contest);
  commit(data, "research");
  return data;
};

let web;
let researched;
before(async () => {
  const routes = Object.fromEntries(
    [...SOURCES.map((s) => s.slice(3)), WRITE_INS].map(([url, file]) => [
      url,
      { body: fs.readFileSync(path.join(FIXTURE, "web", file), "utf8") },
    ]),
  );
  web = await startServer(routes);
  researched = await research(web);
});
after(async () => {
  researched?.cleanup();
  await web?.close();
});

// A copy of the researched data repo, git history and all, for one test to
// change; it shares the original's stubs and a copy of its environment.
const copies = [];
afterEach(() => {
  while (copies.length) fs.rmSync(copies.pop(), { recursive: true, force: true });
});
const copy = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fixture-"));
  copies.push(root);
  fs.cpSync(researched.root, root, { recursive: true });
  return {
    root,
    file: (rel) => path.join(root, rel),
    read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    write: (rel, text) => fs.writeFileSync(path.join(root, rel), text),
    env: { ...researched.env },
  };
};

// publish's lines for the fixture as researched, in ballot order.
const PUBLISHED = [
  "articles/us-house-07.md ready",
  "articles/county-controller.md ready",
  "articles/county-sheriff.md not-ready file-missing",
  "articles/school-director.md ready",
  "articles/supreme-court-retention-a.md ready",
  "articles/question-1.md ready",
];

describe("fixture ballot: all six commands", () => {
  it("publishes the golden page, byte for byte", async () => {
    const data = copy();
    const result = await run(data, "publish", [BALLOT]);
    passes(result);
    assert.deepStrictEqual(lines(result), [...PUBLISHED, "site/index.html written"]);
    const page = fs.readFileSync(data.file(SITE));
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(GOLDEN, page);
    assert.ok(
      page.equals(fs.readFileSync(GOLDEN)),
      "site/index.html differs from golden/index.html",
    );
  });
});

// A fictional API key, as OPENFEC_API_KEY holds one (snapshot-format.md, Cleaning the URL).
const KEY = "Fx7kQ2mZpL9vR4tW";
// Each planted leak: its name, the text planted, and the codes the page
// scan refuses it with (SKILL.md step 6.3). The printed title holds a
// private string too.
const LEAKS = [
  ["ballot id", "xx-exampleton-1", ["private-ballot-id"]],
  ["ballot id with underscores", "xx_exampleton_1", ["private-ballot-id"]],
  ["ballot id with slashes", "xx/exampleton/1", ["private-ballot-id"]],
  ["private string", "Springfield Township", ["private-string"]],
  ["private string hidden by a soft hyphen", "Spring\u00adfield Township", ["private-string"]],
  ["private string hidden by a ligature", "Spring\ufb01eld Township", ["private-string"]],
  ["ZIP", "99999", ["private-zip"]],
  ["address label", "addr-mom", ["private-label"]],
  [
    "printed title",
    "Question 1: Springfield Township Library Levy",
    ["private-string", "private-title"],
  ],
  ["key value", KEY, ["private-key"]],
  ["script", "<script", ["page-script"]],
  ["external src", '<img src="https://tracker.example.net/p.png">', ["page-link"]],
];
// The leaks a claim can hold and still pass check, which fails a claim
// with a figure its excerpt lacks (figure-missing) or an attribute
// (claim-format) before publish ever reads it.
const CLAIM_LEAKS = LEAKS.filter(([, leak]) => !/[0-9]|src=/.test(leak));

// The golden page's line holding the trust header, where display_name shows.
const TRUST_LINE =
  fs
    .readFileSync(GOLDEN, "utf8")
    .split("\n")
    .findIndex((l) => l.includes('<div class="meta">Made by ')) + 1;

describe("fixture ballot: a leak on the page refuses all of it", () => {
  for (const [name, leak, codes] of LEAKS) {
    it(`refuses the ${name} as ${codes.join(" and ")}, and writes no page`, async () => {
      const data = copy();
      data.write("publish.yaml", `branch: main\ndisplay_name: ${JSON.stringify(`Sam ${leak}`)}\n`);
      const result = await run(data, "publish", [BALLOT], { OPENFEC_API_KEY: KEY });
      assert.deepStrictEqual(lines(result), [
        ...PUBLISHED,
        ...codes.map((code) => `site/index.html:${TRUST_LINE} ${code}`),
      ]);
      assert.strictEqual(result.status, 1);
      assert.ok(!data.exists(SITE));
    });
  }
});

describe("fixture ballot: a leak in a claim drops its contest", () => {
  const ARTICLE = `${BALLOT}/articles/us-house-07.md`;
  const CLAIM = "- She served two terms on the Exampleton school board.";
  for (const [name, leak] of CLAIM_LEAKS) {
    it(`drops the House race for the ${name}, as private-match`, async () => {
      const data = copy();
      data.write(ARTICLE, data.read(ARTICLE).replace(CLAIM, `${CLAIM.slice(0, -1)} near ${leak}.`));
      const at =
        data
          .read(ARTICLE)
          .split("\n")
          .findIndex((l) => l.startsWith(CLAIM.slice(0, -1))) + 1;
      await review(data, "us-house-07");
      commit(data, "reword");
      const keys = await run(data, "review-list", ["--keys", BALLOT, "us-house-07"]);
      const key = lines(keys)
        .find((l) => l.startsWith(`articles/us-house-07.md:${at} `))
        .split(" ")[2];
      const result = await run(data, "publish", [BALLOT]);
      passes(result);
      assert.deepStrictEqual(lines(result), [
        `articles/us-house-07.md:${at} private-match ${key}`,
        "articles/us-house-07.md not-ready private-match",
        ...PUBLISHED.slice(1),
        "site/index.html written",
      ]);
      const page = data.read(SITE);
      assert.ok(!page.includes("She served two terms"));
      assert.ok(!page.includes("Jane Example taught school"));
    });
  }
});
