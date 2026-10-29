"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT, DEFAULT_TIERS, runInTty } = require("./harness");
const { COUNTY_PAGE, fetchVia, frontMatter, repo, server } = require("./fetch-snapshot-fixture");

// fetch-snapshot on pages that are not the article they stand for
// (snapshot-format.md, Unfetchable pages): redirects that land on another site
// or on a login or subscribe page, and a short teaser, are logged, never saved.

const STORY = "https://county.example.gov/news/certified";
const args = (url = STORY) => [BALLOT, "us-house-07", "_race", "county-page", url];
const SAVED = `${BALLOT}/sources/us-house-07/_race/county-page.md`;
const redirect = (location) => ({ status: 302, headers: { location } });
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The run failed with `code`, logged the URL it was asked for with `reason`,
// and saved nothing.
const refused = (data, result, code, reason, url = STORY) => {
  assert.equal(result.stdout, `us-house-07/_race ${code}\n`);
  assert.equal(result.status, 1);
  assert.match(
    data.read(`${BALLOT}/unfetchable.md`),
    new RegExp(
      `^- ${escaped(url)} \\| us-house-07/_race \\| \\d{4}-\\d{2}-\\d{2} \\| ${escaped(reason)}\\n$`,
    ),
  );
  assert.ok(!data.exists(SAVED));
};

describe("fetch-snapshot logs redirects that land off the site it was asked for", () => {
  it("refuses redirects that land on another tiered host", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        [STORY]: redirect("https://news.example.com/story"),
        "https://news.example.com/story": { body: COUNTY_PAGE },
      },
      args(),
    );
    refused(data, result, "off-site-redirect", "off-site redirect to news.example.com");
  });

  // Value: protects=M1 of the PR #18 review: a paywall's or login's own host is rarely tiered, and the article it took must still reach the review list, logged under the URL given, the untiered host never contacted; fails_when=an untiered off-site hop is logged as domain-not-in-tiers again (which review-list drops), or is requested; why_new=PR #18 review (B#1); seam=cli; no_claim=none
  it("refuses redirects to a host missing from tiers.yaml as off-site, never contacting it", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { [STORY]: redirect("https://sso.vendor.example.net/authorize?next=1") },
      args(),
    );
    refused(data, result, "off-site-redirect", "off-site redirect to sso.vendor.example.net");
    assert.deepEqual(result.seen, [STORY]);
  });

  it("judges a landing by its URL whatever it answered", async () => {
    const data = repo();
    // The test server answers 404 for a route it does not hold.
    const result = await fetchVia(
      data,
      { [STORY]: redirect("https://news.example.com/x") },
      args(),
    );
    refused(data, result, "off-site-redirect", "off-site redirect to news.example.com");
  });

  it("follows redirects that pass through another site and land back on this one", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        [STORY]: redirect("https://news.example.com/consent"),
        "https://news.example.com/consent": redirect(`${STORY}?ok=1`),
        [`${STORY}?ok=1`]: { body: COUNTY_PAGE },
      },
      args(),
    );
    assert.equal(result.status, 0, result.stdout);
  });

  it("follows a redirect that only adds or drops www, or moves to https", async () => {
    const data = repo();
    const http = STORY.replace("https:", "http:");
    const result = await fetchVia(
      data,
      {
        [http]: redirect(STORY),
        [STORY]: redirect("https://www.county.example.gov/news/certified"),
        "https://www.county.example.gov/news/certified": { body: COUNTY_PAGE },
      },
      args(http),
    );
    assert.equal(result.status, 0, result.stdout);
  });

  it("still logs a redirect within the site to an untiered path as domain-not-in-tiers", async () => {
    const data = repo({
      tiers: `${DEFAULT_TIERS}- match: www.paper.example/news/
  tier: T2
  owner: third-party
  source: Example Paper
`,
    });
    const story = "https://www.paper.example/news/story";
    const result = await fetchVia(
      data,
      { [story]: redirect("https://www.paper.example/archive/story") },
      [BALLOT, "us-house-07", "_race", "county-page", story],
    );
    assert.equal(result.stdout, "us-house-07/_race domain-not-in-tiers\n");
    assert.deepEqual(result.seen, [story]);
  });
});

describe("fetch-snapshot logs redirects that land on a login or subscribe page", () => {
  for (const location of [
    "/login?next=/news/certified",
    "/Account/SignIn.aspx",
    "/login;jsessionid=ABC123",
    "/subscribe/offer",
    "https://www.county.example.gov/paywall",
  ]) {
    it(`refuses redirects that land on ${location}`, async () => {
      const data = repo();
      // The test server answers 404 for the login page: the URL decides, not the status.
      const result = await fetchVia(data, { [STORY]: redirect(location) }, args());
      refused(data, result, "login-redirect", "login redirect");
    });
  }

  it("follows redirects that pass through a single sign-on check and land on the article", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        [STORY]: redirect("/sso/check?return=/news/certified"),
        "https://county.example.gov/sso/check?return=/news/certified": redirect(`${STORY}?sso=1`),
        [`${STORY}?sso=1`]: { body: COUNTY_PAGE },
      },
      args(),
    );
    assert.equal(result.status, 0, result.stdout);
  });

  it("saves a page asked for by a path that only looks like one", async () => {
    const data = repo();
    const url = "https://county.example.gov/elections/register";
    const result = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, args(url));
    assert.equal(result.status, 0, result.stdout);
  });

  // Value: protects=a wall word the URL given already has is not a wall, so a county page's own canonicalizing redirect is followed; fails_when=isWall reads the landing URL alone again; why_new=PR #18 review (B#4); seam=cli; no_claim=none
  it("follows a trailing-slash or www redirect on such a path, but not one on to a login", async () => {
    const url = "https://county.example.gov/elections/register";
    for (const landed of [`${url}/`, "https://www.county.example.gov/elections/register"]) {
      const data = repo();
      const result = await fetchVia(
        data,
        { [url]: redirect(landed), [landed]: { body: COUNTY_PAGE } },
        args(url),
      );
      assert.equal(result.status, 0, `${landed}: ${result.stdout}`);
    }
    const data = repo();
    const result = await fetchVia(
      data,
      { [url]: redirect("/login?next=/elections/register") },
      args(url),
    );
    refused(data, result, "login-redirect", "login redirect", url);
  });

  it("follows a redirect whose path only contains such a word", async () => {
    const data = repo();
    const landed = "https://county.example.gov/news/login-help-for-voters";
    const result = await fetchVia(
      data,
      { [STORY]: redirect(landed), [landed]: { body: COUNTY_PAGE } },
      args(),
    );
    assert.equal(result.status, 0, result.stdout);
  });
});

describe("fetch-snapshot logs a page with under 500 characters of readable text", () => {
  // A page whose readable text is one paragraph of exactly `length` characters.
  const pageOf = (length) =>
    `<html><body><article><p>${"x".repeat(length)}</p></article></body></html>`;

  it("refuses 499 characters as a short page", async () => {
    const data = repo();
    const result = await fetchVia(data, { [STORY]: { body: pageOf(499) } }, args());
    refused(data, result, "short-page", "short page");
  });

  it("saves 500", async () => {
    const data = repo();
    const result = await fetchVia(data, { [STORY]: { body: pageOf(500) } }, args());
    assert.equal(result.status, 0, result.stdout);
  });

  it("logs the URL asked for when a redirect lands on a teaser", async () => {
    const data = repo();
    const teaser = "https://county.example.gov/news/certified/preview";
    const result = await fetchVia(
      data,
      { [STORY]: redirect(teaser), [teaser]: { body: pageOf(100) } },
      args(),
    );
    refused(data, result, "short-page", "short page");
  });
});

// Value: protects=O2 of the PR #18 review: an entry clears once the URL it logged is saved, even when that URL holds a |, which href keeps raw; fails_when=the log and the front matter spell the URL differently again; why_new=PR #18 review (A#3, B#6); seam=cli; no_claim=review-list's comparison (review-list.test.js)
describe("fetch-snapshot spells a URL the same in unfetchable.md and in front matter", () => {
  it("escapes a | in both", async () => {
    const data = repo();
    const url = "https://county.example.gov/news/a|b";
    const logged = "https://county.example.gov/news/a%7Cb";
    const teaser = "<html><body><p>Jane Example is running for Congress.</p></body></html>";
    const short = await fetchVia(data, { [url]: { body: teaser } }, args(url));
    refused(data, short, "short-page", "short page", logged);
    const saved = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, args(url));
    assert.equal(saved.status, 0, saved.stdout);
    const field = Object.fromEntries(frontMatter(data.read(SAVED)));
    assert.equal(field.url, logged);
    assert.equal(field.requested_url, logged);
  });
});

describe("fetch-snapshot --keep-short saves a short page the researcher confirms", () => {
  const TEASER = { body: "<html><body><p>Jane Example is running for Congress.</p></body></html>" };
  // Run --keep-short on a pseudo-terminal through a local server holding `routes`.
  const keepShort = async (data, routes, answer) => {
    const web = await server(routes);
    return runInTty("fetch-snapshot", ["--keep-short", ...args()], {
      cwd: data.root,
      env: { ...data.env, RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target },
      answer,
    });
  };
  const lines = (result) =>
    result.stdout.split("\n").filter((l) => l.trim() && !l.includes("[y/N]"));

  // Value: protects=D4 of the PR #18 review: a page that is short but is the article can be saved, only on a yes at the researcher's terminal, and it then clears the entry the plain fetch logged; fails_when=the prompt is skipped, a no saves or logs, or the mode runs without a terminal; why_new=D4(b); seam=cli; no_claim=the hook and deny rules (fetch-snapshot-ballot.test.js)
  it("saves on a yes, and logs nothing on a no", async () => {
    const data = repo();
    const refusedRun = await fetchVia(data, { [STORY]: TEASER }, args());
    refused(data, refusedRun, "short-page", "short page");
    const log = data.read(`${BALLOT}/unfetchable.md`);

    const no = await keepShort(data, { [STORY]: TEASER }, "n");
    assert.deepEqual(lines(no).slice(-1), ["us-house-07/_race not-confirmed"]);
    assert.equal(no.status, 1);
    assert.ok(!data.exists(SAVED));
    assert.equal(data.read(`${BALLOT}/unfetchable.md`), log);

    const yes = await keepShort(data, { [STORY]: TEASER }, "y");
    assert.match(
      yes.stdout,
      /Save https:\/\/county\.example\.gov\/news\/certified, 37 characters of text, as us-house-07\/_race\? \[y\/N\]/,
    );
    assert.deepEqual(lines(yes).slice(-1), ["sources/us-house-07/_race/county-page.md saved"]);
    assert.equal(yes.status, 0);
    assert.equal(Object.fromEntries(frontMatter(data.read(SAVED))).requested_url, STORY);
  });

  it("refuses without a terminal, before fetching", async () => {
    const data = repo();
    const result = await fetchVia(data, { [STORY]: TEASER }, ["--keep-short", ...args()]);
    assert.equal(result.stdout, "- not-a-terminal\n");
    assert.equal(result.status, 1);
    assert.deepEqual(result.seen, []);
  });
});
