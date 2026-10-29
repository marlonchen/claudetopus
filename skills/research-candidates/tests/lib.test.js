"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const constants = require("../scripts/lib/constants");
const { githubRepo } = require("../scripts/lib/repo-guard");
const os = require("node:os");
const { ballotIdPrefix } = require("../scripts/lib/ballot-check");
const { voteForCount } = require("../scripts/lib/ballot-match");
const { withLock } = require("../scripts/lib/snapshot-store");
const { combineHops, conflicts, matchUrl, parseMatch } = require("../scripts/lib/tiers");

// Seam 2 (spec, Testing Decisions): the shared library's edge cases that would
// be slow through the CLI.

const SKILL_DIR = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(SKILL_DIR, rel), "utf8");

const entry = (match, fields = {}) => ({
  match,
  parsed: parseMatch(match),
  tier: "T2",
  statements_only: false,
  owner: "third-party",
  source: match,
  ...fields,
});
const best = (entries, url) => matchUrl(entries, new URL(url))?.match ?? null;

describe("source-tiers.md: host match on dot-label boundaries", () => {
  const entries = [entry("county.example.gov")];
  it("matches the host and its subdomains", () => {
    assert.equal(best(entries, "https://county.example.gov/x"), "county.example.gov");
    assert.equal(best(entries, "https://www.county.example.gov/x"), "county.example.gov");
  });
  it("never matches a host that only ends with the same letters", () => {
    assert.equal(best(entries, "https://evilcounty.example.gov/"), null);
    assert.equal(best(entries, "https://county.example.gov.evil.net/"), null);
  });
  it("compares hosts case-insensitively and ignores the port", () => {
    assert.equal(best(entries, "https://COUNTY.Example.GOV:8443/"), "county.example.gov");
  });
  it("compares internationalized hosts in their punycode form", () => {
    const idn = [entry("bücher.example")];
    assert.equal(best(idn, "https://xn--bcher-kva.example/"), "bücher.example");
  });
});

describe("source-tiers.md: path prefix on segment boundaries, most specific match wins", () => {
  const entries = [entry("news.example.com"), entry("news.example.com/opinion/")];
  it("matches the prefix itself and paths under it", () => {
    assert.equal(best(entries, "https://news.example.com/opinion"), "news.example.com/opinion/");
    assert.equal(
      best(entries, "https://news.example.com/opinion/a/b"),
      "news.example.com/opinion/",
    );
  });
  it("never matches a longer segment that starts with the prefix", () => {
    assert.equal(best(entries, "https://news.example.com/opinionated"), "news.example.com");
  });
  it("prefers an entry that lies within another, by host or by path", () => {
    const nested = [entry("example.com/news/"), entry("www.example.com/news/")];
    assert.equal(best(nested, "https://www.example.com/news/x"), "www.example.com/news/");
  });
});

describe("source-tiers.md: two entries conflict when neither lies within the other", () => {
  const conflict = (a, b) => conflicts(parseMatch(a), parseMatch(b));
  it("lets nested entries stand, in either order", () => {
    for (const [a, b] of [
      ["example.com", "www.example.com"],
      ["news.example.com", "news.example.com/opinion/"],
      ["example.com/news", "www.example.com/news/world"],
    ]) {
      assert.equal(conflict(a, b), false, `${a} ${b}`);
      assert.equal(conflict(b, a), false, `${b} ${a}`);
    }
  });
  it("refuses a deeper host with a shorter path, and the same host and path twice", () => {
    assert.equal(conflict("www.example.com", "example.com/news"), true);
    assert.equal(conflict("Example.com/News/", "example.com/News"), true);
  });
  it("leaves entries no URL matches both of alone", () => {
    assert.equal(conflict("example.com/news", "example.com/sport"), false);
    assert.equal(conflict("a.example.com", "b.example.com"), false);
  });
});

describe("source-tiers.md: a match is a host and an optional path prefix", () => {
  it("accepts a host with an optional path prefix only", () => {
    assert.deepEqual(parseMatch("County.Example.gov/Elections/"), {
      host: "county.example.gov",
      path: "/Elections",
    });
    for (const bad of [
      "https://county.example.gov",
      "county.example.gov:443",
      "a@b.gov",
      "x.gov?q",
      "*.example.com",
      "",
      7,
    ]) {
      assert.equal(parseMatch(bad), null, String(bad));
    }
  });
});

describe("source-tiers.md: across redirect hops", () => {
  const t1 = entry("a.gov", { tier: "T1", source: "A" });
  const t3 = entry("b.org", { tier: "T3", source: "B" });
  const t1s = entry("c.gov", { tier: "T1", statements_only: true, source: "C" });
  it("takes the strictest tier and the final hop's source", () => {
    assert.deepEqual(combineHops([t3, t1]), {
      tier: "T3",
      statements_only: false,
      owner: "third-party",
      source: "A",
    });
  });
  it("keeps statements_only when any hop has it", () => {
    assert.equal(combineHops([t1s, t3]).statements_only, true);
  });
  it("refuses a hop with no match and an owner that changes", () => {
    assert.deepEqual(combineHops([t1, null]).refused, {
      code: "domain-not-in-tiers",
      reason: "domain not in tiers.yaml",
    });
    const campaign = entry("jane.com", { tier: "T4", statements_only: true, owner: "jane" });
    assert.deepEqual(combineHops([t1, campaign]).refused, {
      code: "owner-changes-across-redirects",
      reason: "owner changes across redirects",
    });
  });
});

describe("Rule 8: only a GitHub URL can be confirmed private", () => {
  it("reads owner/repo from https, ssh and scp-like URLs", () => {
    for (const url of [
      "https://github.com/me/elections.git",
      "https://token@github.com/me/elections",
      "ssh://git@github.com/me/elections.git",
      "git@github.com:me/elections.git",
    ]) {
      assert.equal(githubRepo(url), "me/elections", url);
    }
  });
  it("reads nothing from another host or a look-alike", () => {
    for (const url of [
      "https://gitlab.com/me/elections.git",
      "https://github.com.evil.net/me/elections",
      "/srv/git/elections.git",
      "https://github.com/me/elections/extra",
    ]) {
      assert.equal(githubRepo(url), null, url);
    }
  });
});

describe("constants match the reference text they come from", () => {
  it("the source repo id is the one Rule 8 records", () => {
    assert.match(read("SKILL.md"), new RegExp(`that repo's id, \`${constants.SOURCE_REPO_ID}\``));
  });
  it("the election directory pattern is the Layout's", () => {
    assert.ok(read("SKILL.md").includes(`\`${constants.ELECTION_PATTERN.source}\``));
  });
  it("the ballot id and id patterns are ballot-format.md's", () => {
    const ballot = read("references/ballot-format.md");
    assert.ok(ballot.includes(`\`${constants.BALLOT_ID_PATTERN.source}\``));
    assert.ok(ballot.includes(`\`${constants.ID_PATTERN.source}\``));
  });
  it("the section names and office types are sections.md's", () => {
    const sections = read("references/sections.md");
    const table = (heading) => {
      const start = sections.indexOf(`## ${heading}`);
      const text = sections.slice(start, sections.indexOf("\n## ", start + 1));
      return [...text.matchAll(/^\| [A-Z]\. ([^|]+?) \|/gm)].map((m) => m[1]);
    };
    assert.deepEqual(table("Candidate contests"), constants.SECTIONS.candidate);
    assert.deepEqual(table("Retention contests"), constants.SECTIONS.retention);
    assert.deepEqual(table("Measures"), constants.SECTIONS.measure);
    const types = [...sections.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    assert.deepEqual(types, constants.OFFICE_TYPES);
  });
  it("the Positions issues, section rules and checklist items are sections.md's", () => {
    const sections = read("references/sections.md");
    const issues = Object.fromEntries(
      [...sections.matchAll(/^\| `([a-z]+)` \| [^|]+ \| ([^|]+) \|$/gm)].map((m) => [
        m[1],
        m[2].startsWith("None") ? [] : m[2].trim().split("; "),
      ]),
    );
    assert.deepEqual(issues, constants.POSITIONS_ISSUES);
    const tables = {
      candidate: "Candidate contests",
      retention: "Retention contests",
      measure: "Measures",
    };
    for (const [type, heading] of Object.entries(tables)) {
      const start = sections.indexOf(`## ${heading}`);
      const rows = [
        ...sections
          .slice(start, sections.indexOf("\n## ", start + 1))
          .matchAll(/^\| [A-Z]\. ([^|]+?) \| [^|]+ \| ([^|]+?) \| ([^|]*?) ?\|$/gm),
      ];
      const saysOnly = rows.filter((m) => m[3].includes("`says-only`")).map((m) => m[1]);
      assert.deepEqual(saysOnly, constants.SAYS_ONLY[type], type);
      const items = rows
        .filter((m) => !m[2].includes("_ballot/"))
        .map((m) => [m[1], m[2].split(", ")]);
      assert.deepEqual(Object.fromEntries(items), constants.SECTION_ITEMS[type], type);
    }
    assert.match(
      sections,
      new RegExp(`gets the ${constants.WITHDRAWN_SECTIONS.join(" and ")} section only`),
    );
    const { type, office_type, section } = constants.EXEMPTION;
    assert.strictEqual(type, "candidate");
    assert.match(
      sections,
      new RegExp(
        `A candidate contest marked \`office_type: ${office_type}\` in \`ballot.yaml\` has its ${section} section in the state \`Not part of this office's job\``,
      ),
    );
  });
  it("the search log items and the candidate statuses are the references'", () => {
    const { candidate, measure, retention } = constants.CHECKLIST_ITEMS;
    assert.deepEqual(candidate, ["1", "2", "3", "4", "5"]);
    assert.match(
      read("references/snapshot-format.md"),
      new RegExp(
        `1-5 for a candidate contest, ${measure} for a measure, ${retention} for a retention contest`,
      ),
    );
    assert.match(
      read("references/ballot-format.md"),
      new RegExp(`status: on_ballot +# ${constants.STATUSES.join(" \\| ")}$`, "m"),
    );
  });
  it("the excerpt length and section states are article-format.md's", () => {
    const article = read("references/article-format.md");
    const { min, max } = constants.EXCERPT_LENGTH;
    assert.match(article, new RegExp(`The excerpt is ${min} to ${max} characters`));
    const start = article.indexOf("## Section states");
    const states = [
      ...article.slice(start, article.indexOf("\n## ", start + 1)).matchAll(/^- `([^`]+)`:/gm),
    ].map((m) => m[1]);
    assert.deepEqual(states, constants.SECTION_STATES);
  });
  it("the always-reviewed sections and allegation words are the references'", () => {
    const sections = read("references/sections.md");
    const tables = {
      candidate: "Candidate contests",
      retention: "Retention contests",
      measure: "Measures",
    };
    for (const [type, heading] of Object.entries(tables)) {
      const start = sections.indexOf(`## ${heading}`);
      const rows = [
        ...sections
          .slice(start, sections.indexOf("\n## ", start + 1))
          .matchAll(/^\| [A-Z]\. ([^|]+?) \|.*\| ([^|]*?) ?\|$/gm),
      ];
      const always = rows.filter((m) => m[2].includes("`always reviewed`")).map((m) => m[1]);
      assert.deepEqual(always, constants.ALWAYS_REVIEWED[type], type);
    }
    const bullet = read("references/review-list.md")
      .split("\n")
      .find((line) => line.includes("allegation word"));
    const words = [...bullet.split("Bare stems")[0].matchAll(/`([a-z]+(?:\([a-z|]+\))?)`/g)];
    assert.deepEqual(
      words.map((m) => m[1]),
      constants.ALLEGATION_WORDS,
    );
  });
  it("the API key variables are the ones snapshot-format.md names", () => {
    const named = read("references/snapshot-format.md").match(
      /environment variables the scripts read \(([^)]*)\)/,
    );
    assert.ok(named, "snapshot-format.md no longer names the API key variables");
    assert.deepEqual(
      [...named[1].matchAll(/`([A-Z_]+)`/g)].map((m) => m[1]),
      constants.KEY_ENV,
    );
  });
});

describe("ballot-format.md, Ballot ids: the id state and county build", () => {
  it("folds letters to ASCII, drops apostrophes and one trailing county word", () => {
    assert.equal(ballotIdPrefix("XX", "Exampleton County"), "xx-exampleton");
    assert.equal(ballotIdPrefix("NM", "Doña Ana County"), "nm-dona-ana");
    assert.equal(ballotIdPrefix("AK", "Juneau City and Borough"), "ak-juneau");
    assert.equal(ballotIdPrefix("AK", "Bethel Census Area"), "ak-bethel");
    assert.equal(ballotIdPrefix("LA", "Orleans Parish"), "la-orleans");
    assert.equal(ballotIdPrefix("MD", "Prince George’s County"), "md-prince-georges");
  });
  it("never drops city alone, so St. Louis city and St. Louis County stay apart", () => {
    assert.equal(ballotIdPrefix("MO", "St. Louis city"), "mo-st-louis-city");
    assert.equal(ballotIdPrefix("MO", "St. Louis County"), "mo-st-louis");
  });
});

describe("ballot-format.md, Command line: the Vote for count", () => {
  it("reads digits, number words and 'not more than'", () => {
    assert.equal(voteForCount("Vote for 3"), 3);
    assert.equal(voteForCount("VOTE FOR ONE"), 1);
    assert.equal(voteForCount("Vote for not more than two"), 2);
    assert.equal(voteForCount("Vote for ten"), 10);
    assert.equal(voteForCount("(Vote for 1)"), 1);
    assert.equal(voteForCount("Vote for: 2"), 2);
    assert.equal(voteForCount("7th District Vote for one"), 1);
  });
  it("gives none for a line that names no count", () => {
    assert.equal(voteForCount("Vote for the candidate of your choice"), null);
    assert.equal(voteForCount("Vote for one-third"), null);
  });
});

describe("each command's output codes are the ones its reference lists", () => {
  // The codes a Command line section lists.
  const listedIn = (ref) => {
    const format = read(`references/${ref}`);
    const start = format.indexOf("## Command line");
    const section = format.slice(start, format.indexOf("\n## ", start + 1));
    return new Set([...section.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]));
  };
  // The codes a lib file can print: new Failure(location, "code"), a fail(..., "code")
  // helper's last argument, refusals ({ code: "..." }, refuse(url, "...")) and the fixed
  // "- code" lines a command prints itself.
  const emittedBy = (file) => {
    const source = fs.readFileSync(path.join(SKILL_DIR, "scripts", "lib", file), "utf8");
    const emitted = new Set();
    for (const pattern of [
      /new Failure\([^;]*?, "([a-z-]+)"/g,
      /\bfail\([^;]*?, "([a-z-]+)"\)/g,
      /code: "([a-z-]+)"/g,
      /refuse\(url, "([a-z-]+)"/g,
      /"- ([a-z-]+)/g,
    ]) {
      for (const m of source.matchAll(pattern)) emitted.add(m[1]);
    }
    return emitted;
  };
  // ballot-check's own modules; every other lib file but install-deps (README.md lists its two
  // codes) is fetch-snapshot's, or shared by both.
  const BALLOT_CHECK = ["ballot-check.js", "ballot-match.js", "ballot-privacy.js"];
  // check's own modules (article-format.md, Command line).
  const CHECK = ["check.js", "article.js", "figures.js", "snapshot-hash.js"];
  // coverage's own module (article-format.md, Command line).
  const COVERAGE = ["coverage.js"];
  // review-list's own module (review-list.md, Command line).
  const REVIEW_LIST = ["review-list.js"];

  it("fetch-snapshot: every code is in snapshot-format.md's Command line section", () => {
    const listed = listedIn("snapshot-format.md");
    const files = fs
      .readdirSync(path.join(SKILL_DIR, "scripts", "lib"))
      .filter(
        (f) =>
          f !== "install-deps.js" &&
          ![...BALLOT_CHECK, ...CHECK, ...COVERAGE, ...REVIEW_LIST].includes(f),
      );
    const emitted = new Set(files.flatMap((f) => [...emittedBy(f)]));
    assert.ok(emitted.size >= 20, `only ${emitted.size} codes found in scripts/lib`);
    for (const code of emitted) assert.ok(listed.has(code), `\`${code}\` is not listed`);
  });

  it("coverage: every code is in article-format.md's Command line section", () => {
    const listed = listedIn("article-format.md");
    const own = new Set(COVERAGE.flatMap((f) => [...emittedBy(f)]));
    assert.ok(own.size >= 8, `only ${own.size} codes found in coverage`);
    for (const code of own) assert.ok(listed.has(code), `\`${code}\` is not listed`);
  });

  it("review-list: every code is in review-list.md's Command line section", () => {
    const listed = listedIn("review-list.md");
    const own = new Set(REVIEW_LIST.flatMap((f) => [...emittedBy(f)]));
    assert.ok(own.size >= 10, `only ${own.size} codes found in review-list`);
    for (const code of own) assert.ok(listed.has(code), `\`${code}\` is not listed`);
    // The codes it reaches through check, coverage and the shared modules.
    for (const code of ["usage", "bad-ballot", "unknown-ballot", "ballot-invalid", "deps-missing"])
      assert.ok(listed.has(code), `\`${code}\` is not listed`);
  });

  it("ballot-check: every code is in ballot-format.md's Command line section", () => {
    const listed = listedIn("ballot-format.md");
    const shared = [
      "data-files.js",
      "fetch-common.js",
      "output.js",
      "repo-guard.js",
      "terminal.js",
    ];
    const own = new Set(BALLOT_CHECK.flatMap((f) => [...emittedBy(f)]));
    assert.ok(own.size >= 15, `only ${own.size} codes found in ballot-check`);
    for (const code of own) assert.ok(listed.has(code), `\`${code}\` is not listed`);
    // Shared codes ballot-check can reach.
    const reachable = [
      "usage",
      "bad-ballot",
      "unknown-ballot",
      "not-a-terminal",
      "file-missing",
      "yaml-invalid",
      "internal-error",
      "guard-no-publish-yaml",
      "guard-not-repo-root",
    ];
    const sharedCodes = new Set(shared.flatMap((f) => [...emittedBy(f)]));
    for (const code of reachable) {
      assert.ok(sharedCodes.has(code) || own.has(code), `\`${code}\` is no longer emitted`);
      assert.ok(listed.has(code), `\`${code}\` is not listed`);
    }
  });

  it("check: every code is in article-format.md's Command line section", () => {
    const listed = listedIn("article-format.md");
    const own = new Set(CHECK.flatMap((f) => [...emittedBy(f)]));
    assert.ok(own.size >= 6, `only ${own.size} codes found in check`);
    for (const code of own) assert.ok(listed.has(code), `\`${code}\` is not listed`);
  });
});

describe("snapshot-format.md, Manifest: the ballot lock", () => {
  it("is released only while this run still owns it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-lock-"));
    try {
      const lock = path.join(dir, ".lock", "held");
      withLock(dir, () => fs.writeFileSync(lock, "1 another-owner\n"));
      assert.equal(fs.readFileSync(lock, "utf8"), "1 another-owner\n");
      fs.rmSync(lock);
      withLock(dir, () => assert.ok(fs.existsSync(lock)));
      assert.ok(!fs.existsSync(lock));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // A ballot directory with its lock files already in place, aged by `ageMs`.
  const lockedBallot = (files) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-lock-"));
    fs.mkdirSync(path.join(dir, ".lock"));
    for (const [name, [text, ageMs]] of Object.entries(files)) {
      const file = path.join(dir, ".lock", name);
      fs.writeFileSync(file, text);
      const when = new Date(Date.now() - ageMs);
      fs.utimesSync(file, when, when);
    }
    return dir;
  };
  const ballotLocked = (error) => error.code === "ballot-locked";

  it("waits for a fresh lock even when its pid is not one this run can see", () => {
    const dir = lockedBallot({ held: ["999999 other-namespace\n", 0] });
    try {
      assert.throws(() => withLock(dir, () => {}, 300), ballotLocked);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sleeps and keeps its deadline while another run breaks a stale lock", () => {
    const dir = lockedBallot({ held: ["1 x\n", 3600 * 1000], break: ["2 y\n", 0] });
    try {
      const started = Date.now();
      const cpu = process.cpuUsage();
      assert.throws(() => withLock(dir, () => {}, 300), ballotLocked);
      const elapsed = Date.now() - started;
      const { user, system } = process.cpuUsage(cpu);
      assert.ok(elapsed < 2000, `waited ${elapsed} ms`);
      assert.ok((user + system) / 1000 < elapsed / 2, "spun instead of sleeping");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes over a stale lock whose break lock has an mtime in the future", () => {
    const dir = lockedBallot({ held: ["1 x\n", 3600 * 1000], break: ["2 y\n", -3600 * 1000] });
    try {
      assert.equal(
        withLock(dir, () => "held", 1000),
        "held",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
