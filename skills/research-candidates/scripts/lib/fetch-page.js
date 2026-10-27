"use strict";

// Fetch a page hop by hop. Every hop's URL is tier-matched before it is
// requested, so a host missing from tiers.yaml is never contacted; redirects
// are followed by hand for the same reason.
//
// RESEARCH_CANDIDATES_TEST_HTTP_TARGET (127.0.0.1:<port> or localhost:<port>)
// sends every request to a local test server over plain http, with the URL it
// stands for in the X-Original-Url header. Tests only; any other value is
// ignored, so the variable can never send a page anywhere but this machine.

const { combineHops, matchUrl } = require("./tiers");

const MAX_HOPS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 30000;
// API-key query parameters (snapshot-format.md, Cleaning the URL).
const KEY_PARAM = /^(api[_-]?key|key|token|access[_-]?token|secret|sig(nature)?)$/i;
const TEST_TARGET = /^(127\.0\.0\.1|localhost):[0-9]{1,5}$/;

const isHttp = (url) => url.protocol === "https:" || url.protocol === "http:";

// The fragment never leaves the machine; it is not part of an HTTP request.
const withoutFragment = (url) => {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy;
};

// The URL as recorded: key parameters removed, fragment dropped.
const cleanUrl = (url) => {
  const clean = withoutFragment(url);
  for (const name of [...clean.searchParams.keys()]) {
    if (KEY_PARAM.test(name)) clean.searchParams.delete(name);
  }
  if (![...clean.searchParams.keys()].length) clean.search = "";
  return clean;
};

const request = (url) => {
  const sent = withoutFragment(url);
  const target = process.env.RESEARCH_CANDIDATES_TEST_HTTP_TARGET;
  const headers = { "user-agent": "research-candidates fetch-snapshot", accept: "text/html" };
  const options = { redirect: "manual", headers, signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (target && TEST_TARGET.test(target)) {
    headers["x-original-url"] = sent.href;
    return fetch(`http://${target}${sent.pathname}${sent.search}`, options);
  }
  return fetch(sent.href, options);
};

// The body, or null once it passes MAX_BYTES; never buffers more than that.
const readCapped = async (response) => {
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) {
      await response.body.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
};

const decode = (bytes, contentType) => {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
};

const refuse = (url, code, reason) => ({ url, refused: { code, reason } });

// Returns { url, html, tiers } for a saved page, or { url, refused: { code,
// reason } } with the URL to log (the refused hop, or the final URL) and the
// unfetchable.md reason.
const fetchPage = async (entries, startUrl) => {
  const matches = [];
  let url = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (!isHttp(url)) return refuse(url, "not-http", "not http");
    matches.push(matchUrl(entries, url));
    const combined = combineHops(matches);
    if (combined.refused) return { url, refused: combined.refused };

    let response;
    try {
      response = await request(url);
    } catch {
      return refuse(url, "network-error", "network error");
    }
    if (response.status >= 300 && response.status < 400 && response.headers.has("location")) {
      await response.body?.cancel();
      try {
        url = new URL(response.headers.get("location"), url);
      } catch {
        return refuse(url, "bad-redirect", "bad redirect");
      }
      continue;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return refuse(url, "http-error", `http ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/^\s*(text\/html|application\/xhtml\+xml)\b/i.test(contentType)) {
      await response.body?.cancel();
      return refuse(url, "not-html", "not html");
    }
    const bytes = await readCapped(response);
    if (!bytes) return refuse(url, "too-large", "too large");
    return { url, html: decode(bytes, contentType), tiers: combined };
  }
  return refuse(url, "too-many-redirects", "too many redirects");
};

module.exports = { cleanUrl, fetchPage, isHttp };
