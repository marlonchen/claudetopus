"use strict";

// The figure check (article-format.md, Figures): every figure in a claim's
// text matches a figure in that claim's own excerpt. Both sides are
// normalized as excerpts are, then canonicalized: `$` and thousands commas
// dropped, K, M, million and billion read as multipliers, `%` as a
// percentage (written `%` or `percent`), which matches only a percentage. A
// claimed figure matches when the excerpt's value, rounded half-up to the
// decimal places the claim shows, equals it, and is within 1% of it, so
// "$1 million" never stands for 500,000. A figure written with a scale it does
// not read (`5 thousand`, `5B`), or with digits outside ASCII once normalized,
// is unread: it matches nothing on either side, so the check fails closed.
// Values stay exact as BigInt digits and powers of ten.

const { normalizeLine } = require("./normalize");

// A number: digits with optional thousands commas and decimals, or decimals alone.
const NUMBER = /(?:(\p{Nd}{1,3}(?:,\p{Nd}{3})+|\p{Nd}+)(?:\.(\p{Nd}+))?|\.(\p{Nd}+))/gu;
const ASCII_DIGITS = /^[0-9,.]+$/;
// What may follow a number: a multiplier, then a percent sign. K and M count
// only written right after the number, the words in any case after one space.
const END = "(?![\\p{L}\\p{M}\\p{Nd}])";
const LETTER_MULTIPLIER = new RegExp(`(K|M)${END}`, "uy");
const WORD_MULTIPLIER = new RegExp(` ?(million|billion)${END}`, "iuy");
// Scales it does not read, which leave the figure unread.
const UNREAD_SCALE = new RegExp(`(?:[kmBb]|bn| ?(?:thousand|hundred|trillion))${END}`, "iuy");
const PERCENT = new RegExp(` ?(?:%|percent${END})`, "iuy");
const POWERS = { k: 3, m: 6, million: 6, billion: 9 };

// Each figure in `text` as { digits, decimals, power, percent, unread }: its
// value is digits × 10^(power − decimals).
const figures = (text) => {
  const line = normalizeLine(text);
  const found = [];
  for (const m of line.matchAll(NUMBER)) {
    const whole = m[1] ?? "0";
    const fraction = m[2] ?? m[3] ?? "";
    let at = m.index + m[0].length;
    let power = 0;
    for (const suffix of [LETTER_MULTIPLIER, WORD_MULTIPLIER]) {
      suffix.lastIndex = at;
      const unit = suffix.exec(line);
      if (unit) {
        power = POWERS[unit[1].toLowerCase()];
        at = suffix.lastIndex;
        break;
      }
    }
    UNREAD_SCALE.lastIndex = at;
    const unread = !ASCII_DIGITS.test(m[0]) || (!power && UNREAD_SCALE.test(line));
    PERCENT.lastIndex = at;
    found.push({
      digits: unread ? 0n : BigInt(whole.replaceAll(",", "") + fraction),
      decimals: fraction.length,
      power,
      percent: PERCENT.test(line),
      unread,
    });
  }
  return found;
};

const scaled = (digits, exp) => (exp >= 0 ? digits * 10n ** BigInt(exp) : digits);

// Does the excerpt figure `e` back the claimed figure `c`?
const backs = (c, e) => {
  if (c.unread || e.unread || c.percent !== e.percent) return false;
  // Half-up: e in the claim's unit, times 10^c.decimals, is num / den.
  const exp = e.power - c.power + c.decimals - e.decimals;
  const num = scaled(e.digits, exp);
  const den = exp >= 0 ? 1n : 10n ** BigInt(-exp);
  if ((2n * num + den) / (2n * den) !== c.digits) return false;
  // Within 1%: both values at the smaller of their powers of ten.
  const ce = c.power - c.decimals;
  const ee = e.power - e.decimals;
  const low = Math.min(ce, ee);
  const cv = scaled(c.digits, ce - low);
  const ev = scaled(e.digits, ee - low);
  const diff = cv > ev ? cv - ev : ev - cv;
  return diff * 100n <= ev;
};

// Is every figure in the claim text backed by a figure in its excerpt?
const figuresBacked = (text, excerpt) => {
  const quoted = figures(excerpt);
  return figures(text).every((c) => quoted.some((e) => backs(c, e)));
};

module.exports = { figuresBacked };
