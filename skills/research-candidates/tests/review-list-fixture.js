"use strict";

// The data repo review-list's tests run against: snapshots, an article whose
// claims each exercise one review rule, and helpers to run review-list, read
// its review file and mark items (review-list.test.js).

const assert = require("node:assert");
const crypto = require("node:crypto");
const { BALLOT, makeDataRepo, runCli } = require("./harness");
const { entryKey } = require("../scripts/lib/review-list");

const repos = [];

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
const PAMPHLET = "sources/_ballot/pamphlet.md";
const JANE_BIO = "sources/us-house-07/jane-example/bio.md";
const JANE_SITE = "sources/us-house-07/jane-example/site.md";
const JANE_MINUTES = "sources/us-house-07/jane-example/minutes.md";
const JOHN_NEWS = "sources/us-house-07/john-sample/news.md";
const JOHN_SITE = "sources/us-house-07/john-sample/site.md";

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
    body: "OFFICIAL SAMPLE BALLOT\nJane Example\nExample Party\nJohn Sample\nSample Party\nPat Example",
  }),
  [PAMPHLET]: snapshot({
    subject: "_ballot",
    url: "https://county.example.gov/pamphlet",
    tier: "T1",
    statementsOnly: true,
    extra: "role: pamphlet\n",
    body: "Jane Example will protect health care for every family.",
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
  // A PDF's text, with a word split at a line break.
  [JANE_MINUTES]: snapshot({
    subject: "jane-example",
    url: "https://county.example.gov/minutes.pdf",
    body: "The school board heard al-\nlegations of misuse of school funds that spring.",
  }),
  [JOHN_NEWS]: snapshot({
    subject: "john-sample",
    url: "https://news.example.com/john",
    body: `John Sample ran a hardware store in Exampleton for many years.
Jane Example voted against the school budget last spring.`,
  }),
  // A rival's campaign site.
  [JOHN_SITE]: snapshot({
    subject: "john-sample",
    url: "https://johnsample.com/",
    tier: "T4",
    statementsOnly: true,
    owner: "john-sample",
    body: "John Sample will build more housing in Exampleton.",
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
  verbatim: claim(
    "She served two terms on the Exampleton school board and chaired its finance committee",
    "T2",
    JANE_BIO,
    SERVED,
  ),
  fragment: claim("She served two terms on the Exampleton school board", "T2", JANE_BIO, SERVED),
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
    "Says: “Jane Example will cut property taxes for every family in Exampleton.”",
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
  // A Says: claim citing the county's pamphlet: _ballot is exempt from attribution.
  pamphlet: claim(
    "Says: Jane Example will protect health care for every family",
    "T1s",
    PAMPHLET,
    "Jane Example will protect health care for every family.",
  ),
  rival: claim(
    "Says: John Sample will build more housing in Exampleton",
    "T4s",
    JOHN_SITE,
    "John Sample will build more housing in Exampleton.",
  ),
  always: claim(
    "She served two terms on the Exampleton school board and chaired its finance committee",
    "T2",
    JANE_BIO,
    SERVED,
  ),
  johnBallot: claim("John Sample Sample Party", "T1", SAMPLE_BALLOT, "John Sample Sample Party"),
  johnStore: claim(
    "John Sample ran a hardware store in Exampleton for many years",
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
  background: [CLAIMS.verbatim, CLAIMS.fragment, CLAIMS.reworded, CLAIMS.alleged].join("\n"),
  record: CLAIMS.misfiled,
  money: CLAIMS.interprets,
  positions: {
    "Taxes and spending": CLAIMS.curly,
    "Economy and jobs": CLAIMS.attributed,
    "Health care": CLAIMS.pamphlet,
    Immigration: CLAIMS.rival,
  },
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
const FORGED = "0123456789abcdef0123456789abcdef";

// Save a snapshot as fetch-snapshot would: its manifest line, then the file.
const plant = (data, rel, text) => {
  const manifest = `${BALLOT}/snapshots.sha256`;
  data.write(manifest, `${data.read(manifest)}${sha256(text)}  ${rel}\n`);
  data.write(`${BALLOT}/${rel}`, text);
};

const setup = ({ article = ARTICLE, unfetchable = UNFETCHABLE, ballot } = {}) => {
  const data = makeDataRepo(ballot ? { ballot } : {});
  repos.push(data);
  data.write(`${BALLOT}/snapshots.sha256`, "");
  for (const [rel, text] of Object.entries(SNAPSHOTS)) plant(data, rel, text);
  data.write(
    `${BALLOT}/ballot-view.md`,
    `link: ${SAMPLE_BALLOT}\nJane Example Example Party\nJohn Sample Sample Party\nPat Example\n`,
  );
  data.write(`${BALLOT}/articles/us-house-07.md`, article);
  data.write(`${BALLOT}/search-log/us-house-07.tsv`, FULL_LOG);
  if (unfetchable !== null) data.write(`${BALLOT}/unfetchable.md`, unfetchable);
  return data;
};

const reviewList = (data, args = [BALLOT]) =>
  runCli("review-list", args, { cwd: data.root, env: data.env });

// --keys for one contest, as { line: { state, key } }.
const keysOf = async (data, contest = "us-house-07") => {
  const result = await reviewList(data, ["--keys", BALLOT, contest]);
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

const neutrality = (data, reviewed, flags = [], contest = "us-house-07") =>
  data.write(
    `${BALLOT}/review/${contest}.neutrality.md`,
    `<!-- reviewed: ${reviewed.join(" ")} -->\n${flags.map(([k, r]) => `- ${k} | ${r}\n`).join("")}`,
  );

// A neutrality pass that read every current claim of `contest`, flagging none.
const readEvery = async (data, contest = "us-house-07") =>
  neutrality(
    data,
    Object.values(await keysOf(data, contest)).map((k) => k.key),
    [],
    contest,
  );

// The review file's items, as { key: { checked, why } }, why being the
// reasons on its why line (none for an unfetchable entry).
const itemsOf = (data, contest = "us-house-07") => {
  const items = {};
  let last = null;
  for (const line of data.read(`${BALLOT}/review/${contest}.md`).split("\n")) {
    const item = /^- \[([ x])\] .* <!-- id:([0-9a-f]{32}) -->$/.exec(line);
    if (item) {
      last = item[2];
      items[last] = { checked: item[1] === "x", why: [] };
    }
    const why = /^ {2}- why: (.+) \(articles\/[^()]+\)$/.exec(line);
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

// A later neutrality pass that read every claim not accepted yet.
const readUnaccepted = async (data, flags = []) =>
  neutrality(
    data,
    Object.values(await keysOf(data))
      .filter((k) => k.state === "unaccepted")
      .map((k) => k.key),
    flags,
  );

const PAYWALLED = entryKey({
  url: "https://news.example.com/paywalled",
  where: "us-house-07/jane-example",
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

// The review file line of the item with `key`, counted from 1.
const itemLine = (data, key) =>
  data
    .read(`${BALLOT}/${R}.md`)
    .split("\n")
    .findIndex((line) => line.endsWith(` <!-- id:${key} -->`)) + 1;

// A retention article for supreme-court-retention-a: Discipline is always reviewed.
const PAT_NEWS = "sources/supreme-court-retention-a/pat-example/news.md";
const retentionArticle = (excerpt = "The state commission reprimanded Pat Example in 2019.") =>
  [
    "# supreme-court-retention-a\n",
    "## Pat Example\n",
    section("A. On the ballot", claim("Pat Example", "T1", SAMPLE_BALLOT, "Pat Example")),
    section("B. Record in office"),
    section("C. Evaluation findings"),
    section(
      "D. Discipline",
      claim("The state commission reprimanded Pat Example in 2019", "T2", PAT_NEWS, excerpt),
    ),
    section("E. Statements"),
  ].join("\n");

const addRetention = (data, article = retentionArticle()) => {
  plant(
    data,
    PAT_NEWS,
    snapshot({
      subject: "pat-example",
      url: "https://news.example.com/pat",
      body: "The state commission reprimanded Pat Example in 2019.",
    }),
  );
  data.write(`${BALLOT}/articles/supreme-court-retention-a.md`, article);
  data.write(
    `${BALLOT}/search-log/supreme-court-retention-a.tsv`,
    "supreme-court-retention-a\tpat-example\t7\t2026-10-20\n",
  );
};

module.exports = {
  ARTICLE,
  CLAIMS,
  FORGED,
  JANE_BIO,
  JANE_MINUTES,
  JOHN_NEWS,
  LINES,
  PAYWALLED,
  R,
  SNAPSHOTS,
  UNFETCHABLE,
  addRetention,
  afterFirstRun,
  claim,
  itemLine,
  itemsOf,
  keyList,
  keysOf,
  mark,
  neutrality,
  plant,
  readEvery,
  readUnaccepted,
  repos,
  retentionArticle,
  reviewList,
  section,
  setup,
  sha256,
  snapshot,
};
