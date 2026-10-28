"use strict";

// The article parser (article-format.md, Structure, Claim lines and Section
// states), shared by check, coverage and review-list. It reads every line as
// one of: blank, a `#` to `####` heading, a section state, a claim line or the
// excerpt right after one, and fails anything else as claim-format. It never
// judges structure (which blocks and sections, in which order, in which
// states): that is coverage's, from what this returns.
//
// Returns { title, blocks, claims, failures }: title { text, line } or null;
// blocks [{ name, line, sections: [{ name, line, states, claims, issues:
// [{ name, line, states, claims }] }] }]; claims [{ line, text, tag, label,
// target, excerpt, excerptLine, block, section, issue }], each also under its
// section or issue; failures [{ line, code }], in line order.

const { SECTION_STATES } = require("./constants");

const HEADING = /^(#{1,4}) (\S.*)$/;
// - <claim text> `<tag>` [<label>](<target>)
const CLAIM = /^- (\S.*?) `([^`]+)` \[([^\]]+)\]\(([^()\s]+)\)$/;
const EXCERPT = /^ +> (\S.*)$/;
// Claim text that holds a second code span or link: a backtick, an inline or
// reference link, an autolink, an HTML tag or a bare URL. Text the figure
// check strips would otherwise hide a figure from it (article-format.md, Figures).
const EXTRA_SPAN =
  /`|\]\(|\]\[|<[a-z][a-z0-9+.-]*:|<[^\s<>@]+@|<\/?[a-z][^<>]*>|\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i;

const parseArticle = (text) => {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  let title = null;
  const blocks = [];
  const claims = [];
  const failures = [];
  let block = null;
  let section = null;
  let issue = null;
  // The claim whose excerpt must be the next line, and whether it was.
  let pending = null;
  const fail = (line) => failures.push({ line, code: "claim-format" });

  for (const [i, raw] of lines.entries()) {
    const n = i + 1;
    const line = raw.trimEnd();
    const excerpt = EXCERPT.exec(line);
    if (pending) {
      const claim = pending;
      pending = null;
      if (excerpt && claim.malformed) {
        fail(claim.line);
        continue;
      }
      if (excerpt) {
        claim.excerpt = excerpt[1];
        claim.excerptLine = n;
        claims.push(claim);
        (claim.issue ?? claim.section)?.claims.push(claim);
        continue;
      }
      fail(claim.line);
    }
    if (line === "") continue;
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      const name = heading[2];
      if (level === 1) title ??= { text: name, line: n };
      if (level === 2) {
        block = { name, line: n, sections: [] };
        blocks.push(block);
        section = null;
        issue = null;
      }
      if (level === 3) {
        section = { name, line: n, states: [], claims: [], issues: [] };
        block?.sections.push(section);
        issue = null;
      }
      if (level === 4) {
        issue = { name, line: n, states: [], claims: [] };
        section?.issues.push(issue);
      }
      continue;
    }
    if (SECTION_STATES.includes(line)) {
      (issue ?? section)?.states.push({ state: line, line: n });
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
      if (EXTRA_SPAN.test(claim[1])) pending.malformed = true;
      continue;
    }
    fail(n);
  }
  if (pending) fail(pending.line);
  return { title, blocks, claims, failures };
};

module.exports = { parseArticle };
