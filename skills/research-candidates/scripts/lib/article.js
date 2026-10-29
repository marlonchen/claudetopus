"use strict";

// The article parser (article-format.md, Structure, Claim lines and Section
// states), shared by check, coverage and review-list. It reads every line as
// one of: blank, a `#` to `####` heading, a section state, a claim line or the
// excerpt right after one, and fails anything else as claim-format. It never
// judges structure (which blocks and sections, in which order, in which
// states): that is coverage's, from what this returns.
//
// Returns { title, titles, blocks, claims, rejected, strays, failures }:
// titles, every `#` heading as { text, line }, and title, the first or null;
// blocks [{ name, line, sections: [{ name, line, states, claims, rejected,
// issues: [{ name, line, states, claims, rejected }] }] }]; claims [{ line,
// text, tag, label, target, excerpt, excerptLine, block, section, issue }],
// each also under its section or issue; rejected, each claim line failed as
// claim-format, as { line, target }, also under its section or issue, so it
// still counts as a claim there (a `- ` line with no tag or link is one too,
// with target null); strays, the lines of each heading, state or
// claim with no block or section to sit in (a `###` before any `##`, a `####`
// or a state or claim before a block's first `###`), so nothing the tree
// leaves out is lost; failures [{ line, code }], in line order.

const { SECTION_STATES } = require("./constants");

const HEADING = /^(#{1,4}) (\S.*)$/;
// - <claim text> `<tag>` [<label>](<target>)
const CLAIM = /^- (\S.*?) `([^`]+)` \[([^\]]+)\]\(([^()\s]+)\)$/;
const EXCERPT = /^ +> (\S.*)$/;
// Claim text that holds a second code span or link: a backtick, an inline or
// reference link, an autolink, an HTML tag, a bare URL or email address, or a
// mailto: link. Text the figure check strips would otherwise hide a figure
// from it (article-format.md, Figures).
// The link text: `s` and a number, so no figure hides in it.
const LABEL = /^s\d+$/;
const EXTRA_SPAN =
  /`|\]\(|\]\[|<[a-z][a-z0-9+.-]*:|<[^\s<>@]+@|<\/?[a-z][^<>]*>|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\bmailto:|[^\s@<>]@[^\s@<>]+\.[a-z]/i;

const parseArticle = (text) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const titles = [];
  const blocks = [];
  const claims = [];
  const rejected = [];
  const strays = [];
  const failures = [];
  let block = null;
  let section = null;
  let issue = null;
  // The claim whose excerpt must be the next line, and whether it was.
  let pending = null;
  const fail = (line) => failures.push({ line, code: "claim-format" });
  const reject = (claim) => {
    fail(claim.line);
    const entry = { line: claim.line, target: claim.target };
    rejected.push(entry);
    (claim.issue ?? claim.section)?.rejected.push(entry);
  };

  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = raw.trimEnd();
    const excerpt = EXCERPT.exec(line);
    if (pending) {
      const claim = pending;
      pending = null;
      if (excerpt && claim.malformed) {
        reject(claim);
        continue;
      }
      if (excerpt) {
        claim.excerpt = excerpt[1];
        claim.excerptLine = n;
        claims.push(claim);
        (claim.issue ?? claim.section)?.claims.push(claim);
        continue;
      }
      reject(claim);
    }
    if (line === "") continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const name = heading[2];
      if (level === 1) titles.push({ text: name, line: n });
      if (level === 2) {
        block = { name, line: n, sections: [] };
        blocks.push(block);
        section = null;
        issue = null;
      }
      if (level === 3) {
        section = { name, line: n, states: [], claims: [], rejected: [], issues: [] };
        if (block) block.sections.push(section);
        else strays.push(n);
        issue = null;
      }
      if (level === 4) {
        // With no section, the states and claims under it are strays too.
        issue = section && { name, line: n, states: [], claims: [], rejected: [] };
        if (issue) section.issues.push(issue);
        else strays.push(n);
      }
      continue;
    }
    if (SECTION_STATES.includes(line)) {
      const container = issue ?? section;
      if (container) container.states.push({ state: line, line: n });
      else strays.push(n);
      continue;
    }
    const claim = CLAIM.exec(line);
    if (claim) {
      pending = {
        line: n,
        text: claim[1],
        tag: claim[2],
        label: claim[3],
        target: claim[4],
        excerpt: null,
        excerptLine: null,
        block,
        section,
        issue,
      };
      if (EXTRA_SPAN.test(claim[1]) || !LABEL.test(claim[3])) pending.malformed = true;
      if (!section) strays.push(n);
      continue;
    }
    // A claim line without its tag or link: failed as before, and still a claim.
    if (line.startsWith("- ")) {
      reject({ line: n, target: null, section, issue });
      if (!section) strays.push(n);
      continue;
    }
    fail(n);
  }
  if (pending) reject(pending);
  return { title: titles[0] ?? null, titles, blocks, claims, rejected, strays, failures };
};

module.exports = { parseArticle };
