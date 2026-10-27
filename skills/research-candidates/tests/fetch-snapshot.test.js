"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, articlePage, makeDataRepo, runCli, startServer } = require("./harness");

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
    require("node:fs").rmSync(data.file(`${BALLOT}/${rel}`));
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
    "a page with no text",
    { body: "<html><body><script>x()</script></body></html>" },
    "no-readable-text",
    "no readable text",
  );
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
    assert.deepEqual(data.list(BALLOT), ["ballot.yaml"]);
  });
});

describe("a pinned install stays its git tree", () => {
  // The skill-pin gate refuses any file under the installed skill that its
  // tree lacks, so running a command must not leave one (no node_modules).
  const skillDir = require("node:path").join(__dirname, "..");
  const untracked = () =>
    require("./harness")
      .git(
        skillDir,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--exclude=.DS_Store",
        ".",
      )
      .split("\n")
      .filter(Boolean);

  it("loads its dependencies from outside the skill directory", async () => {
    const { depsDir } = require("../scripts/lib/deps");
    assert.ok(require("node:path").relative(skillDir, depsDir()).startsWith(".."));
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
    const result = await fetchSnapshot(data, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "publish.yaml guard-no-publish-yaml\n");
    assert.ok(!data.exists(`${BALLOT}/sources`));
  });

  it("refuses in a clone of the skill's source repo", async () => {
    const data = repo();
    data.write("skills/research-candidates/SKILL.md", "---\nname: research-candidates\n---\n");
    const result = await fetchSnapshot(data, PLAIN);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "skills/research-candidates/SKILL.md guard-skill-source-clone\n");
  });

  const refusesRemote = (name, options, code) =>
    it(name, async () => {
      const data = repo(options);
      const result = await fetchSnapshot(data, PLAIN);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, code);
      assert.ok(!data.exists(`${BALLOT}/sources`));
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
