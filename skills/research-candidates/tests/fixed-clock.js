"use strict";

// Preloaded into a command (`node --require`) by a test that needs its output
// byte for byte (fixture.test.js): `new Date()` with no arguments, and `Date()`
// called bare, read RESEARCH_CANDIDATES_TEST_NOW, so today's date (a
// snapshot's `fetched:`, a search-log line, the page's "Updated") never
// changes with the day the tests run. Date.now() keeps the real clock, the
// one file times are written in, so lock waits and stale-lock ages, which
// compare the two, still hold.

const now = Date.parse(process.env.RESEARCH_CANDIDATES_TEST_NOW ?? "");
if (Number.isNaN(now)) throw new Error("fixed-clock: RESEARCH_CANDIDATES_TEST_NOW is not a date");

const RealDate = Date;
// A function, not a class, so a bare `Date()` returns the fixed time's string
// as the real one returns the current time's, where a class would throw.
function FixedDate(...args) {
  if (!new.target) return new RealDate(now).toString();
  return Reflect.construct(RealDate, args.length ? args : [now], new.target);
}
Object.setPrototypeOf(FixedDate, RealDate);
FixedDate.prototype = RealDate.prototype;
globalThis.Date = FixedDate;
