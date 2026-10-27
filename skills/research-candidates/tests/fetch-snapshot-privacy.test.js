"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT, DEFAULT_PRIVATE } = require("./harness");
const { COUNTY_PAGE, fetchVia, frontMatter, repo } = require("./fetch-snapshot-fixture");

// Rule 7's privacy refusals as the discovery agent sees them: a URL holding a
// private value is never requested, never logged and printed only as a class
// code (snapshot-format.md). The fixture's private values are in harness.js.

const args = (url) => [BALLOT, "us-house-07", "_race", "page", url];
const redirectTo = (location) => ({
  "https://county.example.gov/go": { status: 302, headers: { location } },
});
// A refusal that left no trace: one class-code line, no request past `seen`,
// no unfetchable.md, no snapshot.
const assertRefused = (data, result, code, seen = []) => {
  assert.equal(result.stdout, `us-house-07/_race ${code}\n`);
  assert.equal(result.stderr, "");
  assert.equal(result.status, 1);
  assert.deepEqual(result.seen, seen);
  assert.ok(!data.exists(`${BALLOT}/unfetchable.md`), "a privacy refusal was logged");
  assert.ok(!data.exists(`${BALLOT}/sources`));
};

describe("fetch-snapshot refuses a URL holding a private value", () => {
  // Value: protects=each Rule 7 class refuses with its own code and no request; fails_when=a class is dropped from URL_CLASSES or its loader; why_new=new; seam=cli; no_claim=every spelling (privacy.test.js)
  it("refuses each class with its code, before any request", async () => {
    const cases = [
      ["https://county.example.gov/xx_exampleton_1/", "private-ballot-id"],
      ["https://county.example.gov/?a=123%20Elm%20Street%20Apt%204", "private-address"],
      ["https://county.example.gov/lookup?zip=99999-0001", "private-zip"],
      ["https://county.example.gov/addr-mom", "private-label"],
      ["https://county.example.gov/springfield-township/", "private-string"],
      ["https://county.example.gov/style/bs0412", "private-string"],
      ["https://county.example.gov/q?k=s3cr3t-fec-key", "private-key"],
    ];
    for (const [url, code] of cases) {
      const data = repo();
      const result = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, args(url), {
        OPENFEC_API_KEY: "s3cr3t-fec-key",
      });
      assertRefused(data, result, code);
    }
  });

  // Value: protects=the match runs before the tier lookup; fails_when=main loads tiers.yaml or fetchPage tier-matches before the privacy check, so the agent learns the host is untiered or a broken tiers.yaml masks the refusal; why_new=new; seam=cli; no_claim=none
  it("refuses before reading tiers.yaml or matching a tier", async () => {
    const untiered = repo();
    const url = "https://unknown.example.net/precinct-12";
    assertRefused(untiered, await fetchVia(untiered, {}, args(url)), "private-string");
    const broken = repo({ tiers: "- match: [unclosed\n" });
    assertRefused(broken, await fetchVia(broken, {}, args(url)), "private-string");
  });

  // Value: protects=every redirect hop is checked before it is requested or logged; fails_when=fetchPage checks only the first URL, or checks after the tier lookup or the not-http refusal; why_new=new; seam=cli; no_claim=none
  it("checks every redirect hop before requesting, tier-matching or logging it", async () => {
    for (const [location, code] of [
      ["https://county.example.gov/xx-exampleton-1/ballot", "private-ballot-id"],
      ["https://elsewhere.example.net/?zip=99999", "private-zip"],
      ["ftp://county.example.gov/addr-mom", "private-label"],
      ["https://[bad/springfield township", "private-string"],
    ]) {
      const data = repo();
      const result = await fetchVia(
        data,
        redirectTo(location),
        args("https://county.example.gov/go"),
      );
      assertRefused(data, result, code, ["https://county.example.gov/go"]);
    }
  });

  // Value: protects=a Unicode host is checked in Unicode, not only as punycode; fails_when=spellings() drops the domainToUnicode form; why_new=new; seam=cli; no_claim=confusable letters (TODOS)
  it("reads a punycode host in Unicode", async () => {
    const data = repo({
      private: DEFAULT_PRIVATE.replace("private_strings:\n", "$&  - Peña Hall\n"),
    });
    const host = new URL("https://peña-hall.example.net/").host;
    assert.match(host, /^xn--/);
    const result = await fetchVia(
      data,
      redirectTo(`https://${host}/`),
      args("https://county.example.gov/go"),
    );
    assertRefused(data, result, "private-string", ["https://county.example.gov/go"]);
  });

  // Value: protects=private values are read from private.yaml and addresses.yaml, which must parse; fails_when=a missing or malformed file is read as no values; why_new=new; seam=cli; no_claim=ballot-check's own checks of these files
  it("refuses to fetch without readable private.yaml and addresses.yaml", async () => {
    const url = "https://county.example.gov/";
    const routes = { [url]: { body: COUNTY_PAGE } };
    for (const [options, line] of [
      [{ private: false }, `${BALLOT}/private.yaml file-missing`],
      [{ addresses: false }, "addresses.yaml file-missing"],
      [{ private: "private_strings: Precinct 12\n" }, `${BALLOT}/private.yaml private-invalid`],
      [{ addresses: "addr-mom:\n  ballot: x\n" }, "addresses.yaml:1 addresses-invalid"],
      [{ addresses: "- 123 Elm Street\n" }, "addresses.yaml addresses-invalid"],
    ]) {
      const data = repo(options);
      const result = await fetchVia(data, routes, args(url));
      assert.equal(result.stdout, `${line}\n`);
      assert.deepEqual(result.seen, []);
    }
  });
});

describe("fetch-snapshot keeps API keys out of every recorded URL", () => {
  // Value: protects=key parameters are stripped from snapshots and the log; fails_when=cleanUrl stops removing KEY_PARAM names; why_new=no test fetched a URL with a key parameter; seam=cli; no_claim=api mode, which adds keys itself
  it("strips key parameters from the snapshot url and the unfetchable log", async () => {
    const data = repo();
    const url = "https://county.example.gov/list?api_key=DEMO_KEY&page=2&apiKey=x";
    const saved = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, args(url));
    assert.equal(saved.status, 0);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/_race/page.md`)),
    );
    assert.equal(field.url, "https://county.example.gov/list?page=2");

    const missing = "https://county.example.gov/gone?token=abc&access_token=def";
    const refused = await fetchVia(data, {}, args(missing));
    assert.equal(refused.stdout, "us-house-07/_race http-error\n");
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/county\.example\.gov\/gone \| /,
    );
  });
});
