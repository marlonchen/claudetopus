"use strict";

// Fetch a page hop by hop. Every hop's URL is tier-matched before it is
// requested, so a host missing from tiers.yaml is never contacted; redirects
// are followed by hand for the same reason.
//
// RESEARCH_CANDIDATES_TEST_HTTP_TARGET (host:port) sends every request to a
// local test server over plain http, with the URL it stands for in the
// X-Original-Url header. Tests only.

const { combineHops, matchUrl } = require("./tiers");

const MAX_HOPS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30000;
// API-key query parameters (snapshot-format.md, Cleaning the URL).
const KEY_PARAM = /^(api[_-]?key|key|token|access[_-]?token|secret|sig(nature)?)$/i;

// The URL as recorded: key parameters removed, fragment dropped.
const cleanUrl = (url) => {
  const clean = new URL(url.href);
  clean.hash = "";
  for (const name of [...clean.searchParams.keys()]) {
    if (KEY_PARAM.test(name)) clean.searchParams.delete(name);
  }
  if (![...clean.searchParams.keys()].length) clean.search = "";
  return clean;
};

// The fragment never leaves the machine; it is not part of an HTTP request.
const request = (url) => {
  const target = process.env.RESEARCH_CANDIDATES_TEST_HTTP_TARGET;
  const headers = { "user-agent": "research-candidates fetch-snapshot", accept: "text/html" };
  const sent = new URL(url.href);
  sent.hash = "";
  if (target) headers["x-original-url"] = sent.href;
  return fetch(target ? `http://${target}${sent.pathname}${sent.search}` : sent.href, {
    redirect: "manual",
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
};

const decode = (bytes, contentType) => {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

// Returns { url, html, tiers } for a saved page, or { url, refused: reason }
// with the URL to log (the refused hop, or the final URL).
const fetchPage = async (entries, startUrl) => {
  const matches = [];
  let url = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { url, refused: "not http" };
    }
    matches.push(matchUrl(entries, url));
    const combined = combineHops(matches);
    if (combined.refused) return { url, refused: combined.refused };

    let response;
    try {
      response = await request(url);
    } catch {
      return { url, refused: "network error" };
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      try {
        url = new URL(response.headers.get("location"), url);
      } catch {
        return { url, refused: "bad redirect" };
      }
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return { url, refused: `http ${response.status}` };
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      await response.body?.cancel();
      return { url, refused: "not html" };
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_BYTES) return { url, refused: "too large" };
    return { url, html: decode(bytes, contentType), tiers: combined };
  }
  return { url, refused: "too many redirects" };
};

module.exports = { cleanUrl, fetchPage };
