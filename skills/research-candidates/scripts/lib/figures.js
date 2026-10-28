"use strict";

// The figure check (article-format.md, Figures): every figure in a claim's
// text matches a figure in that claim's own excerpt. Both sides are
// normalized as excerpts are, then canonicalized: `$` and thousands commas
// dropped, K, M, million and billion read as multipliers, `%` as a
// percentage, which matches only a percentage. A claimed figure matches when
// the excerpt's value, rounded half-up to the decimal places the claim shows,
// equals it, and is within 1% of it, so "$1 million" never stands for 500,000.
// Values stay exact as BigInt digits and powers of ten.

const { normalizeLine } = require("./normalize");

const NUMBER = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?/g;
// What may follow a number: a multiplier, then a percent sign. K and M count
// only written right after the number, the words in any case after one space.
const LETTER_MULTIPLIER = /(K|M)(?![\p{L}\p{M}\p{Nd}])/uy;
const WORD_MULTIPLIER = / ?(million|billion)(?![\p{L}\p{M}\p{Nd}])/iuy;
const PERCENT = / ?%/y;
const POWERS = { k: 3, m: 6, million: 6, billion: 9 };

// Each figure in `text` as { digits, decimals, power, percent }: its value is
// digits × 10^(power − decimals).
const figures = (text) => {
  const line = normalizeLine(text);
  const found = [];
  for (const m of line.matchAll(NUMBER)) {
    const fraction = m[2] ?? "";
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
    PERCENT.lastIndex = at;
    found.push({
      digits: BigInt(m[1].replaceAll(",", "") + fraction),
      decimals: fraction.length,
      power,
      percent: PERCENT.test(line),
    });
  }
  return found;
};

const scaled = (digits, exp) => (exp >= 0 ? digits * 10n ** BigInt(exp) : digits);

// Does the excerpt figure `e` back the claimed figure `c`?
const backs = (c, e) => {
  if (c.percent !== e.percent) return false;
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
