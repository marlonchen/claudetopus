"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { BALLOT } = require("./harness");
const {
  NOT_RESEARCHED,
  SAMPLE_TEXT,
  addContest,
  ballotClaim,
  block,
  claim,
  commit,
  houseArticle,
  logLines,
  page,
  publish,
  repos,
  section,
  setup,
  snapshot,
  text,
} = require("./publish-fixture");

// The page publish renders (page.md; SKILL.md step 6.2), read back as a DOM
// from site/index.html (seam 1). Expected text is page.md's own copy.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SKILL_DIR = path.join(__dirname, "..");
const SITE = `${BALLOT}/site/index.html`;
const all = (root, selector) => [...root.querySelectorAll(selector)];
const texts = (root, selector) => all(root, selector).map(text);
// A ballot-list row as [href, contest title, "Vote for" line or null, status].
const row = (a) => {
  const sub = a.querySelector(".sub");
  const name = text(a.firstElementChild);
  return [
    a.getAttribute("href"),
    sub ? name.slice(0, -text(sub).length) : name,
    sub ? text(sub) : null,
    text(a.querySelector(".st")).replace(/›$/, ""),
  ];
};
// A receipt note's lines (source, fixed line, links), split at its <br>s.
// The parser can split one line's text into several nodes.
const noteLines = (note) => {
  const found = [""];
  for (const n of note.childNodes) {
    if (n.nodeName === "BR") found.push("");
    else found[found.length - 1] += n.textContent;
  }
  return found.map((l) => l.replace(/\s+/g, " ").trim());
};
// A race's own note, not a receipt's.
const raceNote = (race) => all(race, ".note").find((n) => !n.closest("details"));
// The publish date as page.md writes dates ("Oct 24, 2026").
const todayShown = () =>
  new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

const published = async (data) => {
  const result = await publish(data);
  assert.strictEqual(result.status, 0, result.stdout);
  return page(data);
};

describe("publish: one self-contained file", () => {
  it("has the fixed CSP, noindex, no-referrer, no scripts and no outside requests", async () => {
    const data = await setup();
    const doc = await published(data);
    const html = data.read(SITE);
    const skill = fs.readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8");
    const csp = skill.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)[1];
    const meta = (selector) => doc.querySelector(selector)?.getAttribute("content");
    assert.strictEqual(meta('meta[http-equiv="Content-Security-Policy"]'), csp);
    assert.strictEqual(meta('meta[name="robots"]'), "noindex, nofollow");
    assert.strictEqual(meta('meta[name="referrer"]'), "no-referrer");
    assert.strictEqual(doc.documentElement.getAttribute("lang"), "en");
    assert.strictEqual(all(doc, "main").length, 1);
    assert.doesNotMatch(html, /<script/i);
    assert.strictEqual(all(doc, "[src], link, img, iframe").length, 0);
    // Every link stays on the page or is a receipt link.
    const outside = all(doc, "a[href]")
      .map((a) => a.getAttribute("href"))
      .filter((href) => !href.startsWith("#"));
    assert.deepStrictEqual([...new Set(outside)].sort(), [
      "https://county.example.gov/",
      "https://janeexample.com/issues",
      "https://news.example.com/jane",
    ]);
  });

  it("embeds the four bundled font faces, byte for byte, within the 200KB budget", async () => {
    const data = await setup();
    await published(data);
    const embedded = [
      ...data.read(SITE).matchAll(/src:url\(data:font\/woff2;base64,([A-Za-z0-9+/=]+)\)/g),
    ].map((m) => Buffer.from(m[1], "base64"));
    const dir = path.join(SKILL_DIR, "fonts");
    const bundled = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".woff2"))
      .map((f) => fs.readFileSync(path.join(dir, f)));
    assert.strictEqual(bundled.length, 4);
    assert.deepStrictEqual(
      embedded.map((b) => b.toString("hex")).sort(),
      bundled.map((b) => b.toString("hex")).sort(),
    );
    const total = bundled.reduce((sum, b) => sum + b.length, 0);
    assert.ok(total <= 200 * 1024, `fonts are ${total} bytes`);
  });
});

describe("publish: ballot screen", () => {
  it("gives the trust header, the date, the counts and every contest in ballot order", async () => {
    const data = await setup();
    const doc = await published(data);
    const ballot = doc.getElementById("ballot");
    assert.strictEqual(
      text(ballot.querySelector("h1")),
      "Your 2026 ballot",
      "the ballot title names the election year",
    );
    const lines = texts(ballot, ".meta");
    assert.ok(
      lines.includes(
        "Made by Sam for our family. Not affiliated with any campaign or party. Facts only, every one with its source.",
      ),
    );
    assert.ok(lines.includes(`Updated ${todayShown()}`));
    assert.strictEqual(
      text(ballot.querySelector(".banner")),
      "4 contests on your ballot · 1 ready to read",
    );
    assert.strictEqual(all(ballot.querySelector("details.how"), "li").length, 6);
    assert.deepStrictEqual(all(ballot, ".list a.row").map(row), [
      ["#us-house-07", "Representative in Congress, 7th District", null, "Ready"],
      ["#school-director", "School Director", "Vote for 2", "Not ready yet"],
      [
        "#supreme-court-retention-a",
        "Shall Justice Pat Example of the Supreme Court be retained in office?",
        null,
        "Not ready yet",
      ],
      ["#question-1", "Question 1", null, "Not ready yet"],
    ]);
  });

  it("makes every link one of the classes its 44px tap target is set on", async () => {
    const doc = await published(await setup());
    const bare = all(doc, "a").filter((a) => !/\b(link|chip|row)\b/.test(a.className));
    assert.deepStrictEqual(bare.map(text), []);
  });

  it("never shows the printed title of a contest with a display_title", async () => {
    const data = await setup();
    await published(data);
    assert.doesNotMatch(data.read(SITE), /Springfield/);
  });

  it("says none ready yet, with the note, when no contest is ready", async () => {
    const data = await setup();
    const rel = `${BALLOT}/articles/us-house-07.md`;
    data.write(rel, data.read(rel).replace("for twelve years.", "for twelve years"));
    commit(data);
    const ballot = (await published(data)).getElementById("ballot");
    assert.strictEqual(
      text(ballot.querySelector(".banner")),
      "4 contests on your ballot · none ready yet",
    );
    assert.match(
      text(raceNote(ballot)),
      /^Not ready yet\. Every candidate gets the same research before anything shows here\./,
    );
  });
});

describe("publish: candidate race", () => {
  it("is topic first: chips, sections, issues and candidates in ballot order", async () => {
    const data = await setup();
    const race = (await published(data)).getElementById("us-house-07");
    assert.strictEqual(
      text(race.querySelector(".banner")),
      "✓ 2 of 2 candidates on the official ballot covered",
    );
    assert.ok(
      texts(race, ".meta").includes(
        `Updated ${todayShown()} · Not affiliated with any campaign or party · About this guide ↑`,
      ),
    );
    const chips = all(race, "nav.chips a");
    assert.deepStrictEqual(chips.map(text), [
      "On the ballot",
      "Background",
      "Record",
      "Money",
      "Positions",
      "Controversies",
    ]);
    for (const chip of chips) {
      const id = chip.getAttribute("href").slice(1);
      assert.strictEqual(race.querySelector(`[id="${id}"]`)?.tagName, "H2", id);
    }
    assert.deepStrictEqual(all(race, "h3.issue").map(text).slice(0, 2), [
      "Taxes and spending",
      "Economy and jobs",
    ]);
    assert.deepStrictEqual(texts(race, "h4").slice(0, 2), [
      "Jane Example · Example Party",
      "John Sample · Sample Party",
    ]);
    const says = race.querySelector(".says").parentElement;
    assert.strictEqual(
      text(says),
      "Says: Jane Example will cut property taxes for every family in Exampleton.",
    );
    assert.strictEqual(text(race.querySelector(".unk")), "○ Unknown: no source found.");
    assert.ok(
      texts(race, "summary .vh").includes(
        "for Jane Example, Positions section, Taxes and spending",
      ),
    );
    assert.ok(texts(race, ".meta").includes("Certified write-ins: none published"));
    assert.deepStrictEqual(texts(race, ".next a"), [
      "Next on your ballot: School Director →",
      "← All races",
    ]);
  });

  it("links a sample-ballot receipt only to the county site's origin", async () => {
    const data = await setup();
    const race = (await published(data)).getElementById("us-house-07");
    const note = race.querySelector("details.src .note");
    assert.deepStrictEqual(noteLines(note), [
      "Exampleton County elections",
      "The quote above was saved on Oct 19, 2026 from the official ballot record; this link opens the county election site.",
      "County election site ↗",
    ]);
    assert.strictEqual(note.querySelector("a").getAttribute("href"), "https://county.example.gov/");
    assert.doesNotMatch(data.read(SITE), /precinct-12/);
  });

  it("keeps a sample-ballot origin's port and gives an IDN host in its ASCII form", async () => {
    const data = await setup({
      sample: SAMPLE_TEXT.replace(
        "https://county.example.gov/",
        "https://bücher.example.gov:8443/",
      ),
    });
    const race = (await published(data)).getElementById("us-house-07");
    const href = race.querySelector("details.src .note a").getAttribute("href");
    assert.strictEqual(href, "https://xn--bcher-kva.example.gov:8443/");
  });
});

// Jane's Money section, one claim per receipt case (SKILL.md step 6.2).
const MONEY = "sources/us-house-07/jane-example";
const RECEIPTS = {
  publicUrl: {
    rel: `${MONEY}/fec-summary.md`,
    text: snapshot({
      subject: "jane-example",
      source: "FEC candidate summary",
      url: "https://api.open.fec.gov/v1/candidate/H0XX00000/totals/",
      tier: "T1",
      method: "api",
      extra: "public_url: https://www.fec.gov/data/candidate/H0XX00000/#totals\n",
      body: "results.0.note: Jane Example filed her report with the commission.",
    }),
    excerpt: "Jane Example filed her report with the commission.",
    tag: "T1",
  },
  api: {
    rel: `${MONEY}/fec-raw.md`,
    text: snapshot({
      subject: "jane-example",
      source: "FEC data",
      url: "https://api.open.fec.gov/v1/candidate/H0XX00000/",
      tier: "T1",
      method: "api",
      body: "results.0.note: Jane Example registered her committee on time.",
    }),
    excerpt: "Jane Example registered her committee on time.",
    tag: "T1",
  },
  query: {
    rel: `${MONEY}/story.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://news.example.com/story?id=7",
      body: "Jane Example raised money from donors across the district.",
    }),
    excerpt: "Jane Example raised money from donors across the district.",
  },
  fragment: {
    rel: `${MONEY}/profile.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://news.example.com/profile#money",
      body: "Jane Example spent most of her money on mailers.",
    }),
    excerpt: "Jane Example spent most of her money on mailers.",
  },
  archived: {
    rel: `${MONEY}/archived.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://news.example.com/archived",
      body: "Jane Example reported no debts at the end of the quarter.",
    }),
    excerpt: "Jane Example reported no debts at the end of the quarter.",
  },
  hostile: {
    rel: `${MONEY}/hostile.md`,
    text: snapshot({
      subject: "jane-example",
      source: "Example <i>News</i>",
      url: "https://news.example.com/hostile",
      // No src or href: the privacy scan drops a contest quoting one (publish.test.js).
      body: 'Jane Example wrote <img alt=x onerror="alert(1)"> on her site.',
    }),
    excerpt: 'Jane Example wrote <img alt=x onerror="alert(1)"> on her site.',
  },
  // Links no receipt may carry: another scheme, a userinfo, a public_url query.
  script: {
    rel: `${MONEY}/script.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://news.example.com/script",
      extra: "public_url: javascript:alert(1)\n",
      body: "Jane Example thanked the volunteers who knocked on doors.",
    }),
    excerpt: "Jane Example thanked the volunteers who knocked on doors.",
  },
  dataUrl: {
    rel: `${MONEY}/data-url.md`,
    text: snapshot({
      subject: "jane-example",
      url: "data:text/html,hello",
      body: "Jane Example paid her staff on the first of each month.",
    }),
    excerpt: "Jane Example paid her staff on the first of each month.",
  },
  userinfo: {
    rel: `${MONEY}/userinfo.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://user:secret@news.example.com/userinfo",
      body: "Jane Example rented a small office downtown.",
    }),
    excerpt: "Jane Example rented a small office downtown.",
  },
  publicQuery: {
    rel: `${MONEY}/public-query.md`,
    text: snapshot({
      subject: "jane-example",
      source: "FEC filings",
      url: "https://api.open.fec.gov/v1/filings/",
      tier: "T1",
      method: "api",
      extra: "public_url: https://www.fec.gov/data/filings/?committee_id=C1\n",
      body: "results.0.note: Jane Example amended one report.",
    }),
    excerpt: "Jane Example amended one report.",
    tag: "T1",
  },
  long: {
    rel: `${MONEY}/long.md`,
    text: snapshot({
      subject: "jane-example",
      url: "https://news.example.com/long",
      body: `Jane Example ${"spent money on the campaign and ".repeat(8)}ended the quarter even.`,
    }),
    excerpt: `Jane Example ${"spent money on the campaign and ".repeat(8)}ended the quarter even.`,
  },
};
const receiptSetup = async () => {
  // Claim text holds no HTML tag (check fails one), so the hostile claim drops it.
  const money = Object.values(RECEIPTS)
    .map((r) => claim(r.excerpt.replace(/<[^>]*>/g, "x"), r.tag ?? "T2", r.rel, r.excerpt))
    .join("\n");
  const data = await setup({
    house: houseArticle({ money }),
    snapshots: Object.fromEntries(Object.values(RECEIPTS).map((r) => [r.rel, r.text])),
  });
  data.write(`${BALLOT}/archives.tsv`, `${RECEIPTS.archived.rel}\t20261019120000\n`);
  commit(data);
  return data;
};
// The receipt of the Money claim whose excerpt starts with `start`.
const receiptOf = (doc, start) => {
  const claimDiv = all(doc, "#us-house-07 .claim").find((c) =>
    text(c.querySelector("blockquote")).startsWith(`“${start}`),
  );
  assert.ok(claimDiv, `no claim quoting ${start}`);
  const note = claimDiv.querySelector("details.src .note");
  return {
    claim: claimDiv,
    line: noteLines(note)[1],
    links: all(note, "a").map((a) => [text(a), a.getAttribute("href")]),
  };
};

describe("publish: receipts", () => {
  it("gives each link case its page.md line and only the links step 6.2 allows", async () => {
    const data = await receiptSetup();
    const doc = await published(data);
    const publicUrl = receiptOf(doc, "Jane Example filed");
    assert.match(
      publicUrl.line,
      /saved on Oct 19, 2026 from the official record this link shows\./,
    );
    assert.deepStrictEqual(publicUrl.links, [
      ["Original page ↗", "https://www.fec.gov/data/candidate/H0XX00000/"],
    ]);
    const api = receiptOf(doc, "Jane Example registered");
    assert.match(
      api.line,
      /saved on Oct 19, 2026 from this source's official data service, which has no page to link\.$/,
    );
    assert.deepStrictEqual(api.links, []);
    const query = receiptOf(doc, "Jane Example raised");
    assert.match(
      query.line,
      /saved on Oct 19, 2026 from this source; its address can't be shared\.$/,
    );
    assert.deepStrictEqual(query.links, []);
    assert.deepStrictEqual(receiptOf(doc, "Jane Example spent most").links, [
      ["Original page ↗", "https://news.example.com/profile"],
    ]);
    const archived = receiptOf(doc, "Jane Example reported");
    assert.match(
      archived.line,
      /saved from this page on Oct 19, 2026\. If the page has changed, the saved quote is what this summary used\./,
    );
    assert.deepStrictEqual(archived.links, [
      ["Original page ↗", "https://news.example.com/archived"],
      [
        "Saved copy ↗",
        "https://web.archive.org/web/20261019120000/https://news.example.com/archived",
      ],
    ]);
    assert.doesNotMatch(data.read(SITE), /id=7|#money"|#totals/);
    for (const start of [
      "Jane Example thanked",
      "Jane Example paid",
      "Jane Example rented",
      "Jane Example amended",
    ]) {
      const refused = receiptOf(doc, start);
      assert.match(refused.line, /from this source; its address can't be shared\.$/, start);
      assert.deepStrictEqual(refused.links, [], start);
    }
    assert.doesNotMatch(data.read(SITE), /javascript:|data:text|secret|committee_id/);
  });

  it("escapes every value it shows, so source text never becomes markup", async () => {
    const data = await receiptSetup();
    const doc = await published(data);
    assert.strictEqual(all(doc, "img, i").length, 0);
    const hostile = receiptOf(doc, "Jane Example wrote");
    assert.match(
      text(hostile.claim.querySelector("blockquote")),
      /<img alt=x onerror="alert\(1\)">/,
    );
    assert.strictEqual(text(hostile.claim.querySelector("cite")), "Example <i>News</i>");
  });

  it("cuts an excerpt over 200 characters at a word, the rest behind … full quote", async () => {
    const data = await receiptSetup();
    const doc = await published(data);
    const quote = receiptOf(doc, "Jane Example spent money").claim.querySelector("blockquote");
    const more = quote.querySelector("details.more");
    assert.match(text(more.querySelector("summary")), /^… full quote/);
    const shown = text(quote).split("… full quote")[0].trim().slice(1);
    const { excerpt } = RECEIPTS.long;
    assert.ok([...shown].length <= 200, `${[...shown].length} characters shown`);
    assert.ok(excerpt.startsWith(shown) && excerpt[shown.length] === " ", "not cut at a word");
    assert.match(text(quote), /ended the quarter even\.”/);
  });
});

// School Director: multi-seat, a withdrawn candidate, a certified write-in
// and Money left for later.
const WRITE_INS = "sources/_ballot/write-in-list.md";
const LOCAL_ISSUES = [
  "Taxes and budget",
  "Public safety",
  "Schools",
  "Housing and development",
  "Roads and transit",
];
const addSchoolDirector = async (data) => {
  const writeIns = snapshot({
    subject: "_ballot",
    source: "Exampleton County elections",
    url: "https://county.example.gov/write-ins",
    tier: "T1",
    extra: "role: write_in_list\n",
    body: "Di Dunn is a certified write-in candidate for School Director.",
  });
  const ledger = `${BALLOT}/ballot.ledger`;
  data.write(ledger, `${data.read(ledger)}${WRITE_INS}\twrite_in_list\turl\tnone\t2026-10-20\n`);
  const later = (name, onBallot) => block(name, { onBallot, money: NOT_RESEARCHED }, "local");
  const article = [
    "# school-director\n",
    later("Ann Able", ballotClaim("Ann Able Example Party")),
    `## Bo Baker\n\n${section("A. On the ballot", ballotClaim("Bo Baker Example Party"))}`,
    later("Cy Cole", ballotClaim("Cy Cole Example Party")),
    later(
      "Di Dunn",
      claim(
        "Di Dunn is a certified write-in candidate for School Director.",
        "T1",
        WRITE_INS,
        "Di Dunn is a certified write-in candidate for School Director.",
      ),
    ),
  ].join("\n");
  await addContest(data, {
    id: "school-director",
    article,
    snapshots: { [WRITE_INS]: writeIns },
    log: logLines("school-director", ["ann-able", "cy-cole", "di-dunn"], ["1", "2", "3", "4", "5"]),
  });
};

describe("publish: multi-seat race", () => {
  it("counts printed candidates, the write-in and the topic still to come", async () => {
    const data = await setup();
    await addSchoolDirector(data);
    const doc = await published(data);
    const race = doc.getElementById("school-director");
    assert.strictEqual(
      text(race.querySelector(".banner")),
      "✓ 2 of 2 candidates · Vote for up to 2 · +1 certified write-in · 1 topic not researched yet",
    );
    assert.ok(!texts(race, ".meta").includes("Certified write-ins: none published"));
    // Withdrawn: in ballot position, muted, labeled, and only On the ballot.
    assert.deepStrictEqual(texts(race, "h3"), [
      "Ann Able · Example Party",
      "Bo Baker · Example Party · Withdrew (still on printed ballot)",
      "Cy Cole · Example Party",
      "Di Dunn · Certified write-in",
      "Ann Able · Example Party",
      "Cy Cole · Example Party",
      "Di Dunn · Certified write-in",
      "Ann Able · Example Party",
      "Cy Cole · Example Party",
      "Di Dunn · Certified write-in",
      ...LOCAL_ISSUES,
      "Ann Able · Example Party",
      "Cy Cole · Example Party",
      "Di Dunn · Certified write-in",
    ]);
    assert.ok(all(race, ".cand.withdrawn").every((c) => text(c).startsWith("Bo Baker")));
    // Money: one line for everyone, no per-candidate rows, and it keeps its chip.
    const money = race.querySelector("#school-director--money");
    assert.strictEqual(
      text(money.nextElementSibling),
      "Not researched yet. Research on this topic is still to come, for every candidate at once. Check back; this link stays the same.",
    );
    assert.strictEqual(money.nextElementSibling.nextElementSibling.tagName, "H2");
    assert.ok(texts(race, "nav.chips a").includes("Money"));
    assert.deepStrictEqual(row(doc.querySelector('#ballot a[href="#school-director"]')), [
      "#school-director",
      "School Director",
      "Vote for 2",
      "Ready",
    ]);
    assert.strictEqual(
      text(doc.querySelector("#ballot .banner")),
      "4 contests on your ballot · 2 ready to read",
    );
  });
});

// The retention contest, its sections all Unknown but On the ballot.
const retentionArticle = (state = "Unknown, no source found") =>
  [
    "# supreme-court-retention-a\n",
    "## Pat Example\n",
    section("A. On the ballot", ballotClaim("Pat Example")),
    section("B. Record in office", state),
    section("C. Evaluation findings", state),
    section("D. Discipline", state),
    section("E. Statements", state),
  ].join("\n");
const addRetention = (data, state, article = retentionArticle(state)) =>
  addContest(data, {
    id: "supreme-court-retention-a",
    article,
    log: logLines("supreme-court-retention-a", ["pat-example"], ["7"]),
  });

describe("publish: retention race", () => {
  it("names the official, counts sources and notes thin judicial records", async () => {
    const data = await setup();
    await addRetention(data);
    const race = (await published(data)).getElementById("supreme-court-retention-a");
    assert.strictEqual(text(race.querySelector(".banner")), "✓ Official record searched: 1 source");
    assert.strictEqual(text(race.querySelector(".who")), "Pat Example");
    assert.strictEqual(all(race, "h3, h4").length, 0, "retention sections are h2 only");
    assert.deepStrictEqual(texts(race, "h2"), [
      "On the ballot",
      "Record in office",
      "Evaluation findings",
      "Discipline",
      "Statements",
    ]);
    assert.ok(texts(race, ".meta").includes("Thin records are common for judges."));
    assert.ok(texts(race, "summary .vh").includes("for Pat Example, On the ballot section"));
  });

  it("says a section left for later is still to come, in its line and its banner", async () => {
    const data = await setup();
    const rel = `${BALLOT}/ballot.yaml`;
    data.write(
      rel,
      data
        .read(rel)
        .replace(
          "      name: Pat Example\n",
          "      name: Pat Example\n    not_researched: [Discipline]\n",
        ),
    );
    commit(data);
    const article = retentionArticle().replace(
      "### D. Discipline\n\nUnknown, no source found",
      `### D. Discipline\n\n${NOT_RESEARCHED}`,
    );
    await addRetention(data, undefined, article);
    const race = (await published(data)).getElementById("supreme-court-retention-a");
    assert.strictEqual(
      text(race.querySelector(".banner")),
      "✓ Official record searched: 1 source · 1 topic not researched yet",
    );
    assert.strictEqual(
      text(race.querySelector("#supreme-court-retention-a--discipline").nextElementSibling),
      "Not researched yet. Research on this topic is still to come, for every candidate at once. Check back; this link stays the same.",
    );
  });

  it("shows a not-researched contest's On the ballot section and one note, with no chips", async () => {
    const data = await setup();
    const rel = `${BALLOT}/ballot.yaml`;
    data.write(
      rel,
      data
        .read(rel)
        .replace("      name: Pat Example\n", "      name: Pat Example\n    not_researched: all\n"),
    );
    commit(data);
    await addRetention(data, NOT_RESEARCHED);
    const doc = await published(data);
    const race = doc.getElementById("supreme-court-retention-a");
    assert.deepStrictEqual(texts(race, "h2"), ["On the ballot"]);
    assert.strictEqual(all(race, "nav.chips").length, 0);
    assert.strictEqual(
      text(raceNote(race)),
      "Not researched yet. This race is on your ballot, but we haven't researched it yet. Every candidate gets the same research before the rest shows here. Check back; this link stays the same.",
    );
    assert.strictEqual(
      row(doc.querySelector('#ballot a[href="#supreme-court-retention-a"]'))[3],
      "Not researched yet",
    );
    // Not researched contests are not counted as ready to read.
    assert.strictEqual(
      text(doc.querySelector("#ballot .banner")),
      "4 contests on your ballot · 1 ready to read",
    );
  });
});

const MEASURE = "sources/question-1/_race";
const addMeasure = (data) =>
  addContest(data, {
    id: "question-1",
    article: [
      "# question-1\n",
      "## question-1\n",
      section(
        "A. What it does",
        claim(
          "The measure would fund the county library system.",
          "T1",
          `${MEASURE}/text.md`,
          "The measure would fund the county library system.",
        ),
      ),
      section("B. Fiscal effect"),
      section(
        "C. Arguments for",
        claim(
          "Says: The library levy keeps every branch open.",
          "T1s",
          `${MEASURE}/pamphlet.md`,
          "The library levy keeps every branch open.",
        ),
      ),
      section(
        "D. Arguments against",
        claim(
          "Says: The levy raises taxes on every household.",
          "T1s",
          `${MEASURE}/pamphlet.md`,
          "The levy raises taxes on every household.",
        ),
      ),
      section("E. Independent analysis"),
    ].join("\n"),
    snapshots: {
      [`${MEASURE}/text.md`]: snapshot({
        subject: "_race",
        source: "Official question text",
        url: "https://county.example.gov/questions/library",
        tier: "T1",
        body: "The measure would fund the county library system.",
      }),
      [`${MEASURE}/pamphlet.md`]: snapshot({
        subject: "_race",
        source: "Official voter guide",
        url: "https://county.example.gov/pamphlet",
        tier: "T1",
        statementsOnly: true,
        body: "The library levy keeps every branch open. The levy raises taxes on every household.",
      }),
    },
    log: logLines("question-1", ["_race"], ["6"]),
  });

describe("publish: measure race", () => {
  it("shows its display title, its sections and the arguments as the voter guide's", async () => {
    const data = await setup();
    await addMeasure(data);
    const race = (await published(data)).getElementById("question-1");
    assert.strictEqual(text(race.querySelector("h1")), "Question 1");
    assert.strictEqual(
      text(race.querySelector(".banner")),
      "✓ Official text and fiscal note saved",
    );
    assert.deepStrictEqual(texts(race, "nav.chips a"), [
      "What it does",
      "Fiscal effect",
      "Arguments for",
      "Arguments against",
      "Independent analysis",
    ]);
    assert.strictEqual(all(race, "h3, .cand").length, 0);
    assert.strictEqual(
      texts(race, ".meta").filter((t) => t === "These are arguments, not facts.").length,
      2,
    );
    assert.deepStrictEqual(texts(race, ".badge"), [
      "Official record",
      "From the official voter guide",
      "From the official voter guide",
    ]);
    assert.ok(texts(race, "summary .vh").includes("for Question 1, Arguments for section"));
    // The last race on the ballot ends with All races alone.
    assert.deepStrictEqual(texts(race, ".next a"), ["← All races"]);
  });
});
