"use strict";

// Preloaded into a command (`node --require`) by a test that needs its output
// byte for byte (fixture.test.js): `new Date()` with no arguments returns
// RESEARCH_CANDIDATES_TEST_NOW, so today's date (a snapshot's `fetched:`, a
// search-log line, the page's "Updated") never changes with the day the
// tests run. Date.now() keeps the real clock, so lock waits and stale-lock
// ages still pass.

const now = Date.parse(process.env.RESEARCH_CANDIDATES_TEST_NOW ?? "");
if (Number.isNaN(now)) throw new Error("fixed-clock: RESEARCH_CANDIDATES_TEST_NOW is not a date");

const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) {
    super(...(args.length ? args : [now]));
  }
};
