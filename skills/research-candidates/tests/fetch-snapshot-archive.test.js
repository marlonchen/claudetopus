"use strict";

const assert = require("node:assert");
const { describe, it } = require("node:test");
const { BALLOT } = require("./harness");
const { fetchSnapshot, repo, server, sha256 } = require("./fetch-snapshot-fixture");

// fetch-snapshot --archive, the Wayback batch (snapshot-format.md, Saved
// copies), run as a subprocess against a temp data repo with the Wayback
// Machine replaced by a local server through RESEARCH_CANDIDATES_TEST_HTTP_TARGET,
// so no test sends anything off this machine.

const STAMP = "20261019120000";
const save = (url) => `https://web.archive.org/save/${url}`;
const captured = (url, stamp = STAMP) => ({
  [save(url)]: {
    status: 302,
    headers: { location: `https://web.archive.org/web/${stamp}/${url}` },
  },
});

// Write a snapshot as fetch-snapshot saves one, with its manifest line, so
// the batch reads it as any saved snapshot. `fields` override the front matter.
const plant = (data, rel, fields = {}) => {
  const front = {
    source: "Example News",
    url: "https://news.example.com/story",
    requested_url: "https://news.example.com/story",
    fetched: "2026-10-19",
    method: "html",
    tier: "T2",
    statements_only: "false",
    subject: rel.split("/")[2],
    owner: "third-party",
    ...fields,
  };
  const yaml = Object.entries(front)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${value}\n`)
    .join("");
  const text = `---\n${yaml}---\nJane Example raised money from donors across the district.\n`;
  data.write(`${BALLOT}/${rel}`, text);
  const manifest = data.exists(`${BALLOT}/snapshots.sha256`)
    ? data.read(`${BALLOT}/snapshots.sha256`)
    : "";
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

const STORY = "sources/us-house-07/jane-example/story.md";
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

describe("fetch-snapshot --archive records Wayback captures in archives.tsv", () => {
  // Value: protects=criteria 1 and 4: a capture appends the snapshot path and its 14-digit timestamp, the request goes to the overridable endpoint as /save/<url>, and a rerun sends nothing for a path already recorded; fails_when=the line shape changes, the URL sent is not the snapshot's url, or a rerun captures again; why_new=new; seam=cli; no_claim=the real Wayback Machine's answers
  it("appends path and timestamp, and a rerun resumes past recorded paths", async () => {
    const data = repo();
    plant(data, STORY);
    const url = "https://news.example.com/story";
    const first = await archive(data, captured(url));
    assert.strictEqual(first.stdout, `${STORY} archived\n`);
    assert.strictEqual(first.stderr, "");
    assert.strictEqual(first.status, 0);
    assert.deepStrictEqual(first.seen, [save(url)]);
    assert.strictEqual(archives(data), `${STORY}\t${STAMP}\n`);

    const rerun = await archive(data, captured(url, "20261020000000"));
    assert.strictEqual(rerun.stdout, "archives.tsv up-to-date\n");
    assert.strictEqual(rerun.status, 0);
    assert.deepStrictEqual(rerun.seen, []);
    assert.strictEqual(archives(data), `${STORY}\t${STAMP}\n`);
  });
});

describe("fetch-snapshot --archive sends only eligible snapshots", () => {
  // Value: protects=criterion 2 and D8: _ballot snapshots (a --ballot fetch and a --ballot --file save alike), api snapshots, a url with a query string and a snapshot with a public_url are never sent to the Wayback Machine; fails_when=an exclusion is dropped or read from the wrong field; why_new=new; seam=cli; no_claim=what Wayback does with what it is sent
  it("never sends _ballot, api, query-string, public_url or --file snapshots", async () => {
    const data = repo();
    plant(data, "sources/_ballot/sample-ballot.md", {
      source: "Exampleton County elections",
      url: "https://county.example.gov/ballots/style-7.pdf",
      requested_url: undefined,
      method: "pdf",
      tier: "T1",
      subject: "_ballot",
      role: "sample_ballot",
    });
    // --ballot --file records only the origin of the page the file came from.
    plant(data, "sources/_ballot/pamphlet.md", {
      source: "Exampleton County elections",
      url: "https://county.example.gov/",
      requested_url: undefined,
      method: "html",
      tier: "T1",
      subject: "_ballot",
      role: "pamphlet",
    });
    plant(data, "sources/us-house-07/jane-example/totals.md", {
      source: "FEC candidate data",
      url: "https://api.open.fec.gov/v1/candidate/H0XX00000/totals/",
      method: "api",
      tier: "T1",
    });
    plant(data, "sources/us-house-07/jane-example/query.md", {
      url: "https://news.example.com/story?id=7",
    });
    plant(data, "sources/us-house-07/jane-example/filing.md", {
      url: "https://news.example.com/filing",
      public_url: "https://news.example.com/filing",
    });
    plant(data, STORY);
    const url = "https://news.example.com/story";
    const routes = {
      ...captured(url),
      ...captured("https://county.example.gov/ballots/style-7.pdf"),
      ...captured("https://county.example.gov/"),
      ...captured("https://api.open.fec.gov/v1/candidate/H0XX00000/totals/"),
      ...captured("https://news.example.com/filing"),
    };
    const result = await archive(data, routes);
    assert.strictEqual(result.stdout, `${STORY} archived\n`);
    assert.strictEqual(result.status, 0);
    assert.deepStrictEqual(result.seen, [save(url)]);
    assert.strictEqual(archives(data), `${STORY}\t${STAMP}\n`);
  });

  // Value: protects=only a URL is sent: the request carries the snapshot's own url as the /save/ path and no cookie, referer, front matter or body; fails_when=a header or the body starts carrying ballot data; why_new=new; seam=cli; no_claim=the real endpoint's URL scheme
  it("sends the snapshot's url and nothing else", async () => {
    const data = repo();
    plant(data, STORY, { url: "https://news.example.com/story#money" });
    const result = await archive(data, captured("https://news.example.com/story"));
    // A fragment is dropped when fetch-snapshot cleans the url, so one is never sent either.
    assert.deepStrictEqual(result.seen, []);
    assert.strictEqual(result.stdout, "archives.tsv up-to-date\n");

    const clean = repo();
    plant(clean, STORY);
    const sent = await archive(clean, captured("https://news.example.com/story"));
    assert.deepStrictEqual(sent.seen, [save("https://news.example.com/story")]);
    const [headers] = sent.headers;
    // The headers Node's fetch adds to every request carry nothing of the ballot.
    const own = Object.keys(headers).filter((name) => !FETCH_HEADERS.includes(name));
    assert.deepStrictEqual(own.sort(), ["user-agent", "x-original-url"]);
    assert.strictEqual(headers["user-agent"], "research-candidates fetch-snapshot");
  });
});

describe("fetch-snapshot --archive fails soft when the Wayback Machine is down", () => {
  const OTHER = "sources/us-house-07/john-sample/profile.md";
  const OTHER_URL = "https://news.example.com/profile";
  const twoSnapshots = () => {
    const data = repo();
    plant(data, STORY);
    plant(data, OTHER, { url: OTHER_URL, subject: "john-sample" });
    return data;
  };

  // Value: protects=criterion 3: an outage (server error, throttling, no answer) writes nothing, exits 0, stops the batch after one request and prints only the path, a code and a hint; a later run captures what is left; fails_when=an outage fails the run, writes a line, keeps sending, or prints a URL; why_new=new; seam=cli; no_claim=Wayback's real error shapes
  it("stops at an outage, writes nothing, and a later run resumes", async () => {
    for (const status of [503, 429]) {
      const data = twoSnapshots();
      const down = await archive(data, {
        [save("https://news.example.com/story")]: { status },
        ...captured(OTHER_URL),
      });
      assert.strictEqual(down.stdout, `${STORY} wayback-unavailable\n- rerun-later\n`, `${status}`);
      assert.strictEqual(down.stderr, "");
      assert.strictEqual(down.status, 0, `${status}`);
      assert.strictEqual(down.seen.length, 1, `${status}`);
      assert.strictEqual(archives(data), null, `${status}`);

      const later = await archive(data, {
        ...captured("https://news.example.com/story"),
        ...captured(OTHER_URL),
      });
      assert.strictEqual(later.stdout, `${STORY} archived\n${OTHER} archived\n`);
      assert.strictEqual(archives(data), `${STORY}\t${STAMP}\n${OTHER}\t${STAMP}\n`);
    }
  });

  // Value: protects=criterion 3 when nothing answers: a refused connection is an outage, not an internal-error; fails_when=a network error escapes as a crash or a failed run; why_new=new; seam=cli; no_claim=timeouts (the same catch)
  it("treats no answer at all as an outage", async () => {
    const data = twoSnapshots();
    const closed = await server({});
    const target = closed.target;
    await closed.close();
    const result = await fetchSnapshot(data, ["--archive", BALLOT], {
      RESEARCH_CANDIDATES_TEST_HTTP_TARGET: target,
    });
    assert.strictEqual(result.stdout, `${STORY} wayback-unavailable\n- rerun-later\n`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(archives(data), null);
  });

  // Value: protects=an answer that names no capture (a refused page) skips only that snapshot, records nothing for it, and the batch goes on; fails_when=a non-capture answer is recorded, or stops the batch; why_new=new; seam=cli; no_claim=which pages Wayback refuses
  it("skips a snapshot Wayback does not capture and goes on", async () => {
    const data = twoSnapshots();
    const result = await archive(data, {
      [save("https://news.example.com/story")]: { status: 200, body: "Sorry" },
      ...captured(OTHER_URL),
    });
    assert.strictEqual(result.stdout, `${STORY} wayback-no-capture\n${OTHER} archived\n`);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(archives(data), `${OTHER}\t${STAMP}\n`);
  });
});

describe("fetch-snapshot --archive never sends a URL holding a private value", () => {
  const OTHER_BALLOT = "2026-general/yy-otherville-2";
  // Value: protects=ADR 0010 and Rule 7 at the batch: every URL passes the fetch URL's refusals (this ballot's id, every ballot's private_strings, a key value) and the page's (another ballot's id) before it is sent, a match is never sent or recorded, and the output names only the snapshot path and the class code, never a URL (ADR 0006); fails_when=a class is skipped, a refusal still sends, or a URL reaches stdout or stderr; why_new=new; seam=cli; no_claim=private text no private_strings entry lists
  it("refuses each class by its code, sends nothing for it, and prints no URL", async () => {
    const cases = [
      ["https://news.example.com/xx-exampleton-1/story", "private-ballot-id"],
      ["https://news.example.com/yy_otherville_2/story", "private-ballot-id"],
      ["https://news.example.com/springfield-township/story", "private-string"],
      ["https://news.example.com/results/precinct-12", "private-string"],
      ["https://news.example.com/maple-ward/story", "private-string"],
      ["https://news.example.com/s3cr3t-fec-key/story", "private-key"],
    ];
    for (const [url, code] of cases) {
      const data = repo();
      data.write(`${OTHER_BALLOT}/ballot.yaml`, "contests: []\n");
      data.write(`${OTHER_BALLOT}/private.yaml`, "private_strings:\n  - Maple Ward\n");
      const leaky = "sources/us-house-07/jane-example/leaky.md";
      plant(data, leaky, { url });
      plant(data, STORY);
      const result = await archive(
        data,
        { ...captured(url), ...captured("https://news.example.com/story") },
        { OPENFEC_API_KEY: "s3cr3t-fec-key" },
      );
      assert.strictEqual(result.stdout, `${leaky} ${code}\n${STORY} archived\n`, url);
      assert.strictEqual(result.stderr, "", url);
      assert.strictEqual(result.status, 1, url);
      assert.deepStrictEqual(result.seen, [save("https://news.example.com/story")], url);
      assert.strictEqual(archives(data), `${STORY}\t${STAMP}\n`, url);
    }
  });

  // Value: protects=only snapshots fetch-snapshot wrote, unchanged, are ever sent: a snapshot that does not match snapshots.sha256 stops the whole batch before any request; fails_when=an edited url is sent; why_new=new; seam=cli; no_claim=check's own manifest report
  it("sends nothing while a snapshot does not match its manifest line", async () => {
    const data = repo();
    plant(data, STORY);
    const edited = "sources/us-house-07/jane-example/edited.md";
    plant(data, edited);
    data.write(`${BALLOT}/${edited}`, data.read(`${BALLOT}/${edited}`).replace("/story", "/other"));
    const result = await archive(data, {
      ...captured("https://news.example.com/story"),
      ...captured("https://news.example.com/other"),
    });
    assert.strictEqual(result.stdout, `${edited} snapshot-hash\n`);
    assert.strictEqual(result.status, 1);
    assert.deepStrictEqual(result.seen, []);
    assert.strictEqual(archives(data), null);
  });

  // Value: protects=archives.tsv is read by publish's own rule before anything is sent, so the batch never appends to a log publish would refuse; fails_when=a torn or foreign line is appended to; why_new=new; seam=cli; no_claim=publish's archives-invalid (publish-page.test.js)
  it("sends nothing while archives.tsv is invalid", async () => {
    for (const text of ["sources/x.md\t2026\n", `${STORY}\t${STAMP}`]) {
      const data = repo();
      plant(data, STORY);
      plant(data, "sources/us-house-07/jane-example/other.md", {
        url: "https://news.example.com/other",
      });
      data.write(`${BALLOT}/archives.tsv`, text);
      const result = await archive(data, captured("https://news.example.com/other"));
      assert.strictEqual(result.stdout, "archives.tsv:1 archives-invalid\n", JSON.stringify(text));
      assert.strictEqual(result.status, 1);
      assert.deepStrictEqual(result.seen, []);
    }
  });
});
