"use strict";

// Fetch a page hop by hop. Every hop's URL is privacy-checked and then
// tier-matched before it is requested, so a URL holding a private value or a
// host missing from tiers.yaml is never contacted; redirects are followed by
// hand for the same reason.
//
// RESEARCH_CANDIDATES_TEST_HTTP_TARGET (127.0.0.1:<port> or localhost:<port>)
// sends every request to a local test server over plain http, with the URL it
// stands for in the X-Original-Url header. Tests only; any other value is
// ignored, so the variable can never send a page anywhere but this machine.

const { domainToUnicode } = require("node:url");
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

// The URL as recorded: credentials and key parameters removed, fragment dropped.
const cleanUrl = (url) => {
  const clean = withoutFragment(url);
  clean.username = "";
  clean.password = "";
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
  if (!response.body) return Buffer.alloc(0);
  // An explicit reader: the stream is locked to it, so it is the one that cancels.
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
};

// windows-1252 bytes 0x80-0x9f (WHATWG Encoding), which latin1, iso-8859-1 and
// us-ascii labels also name. Node 20's TextDecoder decodes them as C1 controls.
const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f" + "\u0090‘’“”•–—˜™š›œ\u009džŸ";

const decode = (bytes, contentType) => {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1];
  let decoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  if (decoder.encoding === "windows-1252") {
    return Buffer.from(bytes)
      .toString("latin1")
      .replace(/[\x80-\x9f]/g, (c) => CP1252_HIGH[c.charCodeAt(0) - 0x80]);
  }
  return decoder.decode(bytes);
};

const refuse = (url, code, reason) => ({ url, refused: { code, reason } });

// Every spelling of a URL the privacy check reads: as given (the argument or
// the Location header), parsed, and with its host in Unicode, since parsing
// turns a Unicode host into punycode. Each is checked on its own, so no
// phrase is read across two of them.
const spellings = (url, given) => {
  const host = domainToUnicode(url.hostname) + (url.port ? `:${url.port}` : "");
  return [given, url.href, url.href.replace(url.host, () => host)];
};

// Fetch reads header bytes as latin1, so a Location sent as raw UTF-8 arrives
// as mojibake. Read it as UTF-8, as browsers do, when its bytes are valid UTF-8.
const fromHeader = (value) => {
  if (!/[\x80-\xff]/.test(value)) return value;
  const utf8 = Buffer.from(value, "latin1").toString("utf8");
  return utf8.includes("\ufffd") ? value : utf8;
};

// Returns { url, html, tiers } for a saved page, or { url, refused: { code,
// reason } } with the URL to log (the refused hop, or the final URL) and the
// unfetchable.md reason. The caller has privacy-checked `startUrl`;
// `checkPrivate(texts)` throws on a private value in any of `texts`, and runs
// on each redirect's Location before it is parsed and on every spelling once
// it is, so no URL is requested, tier-matched or returned for logging unchecked.
const fetchPage = async (entries, startUrl, checkPrivate) => {
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
      const location = response.headers.get("location");
      const given = fromHeader(location);
      // A bad redirect logs only the hop before it, but its text is still checked.
      checkPrivate([location, given]);
      try {
        url = new URL(given, url);
      } catch {
        return refuse(url, "bad-redirect", "bad redirect");
      }
      checkPrivate(spellings(url, given));
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
    let bytes;
    try {
      bytes = await readCapped(response);
    } catch {
      // A reset or a timeout partway through the body.
      return refuse(url, "network-error", "network error");
    }
    if (!bytes) return refuse(url, "too-large", "too large");
    return { url, html: decode(bytes, contentType), tiers: combined };
  }
  return refuse(url, "too-many-redirects", "too many redirects");
};

module.exports = { cleanUrl, fetchPage, isHttp, spellings };
