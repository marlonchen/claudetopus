"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, makeDataRepo, runCli } = require("./harness");
const { claimKey, entryKey, isVerbatim, ready } = require("../scripts/lib/review-list");

// review-list (review-list.md, Command line), run as a subprocess against a
// temp data repo (seam 1), plus its key and readiness functions.

const repos = [];
afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const UNKNOWN = "Unknown, no source found";
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

const SAMPLE_BALLOT = "sources/_ballot/sample-ballot.md";
const JANE_BIO = "sources/us-house-07/jane-example/bio.md";
const JANE_SITE = "sources/us-house-07/jane-example/site.md";
const JOHN_NEWS = "sources/us-house-07/john-sample/news.md";

// A snapshot as fetch-snapshot saves it.
const snapshot = ({
  subject,
  url,
  body,
  tier = "T2",
  statementsOnly = false,
  owner = "third-party",
  extra = "",
}) => `---
source: Example News
url: ${url}
fetched: 2026-10-20
method: html
tier: ${tier}
statements_only: ${statementsOnly}
subject: ${subject}
owner: ${owner}
${extra}---
${body}
`;

const SNAPSHOTS = {
  [SAMPLE_BALLOT]: snapshot({
    subject: "_ballot",
    url: "https://county.example.gov/",
    tier: "T1",
    extra: "role: sample_ballot\n",
    body: "OFFICIAL SAMPLE BALLOT\nJane Example\nExample Party\nJohn Sample\nSample Party",
  }),
  [JANE_BIO]: snapshot({
    subject: "jane-example",
    url: "https://news.example.com/jane",
    body: `Jane Example grew up in Exampleton and taught school for twelve years.
She served two terms on the Exampleton school board and chaired its finance committee.
Jane Example said she would "cut property taxes for every family" if elected.
A former aide accused Jane Example of misusing campaign funds, which she denies.`,
  }),
  [JANE_SITE]: snapshot({
    subject: "jane-example",
    url: "https://janeexample.com/issues",
    tier: "T4",
    statementsOnly: true,
    owner: "jane-example",
    body: "Jane Example will cut property taxes for every family in Exampleton.",
  }),
  [JOHN_NEWS]: snapshot({
    subject: "john-sample",
    url: "https://news.example.com/john",
    body: `John Sample ran a hardware store in Exampleton for many years.
Jane Example voted against the school budget last spring.`,
  }),
};

const claim = (text, tag, target, excerpt) =>
  `- ${text} \`${tag}\` [s1](../${target})\n  > ${excerpt}`;

const SERVED =
  "She served two terms on the Exampleton school board and chaired its finance committee.";

// Each claim of the article, by what the first run should make of it.
const CLAIMS = {
  janeBallot: claim(
    "Jane Example Example Party",
    "T1",
    SAMPLE_BALLOT,
    "Jane Example Example Party",
  ),
  verbatim: claim("She served two terms on the Exampleton school board", "T2", JANE_BIO, SERVED),
  reworded: claim("Was a member of the school board", "T2", JANE_BIO, SERVED),
  alleged: claim(
    "A former aide accused Jane Example of misusing campaign funds",
    "T2",
    JANE_BIO,
    "A former aide accused Jane Example of misusing campaign funds, which she denies.",
  ),
  misfiled: claim(
    "Jane Example voted against the school budget last spring",
    "T2",
    JOHN_NEWS,
    "Jane Example voted against the school budget last spring.",
  ),
  interprets: claim(
    "Jane Example grew up in Exampleton",
    "T2i",
    JANE_BIO,
    "Jane Example grew up in Exampleton and taught school for twelve years.",
  ),
  curly: claim(
    "Says: “cut property taxes for every family”",
    "T4s",
    JANE_SITE,
    "Jane Example will cut property taxes for every family in Exampleton.",
  ),
  attributed: claim(
    "Says: cut property taxes for every family",
    "T2s",
    JANE_BIO,
    'Jane Example said she would "cut property taxes for every family" if elected.',
  ),
  always: claim("She served two terms on the Exampleton school board", "T2", JANE_BIO, SERVED),
  johnBallot: claim("John Sample Sample Party", "T1", SAMPLE_BALLOT, "John Sample Sample Party"),
  johnStore: claim(
    "John Sample ran a hardware store in Exampleton",
    "T2",
    JOHN_NEWS,
    "John Sample ran a hardware store in Exampleton for many years.",
  ),
};

const section = (heading, body = UNKNOWN) => `### ${heading}\n\n${body}\n`;
const block = (name, parts) =>
  [
    `## ${name}\n`,
    section("A. On the ballot", parts.onBallot),
    section("B. Background", parts.background),
    section("C. Record in public office", parts.record),
    section("D. Money", parts.money),
    "### E. Positions\n",
    ...FEDERAL_ISSUES.map((issue) => `#### ${issue}\n\n${parts.positions?.[issue] ?? UNKNOWN}\n`),
    section("F. Controversies and cases", parts.controversies),
  ].join("\n");

const ARTICLE = `# us-house-07\n\n${block("Jane Example", {
  onBallot: CLAIMS.janeBallot,
  background: [CLAIMS.verbatim, CLAIMS.reworded, CLAIMS.alleged].join("\n"),
  record: CLAIMS.misfiled,
  money: CLAIMS.interprets,
  positions: { "Taxes and spending": CLAIMS.curly, "Economy and jobs": CLAIMS.attributed },
  controversies: CLAIMS.always,
})}\n${block("John Sample", { onBallot: CLAIMS.johnBallot, background: CLAIMS.johnStore })}`;

// The 1-based line of a claim in `article` (the nth with that text).
const lineOf = (article, text, nth = 1) => {
  const first = text.split("\n")[0];
  let seen = 0;
  const index = article.split("\n").findIndex((l) => l === first && ++seen === nth);
  assert.ok(index !== -1, `no claim ${first} in the article`);
  return index + 1;
};
const LINES = Object.fromEntries(
  Object.entries(CLAIMS).map(([name, text]) => [
    name,
    lineOf(ARTICLE, text, name === "always" ? 2 : 1),
  ]),
);

const FULL_LOG = ["jane-example", "john-sample"]
  .flatMap((id) => ["1", "2", "3", "4", "5"].map((i) => `us-house-07\t${id}\t${i}\t2026-10-20\n`))
  .join("");

// Listed: a fetch that failed. Left off: a domain refusal, a URL a later
// snapshot saved, another contest's entry and a ballot-level one.
const UNFETCHABLE = `- https://news.example.com/paywalled | us-house-07/jane-example | 2026-10-20 | http 403
- https://elsewhere.example.org/jane | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- https://news.example.com/jane | us-house-07/jane-example | 2026-10-19 | network error
- https://news.example.com/other | us-house-08/someone | 2026-10-20 | http 404
- https://county.example.gov/x | _ballot | 2026-10-20 | http 500
`;

const R = "review/us-house-07";

const setup = ({ article = ARTICLE, unfetchable = UNFETCHABLE } = {}) => {
  const data = makeDataRepo();
  repos.push(data);
  let manifest = "";
  for (const [rel, text] of Object.entries(SNAPSHOTS)) {
    manifest += `${sha256(text)}  ${rel}\n`;
    data.write(`${BALLOT}/${rel}`, text);
  }
  data.write(`${BALLOT}/snapshots.sha256`, manifest);
  data.write(
    `${BALLOT}/ballot-view.md`,
    `link: ${SAMPLE_BALLOT}\nJane Example Example Party\nJohn Sample Sample Party\n`,
  );
  data.write(`${BALLOT}/articles/us-house-07.md`, article);
  data.write(`${BALLOT}/search-log/us-house-07.tsv`, FULL_LOG);
  if (unfetchable !== null) data.write(`${BALLOT}/unfetchable.md`, unfetchable);
  return data;
};

const reviewList = (data, args = [BALLOT]) =>
  runCli("review-list", args, { cwd: data.root, env: data.env });

// --keys, as { line: { state, key } }.
const keysOf = async (data) => {
  const result = await reviewList(data, ["--keys", BALLOT]);
  assert.strictEqual(result.status, 0, result.stdout);
  return Object.fromEntries(
    result.stdout
      .trim()
      .split("\n")
      .map((l) => {
        const [at, state, key] = l.split(" ");
        return [Number(at.split(":")[1]), { state, key }];
      }),
  );
};

const neutrality = (data, reviewed, flags = []) =>
  data.write(
    `${BALLOT}/${R}.neutrality.md`,
    `<!-- reviewed: ${reviewed.join(" ")} -->\n${flags.map(([k, r]) => `- ${k} | ${r}\n`).join("")}`,
  );

// The review file's items, as { key: { checked, why } }, why being the
// reasons on its why line (none for an unfetchable entry).
const itemsOf = (data) => {
  const items = {};
  let last = null;
  for (const line of data.read(`${BALLOT}/${R}.md`).split("\n")) {
    const item = /^- \[([ x])\] .* <!-- id:([0-9a-f]{16}) -->$/.exec(line);
    if (item) {
      last = item[2];
      items[last] = { checked: item[1] === "x", why: [] };
    }
    const why = /^ {2}- why: (.+) \(articles\/us-house-07\.md:\d+\)$/.exec(line);
    if (why) items[last].why = why[1].split(", ");
  }
  return items;
};

const keyList = (data) =>
  data.exists(`${BALLOT}/${R}.accepted`)
    ? data.read(`${BALLOT}/${R}.accepted`).split("\n").filter(Boolean)
    : [];

// A data repo after a first run that flagged johnStore; returns it and the keys by claim name.
const afterFirstRun = async () => {
  const data = setup();
  const byLine = await keysOf(data);
  const keys = Object.fromEntries(Object.entries(LINES).map(([n, l]) => [n, byLine[l].key]));
  neutrality(data, Object.values(keys), [[keys.johnStore, "the quote drops its context"]]);
  const result = await reviewList(data);
  assert.strictEqual(result.status, 0, result.stdout);
  return { data, keys };
};

const PAYWALLED = entryKey({
  url: "https://news.example.com/paywalled",
  where: "us-house-07/jane-example",
});

describe("review-list --keys", () => {
  it("prints each claim's location, whether it is accepted and a 64-bit key, writing nothing", async () => {
    const data = setup();
    const result = await reviewList(data, ["--keys", BALLOT]);
    assert.strictEqual(result.status, 0, result.stdout);
    const lines = result.stdout.trim().split("\n");
    assert.deepStrictEqual(
      lines.map((l) => l.split(" ")[0]),
      Object.values(LINES)
        .sort((a, b) => a - b)
        .map((n) => `articles/us-house-07.md:${n}`),
    );
    for (const l of lines) assert.match(l, / unaccepted [0-9a-f]{16}$/);
    // Same text, tag, excerpt and snapshot in two sections: two keys.
    const keys = await keysOf(data);
    assert.notStrictEqual(keys[LINES.verbatim].key, keys[LINES.always].key);
    assert.deepStrictEqual(data.list(`${BALLOT}/review`), []);
  });

  it("changes a key when the cited snapshot's file changes", async () => {
    const data = setup();
    const before = await keysOf(data);
    const edited = SNAPSHOTS[JANE_BIO].replace("source: Example News", "source: Example Times");
    data.write(`${BALLOT}/${JANE_BIO}`, edited);
    const manifest = data
      .read(`${BALLOT}/snapshots.sha256`)
      .replace(sha256(SNAPSHOTS[JANE_BIO]), sha256(edited));
    data.write(`${BALLOT}/snapshots.sha256`, manifest);
    const after = await keysOf(data);
    assert.notStrictEqual(after[LINES.verbatim].key, before[LINES.verbatim].key);
    assert.strictEqual(after[LINES.misfiled].key, before[LINES.misfiled].key);
  });
});

describe("review-list: the first run", () => {
  it("waits for a neutrality pass that read exactly the current claims", async () => {
    const data = setup();
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.neutrality.md neutrality-missing\n`);
    assert.strictEqual(result.status, 1);
    const keys = Object.values(await keysOf(data)).map((k) => k.key);
    for (const reviewed of [keys.slice(1), [...keys, "0123456789abcdef"]]) {
      neutrality(data, reviewed);
      result = await reviewList(data);
      assert.strictEqual(result.stdout, `${R}.neutrality.md:1 neutrality-stale\n`);
      assert.strictEqual(result.status, 1);
    }
    assert.deepStrictEqual(data.list(`${BALLOT}/review`), ["us-house-07.neutrality.md"]);
  });

  it("lists every mechanical item and baselines only verbatim claims nothing else lists", async () => {
    const { data, keys } = await afterFirstRun();
    // Verbatim, and verbatim once Says: and curly enclosing quotes are dropped.
    const baseline = [keys.janeBallot, keys.verbatim, keys.curly, keys.johnBallot];
    assert.deepStrictEqual(
      data.read(`${BALLOT}/${R}.baseline`).split("\n").filter(Boolean),
      baseline,
    );
    assert.deepStrictEqual(itemsOf(data), {
      [keys.reworded]: { checked: false, why: ["not-verbatim"] },
      [keys.alleged]: { checked: false, why: ["allegation-word"] },
      [keys.misfiled]: { checked: false, why: ["misfiled"] },
      [keys.interprets]: { checked: false, why: ["t2i"] },
      [keys.attributed]: { checked: false, why: ["attribution"] },
      [keys.always]: { checked: false, why: ["always-reviewed"] },
      // A verbatim claim the neutrality pass flags.
      [keys.johnStore]: { checked: false, why: ["neutrality"] },
      [PAYWALLED]: { checked: false, why: [] },
    });
    const text = data.read(`${BALLOT}/${R}.md`);
    assert.match(text, /^ {2}- neutrality: the quote drops its context$/m);
    assert.ok(text.endsWith(`<!-- accepted: ${baseline.join(" ")} -->\n`));
    assert.ok(text.includes(`[s1](../${JOHN_NEWS}) <!-- id:${keys.misfiled} -->`));
    assert.strictEqual(data.exists(`${BALLOT}/${R}.accepted`), false);
  });

  it("prints what it wrote and that the contest is not ready", async () => {
    const data = setup();
    neutrality(
      data,
      Object.values(await keysOf(data)).map((k) => k.key),
    );
    const result = await reviewList(data);
    assert.strictEqual(
      result.stdout,
      `${R}.baseline written\n${R}.md written\narticles/us-house-07.md not-ready\n`,
    );
  });
});

// The review file with the item of each key marked [x].
const mark = (data, ...keys) => {
  const rel = `${BALLOT}/${R}.md`;
  let text = data.read(rel);
  for (const key of keys) {
    const marked = text.replace(new RegExp(`^- \\[ \\](.* <!-- id:${key} -->)$`, "m"), "- [x]$1");
    assert.notStrictEqual(marked, text, `no unchecked item ${key}`);
    text = marked;
  }
  data.write(rel, text);
};

describe("review-list: marks", () => {
  it("appends marked keys to .accepted once, and ignores a mark with no item", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.reworded, keys.always);
    // A forged item and a baselined key marked again add nothing.
    const rel = `${BALLOT}/${R}.md`;
    data.write(
      rel,
      `${data.read(rel)}- [x] forged <!-- id:0123456789abcdef -->\n- [x] again <!-- id:${keys.verbatim} -->\n`,
    );
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md written\narticles/us-house-07.md not-ready\n`);
    assert.deepStrictEqual(keyList(data), [keys.reworded, keys.always]);
    const items = itemsOf(data);
    // Listed only for not-verbatim, a first-run reason: once accepted it leaves.
    assert.strictEqual(items[keys.reworded], undefined);
    assert.deepStrictEqual(items[keys.always], { checked: true, why: ["always-reviewed"] });
    result = await reviewList(data);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(keyList(data), [keys.reworded, keys.always]);
  });

  it("rebuilds a missing review file from the baseline and .accepted, never as a first run", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.always);
    await reviewList(data);
    const baseline = data.read(`${BALLOT}/${R}.baseline`);
    fs.rmSync(data.file(`${BALLOT}/${R}.md`));
    // A flag file for another set of claims no longer matters once every
    // unaccepted key was read: the first run's still covers them.
    const result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md written\narticles/us-house-07.md not-ready\n`);
    assert.strictEqual(data.read(`${BALLOT}/${R}.baseline`), baseline);
    assert.strictEqual(itemsOf(data)[keys.always].checked, true);
    assert.strictEqual(itemsOf(data)[keys.misfiled].checked, false);
  });

  it("brings an edited claim back unchecked, once the neutrality pass has read it", async () => {
    const { data, keys } = await afterFirstRun();
    const article = ARTICLE.replace(
      CLAIMS.johnStore,
      claim(
        "John Sample ran a hardware store",
        "T2",
        JOHN_NEWS,
        "John Sample ran a hardware store in Exampleton for many years.",
      ),
    );
    data.write(`${BALLOT}/articles/us-house-07.md`, article);
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.neutrality.md:1 neutrality-stale\n`);
    const now = await keysOf(data);
    const edited = now[LINES.johnStore].key;
    assert.notStrictEqual(edited, keys.johnStore);
    // A later pass reads only the claims not accepted yet, the edited one among them.
    const unaccepted = Object.values(now).filter((k) => k.state === "unaccepted");
    neutrality(
      data,
      unaccepted.map((k) => k.key).filter((k) => k !== keys.misfiled),
    );
    result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.neutrality.md:1 neutrality-stale\n`);
    neutrality(
      data,
      unaccepted.map((k) => k.key),
    );
    result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    const items = itemsOf(data);
    assert.deepStrictEqual(items[edited], { checked: false, why: ["unaccepted"] });
    assert.strictEqual(items[keys.johnStore], undefined);
  });

  it("reports the contest ready once every claim and unfetchable key is accepted", async () => {
    const { data, keys } = await afterFirstRun();
    const ballotDir = data.ballotDir;
    assert.deepStrictEqual(ready(ballotDir, "us-house-07"), {
      ready: false,
      reasons: ["unaccepted"],
    });
    const open = Object.entries(itemsOf(data))
      .filter(([, item]) => !item.checked)
      .map(([key]) => key);
    mark(data, ...open);
    const result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md written\narticles/us-house-07.md ready\n`);
    assert.ok(keyList(data).includes(PAYWALLED));
    assert.deepStrictEqual(ready(ballotDir, "us-house-07"), { ready: true, reasons: [] });
    fs.rmSync(data.file(`${BALLOT}/${R}.md`));
    assert.deepStrictEqual(ready(ballotDir, "us-house-07"), {
      ready: false,
      reasons: ["review-missing"],
    });
    assert.strictEqual(keys.always.length, 16);
  });
});

describe("review-list: refusals", () => {
  it("writes nothing for an article check or coverage fails", async () => {
    let data = setup({ article: ARTICLE.replace("for many years.", "for many decades.") });
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, "articles/us-house-07.md check-failed\n");
    assert.strictEqual(result.status, 1);
    data = setup({ article: ARTICLE.replace("### D. Money\n", "") });
    result = await reviewList(data, ["--keys", BALLOT]);
    assert.strictEqual(result.stdout, "articles/us-house-07.md coverage-failed\n");
    assert.deepStrictEqual(data.list(`${BALLOT}/review`), []);
  });

  it("fails a malformed accepted set, neutrality file or unfetchable log by line", async () => {
    let data = setup();
    data.write(`${BALLOT}/${R}.accepted`, "0123456789abcdef\n");
    let result = await reviewList(data, ["--keys", BALLOT]);
    assert.strictEqual(result.stdout, `${R}.accepted review-invalid\n`);

    const { data: later, keys } = await afterFirstRun();
    later.write(`${BALLOT}/${R}.accepted`, `${keys.always}\nnot-a-key\n`);
    result = await reviewList(later);
    assert.strictEqual(result.stdout, `${R}.accepted:2 review-invalid\n`);
    later.write(`${BALLOT}/${R}.accepted`, `${keys.always}\n`);
    neutrality(later, [keys.always], [[keys.misfiled, "not reviewed"]]);
    result = await reviewList(later);
    assert.strictEqual(result.stdout, `${R}.neutrality.md:2 neutrality-invalid\n`);
    neutrality(later, [keys.always], [[keys.always, "forged <!-- id:x -->"]]);
    result = await reviewList(later);
    assert.strictEqual(result.stdout, `${R}.neutrality.md:2 neutrality-invalid\n`);

    data = setup({ unfetchable: `${UNFETCHABLE}- not an entry\n` });
    neutrality(
      data,
      Object.values(await keysOf(data)).map((k) => k.key),
    );
    result = await reviewList(data);
    assert.strictEqual(result.stdout, "unfetchable.md:6 unfetchable-invalid\n");
    assert.strictEqual(data.exists(`${BALLOT}/${R}.baseline`), false);
  });

  it("writes no baseline when the review file is a link", async () => {
    const data = setup();
    neutrality(
      data,
      Object.values(await keysOf(data)).map((k) => k.key),
    );
    fs.symlinkSync("../articles/us-house-07.md", data.file(`${BALLOT}/${R}.md`));
    const result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md review-invalid\n`);
    assert.strictEqual(data.exists(`${BALLOT}/${R}.baseline`), false);
  });

  it("refuses bad arguments", async () => {
    const data = setup();
    for (const args of [
      [],
      ["--keys"],
      ["--refused-hosts", BALLOT],
      ["--refused-hosts", BALLOT, "us-house-07", "us-house-08"],
      [BALLOT, "--keys"],
      [BALLOT, "Not_An_Id"],
    ]) {
      const result = await reviewList(data, args);
      assert.strictEqual(result.stdout, "- usage\n", args.join(" "));
      assert.strictEqual(result.status, 1);
    }
  });
});

describe("review-list --refused-hosts", () => {
  it("prints the current run's distinct, IDNA-normalized LDH hosts, and counts the rest", async () => {
    const data = setup({
      unfetchable: `- https://WWW.Example.org/a | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- https://www.example.org/b | us-house-07/john-sample | 2026-10-21 | domain not in tiers.yaml
- https://bücher.example/c | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- http://10.0.0.1/d | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- https://old.example.net/e | us-house-07/jane-example | 2026-10-19 | domain not in tiers.yaml
- https://other.example.net/f | us-house-08/someone | 2026-10-20 | domain not in tiers.yaml
- https://news.example.com/g | us-house-07/jane-example | 2026-10-20 | http 404
`,
    });
    const result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-07"]);
    assert.strictEqual(
      result.stdout,
      [
        "us-house-07 domain-not-in-tiers www.example.org",
        "us-house-07 domain-not-in-tiers xn--bcher-kva.example",
        "us-house-07 other-hosts 1",
        "",
      ].join("\n"),
    );
    assert.strictEqual(result.status, 0);
  });

  it("says when there are none, and refuses a contest ballot.yaml does not list", async () => {
    const data = setup({ unfetchable: null });
    let result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-07"]);
    assert.strictEqual(result.stdout, "us-house-07 no-refused-hosts\n");
    // The default log's one domain refusal.
    data.write(`${BALLOT}/unfetchable.md`, UNFETCHABLE);
    result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-07"]);
    assert.strictEqual(result.stdout, "us-house-07 domain-not-in-tiers elsewhere.example.org\n");
    result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-08"]);
    assert.strictEqual(result.stdout, "articles/us-house-08.md unknown-contest\n");
    assert.strictEqual(result.status, 1);
  });
});

describe("review-list: keys and verbatim claims", () => {
  const fields = {
    subject: "jane-example",
    section: "B. Background",
    issue: undefined,
    text: "Served two terms",
    tag: "T2",
    excerpt: "She served two terms on the board",
    snapshot: JANE_BIO,
    fileHash: "a".repeat(64),
  };
  it("changes the key when any one field changes", () => {
    const key = claimKey(fields);
    assert.match(key, /^[0-9a-f]{16}$/);
    for (const [name, value] of Object.entries({
      subject: "john-sample",
      section: "F. Controversies and cases",
      issue: "Health care",
      text: "Served two terms.",
      tag: "T2i",
      excerpt: "She served two terms on the board.",
      snapshot: JOHN_NEWS,
      fileHash: "b".repeat(64),
    })) {
      assert.notStrictEqual(claimKey({ ...fields, [name]: value }), key, name);
    }
    // Fields never run together: moving text between two fields changes the key.
    assert.notStrictEqual(
      claimKey({ ...fields, text: "Served two", tag: "termsT2" }),
      claimKey({ ...fields, text: "Served two terms", tag: "T2" }),
    );
    assert.notStrictEqual(entryKey({ url: "u", where: "w" }), entryKey({ url: "w", where: "u" }));
  });

  it("finds the claim whole in its excerpt, without Says: and one pair of quotes", () => {
    assert.strictEqual(isVerbatim("served two terms", "She served two terms."), true);
    assert.strictEqual(isVerbatim("Says: “lower taxes”", "We will lower taxes now"), true);
    assert.strictEqual(isVerbatim("Says: 'lower taxes'", "We will lower taxes now"), true);
    assert.strictEqual(isVerbatim("served two term", "She served two terms."), false);
    assert.strictEqual(isVerbatim("Served two terms", "She served two terms."), false);
    assert.strictEqual(isVerbatim('Says: ""', "anything at all here"), false);
  });
});
