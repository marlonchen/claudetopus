"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { describe, it } = require("node:test");
const { ARTICLE_FILLER, BALLOT, articlePage, startServer } = require("./harness");
const {
  COUNTY_PAGE,
  PLAIN,
  body,
  fetchSnapshot,
  fetchVia,
  frontMatter,
  repo,
  sha256,
} = require("./fetch-snapshot-fixture");

// fetch-snapshot as the researcher and the discovery agent see it: exit code,
// `location code` lines on stdout, and the files it writes or leaves alone.
// Saves, the unfetchable log and output lines.

describe("fetch-snapshot saves a tiered HTML page as a write-once snapshot", () => {
  it("saves the readable text with front matter from the matched tiers.yaml entry", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.equal(result.status, 0);

    const saved = data.read(`${BALLOT}/sources/us-house-07/_race/county-page.md`);
    const fields = frontMatter(saved);
    assert.deepEqual(
      fields.map(([key]) => key),
      [
        "source",
        "url",
        "requested_url",
        "fetched",
        "method",
        "tier",
        "statements_only",
        "subject",
        "owner",
      ],
    );
    const field = Object.fromEntries(fields);
    assert.equal(field.source, "Exampleton County elections");
    assert.equal(field.url, "https://county.example.gov/");
    assert.equal(field.requested_url, "https://county.example.gov/");
    assert.match(field.fetched, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(field.method, "html");
    assert.equal(field.tier, "T1");
    assert.equal(field.statements_only, "false");
    assert.equal(field.subject, "_race");
    assert.equal(field.owner, "third-party");

    const text = body(saved);
    assert.match(text, /The county certified two candidates for the 7th District on October 1\./);
    assert.match(text, /\n\nBallots will be mailed/);
    assert.doesNotMatch(text, /About|Copyright/);
    assert.ok(text.endsWith("\n"));

    assert.equal(
      data.read(`${BALLOT}/snapshots.sha256`),
      `${sha256(saved)}  sources/us-house-07/_race/county-page.md\n`,
    );
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  });

  it("records the URL it was asked for beside the one the redirects landed on", async () => {
    const data = repo();
    const given = "https://county.example.gov/news?id=7&api_key=DEMO_KEY#top";
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/news?id=7&api_key=DEMO_KEY": {
          status: 301,
          headers: { location: "/elections/certified" },
        },
        "https://county.example.gov/elections/certified": { body: COUNTY_PAGE },
      },
      [...PLAIN.slice(0, 4), given],
    );
    assert.equal(result.status, 0, result.stdout);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/_race/county-page.md`)),
    );
    assert.equal(field.url, "https://county.example.gov/elections/certified");
    assert.equal(field.requested_url, "https://county.example.gov/news?id=7");
  });

  it("writes a re-fetch to a new numbered file and never overwrites one", async () => {
    const data = repo();
    const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
    const dir = `${BALLOT}/sources/us-house-07/_race`;
    assert.equal((await fetchVia(data, routes, PLAIN)).status, 0);
    const first = data.read(`${dir}/county-page.md`);
    const second = await fetchVia(data, routes, PLAIN);
    assert.equal(second.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assert.equal(data.read(`${dir}/county-page.md`), first);
    assert.deepEqual(data.list(dir), ["county-page-2.md", "county-page.md"]);
    assert.equal(data.read(`${BALLOT}/snapshots.sha256`).split("\n").length, 3);
  });

  it("never reuses the path of a retired snapshot", async () => {
    const data = repo();
    const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
    await fetchVia(data, routes, PLAIN);
    const rel = "sources/us-house-07/_race/county-page.md";
    data.write(
      `${BALLOT}/snapshots.sha256`,
      `${data.read(`${BALLOT}/snapshots.sha256`)}-  ${rel}\n`,
    );
    fs.rmSync(data.file(`${BALLOT}/${rel}`));
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assert.ok(!data.exists(`${BALLOT}/${rel}`));
  });

  it("files a candidate's page under the candidate", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://news.example.com/jane": { body: COUNTY_PAGE } },
      [BALLOT, "us-house-07", "jane-example", "profile", "https://news.example.com/jane"],
    );
    assert.equal(result.stdout, "sources/us-house-07/jane-example/profile.md saved\n");
  });

  it("records the URL without API-key parameters or a fragment", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/list?api_key=abc&page=2": { body: COUNTY_PAGE } },
      [
        BALLOT,
        "us-house-07",
        "_race",
        "list",
        "https://county.example.gov/list?api_key=abc&page=2#top",
      ],
    );
    assert.equal(result.status, 0);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/_race/list.md`)),
    );
    assert.equal(field.url, "https://county.example.gov/list?page=2");
  });

  it("falls back to the page body when Readability finds no article", async () => {
    const data = repo();
    const page =
      `<html><body><nav>Menu</nav><div>Filing deadline: August 1. ${ARTICLE_FILLER}</div>` +
      "<script>var tracker = 1;</script><footer>Footer</footer></body></html>";
    const result = await fetchVia(data, { "https://county.example.gov/": { body: page } }, PLAIN);
    assert.equal(result.status, 0);
    const text = body(data.read(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assert.match(text, /Filing deadline: August 1\./);
    assert.doesNotMatch(text, /tracker|Menu|Footer/);
  });

  // Value: protects=a page is decoded with the charset its content-type names; fails_when=decode ignores the charset parameter and reads every body as UTF-8, turning windows-1252 quotes and accents into U+FFFD; why_new=every other page is served as UTF-8; seam=none; no_claim=charsets named only in a meta tag
  it("decodes the page with the charset its content-type names", async () => {
    const data = repo();
    const page = Buffer.from(
      articlePage("Candidates certified", [
        "The clerk called the list \x93final\x94 for Ren\xe9e Example on October 1.",
        "Ballots will be mailed to voters starting October 8.",
      ]),
      "latin1",
    );
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/": {
          headers: { "content-type": "text/html; charset=windows-1252" },
          body: page,
        },
      },
      PLAIN,
    );
    assert.equal(result.status, 0);
    const text = body(data.read(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assert.match(text, /the list \u201cfinal\u201d for Ren\u00e9e Example/);
    assert.doesNotMatch(text, /\ufffd/);
  });
});

describe("a page that cannot be saved is logged, never saved", () => {
  const logged = (name, route, code, reason) =>
    it(name, async () => {
      const data = repo();
      const result = await fetchVia(data, { "https://county.example.gov/": route }, PLAIN);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, `us-house-07/_race ${code}\n`);
      assert.match(data.read(`${BALLOT}/unfetchable.md`), new RegExp(` \\| ${reason}\\n$`));
      assert.ok(!data.exists(`${BALLOT}/sources`));
    });
  logged("an HTTP error", { status: 403, body: "Forbidden" }, "http-error", "http 403");
  logged(
    "a response that is not HTML",
    { headers: { "content-type": "application/pdf" } },
    "not-html",
    "not html",
  );
  logged(
    "a page larger than the size cap",
    { headers: { "content-length": String(11 * 1024 * 1024) }, body: "x".repeat(11 * 1024 * 1024) },
    "too-large",
    "too large",
  );
  // Value: protects=the size cap on a streamed body with no content-length; fails_when=readCapped trusts only the content-length header and buffers the whole body; why_new=the existing too-large case sends content-length, so only the header branch runs; seam=none; no_claim=memory use while streaming
  logged(
    "a page larger than the size cap that sends no content-length",
    { headers: { "transfer-encoding": "chunked" }, body: "x".repeat(11 * 1024 * 1024) },
    "too-large",
    "too large",
  );
  logged(
    "a page with no text",
    { body: "<html><body><script>x()</script></body></html>" },
    "no-readable-text",
    "no readable text",
  );
  // Value: protects=a hop that cannot be reached is logged as a network error, not a crash; fails_when=fetchPage lets the fetch rejection escape, so the run ends internal-error with nothing in unfetchable.md; why_new=every other hop reaches a live server; seam=none; no_claim=timeouts or DNS failures specifically
  it("a host that cannot be reached", async () => {
    const data = repo();
    const closed = await startServer({});
    const target = closed.target;
    await closed.close();
    const result = await fetchSnapshot(data, PLAIN, {
      RESEARCH_CANDIDATES_TEST_HTTP_TARGET: target,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/_race network-error\n");
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/county\.example\.gov\/ \| us-house-07\/_race \| \d{4}-\d{2}-\d{2} \| network error\n$/,
    );
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });
});

describe("output holds only location code [key] lines", () => {
  it("answers bad arguments with a usage code and writes nothing", async () => {
    const data = repo();
    for (const args of [[], [BALLOT, "us-house-07"], [...PLAIN.slice(0, 4), "--ballot"]]) {
      const result = await fetchSnapshot(data, args);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "- usage\n");
    }
    const badBallot = await fetchSnapshot(data, ["2026-general/../x", ...PLAIN.slice(1)]);
    assert.equal(badBallot.stdout, "- bad-ballot\n");
    // Value: protects=a first argument naming an Object.prototype key is a ballot, not a mode; fails_when=main looks modes up through the prototype chain; why_new=--searched made modes a lookup table; seam=none; no_claim=other bad ballot spellings
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const result = await fetchSnapshot(data, [key, ...PLAIN.slice(1)]);
      assert.equal(result.stdout, "- bad-ballot\n", key);
      assert.equal(result.status, 1, key);
    }
    // Value: protects=only an http(s) URL argument is accepted; fails_when=parseArgs drops the isHttp check or the URL parse guard; why_new=no test passed a bad URL argument; seam=none; no_claim=URLs that parse but are unreachable
    for (const url of ["ftp://county.example.gov/", "file:///etc/passwd", "not a url"]) {
      const badUrl = await fetchSnapshot(data, [...PLAIN.slice(0, 4), url]);
      assert.equal(badUrl.status, 1);
      assert.equal(badUrl.stdout, "- bad-url\n");
    }
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml", "private.yaml"]);
  });

  // Value: protects=a well-formed ballot argument naming no ballot directory is refused before anything is written; fails_when=main drops the ballot-directory check, so recover or the unfetchable log creates <election>/<ballot-id>/ on the fly; why_new=every other test names the one existing ballot; seam=none; no_claim=a ballot directory without ballot.yaml
  it("answers unknown-ballot for a ballot with no directory and creates none", async () => {
    const data = repo();
    const other = "2026-general/xx-elsewhere-1";
    const result = await fetchVia(data, { "https://county.example.gov/": { body: COUNTY_PAGE } }, [
      other,
      ...PLAIN.slice(1),
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, `${other} unknown-ballot\n`);
    assert.ok(!data.exists(other));
    assert.deepEqual(data.list("2026-general"), ["xx-exampleton-1"]);
    assert.deepEqual(result.seen, []);
  });
});

describe("front matter is emitted, never assembled from untrusted text", () => {
  it("refuses a source name holding --- or a control character", async () => {
    for (const source of ["'County --- elections'", '"County\\u0085elections"']) {
      const data = repo({
        tiers: `- match: county.example.gov\n  tier: T1\n  owner: third-party\n  source: ${source}\n`,
      });
      const result = await fetchVia(
        data,
        { "https://county.example.gov/": { body: COUNTY_PAGE } },
        PLAIN,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "source unsafe-value\n");
      assert.ok(!data.exists(`${BALLOT}/sources`));
    }
  });

  it("quotes a source name that YAML would otherwise read as another field", async () => {
    const data = repo({
      tiers:
        "- match: county.example.gov\n  tier: T1\n  owner: third-party\n  source: 'County: tier: T1'\n",
    });
    await fetchVia(data, { "https://county.example.gov/": { body: COUNTY_PAGE } }, PLAIN);
    const saved = data.read(`${BALLOT}/sources/us-house-07/_race/county-page.md`);
    assert.match(saved, /^source: "County: tier: T1"$/m);
  });
});

describe("output and the unfetchable log never carry agent text or credentials", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  it("Rule 5: never echoes a malformed subject, so it cannot forge an output line", async () => {
    const data = repo();
    const forged = "x\nsources/us-house-07/_race/forged.md saved";
    const result = await fetchVia(data, routes, [BALLOT, "us-house-07", forged, "n", PLAIN[4]]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/- unknown-subject\n");
    assert.deepEqual(result.seen, []);
  });

  it("refuses a URL holding credentials, and never logs them from a redirect", async () => {
    const data = repo();
    const direct = await fetchVia(data, {}, [
      BALLOT,
      "us-house-07",
      "_race",
      "p",
      "https://u:pw@county.example.gov/",
    ]);
    assert.equal(direct.stdout, "- bad-url\n");
    const redirected = await fetchVia(
      data,
      {
        "https://county.example.gov/go": {
          status: 302,
          headers: { location: "https://u:pw@county.example.gov/in" },
        },
      },
      [BALLOT, "us-house-07", "_race", "p", "https://county.example.gov/go"],
    );
    assert.equal(redirected.status, 1);
    assert.doesNotMatch(data.read(`${BALLOT}/unfetchable.md`), /pw|u:/);
  });

  it("logs a non-http redirect target without letting it forge unfetchable.md fields", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/go": {
          status: 302,
          headers: { location: "data:x, | fake/contest | 2026-01-01 | ok" },
        },
      },
      [BALLOT, "us-house-07", "_race", "p", "https://county.example.gov/go"],
    );
    assert.equal(result.stdout, "us-house-07/_race not-http\n");
    const line = data.read(`${BALLOT}/unfetchable.md`);
    assert.equal(line.split(" | ").length, 4);
    assert.match(line, / \| us-house-07\/_race \| \d{4}-\d{2}-\d{2} \| not http\n$/);
  });

  it("logs a body cut off partway as a network error", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/": {
          headers: { "content-length": "100000" },
          body: "<html><body><p>partial",
        },
      },
      PLAIN,
    );
    assert.equal(result.stdout, "us-house-07/_race network-error\n");
    assert.match(data.read(`${BALLOT}/unfetchable.md`), / \| network error\n$/);
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });
});
