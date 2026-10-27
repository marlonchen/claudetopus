"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const { afterEach } = require("node:test");
const { BALLOT, articlePage, makeDataRepo, runCli, startServer } = require("./harness");

// The fixtures every fetch-snapshot test file shares: data repos and local web
// servers made through `repo` and `server` are removed after each test.

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

module.exports = {
  COUNTY_PAGE,
  PLAIN,
  body,
  fetchSnapshot,
  fetchVia,
  frontMatter,
  repo,
  server,
  sha256,
};
