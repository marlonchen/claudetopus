"use strict";

const assert = require("node:assert");
const { afterEach, describe, it } = require("node:test");
const { BALLOT } = require("./harness");
const { fetchSnapshot, server, sha256 } = require("./fetch-snapshot-fixture");
const {
  BALLOT_YAML,
  JANE_BIO,
  JANE_SITE,
  checkedBallot,
  claim,
  houseArticle,
  repos,
  setup,
  snapshot,
} = require("./publish-fixture");

// fetch-snapshot --archive, the Wayback batch (snapshot-format.md, Saved
// copies), run as a subprocess against a temp data repo with the Wayback
// Machine replaced by a local server through RESEARCH_CANDIDATES_TEST_HTTP_TARGET,
// so no test sends anything off this machine. The data repo is publish's
// (publish-fixture.js): its House contest is ready and cites Jane's bio and
// campaign site, and the sample ballot; `ballotCiting` adds snapshots its
// Money section cites.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const STAMP = "20261019120000";
const save = (url) => `https://web.archive.org/save/${url}`;
const captured = (url, stamp = STAMP) => ({
  [save(url)]: {
    status: 302,
    headers: { location: `https://web.archive.org/web/${stamp}/${url}` },
  },
});

// The two snapshots the ready House contest cites that are eligible, by path
// order, and their URLs.
const BIO_URL = "https://news.example.com/jane";
const SITE_URL = "https://janeexample.com/issues";
const BASE = { ...captured(BIO_URL), ...captured(SITE_URL) };

const MONEY = "sources/us-house-07/jane-example";
// Claim text for each cited snapshot, one sentence each, holding nothing private.
const SAYS = [
  "reported donations from teachers",
  "spent little on television",
  "held a town hall about roads",
  "thanked her volunteers",
  "filed her report early",
  "hired two organizers",
  "opened an office downtown",
  "paid back a loan",
  "raised money online",
  "bought radio time",
  "skipped one debate",
  "toured the farms",
];

// A data repo whose ready House contest also cites, from Jane's Money
// section, a snapshot at each path of `cites`, built by publish-fixture's
// `snapshot` from its options (`url` and any other), and tagged `tag`.
// `ballot` replaces ballot.yaml.
const ballotCiting = async (cites = {}, { ballot = BALLOT_YAML } = {}) => {
  const snapshots = {};
  const money = Object.entries(cites).map(([rel, { tag = "T2", ...options }], i) => {
    const text = `Jane Example ${SAYS[i]}.`;
    snapshots[rel] = snapshot({ subject: "jane-example", body: text, ...options });
    return claim(text, tag, rel, text);
  });
  return setup({
    ballot,
    house: houseArticle(money.length ? { money: money.join("\n") } : {}),
    snapshots,
  });
};

// Save a snapshot no claim cites, with its manifest line.
const plantUncited = (data, rel, url) => {
  const text = snapshot({ subject: rel.split("/")[2] ?? "x", url, body: "Jane Example spoke." });
  data.write(`${BALLOT}/${rel}`, text);
  const manifest = data.read(`${BALLOT}/snapshots.sha256`);
  data.write(`${BALLOT}/snapshots.sha256`, `${manifest}${sha256(text)}  ${rel}\n`);
};

// Run the batch against a local Wayback holding `routes`.
const archive = async (data, routes, env = {}) => {
  const wayback = await server(routes);
  const result = await fetchSnapshot(data, ["--archive", BALLOT], {
    RESEARCH_CANDIDATES_TEST_HTTP_TARGET: wayback.target,
    ...env,
  });
  return { ...result, seen: wayback.seen, headers: wayback.headers };
};

const FETCH_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "connection",
  "host",
  "sec-fetch-mode",
];
const archives = (data) =>
  data.exists(`${BALLOT}/archives.tsv`) ? data.read(`${BALLOT}/archives.tsv`) : null;
const BOTH = `${JANE_BIO}\t${STAMP}\n${JANE_SITE}\t${STAMP}\n`;

describe("fetch-snapshot --archive records Wayback captures in archives.tsv", () => {
  // Value: protects=criteria 1 and 4: a capture appends the snapshot path and its 14-digit timestamp, the request goes to the overridable endpoint as /save/<url>, and a rerun sends nothing for a path already recorded; fails_when=the line shape changes, the URL sent is not the snapshot's url, or a rerun captures again; why_new=new; seam=cli; no_claim=the real Wayback Machine's answers
  it("appends path and timestamp, and a rerun resumes past recorded paths", async () => {
    const data = await ballotCiting();
    const first = await archive(data, BASE);
    assert.strictEqual(first.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
    assert.strictEqual(first.stderr, "");
    assert.strictEqual(first.status, 0);
    assert.deepStrictEqual(first.seen, [save(BIO_URL), save(SITE_URL)]);
    assert.strictEqual(archives(data), BOTH);

    const rerun = await archive(data, {
      ...captured(BIO_URL, "20261020000000"),
      ...captured(SITE_URL, "20261020000000"),
    });
    assert.strictEqual(rerun.stdout, "archives.tsv up-to-date\n");
    assert.strictEqual(rerun.status, 0);
    assert.deepStrictEqual(rerun.seen, []);
    assert.strictEqual(archives(data), BOTH);
  });

  // Value: protects=O3: two batches at once send each snapshot once and record it once, since each capture is asked for under the ballot lock with archives.tsv read again there; fails_when=the read under the lock is dropped or the send leaves the lock; why_new=new; seam=cli; no_claim=runs on two machines
  it("sends and records each snapshot once when two runs overlap", async () => {
    const data = await ballotCiting();
    const wayback = await server({
      [save(BIO_URL)]: { ...captured(BIO_URL)[save(BIO_URL)], delay: 1000 },
      ...captured(SITE_URL),
    });
    const env = { RESEARCH_CANDIDATES_TEST_HTTP_TARGET: wayback.target };
    const runs = await Promise.all([
      fetchSnapshot(data, ["--archive", BALLOT], env),
      fetchSnapshot(data, ["--archive", BALLOT], env),
    ]);
    for (const run of runs) assert.strictEqual(run.status, 0, run.stdout);
    assert.deepStrictEqual(wayback.seen.sort(), [save(SITE_URL), save(BIO_URL)].sort());
    assert.strictEqual(archives(data), BOTH);
  });
});

describe("fetch-snapshot --archive sends only snapshots the page cites", () => {
  // Value: protects=D2: an uncited snapshot, and an unnamed listed path, are never sent, printed or recorded (ADR 0006); only snapshots cited by ready contests are; fails_when=the batch walks sources/ again or prints a planted name; why_new=new; seam=cli; no_claim=publish's own drops (the next test)
  it("never sends an uncited snapshot or a listed path fetch-snapshot could not name", async () => {
    const data = await ballotCiting();
    plantUncited(data, `${MONEY}/uncited.md`, "https://news.example.com/uncited");
    plantUncited(data, "sources/springfield-township-notes.md", "https://news.example.com/notes");
    const result = await archive(data, {
      ...BASE,
      ...captured("https://news.example.com/uncited"),
      ...captured("https://news.example.com/notes"),
    });
    assert.strictEqual(result.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.seen, [save(BIO_URL), save(SITE_URL)]);
    assert.strictEqual(archives(data), BOTH);
  });

  // Value: protects=D2: a contest that is not ready, or that publish's step 6.2 scan drops, gets no capture; fails_when=readiness or the drop is skipped; why_new=new; seam=cli; no_claim=the page scan of step 6.3
  it("sends nothing for a contest that is not ready or that publish drops", async () => {
    const unreviewed = await checkedBallot();
    const none = await archive(
      unreviewed,
      captured("https://county.example.gov/ballots/precinct-12.pdf"),
    );
    assert.strictEqual(none.stdout, "archives.tsv up-to-date\n");
    assert.deepStrictEqual(none.seen, []);

    // The excerpt quotes a private string, so publish drops the House contest.
    const text = "Jane Example spoke in Springfield Township.";
    const rel = `${MONEY}/speech.md`;
    const data = await setup({
      house: houseArticle({ money: claim(text, "T2", rel, text) }),
      snapshots: {
        [rel]: snapshot({
          subject: "jane-example",
          url: "https://news.example.com/speech",
          body: text,
        }),
      },
    });
    const dropped = await archive(data, {
      ...BASE,
      ...captured("https://news.example.com/speech"),
    });
    assert.strictEqual(dropped.stdout, "archives.tsv up-to-date\n");
    assert.strictEqual(dropped.status, 0);
    assert.deepStrictEqual(dropped.seen, []);
    assert.strictEqual(archives(data), null);
  });

  // Value: protects=criterion 2 and D8: _ballot snapshots (by path and by subject, each check on its own), api snapshots, a url with a query string, a public_url, credentials in the url and a non-http url are never sent to the Wayback Machine; fails_when=an exclusion is dropped or read from the wrong field; why_new=new; seam=cli; no_claim=what Wayback does with what it is sent
  it("never sends _ballot, api, query-string, public_url, credential or non-http snapshots", async () => {
    const data = await ballotCiting({
      // The sample ballot (sources/_ballot/, subject _ballot) is cited already;
      // these two are each _ballot one way only.
      "sources/_ballot/odd-subject.md": {
        subject: "jane-example",
        source: "Exampleton County elections",
        url: "https://county.example.gov/odd",
        tier: "T1",
        extra: "role: pamphlet\n",
        tag: "T1",
      },
      [`${MONEY}/ballot-subject.md`]: { subject: "_ballot", url: "https://county.example.gov/sub" },
      [`${MONEY}/totals.md`]: {
        source: "FEC candidate data",
        url: "https://api.open.fec.gov/v1/candidate/H0XX00000/totals/",
        method: "api",
        tier: "T1",
        tag: "T1",
      },
      [`${MONEY}/query.md`]: { url: "https://news.example.com/story?id=7" },
      [`${MONEY}/filing.md`]: {
        url: "https://news.example.com/filing",
        extra: "public_url: https://news.example.com/filing\n",
      },
      [`${MONEY}/userinfo.md`]: { url: "https://user:secret@news.example.com/userinfo" },
      [`${MONEY}/data-url.md`]: { url: "data:text/html,hello" },
    });
    const result = await archive(data, {
      ...BASE,
      ...captured("https://county.example.gov/ballots/precinct-12.pdf"),
      ...captured("https://county.example.gov/odd"),
      ...captured("https://county.example.gov/sub"),
      ...captured("https://api.open.fec.gov/v1/candidate/H0XX00000/totals/"),
      ...captured("https://news.example.com/filing"),
      ...captured("https://news.example.com/userinfo"),
    });
    assert.strictEqual(result.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.seen, [save(BIO_URL), save(SITE_URL)]);
    assert.strictEqual(archives(data), BOTH);
  });

  // Value: protects=only a URL is sent: the request carries the snapshot's own url as the /save/ path and no cookie, referer, front matter or body; fails_when=a header or the body starts carrying ballot data; why_new=new; seam=cli; no_claim=the real endpoint's URL scheme
  it("sends the snapshot's url and nothing else", async () => {
    const data = await ballotCiting({
      [`${MONEY}/story.md`]: { url: "https://news.example.com/story#money" },
    });
    const result = await archive(data, { ...BASE, ...captured("https://news.example.com/story") });
    // A url with a fragment is skipped whole, never sent with or without it;
    // fetch-snapshot's cleaning drops a fragment, so a recorded url never has one.
    assert.deepStrictEqual(result.seen, [save(BIO_URL), save(SITE_URL)]);
    assert.strictEqual(result.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
    const [headers] = result.headers;
    // The headers Node's fetch adds to every request carry nothing of the ballot.
    const own = Object.keys(headers).filter((name) => !FETCH_HEADERS.includes(name));
    assert.deepStrictEqual(own.sort(), ["user-agent", "x-original-url"]);
    assert.strictEqual(headers["user-agent"], "research-candidates fetch-snapshot");
  });
});

describe("fetch-snapshot --archive fails soft when the Wayback Machine is down", () => {
  const TALLY = `${MONEY}/tally.md`;
  const TALLY_URL = "https://news.example.com/tally";
  const WORDS = `${MONEY}/words.md`;
  const WORDS_URL = "https://news.example.com/words";

  // Value: protects=criterion 3: throttling or no answer writes nothing, exits 0, stops the batch after one request and prints only the path, a code and a hint; a later run captures what is left; fails_when=an outage fails the run, writes a line, keeps sending, or prints a URL; why_new=new; seam=cli; no_claim=Wayback's real error shapes
  it("stops at throttling, writes nothing, and a later run resumes", async () => {
    const data = await ballotCiting();
    const down = await archive(data, { [save(BIO_URL)]: { status: 429 }, ...captured(SITE_URL) });
    assert.strictEqual(down.stdout, `${JANE_BIO} wayback-unavailable\n- rerun-later\n`);
    assert.strictEqual(down.stderr, "");
    assert.strictEqual(down.status, 0);
    assert.strictEqual(down.seen.length, 1);
    assert.strictEqual(archives(data), null);

    const later = await archive(data, BASE);
    assert.strictEqual(later.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
    assert.strictEqual(archives(data), BOTH);
  });

  // Value: protects=criterion 3 when nothing answers: a refused connection is an outage, not an internal-error; fails_when=a network error escapes as a crash or a failed run; why_new=new; seam=cli; no_claim=timeouts (the same catch)
  it("treats no answer at all as an outage", async () => {
    const data = await ballotCiting();
    const closed = await server({});
    const target = closed.target;
    await closed.close();
    const result = await fetchSnapshot(data, ["--archive", BALLOT], {
      RESEARCH_CANDIDATES_TEST_HTTP_TARGET: target,
    });
    assert.strictEqual(result.stdout, `${JANE_BIO} wayback-unavailable\n- rerun-later\n`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(archives(data), null);
  });

  // Value: protects=D4: a server error for one URL skips only that snapshot, so a URL that always fails never blocks the ones after it, and a rerun tries it again; fails_when=a single 5xx stops the batch, or is recorded; why_new=new; seam=cli; no_claim=which pages Wayback fails on
  it("skips a URL that always gets a server error and goes on", async () => {
    const data = await ballotCiting();
    const routes = { [save(BIO_URL)]: { status: 503 }, ...captured(SITE_URL) };
    const first = await archive(data, routes);
    assert.strictEqual(first.stdout, `${JANE_BIO} wayback-no-capture\n${JANE_SITE} archived\n`);
    assert.strictEqual(first.status, 0);
    assert.strictEqual(archives(data), `${JANE_SITE}\t${STAMP}\n`);
    const rerun = await archive(data, routes);
    assert.strictEqual(rerun.stdout, `${JANE_BIO} wayback-no-capture\n`);
    assert.deepStrictEqual(rerun.seen, [save(BIO_URL)]);
  });

  // Value: protects=D4: three server errors in a row are an outage and stop the batch, and any other answer starts the count again; fails_when=the batch never stops on a failing service, or stops after errors that were not in a row; why_new=new; seam=cli; no_claim=Wayback's real outage shapes
  it("stops after three server errors in a row", async () => {
    const data = await ballotCiting({ [TALLY]: { url: TALLY_URL }, [WORDS]: { url: WORDS_URL } });
    const failing = { status: 502 };
    const down = await archive(data, {
      [save(BIO_URL)]: failing,
      [save(SITE_URL)]: failing,
      [save(TALLY_URL)]: failing,
      ...captured(WORDS_URL),
    });
    assert.strictEqual(
      down.stdout,
      `${JANE_BIO} wayback-no-capture\n${JANE_SITE} wayback-no-capture\n${TALLY} wayback-unavailable\n- rerun-later\n`,
    );
    assert.strictEqual(down.status, 0);
    assert.strictEqual(down.seen.length, 3);
    assert.strictEqual(archives(data), null);

    const spaced = await archive(data, {
      [save(BIO_URL)]: failing,
      [save(SITE_URL)]: failing,
      ...captured(TALLY_URL),
      [save(WORDS_URL)]: failing,
    });
    assert.strictEqual(
      spaced.stdout,
      `${JANE_BIO} wayback-no-capture\n${JANE_SITE} wayback-no-capture\n${TALLY} archived\n${WORDS} wayback-no-capture\n`,
    );
    assert.strictEqual(archives(data), `${TALLY}\t${STAMP}\n`);
  });

  // Value: protects=an answer that names no capture (a refused page) skips only that snapshot, records nothing for it, and the batch goes on; fails_when=a non-capture answer is recorded, or stops the batch; why_new=new; seam=cli; no_claim=which pages Wayback refuses
  it("skips a snapshot Wayback does not capture and goes on", async () => {
    const data = await ballotCiting();
    const result = await archive(data, {
      [save(BIO_URL)]: { status: 200, body: "Sorry" },
      ...captured(SITE_URL),
    });
    assert.strictEqual(result.stdout, `${JANE_BIO} wayback-no-capture\n${JANE_SITE} archived\n`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(archives(data), `${JANE_SITE}\t${STAMP}\n`);
  });

  // Value: protects=O4: a capture is recorded only when its /web/<timestamp>/<url> names the URL sent and a real timestamp not in the future; fails_when=another URL's capture, an impossible date or a future one is recorded; why_new=new; seam=cli; no_claim=the live service's answer shape (D3)
  it("records nothing for a capture of another URL or with a bad timestamp", async () => {
    const data = await ballotCiting();
    const answers = [
      `https://web.archive.org/web/${STAMP}/https://evil.example/`,
      `https://web.archive.org/web/${STAMP}/${BIO_URL}/other`,
      `https://web.archive.org/web/99999999999999/${BIO_URL}`,
      `https://web.archive.org/web/20260231120000/${BIO_URL}`,
      `https://web.archive.org/web/20991231235959/${BIO_URL}`,
    ];
    for (const location of answers) {
      const result = await archive(data, {
        [save(BIO_URL)]: { status: 302, headers: { location } },
        [save(SITE_URL)]: { status: 200, headers: { "content-location": location } },
      });
      assert.strictEqual(
        result.stdout,
        `${JANE_BIO} wayback-no-capture\n${JANE_SITE} wayback-no-capture\n`,
        location,
      );
      assert.strictEqual(archives(data), null, location);
    }
    const relative = await archive(data, {
      ...captured(BIO_URL),
      [save(SITE_URL)]: {
        status: 200,
        headers: { "content-location": `/web/${STAMP}/${SITE_URL}` },
      },
    });
    assert.strictEqual(relative.stdout, `${JANE_BIO} archived\n${JANE_SITE} archived\n`);
  });
});

describe("fetch-snapshot --archive never sends a URL holding a private value", () => {
  const OTHER_BALLOT = "2026-general/yy-otherville-2";
  const TITLE = "    title: Representative in Congress, 7th District\n";
  const CASES = [
    ["ballot-id", "https://news.example.com/xx-exampleton-1/story", "private-ballot-id"],
    ["other-id", "https://news.example.com/yy_otherville_2/story", "private-ballot-id"],
    ["string", "https://news.example.com/springfield-township/story", "private-string"],
    ["precinct", "https://news.example.com/results/precinct-12", "private-string"],
    ["other-string", "https://news.example.com/maple-ward/story", "private-string"],
    // Recorded as punycode; only its Unicode spelling holds "Peña Ward".
    ["unicode-host", "https://xn--pea-ward-e3a.example.com/story", "private-string"],
    ["key", "https://news.example.com/s3cr3t-fec-key/story", "private-key"],
    // The House contest's printed title, which its display_title hides.
    [
      "title",
      "https://news.example.com/representative-in-congress-7th-district/x",
      "private-title",
    ],
  ];

  // Value: protects=ADR 0010, Rule 7 and M1 at the batch: every URL is matched with the values and classes the page scan uses (this and every other ballot's id, every ballot's private_strings in each spelling, a key value, a hidden printed title) before it is sent, a match is never sent or recorded, and the output names only the snapshot path and the class code, never a URL (ADR 0006); fails_when=a class or a spelling is skipped, a refusal still sends, or a URL reaches stdout or stderr; why_new=new; seam=cli; no_claim=private text no private_strings entry lists
  it("refuses each class by its code, sends nothing for it, and prints no URL", async () => {
    const data = await ballotCiting(
      Object.fromEntries(CASES.map(([name, url]) => [`${MONEY}/leak-${name}.md`, { url }])),
      { ballot: BALLOT_YAML.replace(TITLE, `${TITLE}    display_title: U.S. House\n`) },
    );
    data.write(`${OTHER_BALLOT}/ballot.yaml`, "contests: []\n");
    data.write(`${OTHER_BALLOT}/private.yaml`, "private_strings:\n  - Maple Ward\n  - Peña Ward\n");
    const result = await archive(
      data,
      { ...BASE, ...Object.assign({}, ...CASES.map(([, url]) => captured(url))) },
      { OPENFEC_API_KEY: "s3cr3t-fec-key" },
    );
    const expected = [
      `${JANE_BIO} archived`,
      ...CASES.map(([name, , code]) => `${MONEY}/leak-${name}.md ${code}`),
      `${JANE_SITE} archived`,
    ].sort();
    assert.strictEqual(result.stdout, `${expected.join("\n")}\n`);
    assert.strictEqual(result.stderr, "");
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.seen, [save(BIO_URL), save(SITE_URL)]);
    assert.strictEqual(archives(data), BOTH);
  });

  // Value: protects=only snapshots fetch-snapshot wrote, unchanged, are ever sent: a snapshot that does not match snapshots.sha256 stops the whole batch before any request; fails_when=an edited url is sent; why_new=new; seam=cli; no_claim=check's own manifest report
  it("sends nothing while a snapshot does not match its manifest line", async () => {
    const data = await ballotCiting();
    data.write(
      `${BALLOT}/${JANE_SITE}`,
      data.read(`${BALLOT}/${JANE_SITE}`).replace("/issues", "/other"),
    );
    const result = await archive(data, { ...BASE, ...captured("https://janeexample.com/other") });
    assert.strictEqual(result.stdout, `${JANE_SITE} snapshot-hash\n`);
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.seen, []);
    assert.strictEqual(archives(data), null);
  });

  // Value: protects=M2: the URL sent is read from bytes that still match the manifest line as it stood when the run began, so a snapshot edited while an earlier capture is in flight is refused, not sent; fails_when=the batch reads a file again without hashing it; why_new=new; seam=cli; no_claim=edits made before the run (the test above)
  it("refuses a snapshot edited during the run and never sends its new url", async () => {
    const data = await ballotCiting();
    const file = `${BALLOT}/${JANE_SITE}`;
    const result = await archive(data, {
      [save(BIO_URL)]: {
        ...captured(BIO_URL)[save(BIO_URL)],
        during: () => data.write(file, data.read(file).replace("/issues", "/edited-after-check")),
      },
      ...captured(SITE_URL),
      ...captured("https://janeexample.com/edited-after-check"),
    });
    assert.strictEqual(result.stdout, `${JANE_BIO} archived\n${JANE_SITE} snapshot-hash\n`);
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.seen, [save(BIO_URL)]);
    assert.strictEqual(archives(data), `${JANE_BIO}\t${STAMP}\n`);
  });

  // Value: protects=archives.tsv is read by publish's own rule before anything is sent, so the batch never appends to a log publish would refuse; fails_when=a torn or foreign line is appended to; why_new=new; seam=cli; no_claim=publish's archives-invalid (publish-page.test.js)
  it("sends nothing while archives.tsv is invalid", async () => {
    const data = await ballotCiting();
    for (const text of ["sources/x.md\t2026\n", `${JANE_BIO}\t${STAMP}`]) {
      data.write(`${BALLOT}/archives.tsv`, text);
      const result = await archive(data, BASE);
      assert.strictEqual(result.stdout, "archives.tsv:1 archives-invalid\n", JSON.stringify(text));
      assert.strictEqual(result.status, 1);
      assert.deepStrictEqual(result.seen, []);
    }
  });

  // Value: protects=the check of archives.tsv under the lock, just before the append: a log torn while a capture was in flight is never appended to, and the batch stops there; fails_when=the append skips its check; why_new=new; seam=cli; no_claim=the check before the run (the test above)
  it("never appends to archives.tsv torn while a capture was in flight", async () => {
    const data = await ballotCiting();
    const torn = `${JANE_SITE}\t2026`;
    const result = await archive(data, {
      [save(BIO_URL)]: {
        ...captured(BIO_URL)[save(BIO_URL)],
        during: () => data.write(`${BALLOT}/archives.tsv`, torn),
      },
      ...captured(SITE_URL),
    });
    assert.strictEqual(result.stdout, "archives.tsv archives-invalid\n");
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.seen, [save(BIO_URL)]);
    assert.strictEqual(archives(data), torn);
  });
});
