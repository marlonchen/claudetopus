"use strict";

// The published page (page.md), rendered from what publish's gates judged:
// ballot.yaml, and for each ready contest the article ready() parsed and the
// snapshots it hashed. It reads no file. Every value it interpolates is
// HTML-escaped, and every receipt link is rebuilt from its parsed URL with no
// query or fragment (SKILL.md step 6.2).

const { POSITIONS_ISSUES, SECTION_STATES, SECTIONS } = require("./constants");
const { resolveTarget } = require("./check");
const { Failure } = require("./output");

const [UNKNOWN, NOT_RESEARCHED, NOT_JOB] = SECTION_STATES;

// SKILL.md step 6.2: the page's fixed CSP.
const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'";

// page.md, Type: the four embedded faces, each a file in the skill's fonts/.
const FONT_FACES = [
  {
    file: "atkinson-hyperlegible-next-400.woff2",
    family: "Atkinson Hyperlegible Next",
    weight: 400,
  },
  {
    file: "atkinson-hyperlegible-next-700.woff2",
    family: "Atkinson Hyperlegible Next",
    weight: 700,
  },
  { file: "ballot-serif-400.woff2", family: "Ballot Serif", weight: 400 },
  { file: "ballot-serif-600.woff2", family: "Ballot Serif", weight: 600 },
];

// page.md, Race screen: a candidate section's chip and heading is its name or
// its first word ("Record" for "Record in public office").
const PAGE_NAMES = {
  "Record in public office": "Record",
  "Controversies and cases": "Controversies",
};
const pageName = (section) => PAGE_NAMES[section] ?? section;
const anchor = (id, section) => `${id}--${pageName(section).toLowerCase().replaceAll(" ", "-")}`;

// page.md, Measure and retention races: the sections whose claims are arguments.
const ARGUMENTS = ["Arguments for", "Arguments against"];

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

// A decorative glyph, which screen readers skip (page.md, Accessibility).
const glyph = (c) => `<span aria-hidden="true">${c}</span>`;
// A <summary>'s closed and open cues, shown by CSS.
const DISCLOSURE = `<span class="dc" aria-hidden="true">▸</span><span class="do" aria-hidden="true">▾</span>`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DATE = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
// "Oct 19, 2026" from 2026-10-19, or null when it is not a real date.
const showDate = (value) => {
  const m = DATE.exec(typeof value === "string" ? value : "");
  if (!m) return null;
  const [y, mo, d] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// An http(s) URL with no credentials, parsed, or null.
const httpUrl = (value) => {
  if (typeof value !== "string") return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const http = url.protocol === "http:" || url.protocol === "https:";
  return http && !url.username && !url.password ? url : null;
};
// Scheme, host and path only: no query or fragment ever reaches a link.
const rebuilt = (url) => `${url.protocol}//${url.host}${url.pathname}`;

// page.md, Receipts: the receipt's fixed line and its links, by the link
// cases SKILL.md step 6.2 sets.
const receiptOf = (rel, fields, archives) => {
  const date = showDate(fields.fetched);
  if (!date || typeof fields.source !== "string" || fields.source === "")
    throw new Failure(rel, "snapshot-invalid");
  const noLink = {
    line: `The quote above was saved on ${date} from this source; its address can't be shared.`,
    links: [],
  };
  if (rel.startsWith("sources/_ballot/")) {
    // The per-ballot path can carry the precinct, so only the origin.
    const url = httpUrl(fields.url);
    if (!url) return noLink;
    return {
      line: `The quote above was saved on ${date} from the official ballot record; this link opens the county election site.`,
      links: [{ text: "County election site", href: `${url.protocol}//${url.host}/` }],
    };
  }
  if (fields.public_url !== undefined) {
    // A public_url never has a query (snapshot-format.md); one that does is
    // not linked, since dropping it would open a different page.
    const url = httpUrl(fields.public_url);
    if (!url || url.search) return noLink;
    return {
      line: `The quote above was saved on ${date} from the official record this link shows.`,
      links: [{ text: "Original page", href: rebuilt(url) }],
    };
  }
  if (fields.method === "api") {
    return {
      line: `The quote above was saved on ${date} from this source's official data service, which has no page to link.`,
      links: [],
    };
  }
  const url = httpUrl(fields.url);
  // Dropping a query would open a different page.
  if (!url || url.search) return noLink;
  const links = [{ text: "Original page", href: rebuilt(url) }];
  const stamp = archives.get(rel);
  if (stamp)
    links.push({
      text: "Saved copy",
      href: `https://web.archive.org/web/${stamp}/${rebuilt(url)}`,
    });
  return {
    line: `The quote above was saved from this page on ${date}. If the page has changed, the saved quote is what this summary used.`,
    links,
  };
};

// page.md, Source labels.
const TIER_LABELS = { T1: "Official record", T2: "News", T3: "Analysis" };
const sourceLabel = (tag, type, section) => {
  if (tag.endsWith("s"))
    return type === "measure" && ARGUMENTS.includes(section)
      ? "From the official voter guide"
      : "Candidate's own words";
  return TIER_LABELS[tag.slice(0, 2)];
};

// page.md, Race screen: an excerpt over this many characters shows its start,
// cut at a word boundary, and the rest behind "… full quote".
const CUT = 200;
const cutExcerpt = (excerpt) => {
  const chars = [...excerpt];
  if (chars.length <= CUT) return [excerpt, ""];
  const head = chars.slice(0, CUT).join("");
  const space = head.search(/\s\S*$/);
  const at = space > 0 ? space : head.length;
  return [excerpt.slice(0, at).trimEnd(), excerpt.slice(at).trimStart()];
};

// One claim: its text, its excerpt shown by default, and its receipt.
// `where` is { who, section, issue } for the receipt's spoken name.
const claimHtml = (claim, ctx, where) => {
  const rel = resolveTarget(claim.target);
  const fields = ctx.readSnapshot(rel)?.fields ?? {};
  const { line, links } = receiptOf(rel, fields, ctx.archives);
  const says = claim.text.startsWith("Says:");
  const text = says
    ? `<span class="says">Says:</span> ${esc(claim.text.slice("Says:".length).trimStart())}`
    : esc(claim.text);
  const [head, rest] = cutExcerpt(claim.excerpt);
  const quote = rest
    ? `“${esc(head)}<details class="more"><summary>… full quote ${DISCLOSURE}</summary>${esc(rest)}”</details>`
    : `“${esc(head)}”`;
  const spoken = ` for ${where.who}, ${pageName(where.section)} section${where.issue ? `, ${where.issue}` : ""}`;
  const label = sourceLabel(claim.tag, ctx.contest.type, where.section);
  const linkHtml = links
    .map((l) => `<a class="link" href="${esc(l.href)}">${esc(l.text)} ${glyph("↗")}</a>`)
    .join(" ");
  return [
    `<div class="claim"><p>${text}</p>`,
    `<blockquote>${quote}<cite>${esc(fields.source)}</cite></blockquote>`,
    `<details class="src"><summary><span class="lab"><span class="badge">${esc(label)}</span><span class="vh">.</span>&nbsp;${glyph("·")}</span>`,
    `<span class="link">Source<span class="vh">${esc(spoken)}</span> ${DISCLOSURE}</span></summary>`,
    `<div class="note">${esc(fields.source)}<br>${esc(line)}${linkHtml ? `<br>${linkHtml}` : ""}</div></details></div>`,
  ].join("");
};

// page.md, Contest states: a race not ready yet, and a ballot with none ready.
const NOT_READY_NOTE = `<div class="note"><b>Not ready yet.</b> Every candidate gets the same research before anything shows here. Check back; this link stays the same.</div>`;

const UNKNOWN_HTML = `<div class="unk">${glyph("○")} Unknown: no source found.</div>`;

// A section's or issue's state: one of SECTION_STATES, or "claims".
const stateOf = (part) => part.states[0]?.state ?? "claims";

// The claims of a part, or its Unknown line.
const partHtml = (part, ctx, where) =>
  stateOf(part) === UNKNOWN
    ? UNKNOWN_HTML +
      (ctx.thinRecords ? `<div class="meta">Thin records are common for judges.</div>` : "")
    : part.claims.map((c) => claimHtml(c, ctx, where)).join("");

// A section name without its letter, as the article heads it ("B. Background").
const sectionNamed = (block, name) =>
  block.sections.find((s) => s.name.replace(/^[A-Z]\. /, "") === name);

const notResearchedLine = (candidates) =>
  `<div class="unk">Not researched yet. Research on this topic is still to come${candidates ? ", for every candidate at once" : ""}. Check back; this link stays the same.</div>`;

// A person's heading in a section: name, then party and status in muted text.
const personHeading = (person, level) => {
  const notes = [person.party, person.label].filter(Boolean);
  const muted = notes.length ? ` <span class="party">· ${notes.map(esc).join(" · ")}</span>` : "";
  return `<h${level}>${esc(person.name)}${muted}</h${level}>`;
};

// One section of a race: its heading, then a block per person (candidate
// races) or its claims (measures and retention), or one line for a state
// that holds for everyone.
const sectionHtml = (name, people, ctx) => {
  const entries = people
    .map((person) => ({ person, part: sectionNamed(person.block, name) }))
    .filter((e) => e.part);
  const id = anchor(ctx.contest.id, name);
  const state = stateOf(entries[0].part);
  const candidates = ctx.contest.type === "candidate";
  if (state === NOT_JOB)
    return `<h2 id="${esc(id)}">${esc(pageName(name))} <span class="oos">(not part of this office's job)</span></h2>`;
  const heading = `<h2 id="${esc(id)}">${esc(pageName(name))}</h2>`;
  // Only a measure has no candidate to name (page.md, Not researched yet).
  if (state === NOT_RESEARCHED) return heading + notResearchedLine(ctx.contest.type !== "measure");
  const lead = ARGUMENTS.includes(name)
    ? `<div class="meta">These are arguments, not facts.</div>`
    : "";
  if (!candidates) {
    const [{ person, part }] = entries;
    return heading + lead + partHtml(part, ctx, { who: person.who, section: name });
  }
  const issues = entries[0].part.issues;
  if (name === "Positions" && issues.length) {
    const body = POSITIONS_ISSUES[ctx.contest.officeType]
      .map((issue) => {
        const blocks = entries.map(({ person, part }) => {
          const held = part.issues.find((i) => i.name === issue);
          const where = { who: person.name, section: name, issue };
          return `<div class="${person.className}">${personHeading(person, 4)}${partHtml(held, ctx, where)}</div>`;
        });
        return `<h3 class="issue">${esc(issue)}</h3>${blocks.join("")}`;
      })
      .join("");
    return heading + body;
  }
  const blocks = entries.map(
    ({ person, part }) =>
      `<div class="${person.className}">${personHeading(person, 3)}${partHtml(part, ctx, { who: person.name, section: name })}</div>`,
  );
  return heading + lead + blocks.join("");
};

// page.md, Contest states: a ready contest whose not_researched is all.
const notResearchedContest = (raw) => raw.not_researched === "all";

// The people of a race, each with its article block, in ballot order:
// printed candidates, then certified write-ins (coverage's order).
const peopleOf = (contest, raw, article) =>
  contest.blocks.map((b, i) => {
    const block = article.blocks[i];
    if (raw.type === "measure") return { block, who: titleOf(raw), name: titleOf(raw) };
    if (raw.type === "retention") return { block, who: b.name, name: b.name };
    const person = raw.candidates.find((c) => c.id === b.subject);
    const label =
      person.status === "certified_write_in"
        ? "Certified write-in"
        : person.status === "withdrawn_still_printed"
          ? "Withdrew (still on printed ballot)"
          : null;
    return {
      block,
      who: b.name,
      name: b.name,
      party: person.party_name ?? person.party,
      label,
      status: person.status,
      className: person.status === "withdrawn_still_printed" ? "cand withdrawn" : "cand",
    };
  });

// The title the page shows for a contest (SKILL.md step 6.2).
const titleOf = (raw) => raw.display_title ?? raw.title;

// page.md, Race screen and Measure and retention races: the coverage banner.
const bannerOf = (raw, people, article, pending) => {
  const topics = pending ? [`${plural(pending, "topic")} not researched yet`] : [];
  const covered = pending ? "" : " covered";
  let parts;
  if (raw.type === "measure") parts = ["Official text and fiscal note saved"];
  else if (raw.type === "retention") {
    const cited = new Set(article.claims.map((c) => resolveTarget(c.target)));
    parts = [`Official record searched: ${plural(cited.size, "source")}`];
  } else {
    const printed = people.filter((p) => p.status === "on_ballot").length;
    const writeIns = people.filter((p) => p.status === "certified_write_in").length;
    const noun = printed === 1 ? "candidate" : "candidates";
    parts =
      raw.vote_for > 1
        ? [`${printed} of ${printed} ${noun}${covered}`, `Vote for up to ${raw.vote_for}`]
        : [`${printed} of ${printed} ${noun} on the official ballot${covered}`];
    if (writeIns) parts.push(`+${plural(writeIns, "certified write-in")}${covered}`);
  }
  return `<div class="banner">${glyph("✓")} ${esc([...parts, ...topics].join(" · "))}</div>`;
};

const backLink = `<a class="link" href="#ballot">${glyph("←")} All races</a>`;

// The way on from a race: the next race on the ballot, if any, then the list.
const nextHtml = (next) =>
  `<div class="next">${
    next
      ? `<a class="link" href="#${esc(next.id)}">Next on your ballot: ${esc(titleOf(next))} ${glyph("→")}</a>`
      : ""
  }${backLink}</div>`;

// One race. `answer` is ready()'s for it; `contest` coverage's reading of it.
const raceHtml = (raw, contest, answer, next, page) => {
  const head = [
    `<section class="race" id="${esc(raw.id)}">`,
    backLink,
    `<h1>${esc(titleOf(raw))}</h1>`,
  ];
  const meta = `<div class="meta">Updated ${esc(page.updated)} · Not affiliated with any campaign or party · <a class="link" href="#ballot">About this guide ${glyph("↑")}</a></div>`;
  const voteFor =
    raw.type === "candidate" && raw.vote_for > 1
      ? `<div class="meta">Vote for ${esc(raw.vote_for)}</div>`
      : "";
  const end = [nextHtml(next), "</section>"];
  if (!answer?.ready) {
    return [...head, voteFor, meta, NOT_READY_NOTE, ...end].join("");
  }
  const { article } = answer;
  const people = peopleOf(contest, raw, article);
  const ctx = {
    contest,
    readSnapshot: answer.readSnapshot,
    archives: page.archives,
    thinRecords: raw.type === "retention" && raw.office_type === "judicial",
  };
  const names = SECTIONS[raw.type];
  if (notResearchedContest(raw)) {
    const shown = names
      .filter((n) => n === "On the ballot")
      .map((n) => sectionHtml(n, people, ctx));
    const candidates =
      raw.type === "measure"
        ? ""
        : " Every candidate gets the same research before the rest shows here.";
    return [
      ...head,
      meta,
      ...shown,
      `<div class="note"><b>Not researched yet.</b> This race is on your ballot, but we haven't researched it yet.${candidates} Check back; this link stays the same.</div>`,
      ...end,
    ].join("");
  }
  // Each section's state is the same for every person who has it (coverage).
  const states = new Map(
    names.map((n) => [n, stateOf(people.map((p) => sectionNamed(p.block, n)).find(Boolean))]),
  );
  const pending = names.filter((n) => states.get(n) === NOT_RESEARCHED).length;
  const chips = names
    .filter((n) => states.get(n) !== NOT_JOB)
    .map((n) => `<a class="chip" href="#${esc(anchor(raw.id, n))}">${esc(pageName(n))}</a>`)
    .join("");
  const writeIns =
    raw.type === "candidate" && !page.writeInList
      ? `<div class="meta">Certified write-ins: none published</div>`
      : "";
  const official = raw.type === "retention" ? `<p class="who">${esc(people[0].name)}</p>` : "";
  return [
    ...head,
    bannerOf(raw, people, article, pending),
    meta,
    writeIns,
    official,
    `<nav class="chips" aria-label="Topics in this race">${chips}</nav>`,
    ...names.map((n) => sectionHtml(n, people, ctx)),
    ...end,
  ].join("");
};

const CSS = `:root{--fg:#1b1d1e;--muted:#55595c;--bg:#ffffff;--quote-bg:#f2f3f1;--line:#d5d8d6;--accent:#0f5f5c;--visited:#5a4a7a;
--body:"Atkinson Hyperlegible Next",-apple-system,system-ui,sans-serif;--serif:"Ballot Serif",Georgia,serif}
@media (prefers-color-scheme:dark){:root{--fg:#e8e6e1;--muted:#a9aca8;--bg:#141617;--quote-bg:#1e2122;--line:#33383a;--accent:#5fbfb7;--visited:#b3a3d6}}
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 var(--body);overflow-wrap:break-word}
main{max-width:640px;margin:0 auto;padding:16px}
.race{content-visibility:auto;contain-intrinsic-size:auto 1200px;border-top:1px solid var(--line);margin-top:32px;padding-top:16px}
h1{font:600 24px/1.2 var(--serif);margin:8px 0}
h2{font:600 19px/1.3 var(--serif);margin:24px 0 8px}
h3,h4{font:700 17px/1.4 var(--body);margin:0}
h3.issue{font:600 17px/1.4 var(--serif);margin:16px 0 4px}
.meta,.party,.oos{color:var(--muted);font-size:14px}
.party,.oos{font-weight:400}
p{margin:0}
a,.link{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.link{display:inline-flex;align-items:center;gap:4px;min-height:44px}
a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
a[href^="http"]:visited{color:var(--visited)}
::selection{background:color-mix(in srgb,var(--accent) 25%,transparent)}
summary{list-style:none;cursor:pointer;min-height:44px}
summary::-webkit-details-marker{display:none}
details[open]>summary .dc,details:not([open])>summary .do{display:none}
.vh{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
details.how{margin:8px 0;font-size:14px;color:var(--muted)}
details.how summary{display:flex;align-items:center;gap:4px;color:var(--accent);text-decoration:underline}
details.how ol{margin:0 0 8px;padding-left:24px}
details.src summary{display:flex;align-items:center;flex-wrap:wrap;gap:4px}
.lab{white-space:nowrap}
details.more summary{display:flex;align-items:center;gap:4px;font:14px var(--body);color:var(--accent)}
.banner{border:2px solid var(--fg);border-radius:8px;padding:8px 12px;margin:8px 0}
.list{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.list li{border-bottom:1px solid var(--line)}
.list .row{display:flex;justify-content:space-between;align-items:center;min-height:48px;gap:8px;color:var(--fg);text-decoration:none}
.list .st{color:var(--muted);font-size:14px;white-space:nowrap}
.list .st.ok{color:var(--fg)}
.chev{color:var(--muted);margin-left:4px}
.sub{display:block;color:var(--muted);font-size:14px}
nav.chips{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0}
.chip{border:1px solid var(--muted);border-radius:22px;padding:0 12px;min-height:44px;display:flex;align-items:center;font-size:14px;max-width:100%;color:var(--fg);text-decoration:none}
.cand{border-top:1px solid var(--line);padding:12px 0}
.cand.withdrawn,.cand.withdrawn .party{color:var(--muted)}
.claim{margin-top:8px}
.says{font-weight:700}
blockquote{margin:8px 0 4px;padding:8px 12px;border-left:3px solid var(--fg);background:var(--quote-bg);font:17px/1.45 var(--serif)}
blockquote cite{display:block;font:14px var(--body);color:var(--muted);font-style:normal;margin-top:4px}
.badge{font-size:14px;color:var(--muted)}
.unk{font-style:italic}
.next{border-top:1px solid var(--line);margin-top:16px;padding-top:8px;display:flex;flex-direction:column;gap:8px}
.note{background:var(--quote-bg);border-radius:8px;padding:12px;margin-top:12px}
.who{margin:8px 0}`;

const fontCss = (fonts) =>
  fonts
    .map(
      (f) =>
        `@font-face{font-family:"${f.family}";font-style:normal;font-weight:${f.weight};src:url(data:font/woff2;base64,${f.data.toString("base64")}) format("woff2")}`,
    )
    .join("\n");

// page.md, Every screen: the six lines of "How to read this".
const HOW_TO_READ = [
  "The quote under each claim is the exact text from the source.",
  "The source labels say where each fact comes from: “Official record” is a government record, “News” is independent reporting, “Analysis” is nonpartisan analysis, and “Candidate's own words” and “From the official voter guide” are what the candidate, or the guide's signers, say.",
  "“Says:” marks the candidate's own claim about themselves.",
  "“○ Unknown” means we looked and found nothing.",
  "“Not researched yet” means we haven't looked yet.",
  "Candidates are listed in official ballot order.",
];

// The ballot list: one row per contest, in ballot order.
const ballotHtml = (raws, answers, page) => {
  const readyToRead = raws.filter(
    (r) => answers.get(r.id)?.ready && !notResearchedContest(r),
  ).length;
  const anyReady = raws.some((r) => answers.get(r.id)?.ready);
  const count = `${plural(page.contestCount, "contest")} on your ballot`;
  const banner = readyToRead
    ? `${esc(count)} · <b>${readyToRead} ready to read</b>`
    : `${esc(count)} · none ready yet`;
  const rows = raws.map((raw) => {
    const answer = answers.get(raw.id);
    const [status, ok] = !answer?.ready
      ? ["Not ready yet", false]
      : notResearchedContest(raw)
        ? ["Not researched yet", false]
        : ["Ready", true];
    const sub =
      raw.type === "candidate" && raw.vote_for > 1
        ? `<span class="sub">Vote for ${esc(raw.vote_for)}</span>`
        : "";
    return `<li><a class="row" href="#${esc(raw.id)}"><span>${esc(titleOf(raw))}${sub}</span><span class="st${ok ? " ok" : ""}">${status}<span class="chev" aria-hidden="true">›</span></span></a></li>`;
  });
  return [
    `<section id="ballot">`,
    `<h1>${esc(page.title)}</h1>`,
    `<div class="meta">Made by ${esc(page.displayName)} for our family. Not affiliated with any campaign or party. Facts only, every one with its source.</div>`,
    `<div class="meta">Updated ${esc(page.updated)}</div>`,
    `<details class="how"><summary>How to read this ${DISCLOSURE}</summary><ol>${HOW_TO_READ.map((l) => `<li>${esc(l).replace("○", glyph("○"))}</li>`).join("")}</ol></details>`,
    `<div class="banner">${banner}</div>`,
    anyReady ? "" : NOT_READY_NOTE,
    `<div class="meta">Tap a race to compare the candidates.</div>`,
    `<ul class="list">${rows.join("")}</ul>`,
    `</section>`,
  ].join("");
};

// The page. `ballot` is ballot.yaml as read; `contests` coverage's reading of
// its contests, by id; `answers` ready()'s Map; `updated` the publish date
// (YYYY-MM-DD); `archives` a Map from snapshot path to its Wayback capture
// time; `writeInList` whether a write_in_list snapshot exists; `fonts` the
// FONT_FACES with their bytes as `data`.
const renderPage = ({
  ballot,
  contests,
  answers,
  displayName,
  updated,
  archives,
  writeInList,
  fonts,
}) => {
  const raws = ballot.contests;
  const page = {
    title: `Your ${String(ballot.election).slice(0, 4)} ballot`,
    contestCount: ballot.contest_count,
    displayName,
    updated: showDate(updated),
    archives,
    writeInList,
  };
  const races = raws.map((raw, i) =>
    raceHtml(raw, contests.get(raw.id), answers.get(raw.id), raws[i + 1], page),
  );
  return [
    "<!doctype html>",
    `<html lang="en"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    `<meta name="viewport" content="width=device-width,initial-scale=1">`,
    `<meta name="robots" content="noindex, nofollow">`,
    `<meta name="referrer" content="no-referrer">`,
    `<title>${esc(page.title)}</title>`,
    `<style>\n${fontCss(fonts)}\n${CSS}\n</style>`,
    `</head><body><main>`,
    ballotHtml(raws, answers, page),
    ...races,
    `</main></body></html>`,
    "",
  ].join("\n");
};

module.exports = { CSP, FONT_FACES, renderPage };
