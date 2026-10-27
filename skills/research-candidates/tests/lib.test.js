"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { describe, it } = require("node:test");
const constants = require("../scripts/lib/constants");
const { githubRepo } = require("../scripts/lib/repo-guard");
const { combineHops, matchUrl, parseMatch } = require("../scripts/lib/tiers");

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

describe("tiers: host match on dot-label boundaries", () => {
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

describe("tiers: path prefix on segment boundaries, longest match wins", () => {
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
  it("prefers a more specific host over a shorter one", () => {
    const hosts = [entry("example.com/news/"), entry("www.example.com")];
    assert.equal(best(hosts, "https://www.example.com/news/x"), "www.example.com");
  });
});

describe("tiers: match values", () => {
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
      "",
      7,
    ]) {
      assert.equal(parseMatch(bad), null, String(bad));
    }
  });
});

describe("tiers: across redirect hops", () => {
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
    assert.deepEqual(combineHops([t1, null]), { refused: "domain not in tiers.yaml" });
    const campaign = entry("jane.com", { tier: "T4", statements_only: true, owner: "jane" });
    assert.deepEqual(combineHops([t1, campaign]), { refused: "owner changes across redirects" });
  });
});

describe("repo guard: GitHub remote URLs", () => {
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
});

describe("fetch-snapshot's output codes are the ones snapshot-format.md lists", () => {
  it("every code the scripts can print is in the Command line section", () => {
    const format = read("references/snapshot-format.md");
    const start = format.indexOf("## Command line");
    const section = format.slice(start, format.indexOf("\n## ", start + 1));
    const listed = new Set([...section.matchAll(/`([a-z][a-z0-9-]*)`/g)].map((m) => m[1]));
    const libDir = path.join(SKILL_DIR, "scripts", "lib");
    const emitted = new Set();
    for (const file of fs.readdirSync(libDir)) {
      const source = fs.readFileSync(path.join(libDir, file), "utf8");
      // new Failure(location, "code") and the refusal-code table's values.
      for (const m of source.matchAll(/new Failure\([^;]*?, "([a-z-]+)"/g)) emitted.add(m[1]);
      for (const m of source.matchAll(/^ {2}"[^"]+": "([a-z-]+)",$/gm)) emitted.add(m[1]);
    }
    emitted.add("http-error");
    assert.ok(emitted.size >= 20, `only ${emitted.size} codes found in scripts/lib`);
    for (const code of emitted) assert.ok(listed.has(code), `\`${code}\` is not listed`);
  });
});
