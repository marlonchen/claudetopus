"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT } = require("./harness");
const { COUNTY_PAGE, fetchVia, repo } = require("./fetch-snapshot-fixture");

// fetch-snapshot on pages that are not the article they stand for
// (snapshot-format.md, Unfetchable pages): redirects that land on another site
// or on a login or subscribe page, and a short teaser, are logged, never saved.

const STORY = "https://county.example.gov/news/certified";
const args = (url = STORY) => [BALLOT, "us-house-07", "_race", "county-page", url];
const SAVED = `${BALLOT}/sources/us-house-07/_race/county-page.md`;
const redirect = (location) => ({ status: 302, headers: { location } });

// The run failed with `code`, logged the URL it was asked for with `reason`,
// and saved nothing.
const refused = (data, result, code, reason, url = STORY) => {
  assert.equal(result.stdout, `us-house-07/_race ${code}\n`);
  assert.equal(result.status, 1);
  assert.match(
    data.read(`${BALLOT}/unfetchable.md`),
    new RegExp(`^- ${url} \\| us-house-07/_race \\| \\d{4}-\\d{2}-\\d{2} \\| ${reason}\\n$`),
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
    refused(data, result, "off-site-redirect", "off-site redirect");
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

  it("still logs a host missing from tiers.yaml as domain-not-in-tiers", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { [STORY]: redirect("https://elsewhere.example.org/") },
      args(),
    );
    assert.equal(result.stdout, "us-house-07/_race domain-not-in-tiers\n");
  });
});

describe("fetch-snapshot logs redirects that land on a login or subscribe page", () => {
  for (const location of [
    "/login?next=/news/certified",
    "/Account/SignIn.aspx",
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
