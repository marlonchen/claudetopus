"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT, DEFAULT_BALLOT } = require("./harness");
const {
  COUNTY_PAGE,
  PLAIN,
  fetchSnapshot,
  fetchVia,
  frontMatter,
  repo,
} = require("./fetch-snapshot-fixture");

// fetch-snapshot's tier, owner and source, which come only from tiers.yaml,
// and the ids a path under sources/ is built from.

describe("source-tiers.md: the tier, owner and source come only from tiers.yaml", () => {
  it("refuses and logs a URL whose host matches no entry, without fetching it", async () => {
    const data = repo();
    const url = "https://evilcounty.example.gov/page?token=secret";
    const result = await fetchVia(data, {}, [BALLOT, "us-house-07", "_race", "page", url]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/_race domain-not-in-tiers\n");
    assert.deepEqual(result.seen, []);
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/evilcounty\.example\.gov\/page \| us-house-07\/_race \| \d{4}-\d{2}-\d{2} \| domain not in tiers\.yaml\n$/,
    );
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("starts its entry on a new line after a line a crash cut short", async () => {
    const data = repo();
    const torn = "- https://news.example.com/a | us-house-07/_race | 2026-10-20 | http 4";
    data.write(`${BALLOT}/unfetchable.md`, torn);
    const url = "https://evilcounty.example.gov/page";
    const result = await fetchVia(data, {}, [BALLOT, "us-house-07", "_race", "page", url]);
    assert.equal(result.status, 1);
    // The torn line stays, for review-list to locate; the new entry is whole.
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/news\.example\.com\/a \| us-house-07\/_race \| 2026-10-20 \| http 4\n- https:\/\/evilcounty\.example\.gov\/page \| us-house-07\/_race \| \d{4}-\d{2}-\d{2} \| domain not in tiers\.yaml\n$/,
    );
  });

  it("matches a path prefix only on a segment boundary, and the longest match wins", async () => {
    const data = repo();
    const routes = {
      "https://www.news.example.com/opinion/jane-op-ed": { body: COUNTY_PAGE },
      "https://news.example.com/opinionated/story": { body: COUNTY_PAGE },
    };
    const run = (name, url) =>
      fetchVia(data, routes, [BALLOT, "us-house-07", "jane-example", name, url]);
    await run("op-ed", "https://www.news.example.com/opinion/jane-op-ed");
    await run("story", "https://news.example.com/opinionated/story");
    const fields = (name) =>
      Object.fromEntries(
        frontMatter(data.read(`${BALLOT}/sources/us-house-07/jane-example/${name}.md`)),
      );
    assert.equal(fields("op-ed").tier, "T4");
    assert.equal(fields("op-ed").statements_only, "true");
    assert.equal(fields("op-ed").source, "Example News opinion page");
    assert.equal(fields("story").tier, "T2");
    assert.equal(fields("story").source, "Example News");
  });

  it("takes the strictest tier across redirects and the final URL's source", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://news.example.com/go": {
          status: 302,
          headers: { location: "https://news.example.com/opinion/piece" },
        },
        "https://news.example.com/opinion/piece": { body: COUNTY_PAGE },
      },
      [BALLOT, "us-house-07", "_race", "piece", "https://news.example.com/go"],
    );
    assert.equal(result.status, 0, result.stdout);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/_race/piece.md`)),
    );
    assert.equal(field.tier, "T4");
    assert.equal(field.statements_only, "true");
    assert.equal(field.source, "Example News opinion page");
    assert.equal(field.url, "https://news.example.com/opinion/piece");
  });

  it("refuses a redirect to an unmatched host before contacting it, as off-site", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/go": {
          status: 301,
          headers: { location: "https://tracker.example.net/landing" },
        },
      },
      [BALLOT, "us-house-07", "_race", "page", "https://county.example.gov/go"],
    );
    assert.equal(result.stdout, "us-house-07/_race off-site-redirect\n");
    assert.deepEqual(result.seen, ["https://county.example.gov/go"]);
    // Logged under the URL given (snapshot-format.md, Unfetchable pages), so
    // review-list lists it; a domain refusal it would drop.
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/county\.example\.gov\/go \| .* \| off-site redirect to tracker\.example\.net\n$/,
    );
  });

  // Value: protects=a redirect is followed only to an http(s) URL; fails_when=fetchPage drops the per-hop isHttp check; why_new=only the start URL is checked elsewhere; seam=none; no_claim=other schemes' handling by fetch itself
  it("refuses and logs a redirect to a URL that is not http", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://county.example.gov/go": {
          status: 302,
          headers: { location: "ftp://county.example.gov/list" },
        },
      },
      [BALLOT, "us-house-07", "_race", "page", "https://county.example.gov/go"],
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/_race not-http\n");
    assert.deepEqual(result.seen, ["https://county.example.gov/go"]);
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- ftp:\/\/county\.example\.gov\/list \| us-house-07\/_race \| \d{4}-\d{2}-\d{2} \| not http\n$/,
    );
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  // Value: protects=the redirect hop cap; fails_when=MAX_HOPS check is removed or off by more than one, so a redirect loop runs forever or longer; why_new=no test redirects more than once; seam=none; no_claim=the exact cap value beyond 11 requests
  it("refuses and logs a redirect loop after ten redirects", async () => {
    const data = repo();
    const loop = "https://county.example.gov/loop";
    const result = await fetchVia(data, { [loop]: { status: 302, headers: { location: loop } } }, [
      BALLOT,
      "us-house-07",
      "_race",
      "page",
      loop,
    ]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/_race too-many-redirects\n");
    assert.equal(result.seen.length, 11);
    assert.match(data.read(`${BALLOT}/unfetchable.md`), / \| too many redirects\n$/);
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("refuses and logs a redirect that changes the owner", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      {
        "https://news.example.com/questionnaire": {
          status: 302,
          headers: { location: "https://janeexample.com/issues" },
        },
      },
      [BALLOT, "us-house-07", "jane-example", "q", "https://news.example.com/questionnaire"],
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/jane-example owner-changes-across-redirects\n");
    assert.match(data.read(`${BALLOT}/unfetchable.md`), / \| owner changes across redirects\n$/);
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("refuses to file a campaign site under a rival or _race", async () => {
    const data = repo();
    const routes = { "https://janeexample.com/issues": { body: COUNTY_PAGE } };
    for (const subject of ["john-sample", "_race"]) {
      const result = await fetchVia(data, routes, [
        BALLOT,
        "us-house-07",
        subject,
        "issues",
        "https://janeexample.com/issues",
      ]);
      assert.equal(result.stdout, `us-house-07/${subject} owner-not-subject\n`);
    }
    assert.ok(!data.exists(`${BALLOT}/sources`));
    const own = await fetchVia(data, routes, [
      BALLOT,
      "us-house-07",
      "jane-example",
      "issues",
      "https://janeexample.com/issues",
    ]);
    assert.equal(own.status, 0);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/jane-example/issues.md`)),
    );
    assert.equal(field.owner, "jane-example");
  });

  it("files a campaign site under a subject of another contest, keeping its owner", async () => {
    const data = repo();
    const url = "https://janeexample.com/judges";
    const result = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, [
      BALLOT,
      "supreme-court-retention-a",
      "pat-example",
      "jane-on-judges",
      url,
    ]);
    assert.equal(
      result.stdout,
      "sources/supreme-court-retention-a/pat-example/jane-on-judges.md saved\n",
    );
    const saved = data.read(
      `${BALLOT}/sources/supreme-court-retention-a/pat-example/jane-on-judges.md`,
    );
    const field = Object.fromEntries(frontMatter(saved));
    assert.equal(field.owner, "jane-example");
    assert.equal(field.subject, "pat-example");
  });

  it("refuses a contest or subject ballot.yaml does not list", async () => {
    const data = repo();
    const url = "https://county.example.gov/";
    const unknownContest = await fetchSnapshot(data, [BALLOT, "us-senate", "_race", "p", url]);
    assert.equal(unknownContest.stdout, `${BALLOT}/ballot.yaml unknown-contest\n`);
    const unknownSubject = await fetchSnapshot(data, [
      BALLOT,
      "us-house-07",
      "pat-example",
      "p",
      url,
    ]);
    assert.equal(unknownSubject.stdout, "us-house-07/pat-example unknown-subject\n");
    const traversal = await fetchSnapshot(data, [BALLOT, "us-house-07", "_race", "../../x", url]);
    assert.equal(traversal.stdout, "us-house-07/_race bad-name\n");
  });
});

describe("ballot-format.md, Ids: a path under sources/ is built only from safe ids", () => {
  it("never builds a path from an id ballot-check would fail, even one ballot.yaml lists", async () => {
    const data = repo({
      ballot: DEFAULT_BALLOT.replace("id: us-house-07", "id: ../us-house-07"),
    });
    const url = "https://county.example.gov/";
    const contest = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, [
      BALLOT,
      "../us-house-07",
      "_race",
      "p",
      url,
    ]);
    assert.equal(contest.stdout, `${BALLOT}/ballot.yaml unknown-contest\n`);
    assert.ok(!data.exists(`${BALLOT}/sources`));
    assert.deepEqual(data.list("2026-general"), ["xx-exampleton-1"]);
  });

  it("refuses a name ending in -<digits>, which only a re-fetch may have", async () => {
    const data = repo();
    const url = "https://county.example.gov/";
    for (const name of ["county-page-2", "report-10"]) {
      const result = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, [
        BALLOT,
        "us-house-07",
        "_race",
        name,
        url,
      ]);
      assert.equal(result.stdout, "us-house-07/_race bad-name\n");
      assert.deepEqual(result.seen, []);
    }
    assert.ok(!data.exists(`${BALLOT}/sources`));
    const numbered = await fetchVia(data, { [url]: { body: COUNTY_PAGE } }, [
      BALLOT,
      "us-house-07",
      "_race",
      "2026-filing",
      url,
    ]);
    assert.equal(numbered.stdout, "sources/us-house-07/_race/2026-filing.md saved\n");
  });
});

describe("source-tiers.md: loading tiers.yaml refuses a bad entry", () => {
  const refusesTiers = (name, tiers, code) =>
    it(name, async () => {
      const data = repo({ tiers });
      const result = await fetchVia(
        data,
        { "https://county.example.gov/": { body: COUNTY_PAGE } },
        PLAIN,
      );
      assert.equal(result.status, 1);
      assert.equal(result.stdout, code);
      assert.deepEqual(result.seen, []);
    });
  const COUNTY =
    "- match: county.example.gov\n  tier: T1\n  owner: third-party\n  source: County\n";

  refusesTiers(
    "an entry with no owner",
    `${COUNTY}- match: news.example.com\n  tier: T2\n  source: News\n`,
    "tiers.yaml:5 tiers-no-owner\n",
  );
  refusesTiers(
    "an entry with no source",
    "- match: county.example.gov\n  tier: T1\n  owner: third-party\n",
    "tiers.yaml:1 tiers-no-source\n",
  );
  refusesTiers(
    "a candidate owner on an entry that is not T4 statements only",
    `${COUNTY}- match: janeexample.com\n  tier: T2\n  owner: jane-example\n  source: Jane\n`,
    "tiers.yaml:5 tiers-owner-not-statements\n",
  );
  refusesTiers(
    "an owner no ballot.yaml lists",
    `${COUNTY}- match: x.example.com\n  tier: T4\n  statements_only: true\n  owner: nobody-here\n  source: X\n`,
    "tiers.yaml:5 tiers-unknown-owner\n",
  );
  refusesTiers(
    "a T4 entry without statements_only: true",
    `${COUNTY}- match: x.example.com\n  tier: T4\n  owner: third-party\n  source: X\n`,
    "tiers.yaml:5 tiers-statements-only\n",
  );
  refusesTiers(
    "a tier that is not T1-T4, even an inherited property name",
    "- match: county.example.gov\n  tier: toString\n  owner: third-party\n  source: County\n",
    "tiers.yaml:1 tiers-invalid\n",
  );
  refusesTiers(
    "a match that is not a host and path",
    "- match: https://county.example.gov/\n  tier: T1\n  owner: third-party\n  source: County\n",
    "tiers.yaml:1 tiers-invalid\n",
  );
  refusesTiers(
    "two entries for the same host and path, so the first would win unseen",
    `${COUNTY}- match: News.example.com/opinion/\n  tier: T2\n  owner: third-party\n  source: A\n` +
      "- match: news.example.com/opinion\n  tier: T4\n  statements_only: true\n  owner: third-party\n  source: B\n",
    "tiers.yaml:9 tiers-overlap\n",
  );
  refusesTiers(
    "a deeper host and a shorter path that both match one URL",
    `${COUNTY}- match: www.example-paper.com\n  tier: T2\n  owner: third-party\n  source: A\n` +
      "- match: example-paper.com/opinion\n  tier: T4\n  statements_only: true\n  owner: third-party\n  source: B\n",
    "tiers.yaml:9 tiers-overlap\n",
  );
  // Value: protects=tiers.yaml must exist, parse strictly and be a list before any URL is fetched; fails_when=readYamlDocument drops uniqueKeys or the error check, loadTiers drops the isSeq check, or a missing file surfaces as internal-error; why_new=the cases above all reach per-entry checks; seam=none; no_claim=ballot.yaml parse errors
  // ballot-format.md, Tiers: discovery searches with every host, and every source reaches the page.
  refusesTiers(
    "a match holding a private string, matched as the publish scan matches",
    `${COUNTY}- match: springfield-township.example.org\n  tier: T2\n  owner: third-party\n  source: X\n`,
    "tiers.yaml:5 private-string match\n",
  );
  refusesTiers(
    "a source holding a ZIP code from addresses.yaml",
    `${COUNTY}- match: x.example.com\n  tier: T2\n  owner: third-party\n  source: X News 99999\n`,
    "tiers.yaml:8 private-zip source\n",
  );
  it("ends another ballot's private.yaml failure, read for the Tiers rule, with check-each-ballot", async () => {
    const data = repo({ tiers: COUNTY });
    data.write("2026-general/xx-exampleton-2/private.yaml", "private_strings: [unclosed\n");
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "- yaml-invalid\n- check-each-ballot\n");
    assert.deepEqual(result.seen, []);
  });
  refusesTiers("a missing tiers.yaml", false, "tiers.yaml file-missing\n");
  refusesTiers(
    "a tiers.yaml with a duplicate key",
    "- match: county.example.gov\n  tier: T1\n  tier: T2\n  owner: third-party\n  source: County\n",
    "tiers.yaml yaml-invalid\n",
  );
  refusesTiers(
    "a tiers.yaml that is a mapping, not a list",
    "county.example.gov:\n  tier: T1\n  owner: third-party\n  source: County\n",
    "tiers.yaml tiers-invalid\n",
  );
});

describe("a broken ballot.yaml elsewhere in the data repo", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  it("does not name another ballot when its ballot.yaml is broken", async () => {
    const data = repo();
    data.write("2026-general/yy-otherplace-2/ballot.yaml", "contests: [unclosed\n");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "- yaml-invalid\n");
    assert.doesNotMatch(result.stdout, /yy-otherplace/);
  });
});
