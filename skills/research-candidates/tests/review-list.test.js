"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT } = require("./harness");
const {
  claimKey,
  entryKey,
  hasAllegation,
  isVerbatim,
  ready,
} = require("../scripts/lib/review-list");
const {
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
} = require("./review-list-fixture");

// review-list (review-list.md, Command line), run as a subprocess against a
// temp data repo (seam 1, review-list-fixture.js), plus its key, word and
// readiness functions.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

// ready() for each contest, as { ready, reasons }: the article and snapshot
// reader it also returns are publish's to render.
const readyOf = (ballotDir, contests) =>
  new Map(
    [...ready(ballotDir, contests)].map(([id, a]) => [id, { ready: a.ready, reasons: a.reasons }]),
  );
// ready() for one contest.
const readyOne = (ballotDir, contest = "us-house-07") => readyOf(ballotDir, [contest]).get(contest);

describe("review-list --keys", () => {
  it("prints each claim's location, whether it is accepted and a 128-bit key, writing nothing", async () => {
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
    for (const l of lines) assert.match(l, / unaccepted [0-9a-f]{32}$/);
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

  it("keeps a key when the claim only gains a character normalizing drops", async () => {
    const data = setup();
    const before = await keysOf(data);
    const hidden = ARTICLE.replace("Was a member of", "Was a mem\u200bber of");
    data.write(`${BALLOT}/articles/us-house-07.md`, hidden);
    const after = await keysOf(data);
    assert.strictEqual(after[LINES.reworded].key, before[LINES.reworded].key);
  });
});

describe("review-list: the first run", () => {
  it("waits for a neutrality pass that read exactly the current claims", async () => {
    const data = setup();
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.neutrality.md neutrality-missing\n`);
    assert.strictEqual(result.status, 1);
    const keys = Object.values(await keysOf(data)).map((k) => k.key);
    for (const reviewed of [keys.slice(1), [...keys, FORGED]]) {
      neutrality(data, reviewed);
      result = await reviewList(data);
      assert.strictEqual(result.stdout, `${R}.neutrality.md:1 neutrality-stale\n`);
      assert.strictEqual(result.status, 1);
    }
    assert.deepStrictEqual(data.list(`${BALLOT}/review`), ["us-house-07.neutrality.md"]);
  });

  it("lists every mechanical item and baselines only whole-sentence claims nothing else lists", async () => {
    const { data, keys } = await afterFirstRun();
    // A whole sample-ballot span, and whole sentences once Says: and curly
    // enclosing quotes are dropped. The pamphlet's Says: claim is _ballot's,
    // so its third-party owner is no attribution.
    const baseline = [keys.janeBallot, keys.verbatim, keys.curly, keys.pamphlet, keys.johnBallot];
    assert.deepStrictEqual(
      data.read(`${BALLOT}/${R}.baseline`).split("\n").filter(Boolean),
      baseline,
    );
    assert.deepStrictEqual(itemsOf(data), {
      // Found whole in its excerpt, but not a whole sentence of it.
      [keys.fragment]: { checked: false, why: ["not-verbatim"] },
      [keys.reworded]: { checked: false, why: ["not-verbatim"] },
      [keys.alleged]: { checked: false, why: ["allegation-word", "not-verbatim"] },
      [keys.misfiled]: { checked: false, why: ["misfiled"] },
      [keys.interprets]: { checked: false, why: ["t2i", "not-verbatim"] },
      [keys.attributed]: { checked: false, why: ["attribution", "not-verbatim"] },
      // A rival's own campaign site, filed under the rival.
      [keys.rival]: { checked: false, why: ["attribution", "misfiled"] },
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
    await readEvery(data);
    const result = await reviewList(data);
    assert.strictEqual(
      result.stdout,
      `${R}.baseline written\n${R}.md written\narticles/us-house-07.md not-ready\n`,
    );
  });

  it("refuses a review file a reset left behind, marks and all, writing nothing", async () => {
    const data = setup();
    const keys = await keysOf(data);
    await readEvery(data);
    data.write(`${BALLOT}/${R}.md`, `- [x] Was a member <!-- id:${keys[LINES.reworded].key} -->\n`);
    const result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md review-invalid\n`);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(data.exists(`${BALLOT}/${R}.baseline`), false);
    assert.strictEqual(data.exists(`${BALLOT}/${R}.accepted`), false);
  });
});

describe("review-list: marks", () => {
  it("appends marked keys to .accepted once, and ignores a mark with no item", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.reworded, keys.always);
    // A forged item and a baselined key marked again add nothing.
    const rel = `${BALLOT}/${R}.md`;
    data.write(
      rel,
      `${data.read(rel)}- [x] forged <!-- id:${FORGED} -->\n- [x] again <!-- id:${keys.verbatim} -->\n`,
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

  it("counts marks on CRLF lines and lines with trailing spaces", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.always, keys.misfiled);
    const rel = `${BALLOT}/${R}.md`;
    const lines = data.read(rel).split("\n");
    data.write(
      rel,
      lines
        .map((l) => (l.includes(keys.misfiled) ? `${l}  ` : l))
        .join("\r\n")
        .replace(/\r\n$/, "\n"),
    );
    const result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.deepStrictEqual(keyList(data), [keys.misfiled, keys.always]);
  });

  it("keeps an item open when a neutrality flag came after the researcher marked it", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.misfiled);
    const at = itemLine(data, keys.misfiled);
    // The pass runs again before review-list and now flags the marked item.
    await readUnaccepted(data, [[keys.misfiled, "a vote described as a stance"]]);
    let result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    // Said, so the researcher knows the mark was dropped.
    assert.strictEqual(
      result.stdout,
      `${R}.md:${at} mark-not-counted ${keys.misfiled}\n${R}.md written\narticles/us-house-07.md not-ready\n`,
    );
    assert.deepStrictEqual(keyList(data), []);
    assert.deepStrictEqual(itemsOf(data)[keys.misfiled], {
      checked: false,
      why: ["misfiled", "neutrality"],
    });
    assert.match(data.read(`${BALLOT}/${R}.md`), /^ {2}- neutrality: a vote described/m);
    // Marked again, with the flag in view, it counts.
    mark(data, keys.misfiled);
    result = await reviewList(data);
    assert.deepStrictEqual(keyList(data), [keys.misfiled]);
  });

  it("does not count a mark whose item did not show every reason the key has now", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.alleged);
    const rel = `${BALLOT}/${R}.md`;
    // As if the item had been written before allegation words caught it.
    data.write(
      rel,
      data.read(rel).replace(/- why: allegation-word, not-verbatim \(/, "- why: not-verbatim ("),
    );
    const at = itemLine(data, keys.alleged);
    const result = await reviewList(data);
    assert.match(
      result.stdout,
      new RegExp(`^${R}\\.md:${at} mark-not-counted ${keys.alleged}$`, "m"),
    );
    assert.deepStrictEqual(keyList(data), []);
    assert.deepStrictEqual(itemsOf(data)[keys.alleged], {
      checked: false,
      why: ["allegation-word"],
    });
  });

  it("ignores a torn last line of .accepted and drops it before the next append", async () => {
    const { data, keys } = await afterFirstRun();
    mark(data, keys.always);
    await reviewList(data);
    const rel = `${BALLOT}/${R}.accepted`;
    data.write(rel, `${data.read(rel)}0123456789ab`);
    let result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.strictEqual(itemsOf(data)[keys.always].checked, true);
    mark(data, keys.misfiled);
    result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.strictEqual(data.read(rel), `${keys.always}\n${keys.misfiled}\n`);
  });

  it("removes a temporary baseline a crash left in review/", async () => {
    const data = setup();
    const leftover = `${BALLOT}/${R}.baseline.tmp-0011223344556677`;
    data.write(leftover, "9f2c41ab");
    neutrality(
      data,
      Object.values(await keysOf(data)).map((k) => k.key),
    );
    const result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.ok(!data.exists(leftover));
    assert.ok(data.exists(`${BALLOT}/${R}.baseline`));
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
    await readUnaccepted(data);
    result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    const items = itemsOf(data);
    assert.deepStrictEqual(items[edited], { checked: false, why: ["unaccepted"] });
    assert.strictEqual(items[keys.johnStore], undefined);
  });

  it("reports the contest ready once every claim and unfetchable key is accepted", async () => {
    const { data, keys } = await afterFirstRun();
    const ballotDir = data.ballotDir;
    assert.deepStrictEqual(readyOne(ballotDir), {
      ready: false,
      reasons: ["unaccepted"],
    });
    const open = Object.entries(itemsOf(data))
      .filter(([, item]) => !item.checked)
      .map(([key]) => key);
    mark(data, ...open);
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md written\narticles/us-house-07.md ready\n`);
    assert.ok(keyList(data).includes(PAYWALLED));
    assert.deepStrictEqual(readyOne(ballotDir), { ready: true, reasons: [] });
    // With every key accepted, the neutrality file is no longer needed.
    fs.rmSync(data.file(`${BALLOT}/${R}.neutrality.md`));
    result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md written\narticles/us-house-07.md ready\n`);
    fs.rmSync(data.file(`${BALLOT}/${R}.md`));
    assert.deepStrictEqual(readyOne(ballotDir), {
      ready: false,
      reasons: ["review-missing"],
    });
    assert.strictEqual(keys.always.length, 32);
  });
});

describe("review-list: what an item shows", () => {
  it("lists a claim given twice as one item with both locations", async () => {
    const article = ARTICLE.replace(CLAIMS.alleged, `${CLAIMS.alleged}\n${CLAIMS.alleged}`);
    const data = setup({ article });
    await readEvery(data);
    await reviewList(data);
    const at = LINES.alleged;
    assert.match(
      data.read(`${BALLOT}/${R}.md`),
      new RegExp(
        `^ {2}- why: allegation-word, not-verbatim \\(articles/us-house-07\\.md:${at}, articles/us-house-07\\.md:${at + 2}\\)$`,
        "m",
      ),
    );
  });

  it("escapes < in claim text and excerpts", async () => {
    const data = setup();
    const rel = "sources/us-house-07/john-sample/sales.md";
    plant(
      data,
      rel,
      snapshot({
        subject: "john-sample",
        url: "https://news.example.com/sales",
        body: "Store sales grew <10% in 2019, the paper reported.",
      }),
    );
    const article = ARTICLE.replace(
      CLAIMS.johnStore,
      `${CLAIMS.johnStore}\n${claim("Store sales grew <10% in 2019", "T2", rel, "Store sales grew <10% in 2019, the paper reported.")}`,
    );
    data.write(`${BALLOT}/articles/us-house-07.md`, article);
    await readEvery(data);
    const result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    const text = data.read(`${BALLOT}/${R}.md`);
    assert.ok(text.includes("- [ ] Store sales grew &lt;10% in 2019 `T2`"));
    assert.ok(text.includes("  > Store sales grew &lt;10% in 2019, the paper reported."));
    assert.ok(!text.includes("<10%"));
  });

  it("catches an allegation word split at a pdftotext break that the excerpt keeps", async () => {
    const minutes = claim(
      "The school board heard al-legations of misuse of school funds that spring",
      "T2",
      JANE_MINUTES,
      "The school board heard al-legations of misuse of school funds that spring.",
    );
    const data = setup({ article: ARTICLE.replace(CLAIMS.reworded, minutes) });
    const keys = await keysOf(data);
    await readEvery(data);
    const result = await reviewList(data);
    assert.strictEqual(result.status, 0, result.stdout);
    assert.deepStrictEqual(itemsOf(data)[keys[LINES.reworded].key].why, ["allegation-word"]);
  });

  it("keeps an unfetchable entry until a snapshot of its own URL and subject is fetched on or after it", async () => {
    const data = setup({
      unfetchable: `- https://news.example.com/jane | us-house-07/jane-example | 2026-10-21 | network error
- https://news.example.com/jane | us-house-07/john-sample | 2026-10-19 | network error
- https://news.example.com/jane?page=2 | us-house-07/jane-example | 2026-10-19 | network error
- https://news.example.com/jane | us-house-07/jane-example | 2026-10-20 | network error
`,
    });
    await readEvery(data);
    await reviewList(data);
    // An unfetchable item has no why line.
    const listed = Object.entries(itemsOf(data))
      .filter(([, item]) => item.why.length === 0)
      .map(([key]) => key);
    // Fetched before the entry, under another subject, or another URL: listed.
    // Fetched the same day: saved since.
    assert.deepStrictEqual(listed, [
      entryKey({ url: "https://news.example.com/jane", where: "us-house-07/jane-example" }),
      entryKey({ url: "https://news.example.com/jane", where: "us-house-07/john-sample" }),
      entryKey({ url: "https://news.example.com/jane?page=2", where: "us-house-07/jane-example" }),
    ]);
  });

  it("clears an unfetchable entry by the URL a later snapshot was asked for, or landed on", async () => {
    const data = setup({
      unfetchable: `- https://news.example.com/jane-old | us-house-07/jane-example | 2026-10-20 | login redirect
- https://news.example.com/jane-moved | us-house-07/jane-example | 2026-10-20 | http 404
- https://news.example.com/jane-other | us-house-07/jane-example | 2026-10-20 | short page
`,
    });
    plant(
      data,
      "sources/us-house-07/jane-example/moved.md",
      snapshot({
        subject: "jane-example",
        url: "https://news.example.com/jane-moved",
        body: "Jane Example moved her campaign office to Main Street.",
        extra: "requested_url: https://news.example.com/jane-old\n",
      }),
    );
    await readEvery(data);
    await reviewList(data);
    const listed = Object.entries(itemsOf(data))
      .filter(([, item]) => item.why.length === 0)
      .map(([key]) => key);
    assert.deepStrictEqual(listed, [
      entryKey({ url: "https://news.example.com/jane-other", where: "us-house-07/jane-example" }),
    ]);
  });
});

describe("review-list: retention and measure contests", () => {
  it("always reviews a retention official's Discipline", async () => {
    const data = setup({ unfetchable: null });
    addRetention(data);
    await readEvery(data, "supreme-court-retention-a");
    const result = await reviewList(data, [BALLOT, "supreme-court-retention-a"]);
    assert.strictEqual(result.status, 0, result.stdout);
    const items = Object.values(itemsOf(data, "supreme-court-retention-a"));
    assert.deepStrictEqual(items, [
      { checked: false, why: ["always-reviewed", "allegation-word"] },
    ]);
  });

  it("keys a measure claim by the contest id and exempts it from attribution", async () => {
    const ballot = `${DEFAULT_BALLOT}  - id: measure-a
    type: measure
    jurisdiction: Exampleton County
    title: Measure A
`;
    const data = setup({ ballot, unfetchable: null });
    const rel = "sources/measure-a/_race/arguments.md";
    const text = snapshot({
      subject: "_race",
      url: "https://news.example.com/measure-a",
      body: "Supporters say the measure would fix every road in the county.",
    });
    plant(data, rel, text);
    const says = "Says: the measure would fix every road in the county";
    const excerpt = "Supporters say the measure would fix every road in the county.";
    data.write(
      `${BALLOT}/articles/measure-a.md`,
      [
        "# measure-a\n",
        "## measure-a\n",
        section("A. What it does"),
        section("B. Fiscal effect"),
        section("C. Arguments for", claim(says, "T2s", rel, excerpt)),
        section("D. Arguments against"),
        section("E. Independent analysis"),
      ].join("\n"),
    );
    data.write(`${BALLOT}/search-log/measure-a.tsv`, "measure-a\t_race\t6\t2026-10-20\n");
    const [only] = Object.values(await keysOf(data, "measure-a"));
    assert.strictEqual(
      only.key,
      claimKey({
        subject: "measure-a",
        section: "C. Arguments for",
        text: says,
        tag: "T2s",
        excerpt,
        snapshot: rel,
        fileHash: sha256(text),
      }),
    );
    await readEvery(data, "measure-a");
    await reviewList(data, [BALLOT, "measure-a"]);
    assert.deepStrictEqual(itemsOf(data, "measure-a"), {
      [only.key]: { checked: false, why: ["not-verbatim"] },
    });
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
    data.write(`${BALLOT}/${R}.accepted`, `${FORGED}\n`);
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
    for (const reason of ["forged <!-- id:x -->", "a <span hidden>hidden</span> note", "a ＞ b"]) {
      neutrality(later, [keys.always], [[keys.always, reason]]);
      result = await reviewList(later);
      assert.strictEqual(result.stdout, `${R}.neutrality.md:2 neutrality-invalid\n`, reason);
    }

    for (const [line, bad] of [
      [6, "- not an entry"],
      [6, "- https://x.example/ | us-house-07/jane-example | 2026-02-30 | http 404"],
      [6, "- https://x.example/ | us-house-07/Jane_Example | 2026-10-20 | http 404"],
    ]) {
      data = setup({ unfetchable: `${UNFETCHABLE}${bad}\n` });
      await readEvery(data);
      result = await reviewList(data);
      assert.strictEqual(result.stdout, `unfetchable.md:${line} unfetchable-invalid\n`, bad);
      assert.strictEqual(data.exists(`${BALLOT}/${R}.baseline`), false);
    }
  });

  it("writes no baseline when the review file, baseline or .accepted is a link", async () => {
    const data = setup();
    await readEvery(data);
    fs.symlinkSync("../articles/us-house-07.md", data.file(`${BALLOT}/${R}.md`));
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, `${R}.md review-invalid\n`);
    assert.strictEqual(data.exists(`${BALLOT}/${R}.baseline`), false);

    const { data: later } = await afterFirstRun();
    for (const name of ["baseline", "accepted"]) {
      const file = later.file(`${BALLOT}/${R}.${name}`);
      const kept = fs.existsSync(file) ? fs.readFileSync(file) : null;
      fs.rmSync(file, { force: true });
      fs.symlinkSync("us-house-07.neutrality.md", file);
      result = await reviewList(later);
      assert.strictEqual(result.stdout, `${R}.${name} review-invalid\n`);
      fs.rmSync(file);
      if (kept) fs.writeFileSync(file, kept);
    }
  });

  it("reports a bad unfetchable.md once, and writes each contest that passes", async () => {
    const data = setup({ unfetchable: "- not an entry\n" });
    addRetention(data);
    let result = await reviewList(data);
    assert.strictEqual(result.stdout, "unfetchable.md:1 unfetchable-invalid\n");
    assert.strictEqual(result.status, 1);

    data.write(`${BALLOT}/unfetchable.md`, UNFETCHABLE);
    data.write(
      `${BALLOT}/articles/supreme-court-retention-a.md`,
      retentionArticle("The state commission reprimanded Pat Example in 2018."),
    );
    await readEvery(data);
    result = await reviewList(data);
    assert.strictEqual(
      result.stdout,
      [
        "articles/supreme-court-retention-a.md check-failed",
        `${R}.baseline written`,
        `${R}.md written`,
        "articles/us-house-07.md not-ready",
        "",
      ].join("\n"),
    );
    assert.strictEqual(result.status, 1);
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

describe("review-list: ready", () => {
  it("returns every refusal as a reason, never throwing one", async () => {
    let data = setup();
    const reasonsOf = (contest = "us-house-07") => readyOne(data.ballotDir, contest).reasons;
    assert.deepStrictEqual(reasonsOf(), ["not-reviewed", "unaccepted"]);
    assert.deepStrictEqual(reasonsOf("us-house-08"), ["unknown-contest"]);
    assert.deepStrictEqual(reasonsOf("supreme-court-retention-a"), ["file-missing"]);
    data.write(`${BALLOT}/${R}.accepted`, `${FORGED}\n`);
    assert.deepStrictEqual(reasonsOf(), ["review-invalid"]);
    data = setup({ unfetchable: "- not an entry\n" });
    assert.deepStrictEqual(reasonsOf(), ["unfetchable-invalid"]);
    data = setup({ article: ARTICLE.replace("for many years.", "for many decades.") });
    assert.deepStrictEqual(reasonsOf(), ["check-failed"]);
    data = setup({ article: ARTICLE.replace("### D. Money\n", "") });
    assert.deepStrictEqual(reasonsOf(), ["coverage-failed"]);
  });

  it("answers for every contest given from one read of the ballot", async () => {
    let data = setup();
    assert.deepStrictEqual(
      readyOf(data.ballotDir, ["us-house-07", "us-house-08", "us-house-07"]),
      new Map([
        ["us-house-07", { ready: false, reasons: ["not-reviewed", "unaccepted"] }],
        ["us-house-08", { ready: false, reasons: ["unknown-contest"] }],
      ]),
    );
    // A failure of the whole run is every contest's reason.
    data = setup({ unfetchable: "- not an entry\n" });
    assert.deepStrictEqual(
      readyOf(data.ballotDir, ["us-house-07", "supreme-court-retention-a"]),
      new Map([
        ["us-house-07", { ready: false, reasons: ["unfetchable-invalid"] }],
        ["supreme-court-retention-a", { ready: false, reasons: ["unfetchable-invalid"] }],
      ]),
    );
  });
});

describe("review-list: ready, for publish", () => {
  it("judges against the contests its caller read, not a second read of the ballot", () => {
    const data = setup();
    assert.deepStrictEqual(
      [...ready(data.ballotDir, ["us-house-07"], { contests: new Map() })].map(([id, a]) => [
        id,
        a.reasons,
      ]),
      [["us-house-07", ["unknown-contest"]]],
    );
  });
});

describe("review-list --refused-hosts", () => {
  it("prints the current run's distinct, IDNA-normalized LDH hosts, and counts the rest", async () => {
    const data = setup({
      unfetchable: `- https://WWW.Example.org/a | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- https://www.example.org/b | us-house-07/john-sample | 2026-10-21 | domain not in tiers.yaml
- https://bücher.example/c | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- http://10.0.0.1/d | us-house-07/jane-example | 2026-10-20 | domain not in tiers.yaml
- https://late.example.net/e | us-house-07/jane-example | 2026-10-19 | domain not in tiers.yaml
- https://old.example.net/e | us-house-07/jane-example | 2026-10-18 | domain not in tiers.yaml
- https://other.example.net/f | us-house-08/someone | 2026-10-20 | domain not in tiers.yaml
- https://news.example.com/g | us-house-07/jane-example | 2026-10-20 | http 404
`,
    });
    const result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-07"]);
    // The day before the run's first log date still counts: a refusal can
    // come before the first search line, or the run can cross midnight.
    assert.strictEqual(
      result.stdout,
      [
        "us-house-07 domain-not-in-tiers late.example.net",
        "us-house-07 domain-not-in-tiers www.example.org",
        "us-house-07 domain-not-in-tiers xn--bcher-kva.example",
        "us-house-07 other-hosts 1",
        "",
      ].join("\n"),
    );
    assert.strictEqual(result.status, 0);
  });

  it("takes the whole latest run of consecutive log dates, and caps what it prints", async () => {
    const data = setup({ unfetchable: null });
    data.write(
      `${BALLOT}/search-log/us-house-07.tsv`,
      [
        "us-house-07\tjane-example\t1\t2026-10-12",
        "us-house-07\tjane-example\t2\t2026-10-19",
        "us-house-07\tjohn-sample\t1\t2026-10-20",
        "",
      ].join("\n"),
    );
    const refusal = (host, date) =>
      `- https://${host}/x | us-house-07/jane-example | ${date} | domain not in tiers.yaml\n`;
    const many = Array.from({ length: 22 }, (_, i) => `h${String(i + 1).padStart(2, "0")}.example`);
    const long = `${"a".repeat(60)}.${"b".repeat(36)}.example`;
    data.write(
      `${BALLOT}/unfetchable.md`,
      [
        refusal("before.example.net", "2026-10-17"),
        refusal("edge.example.net", "2026-10-18"),
        refusal(long, "2026-10-20"),
        ...many.map((h) => refusal(h, "2026-10-20")),
      ].join(""),
    );
    const result = await reviewList(data, ["--refused-hosts", BALLOT, "us-house-07"]);
    const shown = ["edge.example.net", ...many].sort().slice(0, 20);
    assert.strictEqual(
      result.stdout,
      [
        ...shown.map((h) => `us-house-07 domain-not-in-tiers ${h}`),
        "us-house-07 more-hosts 3",
        "us-house-07 other-hosts 1",
        "",
      ].join("\n"),
    );
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

describe("review-list: keys, verbatim claims and allegation words", () => {
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
  it("changes the key when any one field changes, but not for a character normalizing drops", () => {
    const key = claimKey(fields);
    // 128 bits: the first 32 hex digits of a sha256 over the JSON field list.
    assert.strictEqual(
      key,
      sha256(
        JSON.stringify([
          "claim",
          "jane-example",
          "B. Background",
          "",
          "Served two terms",
          "T2",
          "She served two terms on the board",
          JANE_BIO,
          "a".repeat(64),
        ]),
      ).slice(0, 32),
    );
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
    // A zero-width space, or a decomposed accent, is no new key to grind.
    assert.strictEqual(claimKey({ ...fields, text: "Served two\u200b terms" }), key);
    const accent = { ...fields, excerpt: "She served two terms in Bogotá" };
    assert.strictEqual(
      claimKey({ ...accent, excerpt: accent.excerpt.normalize("NFD") }),
      claimKey(accent),
    );
  });

  it("baselines only a whole sentence of the excerpt, of three words or more", () => {
    const yes = [
      ["She served two terms", "She served two terms."],
      ["She left the board", "She served two terms. She left the board!"],
      ["Says: “We will lower taxes now”", "“We will lower taxes now.”"],
      ["Says: 'We will lower taxes now.'", "We will lower taxes now. Then we will go."],
      // A period after a title or an initial ends no sentence.
      ["Sen. Jones voted against the bill", "Sen. Jones voted against the bill."],
      ["She moved to the U.S. in 2004", "Born abroad. She moved to the U.S. in 2004."],
      ["She won in 2020", "She ran in 2016 and lost in 2018. She won in 2020."],
    ];
    for (const [text, excerpt] of yes) assert.strictEqual(isVerbatim(text, excerpt), true, text);
    const no = [
      // Drops the "not" the excerpt has.
      ["Says: support the tax increase", "I do not support the tax increase."],
      ["She served two terms", "She served two terms on the board."],
      // The excerpt itself starts mid-sentence.
      ["support the tax increase", "support the tax increase."],
      // No sentence end in the excerpt.
      ["She served two terms", "She served two terms"],
      ["She left", "She left."],
      ["Served two terms", "She served two terms."],
      ['Says: ""', "anything at all here."],
      // The tail after a title, an initial or an ellipsis drops what came before it.
      [
        "Jones voted to cut school funding.",
        "It is false that Sen. Jones voted to cut school funding.",
      ],
      ["Smith supports the bill fully.", "Nobody thinks Mr. Smith supports the bill fully."],
      ["Doe backed the plan in 2020.", "Critics falsely say J. Doe backed the plan in 2020."],
      [
        "Says: We should raise taxes on families.",
        "I never said... We should raise taxes on families.",
      ],
      [
        "Says: We should raise taxes on families.",
        "I never said… We should raise taxes on families.",
      ],
      // A sentence starts with a capital letter or digit.
      ["Says: raise the minimum wage now.", "I oppose any plan to. raise the minimum wage now."],
      [
        "Says: we should raise taxes on families.",
        "I never said. we should raise taxes on families.",
      ],
      // Nor does a period before a lowercase word end the sentence before it.
      ["Says: We will win this seat.", "We will win this seat. or so the mailer claims."],
    ];
    for (const [text, excerpt] of no) assert.strictEqual(isVerbatim(text, excerpt), false, text);
    // A sample-ballot claim may be its whole span, however short.
    assert.strictEqual(
      isVerbatim("Jane Example Example Party", "Jane Example Example Party"),
      false,
    );
    assert.strictEqual(isVerbatim("Pat Example", "Pat Example", true), true);
    assert.strictEqual(isVerbatim("Pat", "Pat Example", true), false);
  });

  it("matches every allegation word form, whole, and with a pdftotext hyphen", () => {
    for (const text of [
      "a former aide alleging misuse",
      "the grand jury indicts him",
      "the court convicts",
      "the board suspends her",
      "she resigns",
      "two scandals",
      "fraudulently obtained",
      "arrested for DUI",
      "was fined",
      "pleading guilty",
      "violates the rule",
      "the al-legations",
      "an investi-gation",
      "a misdemeanor",
      "two misdemeanors",
      "sentenced to probation",
      "was jailed",
      "a night in jail",
      "a year in prison",
      "was acquitted",
      "the acquittal",
    ]) {
      assert.strictEqual(hasAllegation(text), true, text);
    }
    for (const text of ["in charge of the budget", "Sue Example", "settled in Exampleton", "fine"])
      assert.strictEqual(hasAllegation(text), false, text);
  });
});
