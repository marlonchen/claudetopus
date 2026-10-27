"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { afterEach, describe, it } = require("node:test");
const { depsDir } = require("../scripts/lib/deps");
const {
  BALLOT,
  DEFAULT_BALLOT,
  articlePage,
  git,
  makeDataRepo,
  runCli,
  startServer,
} = require("./harness");

// fetch-snapshot as the researcher and the discovery agent see it: exit code,
// `location code` lines on stdout, and the files it writes or leaves alone.

const repos = [];
const servers = [];
const repo = (options) => {
  const made = makeDataRepo(options);
  repos.push(made);
  return made;
};
const server = async (routes) => {
  const started = await startServer(routes);
  servers.push(started);
  return started;
};
afterEach(async () => {
  while (repos.length) repos.pop().cleanup();
  while (servers.length) await servers.pop().close();
});

const fetchSnapshot = (data, args, env = {}) =>
  runCli("fetch-snapshot", args, { cwd: data.root, env: { ...data.env, ...env } });
// Fetch through a local server holding `routes`.
const fetchVia = async (data, routes, args, env = {}) => {
  const web = await server(routes);
  const result = await fetchSnapshot(data, args, {
    RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target,
    ...env,
  });
  return { ...result, seen: web.seen };
};

const PLAIN = [BALLOT, "us-house-07", "_race", "county-page", "https://county.example.gov/"];
const COUNTY_PAGE = articlePage("Candidates certified", [
  "The county certified two candidates for the 7th District on October 1.",
  "Ballots will be mailed to voters starting October 8.",
]);
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");
// Front matter keys and values as written, in order.
const frontMatter = (text) => {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "no front matter");
  return m[1].split("\n").map((line) => line.split(": "));
};
const body = (text) => text.replace(/^---\n[\s\S]*?\n---\n/, "");

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
      ["source", "url", "fetched", "method", "tier", "statements_only", "subject", "owner"],
    );
    const field = Object.fromEntries(fields);
    assert.equal(field.source, "Exampleton County elections");
    assert.equal(field.url, "https://county.example.gov/");
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
      "<html><body><nav>Menu</nav><div>Filing deadline: August 1.</div>" +
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
    // Value: protects=only an http(s) URL argument is accepted; fails_when=parseArgs drops the isHttp check or the URL parse guard; why_new=no test passed a bad URL argument; seam=none; no_claim=URLs that parse but are unreachable
    for (const url of ["ftp://county.example.gov/", "file:///etc/passwd", "not a url"]) {
      const badUrl = await fetchSnapshot(data, [...PLAIN.slice(0, 4), url]);
      assert.equal(badUrl.status, 1);
      assert.equal(badUrl.stdout, "- bad-url\n");
    }
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
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

describe("a pinned install stays its git tree", () => {
  // The skill-pin gate refuses any file under the installed skill that its
  // tree lacks, so running a command must not leave one (no node_modules).
  const skillDir = path.join(__dirname, "..");
  // Every file git does not track, ignored or not: the gate refuses both kinds.
  const untracked = () =>
    git(skillDir, "ls-files", "--others", "--exclude=.DS_Store", ".").split("\n").filter(Boolean);

  it("sees a stray file whether or not .gitignore covers it", () => {
    const stray = path.join(skillDir, "zz-stray-probe.txt");
    fs.writeFileSync(stray, "x");
    try {
      assert.ok(untracked().includes("zz-stray-probe.txt"));
    } finally {
      fs.rmSync(stray);
    }
  });

  it("loads its dependencies from outside the skill directory", async () => {
    assert.ok(path.relative(skillDir, depsDir()).startsWith(".."));
    const before = untracked();
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 0);
    assert.deepEqual(untracked(), before);
  });
});

describe("deps.js: the npm dependencies load only from the install-deps cache", () => {
  // Value: protects=a missing dependency install reports deps-missing pointing at install-deps; fails_when=load() rethrows MODULE_NOT_FOUND as internal-error or resolves modules from elsewhere; why_new=every other test runs with deps installed; seam=none; no_claim=a partly installed cache
  it("answers deps-missing, naming install-deps, before fetching anything", async () => {
    const data = repo();
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
      { RESEARCH_CANDIDATES_DEPS: data.file(".no-deps") },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "scripts/install-deps deps-missing\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(result.seen, []);
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });
});

describe("snapshot-format.md, Manifest: a crash at any step leaves a state the next run repairs", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  const crash = (data, step) =>
    fetchVia(data, routes, PLAIN, { RESEARCH_CANDIDATES_TEST_CRASH: step });
  const manifestLines = (data) =>
    data.read(`${BALLOT}/snapshots.sha256`).split("\n").filter(Boolean);
  // Every manifest line names a file on disk with that hash, and every file has a line.
  const assertConsistent = (data) => {
    const lines = manifestLines(data);
    for (const line of lines) {
      const [hash, rel] = line.split("  ");
      assert.equal(sha256(data.read(`${BALLOT}/${rel}`)), hash, rel);
    }
    const files = data.list(`${BALLOT}/sources/us-house-07/_race`);
    assert.equal(files.length, lines.length);
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  };

  it("discards a partial that never reached the manifest", async () => {
    const data = repo();
    const crashed = await crash(data, "after-partial");
    assert.equal(crashed.signal, "SIGKILL");
    assert.equal(data.list(`${BALLOT}/.partial`).length, 2); // the partial and the lock
    assert.ok(!data.exists(`${BALLOT}/snapshots.sha256`));

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.equal(manifestLines(data).length, 1);
    assertConsistent(data);
  });

  it("moves a partial whose manifest line was written into place", async () => {
    const data = repo();
    const crashed = await crash(data, "after-manifest");
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(!data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assertConsistent(data);
  });

  it("repairs before refusing, so a failed fetch still finishes an interrupted save", async () => {
    const data = repo();
    await crash(data, "after-manifest");
    const rerun = await fetchVia(data, {}, [
      BALLOT,
      "us-house-07",
      "_race",
      "x",
      "https://nowhere.example/",
    ]);
    assert.equal(rerun.status, 1);
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assertConsistent(data);
  });

  it("drops a partial left behind after its file was linked into place", async () => {
    const data = repo();
    const crashed = await crash(data, "after-link");
    assert.equal(crashed.signal, "SIGKILL");
    assert.ok(data.exists(`${BALLOT}/sources/us-house-07/_race/county-page.md`));
    assert.equal(data.list(`${BALLOT}/.partial`).length, 2);

    const rerun = await fetchVia(data, routes, PLAIN);
    assert.equal(rerun.stdout, "sources/us-house-07/_race/county-page-2.md saved\n");
    assertConsistent(data);
  });

  it("deletes a stray .partial file no manifest line names", async () => {
    const data = repo();
    data.write(`${BALLOT}/.partial/${"0".repeat(64)}`, "stray");
    await fetchVia(data, routes, PLAIN);
    assertConsistent(data);
  });
});

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
        "https://county.example.gov/go": {
          status: 302,
          headers: { location: "https://news.example.com/opinion/piece" },
        },
        "https://news.example.com/opinion/piece": { body: COUNTY_PAGE },
      },
      [BALLOT, "us-house-07", "_race", "piece", "https://county.example.gov/go"],
    );
    assert.equal(result.status, 0);
    const field = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/us-house-07/_race/piece.md`)),
    );
    assert.equal(field.tier, "T4");
    assert.equal(field.statements_only, "true");
    assert.equal(field.source, "Example News opinion page");
    assert.equal(field.url, "https://news.example.com/opinion/piece");
  });

  it("refuses a redirect to an unmatched host before contacting it", async () => {
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
    assert.equal(result.stdout, "us-house-07/_race domain-not-in-tiers\n");
    assert.deepEqual(result.seen, ["https://county.example.gov/go"]);
    assert.match(
      data.read(`${BALLOT}/unfetchable.md`),
      /^- https:\/\/tracker\.example\.net\/landing \|/,
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
  // Value: protects=tiers.yaml must exist, parse strictly and be a list before any URL is fetched; fails_when=readYamlDocument drops uniqueKeys or the error check, loadTiers drops the isSeq check, or a missing file surfaces as internal-error; why_new=the cases above all reach per-entry checks; seam=none; no_claim=ballot.yaml parse errors
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

describe("Rule 8: the repo guard refuses to write outside a private data repo", () => {
  it("refuses without publish.yaml", async () => {
    const data = repo({ publish: false });
    const result = await fetchVia(data, {}, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "publish.yaml guard-no-publish-yaml\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
    assert.deepEqual(result.seen, []);
  });

  it("refuses in a clone of the skill's source repo", async () => {
    const data = repo();
    data.write("skills/research-candidates/SKILL.md", "---\nname: research-candidates\n---\n");
    const result = await fetchSnapshot(data, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "skills/research-candidates/SKILL.md guard-skill-source-clone\n");
  });

  it("refuses when run from below the repo's top level", async () => {
    const data = repo();
    data.write("sub/publish.yaml", "branch: main\n");
    const result = await runCli("fetch-snapshot", PLAIN, {
      cwd: data.file("sub"),
      env: data.env,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ". guard-not-repo-root\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
  });

  // Value: protects=a project root outside any git repo is refused, since its remotes cannot be checked; fails_when=guardRepo treats a failed `git remote` as no remotes and lets the run write; why_new=every other guard test runs inside a git repo; seam=none; no_claim=a git repo with no remotes
  it("refuses outside a git repo", async () => {
    const data = repo();
    fs.rmSync(data.file(".git"), { recursive: true, force: true });
    const result = await fetchVia(
      data,
      { "https://county.example.gov/": { body: COUNTY_PAGE } },
      PLAIN,
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, ". guard-not-git-repo\n");
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
    assert.deepEqual(result.seen, []);
  });

  const refusesRemote = (name, options, code) =>
    it(name, async () => {
      const data = repo(options);
      const result = await fetchVia(data, {}, PLAIN);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, code);
      assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
      assert.deepEqual(result.seen, []);
    });

  refusesRemote(
    "refuses a public remote",
    { gh: { "me/elections": { visibility: "PUBLIC", id: 42 } } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "refuses a remote whose fork-network root is the skill's source repo, by id",
    {
      remotes: { origin: ["git@github.com:Me/Renamed-Fork.git"] },
      gh: { "me/renamed-fork": { visibility: "PRIVATE", id: 7, sourceId: 1373776339 } },
    },
    "remote:origin guard-skill-source-remote\n",
  );
  refusesRemote(
    "counts a remote that is not on GitHub as public",
    { remotes: { origin: ["https://gitlab.com/me/elections.git"] } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "counts a gh error as public",
    { gh: {} },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "counts empty gh output as public",
    { gh: { "me/elections": { visibility: "", id: 42 } } },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "checks every push URL as well as the fetch URL",
    {
      pushUrls: { origin: ["https://github.com/me/elections-mirror"] },
      gh: {
        "me/elections": { visibility: "PRIVATE", id: 42 },
        "me/elections-mirror": { visibility: "PUBLIC", id: 43 },
      },
    },
    "remote:origin guard-remote-not-private\n",
  );
  refusesRemote(
    "checks every remote, not only origin",
    {
      remotes: {
        origin: ["https://github.com/me/elections.git"],
        backup: ["ssh://git@github.com/me/backup.git"],
      },
      gh: {
        "me/elections": { visibility: "PRIVATE", id: 42 },
        "me/backup": { visibility: "INTERNAL", id: 44 },
      },
    },
    "remote:backup guard-remote-not-private\n",
  );
});

describe("pre-landing review fixes", () => {
  const routes = { "https://county.example.gov/": { body: COUNTY_PAGE } };
  const lockFile = `${BALLOT}/.partial/.lock`;

  it("Rule 5: never echoes a malformed subject, so it cannot forge an output line", async () => {
    const data = repo();
    const forged = "x\nsources/us-house-07/_race/forged.md saved";
    const result = await fetchVia(data, routes, [BALLOT, "us-house-07", forged, "n", PLAIN[4]]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "us-house-07/- unknown-subject\n");
    assert.deepEqual(result.seen, []);
  });

  it("takes over an empty lock left by a crash once it is past the grace period", async () => {
    const data = repo();
    data.write(lockFile, "");
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(data.file(lockFile), old, old);
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  });

  it("takes over a lock older than any save, even when its pid is alive (a reused pid)", async () => {
    const data = repo();
    data.write(lockFile, `${process.pid} someone-else\n`);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(data.file(lockFile), old, old);
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
  });

  it("takes over a lock whose process is gone", async () => {
    const data = repo();
    data.write(lockFile, "999999 dead-owner\n");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "sources/us-house-07/_race/county-page.md saved\n");
    assert.deepEqual(data.list(`${BALLOT}/.partial`), []);
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

  it("refuses to append to a manifest whose last line has no newline", async () => {
    const data = repo();
    data.write(`${BALLOT}/snapshots.sha256`, "-  sources/us-house-07/_race/old.md");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.stdout, "snapshots.sha256 manifest-invalid\n");
    assert.equal(data.read(`${BALLOT}/snapshots.sha256`), "-  sources/us-house-07/_race/old.md");
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("never relinks a leftover partial to a manifest path outside sources/", async () => {
    const data = repo();
    const hash = "a".repeat(64);
    data.write(`${BALLOT}/.partial/${hash}`, "planted");
    data.write(`${BALLOT}/snapshots.sha256`, `${hash}  sources/../escaped.md\n`);
    await fetchVia(data, routes, PLAIN);
    assert.ok(!data.exists(`${BALLOT}/escaped.md`));
    assert.ok(!data.list(`${BALLOT}/.partial`).includes(hash));
  });

  it("does not name another ballot when its ballot.yaml is broken", async () => {
    const data = repo();
    data.write("2026-general/yy-otherplace-2/ballot.yaml", "contests: [unclosed\n");
    const result = await fetchVia(data, routes, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "- yaml-invalid\n");
    assert.doesNotMatch(result.stdout, /yy-otherplace/);
  });
});
