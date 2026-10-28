"use strict";

// What every fetch-snapshot mode shares: its <election>/<ballot-id> and URL
// arguments, and opening the ballot directory (Rule 8, then any interrupted
// save finished) before it reads or writes anything else there.

const fs = require("node:fs");
const path = require("node:path");
const { BALLOT_ID_PATTERN, ELECTION_PATTERN } = require("./constants");
const { isHttp } = require("./fetch-page");
const { Failure } = require("./output");
const { guardRepo } = require("./repo-guard");
const { recover, withLock } = require("./snapshot-store");

// Fail bad-ballot unless `ballot` is <election>/<ballot-id>.
const parseBallot = (ballot) => {
  const [election, ballotId, extra] = ballot.split("/");
  if (extra !== undefined || !ELECTION_PATTERN.test(election ?? "")) {
    throw new Failure("-", "bad-ballot");
  }
  if (!BALLOT_ID_PATTERN.test(ballotId ?? "")) throw new Failure("-", "bad-ballot");
};

// The http(s) URL `given` parses to, or bad-url. Credentials in a URL are
// never fetched or recorded.
const parseHttpUrl = (given) => {
  let url;
  try {
    url = new URL(given);
  } catch {
    throw new Failure("-", "bad-url");
  }
  if (!isHttp(url) || url.username || url.password) throw new Failure("-", "bad-url");
  return url;
};

// Check Rule 8, then return the ballot directory with any interrupted save
// finished (snapshot-format.md, Manifest).
const openBallot = (root, ballot) => {
  guardRepo(root);
  const ballotDir = path.join(root, ballot);
  if (!fs.statSync(ballotDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Failure(ballot, "unknown-ballot");
  }
  withLock(ballotDir, () => recover(ballotDir));
  return ballotDir;
};

module.exports = { openBallot, parseBallot, parseHttpUrl };
