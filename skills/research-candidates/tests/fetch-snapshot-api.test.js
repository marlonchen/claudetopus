"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT, DEFAULT_TIERS } = require("./harness");
const {
  COUNTY_PAGE,
  PLAIN,
  body,
  fetchVia,
  frontMatter,
  repo,
} = require("./fetch-snapshot-fixture");

// fetch-snapshot on API endpoints (snapshot-format.md, Body): a JSON response
// is saved as `method: api`, flattened to `key: value` records.

const FEC_TIERS = `${DEFAULT_TIERS}- match: api.open.fec.gov
  tier: T1
  owner: third-party
  source: FEC candidate data
`;
const OPENSTATES_TIERS = `${DEFAULT_TIERS}- match: v3.openstates.org
  tier: T1
  owner: third-party
  source: Open States
`;
const FEC_URL = "https://api.open.fec.gov/v1/candidates/totals/";
const FEC = [BALLOT, "us-house-07", "jane-example", "fec-totals", FEC_URL];
const json = (value) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(value),
});
const SAVED = `${BALLOT}/sources/us-house-07/jane-example/fec-totals.md`;

describe("fetch-snapshot saves an API response as key: value records", () => {
  it("flattens the envelope, then each result as its own record", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const response = {
      api_version: "1.0",
      pagination: { count: 2, page: 1 },
      results: [
        {
          candidate_id: "H0XX00000",
          name: "EXAMPLE, JANE",
          cycles: [2024, 2026],
          receipts: 1234567.89,
        },
        { candidate_id: "H0XX00001", name: "OTHER, PAT", receipts: 5000 },
      ],
    };
    const result = await fetchVia(data, { [FEC_URL]: json(response) }, FEC);
    assert.equal(result.stdout, "sources/us-house-07/jane-example/fec-totals.md saved\n");
    assert.equal(result.status, 0);
    const saved = data.read(SAVED);
    const field = Object.fromEntries(frontMatter(saved));
    assert.equal(field.method, "api");
    assert.equal(field.source, "FEC candidate data");
    assert.equal(
      body(saved),
      [
        "api_version: 1.0",
        "pagination.count: 2",
        "pagination.page: 1",
        "",
        "results.candidate_id: H0XX00000",
        "results.name: EXAMPLE, JANE",
        "results.cycles.0: 2024",
        "results.cycles.1: 2026",
        "results.receipts: 1234567.89",
        "",
        "results.candidate_id: H0XX00001",
        "results.name: OTHER, PAT",
        "results.receipts: 5000",
        "",
      ].join("\n"),
    );
  });
});

// Value: protects=D1 of the PR #18 review: only the two API hosts, whose shapes are known, are saved as api, and only they are told JSON will do; fails_when=JSON from another tiered host is saved again, or every host gets the JSON Accept; why_new=PR #18 review (B#8, D1); seam=cli; no_claim=none
describe("fetch-snapshot takes JSON only from an API host", () => {
  it("refuses JSON from any other tiered host as not-html", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": json({ results: [{ name: "EXAMPLE, JANE" }] }) },
      PLAIN,
    );
    assert.equal(result.stdout, "us-house-07/_race not-html\n");
    assert.equal(result.headers[0].accept, "text/html");
  });

  it("asks an API host for JSON, after HTML", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const result = await fetchVia(data, { [FEC_URL]: json({ results: [{ a: 1 }] }) }, FEC);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.headers[0].accept, "text/html, application/json;q=0.9");
  });
});

describe("fetch-snapshot sends an API key only as a header to its own API", () => {
  const FEC_KEY = "fec-key-0123456789abcdef";
  const STATES_KEY = "states-key-0123456789abcdef";
  const KEYS = { OPENFEC_API_KEY: FEC_KEY, OPENSTATES_API_KEY: STATES_KEY };
  const OK = json({ results: [{ name: "EXAMPLE, JANE" }] });

  it("sends the OpenFEC key as X-Api-Key, with the caller's key parameters stripped", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const given = `${FEC_URL}?api_key=DEMO_KEY&cycle=2026`;
    const result = await fetchVia(
      data,
      { [`${FEC_URL}?cycle=2026`]: OK },
      [...FEC.slice(0, 4), given],
      KEYS,
    );
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(result.seen, [`${FEC_URL}?cycle=2026`]);
    assert.equal(result.headers[0]["x-api-key"], FEC_KEY);
    const saved = data.read(SAVED);
    assert.equal(Object.fromEntries(frontMatter(saved)).url, `${FEC_URL}?cycle=2026`);
    assert.ok(!saved.includes(FEC_KEY));
  });

  it("sends the Open States key to v3.openstates.org", async () => {
    const data = repo({ tiers: OPENSTATES_TIERS });
    const url = "https://v3.openstates.org/people?jurisdiction=pa&name=Example";
    const result = await fetchVia(
      data,
      { [url]: OK },
      [BALLOT, "us-house-07", "jane-example", "openstates-person", url],
      KEYS,
    );
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.headers[0]["x-api-key"], STATES_KEY);
  });

  it("sends no key to any other host, or to its API over plain http", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const county = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
      KEYS,
    );
    assert.equal(county.status, 0, county.stdout);
    assert.equal(county.headers[0]["x-api-key"], undefined);
    const http = FEC_URL.replace("https:", "http:");
    const plain = await fetchVia(data, { [http]: OK }, [...FEC.slice(0, 4), http], KEYS);
    assert.equal(plain.headers[0]["x-api-key"], undefined);
  });

  it("refuses a response that holds a key value, and never logs it", async () => {
    const data = repo({ tiers: FEC_TIERS });
    const echoed = json({ request: { url: `${FEC_URL}?api_key=${FEC_KEY}` }, results: [] });
    const result = await fetchVia(data, { [FEC_URL]: echoed }, FEC, KEYS);
    assert.equal(result.stdout, "us-house-07/jane-example private-key\n");
    assert.equal(result.status, 1);
    assert.ok(!data.exists(SAVED));
    assert.ok(!data.exists(`${BALLOT}/unfetchable.md`));
  });
});
