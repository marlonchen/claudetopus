"use strict";

// Tier matching (source-tiers.md). URLs and `match` entries are both parsed
// with the WHATWG URL parser, so hosts compare in their ASCII (punycode),
// lower-case form. A host matches exactly or on a dot-label boundary; a path
// prefix matches on a segment boundary. tiers.yaml may not hold two entries
// some URL matches when neither lies within the other (`conflicts`), so the
// entries a URL matches always nest and the innermost wins (more host labels,
// then more path). Across redirects the tier is the strictest any hop gives,
// `owner` must not change, and `source` is the final hop's.

const TIER_RANK = { T1: 1, T2: 2, T3: 3, T4: 4 };

// { host, path } of a `match` value, or null when it is not a bare host with
// an optional path prefix.
const parseMatch = (match) => {
  if (typeof match !== "string" || !/^[^\s:/?#@]+(\/[^\s?#]*)?$/.test(match)) return null;
  let url;
  try {
    url = new URL(`https://${match}`);
  } catch {
    return null;
  }
  if (url.port || url.username || url.password) return null;
  // A wildcard or other odd character parses, but would never match a URL.
  if (!/^[a-z0-9._-]+$/.test(url.hostname)) return null;
  return { host: url.hostname, path: url.pathname.replace(/\/+$/, "") };
};

const hostMatches = (host, entryHost) => host === entryHost || host.endsWith(`.${entryHost}`);
const pathMatches = (pathname, prefix) =>
  prefix === "" || pathname === prefix || pathname.startsWith(`${prefix}/`);
const specificity = (entry) => [
  entry.parsed.host.split(".").length,
  entry.parsed.path.split("/").length,
];

// True when every URL `inner` matches, `outer` matches too.
const within = (inner, outer) =>
  hostMatches(inner.host, outer.host) && pathMatches(inner.path, outer.path);

// True when two parsed matches can both match one URL and neither lies within
// the other: the same host and path, or a deeper host with a shorter path
// (`www.example.com` and `example.com/news`). Which should win is unclear.
const conflicts = (a, b) => {
  const overlap =
    (hostMatches(a.host, b.host) || hostMatches(b.host, a.host)) &&
    (pathMatches(a.path, b.path) || pathMatches(b.path, a.path));
  return overlap && within(a, b) === within(b, a);
};

// The most specific entry for a URL object, or null.
const matchUrl = (entries, url) => {
  let best = null;
  for (const entry of entries) {
    if (!hostMatches(url.hostname, entry.parsed.host)) continue;
    if (!pathMatches(url.pathname, entry.parsed.path)) continue;
    if (!best) {
      best = entry;
      continue;
    }
    const [a, b] = [specificity(entry), specificity(best)];
    if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = entry;
  }
  return best;
};

// Combine the matched entry of every hop, first to last. Returns
// { tier, statements_only, owner, source } or { refused: { code, reason } }.
const combineHops = (matches) => {
  if (matches.some((m) => !m)) {
    return { refused: { code: "domain-not-in-tiers", reason: "domain not in tiers.yaml" } };
  }
  const owners = new Set(matches.map((m) => m.owner));
  if (owners.size > 1) {
    return {
      refused: { code: "owner-changes-across-redirects", reason: "owner changes across redirects" },
    };
  }
  const strictest = matches.reduce((a, b) => (TIER_RANK[b.tier] > TIER_RANK[a.tier] ? b : a));
  return {
    tier: strictest.tier,
    statements_only: matches.some((m) => m.statements_only === true),
    owner: matches[0].owner,
    source: matches[matches.length - 1].source,
  };
};

module.exports = { TIER_RANK, combineHops, conflicts, matchUrl, parseMatch };
