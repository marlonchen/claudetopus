"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { after, afterEach, before, describe, it } = require("node:test");
const { load } = require("../scripts/lib/deps");
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
const CLOCK = path.join(__dirname, "fixed-clock.js");
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
// The county's notices ballot-check needs for the write-in and the withdrawal.
const WRITE_INS = ["https://county.example.gov/write-ins", "write-ins.html"];
const WITHDRAWALS = ["https://county.example.gov/withdrawals", "withdrawals.html"];
// The discovery checklist items run (source-tiers.md: 1-5 for a candidate,
// 6 for a measure, 7 for a retention official), by contest and subject.
const CANDIDATE_ITEMS = ["1", "2", "3", "4", "5"];
const SEARCHED = {
  "us-house-07": { "jane-example": CANDIDATE_ITEMS, "john-sample": CANDIDATE_ITEMS },
  "school-director": {
    "ann-able": CANDIDATE_ITEMS,
    "cy-cole": CANDIDATE_ITEMS,
    "di-dunn": CANDIDATE_ITEMS,
  },
  "supreme-court-retention-a": { "pat-example": ["7"] },
  "question-1": { _race: ["6"] },
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
  const clock = JSON.stringify(CLOCK);
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
  const reviewed = lines(keys).map((line) => ` ${line.split(" ")[2]}`);
  data.write(
    `${BALLOT}/review/${contest}.neutrality.md`,
    `<!-- reviewed:${reviewed.join("")} -->\n`,
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
// the sample ballot, the write-in list and the withdrawal notice, check the ballot, save every
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
  const withdrawals = await tty(["--ballot", BALLOT, "withdrawal_notice", WITHDRAWALS[0]]);
  assert.strictEqual(withdrawals.status, 0, withdrawals.stdout);
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
    [...SOURCES.map((s) => s.slice(3)), WRITE_INS, WITHDRAWALS].map(([url, file]) => [
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

// Where `page` first differs from `golden`, as a line and column and the
// bytes around it in each.
const firstDifference = (page, golden) => {
  let at = 0;
  while (at < page.length && page[at] === golden[at]) at++;
  const lines = page.subarray(0, at).toString("utf8").split("\n");
  const around = (buf) => JSON.stringify(buf.subarray(Math.max(0, at - 40), at + 40).toString());
  return `line ${lines.length}, column ${lines.at(-1).length + 1}: golden ${around(golden)}, page ${around(page)}`;
};

describe("fixture ballot: all six commands", () => {
  it("publishes the golden page, byte for byte", async () => {
    const data = copy();
    const result = await run(data, "publish", [BALLOT]);
    passes(result);
    assert.deepStrictEqual(lines(result), [...PUBLISHED, "site/index.html written"]);
    const page = fs.readFileSync(data.file(SITE));
    if (process.env.UPDATE_GOLDEN) {
      assert.ok(!process.env.CI, "UPDATE_GOLDEN rewrites the golden page, so CI never sets it");
      fs.writeFileSync(GOLDEN, page);
    }
    const golden = fs.readFileSync(GOLDEN);
    if (!page.equals(golden)) {
      const actual = path.join(os.tmpdir(), "rc-fixture-index.html");
      fs.writeFileSync(actual, page);
      assert.fail(
        `site/index.html differs from golden/index.html at ${firstDifference(page, golden)}; the page is at ${actual}`,
      );
    }
  });
});

// A fictional API key, as OPENFEC_API_KEY holds one (snapshot-format.md, Cleaning the URL).
const KEY = "Fx7kQ2mZpL9vR4tW";
// Each planted leak: its name, the text planted, the codes the page scan
// refuses it with (SKILL.md step 6.3), and what a claim holding it gets.
// publish drops the contest of a claim that passes check (private-match),
// but check fails one first with a figure its excerpt lacks
// (figure-missing), the printed title (title-in-claim) or an attribute
// (claim-format). The printed title holds a private string too.
const LEAKS = [
  ["ballot id", "xx-exampleton-1", ["private-ballot-id"], "private-match"],
  ["ballot id with underscores", "xx_exampleton_1", ["private-ballot-id"], "private-match"],
  ["ballot id with slashes", "xx/exampleton/1", ["private-ballot-id"], "private-match"],
  ["private string", "Springfield Township", ["private-string"], "private-match"],
  [
    "private string hidden by a soft hyphen",
    "Spring­field Township",
    ["private-string"],
    "private-match",
  ],
  [
    "private string hidden by a ligature",
    "Springﬁeld Township",
    ["private-string"],
    "private-match",
  ],
  ["ZIP", "99999", ["private-zip"], "figure-missing"],
  ["address label", "addr-mom", ["private-label"], "private-match"],
  [
    "printed title",
    "Question 1: Springfield Township Library Levy",
    ["private-string", "private-title"],
    "title-in-claim",
  ],
  ["key value", KEY, ["private-key"], "figure-missing"],
  ["script", "<script", ["page-script"], "private-match"],
  ["external src", '<img src="https://tracker.example.net/p.png">', ["page-link"], "claim-format"],
];

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

// The measure's claim a leak is planted in: its excerpt holds the figure 1,
// as "Question 1" or "District 1" often does, so a ballot id passes check.
const MEASURE = `${BALLOT}/articles/question-1.md`;
const CLAIM = "- Question 1 would fund the county library system with a levy of 0.5 mills.";
const plantInClaim = (data, leak) => {
  data.write(MEASURE, data.read(MEASURE).replace(CLAIM, `${CLAIM.slice(0, -1)} near ${leak}.`));
  return (
    data
      .read(MEASURE)
      .split("\n")
      .findIndex((l) => l.startsWith(CLAIM.slice(0, -1))) + 1
  );
};

describe("fixture ballot: a leak in a claim drops its contest", () => {
  for (const [name, leak] of LEAKS.filter(([, , , outcome]) => outcome === "private-match")) {
    it(`drops the measure for the ${name}, as private-match`, async () => {
      const data = copy();
      const at = plantInClaim(data, leak);
      await review(data, "question-1");
      commit(data, "reword");
      const keys = await run(data, "review-list", ["--keys", BALLOT, "question-1"]);
      const key = lines(keys)
        .find((l) => l.startsWith(`articles/question-1.md:${at} `))
        ?.split(" ")[2];
      assert.ok(key, keys.stdout);
      const result = await run(data, "publish", [BALLOT]);
      passes(result);
      assert.deepStrictEqual(lines(result), [
        `articles/question-1.md:${at} private-match ${key}`,
        ...PUBLISHED.slice(0, -1),
        "articles/question-1.md not-ready private-match",
        "site/index.html written",
      ]);
      const html = data.read(SITE);
      assert.ok(!html.includes("would fund the county library system"));
      // The drop reaches the ballot list too: the row and the ready count.
      const { document } = load("linkedom").parseHTML(html);
      const status = document.querySelector('#ballot a[href="#question-1"] .st');
      assert.match(status.textContent, /^Not ready yet/);
      assert.strictEqual(
        document.querySelector("#ballot .banner").textContent,
        "6 contests on your ballot · 3 ready to read",
      );
    });
  }
});

describe("fixture ballot: check fails a claim holding the other leaks", () => {
  for (const [name, leak, , code] of LEAKS.filter(
    ([, , , outcome]) => outcome !== "private-match",
  )) {
    it(`fails the claim holding the ${name} as ${code}`, async () => {
      const data = copy();
      const at = plantInClaim(data, leak);
      const result = await run(data, "check", [BALLOT]);
      assert.strictEqual(result.status, 1, result.stdout);
      assert.deepStrictEqual(
        lines(result).filter((l) => l.startsWith("articles/question-1.md")),
        [`articles/question-1.md:${at} ${code}`],
      );
    });
  }
});

describe("fixture ballot: the fixed clock", () => {
  it("fixes new Date() and a bare Date(), but not Date.now(), which a refreshed lock keeps", () => {
    const store = JSON.stringify(path.join(__dirname, "..", "scripts", "lib", "snapshot-store"));
    const script = `
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const { withLock } = require(${store});
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-clock-"));
      const lag = withLock(dir, (refresh) => {
        refresh();
        return Math.abs(Date.now() - fs.statSync(path.join(dir, ".lock", "held")).mtimeMs);
      });
      fs.rmSync(dir, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({
        now: new Date().toISOString(),
        bare: Date() === new Date(Date.parse(process.env.RESEARCH_CANDIDATES_TEST_NOW)).toString(),
        given: new Date(0).toISOString(),
        isDate: new Date() instanceof Date,
        real: Date.now(),
        lag,
      }));`;
    const result = spawnSync(process.execPath, ["--require", CLOCK, "-e", script], {
      env: { ...process.env, RESEARCH_CANDIDATES_TEST_NOW: NOW, TZ: "UTC" },
      encoding: "utf8",
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout);
    assert.strictEqual(seen.now, new Date(NOW).toISOString());
    assert.strictEqual(seen.bare, true);
    assert.strictEqual(seen.given, "1970-01-01T00:00:00.000Z");
    assert.strictEqual(seen.isDate, true);
    assert.ok(Math.abs(seen.real - Date.now()) < 60 * 1000, "Date.now() is not the real clock");
    assert.ok(seen.lag < 60 * 1000, `a refreshed lock is ${seen.lag} ms off Date.now()`);
  });
});
