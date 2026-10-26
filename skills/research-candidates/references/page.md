# Page

The published page: one static HTML file per ballot, rendered by `publish` (SKILL.md step 6) and republished as contests become `ready`. This file is the layout and visual spec. Rendering safety rules (escaping, allowed links, CSP, privacy scan) are in SKILL.md step 6.

Wireframe: [page-wireframe.png](page-wireframe.png) (source: [page-wireframe.html](page-wireframe.html)). It shows the ballot list; a candidate race in four frames, in page order (its top and first three sections with Record not researched yet, its Money section with a receipt open, Positions with its first issue, and its last section with the links on); a race that is not ready yet; and a ballot question in two frames, the last race on the ballot. Races the wireframe does not draw are plain rows in its list, and its Next links skip them. Each phone frame is one viewport of the same page. The My weights screen is greyed out because it comes later (see Scope order).

## Every screen

The page is one file. The trust header and freshness line appear in full once, at the top, under the ballot title. Because a reader can open a texted link to one race and land mid-page, each race also carries one short muted line under its banner: "Updated Oct 24, 2026 · Not affiliated with any campaign or party · About this guide ↑", the last part linking to `#ballot`.

- **Trust header.** Under the title, one quiet line: "Made by <`display_name` from `publish.yaml`> for our family. Not affiliated with any campaign or party. Facts only, every one with its source." Right under it, a collapsed `<details>` titled "How to read this" holds six short lines:
  1. The quote under each claim is the exact text from the source.
  2. The source labels, and what each means.
  3. "Says:" marks the candidate's own claim about themselves.
  4. "○ Unknown" means we looked and found nothing.
  5. "Not researched yet" means we haven't looked yet.
  6. Candidates are listed in official ballot order.
- **Freshness.** "Updated Oct 24, 2026" under the title, using the publish time. The banner below carries the ready count.
- No party colors and no photos.

## Ballot screen

The title, then a two-part banner, "6 contests on your ballot · 4 ready to read". The first number comes from the official sample ballot, and the second counts `ready` contests. Then one line: "Tap a race to compare the candidates".

Contests follow in ballot order as one list, with no group headings (`ballot.yaml` has no level to group by, and grouping would break ballot order). Each contest is a row in a divided list, not a bordered card: one link that fills the row, holding the contest name on the left, its status in words on the right, and a chevron. Rows are at least 48px tall. A multi-seat contest shows "Vote for 3" under its name, from `vote_for` ([ballot-format.md](ballot-format.md)).

## Contest states

A contest that is not `ready` shows "Not ready yet" on the ballot list. Its row stays tappable and opens a short note: "Not ready yet. Every candidate gets the same research before anything shows here. Check back; this link stays the same." When no contest is `ready`, the banner reads "6 contests on your ballot · none ready yet", followed by the same note.

A `ready` contest whose every section, apart from On the ballot, is `Not researched yet` ([article-format.md](article-format.md)) shows "Not researched yet" on the ballot list and is not counted as ready to read. Its race shows the title, the On the ballot section and then one note in place of the rest, with no chips: "Not researched yet. This race is on your ballot, but we haven't researched it yet. Every candidate gets the same research before anything shows here. Check back; this link stays the same." A measure, which has no On the ballot section, shows the note alone.

## Race screen

The contest title and the coverage banner ("3 of 3 candidates on the official ballot covered"; for multi-seat contests "6 of 6 candidates covered · Vote for up to 3"). When any section is `Not researched yet`, the banner adds how many: "3 of 3 candidates on the official ballot covered · 1 topic not researched yet". Then a row of chips that jump to each section in [sections.md](sections.md): On the ballot, Background, Record, Money, Positions, Controversies. The chips wrap onto as many lines as they need and never clip or scroll sideways. Each chip is a plain link with a `--muted` border; none is shown as selected.

Each section is a heading. Under it, every candidate appears in ballot order as a block:

- name, then party in muted 14px text ("Cand. A · Democratic"): `party_name` from `ballot.yaml` whenever it is set (a printed party that is abbreviated or in all capitals needs one, [ballot-format.md](ballot-format.md)), otherwise `party` exactly as printed, so it is never abbreviated, and never colored. The "On the ballot" excerpt still quotes the sample ballot exactly ("Cand. A DEM"); contests with no printed party show none;
- the claim, with "Says:" on candidate-statement claims;
- **the verbatim excerpt, shown by default** as a quote, never hidden behind a tap, so the fairness of each summary is plain to every reader. An excerpt over 200 characters shows its first ~200 characters, cut at a word boundary, followed by a `<details>` "… full quote" with the rest;
- a source line: "Candidate's own words · Source ▸". The source name is not repeated here; the excerpt's `<cite>` and the receipt carry it.

The same block works for 2 to 6 candidates and for multi-seat contests.

**Positions issues.** Under Positions, each issue of the contest's office type ([sections.md](sections.md), Positions issues) is a sub-heading, in the list's order, and every candidate appears under each one in ballot order, so a reader compares the candidates on one issue at a time. The chips stay the six sections; issues get no chips.

**Source labels.** The page never shows tier codes. It uses these labels: "Official record" (T1 records), "News" (T2), "Analysis" (T3), and "Candidate's own words" (every `s`-tagged claim, which are exactly the "Says:" claims), except on measure arguments, whose `s`-tagged claims are labeled "From the official voter guide". See [source-tiers.md](source-tiers.md).

**Unknown and out of scope.** "○ Unknown: no source found" sits in that candidate's slot, in italic at full body contrast, so a gap shows up next to rivals who have claims. A section that is "Not part of this office's job" shows once, as a heading line with "(not part of this office's job)" and no per-candidate rows, and it is left out of the chips.

**Not researched yet.** A section in the state `Not researched yet` is in that state for every candidate, so it also shows once: its heading, then one line in italic at full body contrast and no per-candidate rows: "Not researched yet. Research on this topic is still to come, for every candidate at once. Check back; this link stays the same." It carries no ○, so it never reads as "we looked and found nothing". It keeps its chip, so a reader who jumps there learns that the topic is still pending.

**Withdrawn and write-in candidates.** The banner counts printed, non-withdrawn candidates. A withdrawn candidate stays in ballot position, in `--muted` text (never faded with opacity), labeled "Withdrew (still on printed ballot)", showing only the sections [sections.md](sections.md) gives it. Certified write-ins come after printed candidates, are labeled "Certified write-in" and counted separately ("+1 certified write-in covered"). When the county publishes no write-in list, the race says "Certified write-ins: none published".

**Receipts.** The whole source line is the `<summary>` of a block `<details>`, so the receipt opens below the line, full width. At large text sizes the line may wrap, but the label and its "·" separator stay together. Tapping it opens the receipt with the source name, the fetch date and the link, when there is one (the snapshot's `public_url` when it has one). There is no bottom sheet, so receipts work without JavaScript. Every receipt carries a fixed line: "The quote above was saved from this page on Oct 19, 2026. If the page has changed, the saved quote is what this summary used." Four receipts use a different line instead. A `public_url` link: "The quote above was saved on Oct 19, 2026 from the official record this link shows." A `_ballot` receipt, whose link is the county origin: "The quote above was saved on Oct 19, 2026 from the official ballot record; this link opens the county election site." A receipt with no link: "The quote above was saved on Oct 19, 2026 from this source; its address can't be shared." An API source with no `public_url`: "The quote above was saved on Oct 19, 2026 from this source's official data service, which has no page to link." When `archives.tsv` has a Wayback Machine capture of the snapshot, the receipt shows "Saved copy ↗" next to "Original page ↗", built as SKILL.md step 6.2 says. Which links a receipt gets, if any, is set by SKILL.md step 6.2.

**Moving between races.** The ballot list's anchor is `#ballot`, which no contest id may use ([ballot-format.md](ballot-format.md)). Every race has an anchor named for its contest id (for example `#us-house-07`), so a reader can text back a link to one race. Each section heading's anchor adds the section to the contest id (`#us-house-07--money`), and the chips link to their own race's anchors, so no id repeats on the page. Each race ends with two full-width links, stacked: "Next on your ballot: Governor →", then "← All races"; the last race on the ballot has no Next link and ends with "← All races" alone. These are plain anchors. Contest ids are neutral office names, never the ballot id, and `ballot-check` keeps private place names out of them ([ballot-format.md](ballot-format.md)).

## Measure and retention races

The same stack, with one block per section instead of one per candidate.

- **Measures:** What it does (official text) · Fiscal effect (official fiscal note) · Arguments for · Arguments against · Independent analysis. For and Against are sibling blocks of equal size, each labeled "from the official voter guide", and are never presented as facts. Banner: "Official text and fiscal note saved".
- **Retention:** the judge's or official's name, then On the ballot · Record in office · Evaluation findings · Discipline · Statements. Banner: "Official record searched: N sources". A section with no source shows "○ Unknown: no source found" plus a one-line note that thin records are common for judges.

## Type

Two open-license fonts, Latin subset, embedded as base64 `woff2` in the inline CSS, so the page makes no external requests (the woff2 files live in this skill's fonts directory). Budget: the four faces total at most 200KB of `woff2` before base64, which adds a third, so at most about 270KB in the page; subset further rather than exceed it.

- Atkinson Hyperlegible Next (400, 700) for body and UI. It was designed for low-vision readers, with distinct 1/l/I and 0/O, which matters for dollar figures and vote counts.
- Source Serif 4 (400, 600) for headings and excerpts, so the source's own words read differently from the summary.

## Tokens

Colors are CSS variables on `:root`, with dark values under `prefers-color-scheme: dark`. Contrast was measured with the WCAG formula.

| Token | Light | Dark | Contrast (light / dark) |
| --- | --- | --- | --- |
| `--fg` | `#1b1d1e` | `#e8e6e1` | 16.9 / 14.6 on `--bg` |
| `--muted` | `#55595c` | `#a9aca8` | 7.1 / 7.9 on `--bg`; 6.4 / 7.1 on `--quote-bg` |
| `--bg` | `#ffffff` | `#141617` | |
| `--quote-bg` | `#f2f3f1` | `#1e2122` | `--fg` 15.2 / 13.0 |
| `--line` | `#d5d8d6` | `#33383a` | dividers only, never text |
| `--accent` | `#0f5f5c` (teal) | `#5fbfb7` | 7.5 / 8.3; links, focus ring |
| `--visited` | `#5a4a7a` | `#b3a3d6` | 7.8 / 7.9 |

- Type scale: body 17px/1.5; h1 24px Source Serif 600; h2 19px; excerpt 17px/1.45 Source Serif; banners, notes and next/back links at body size; labels and source lines 14px minimum. No text smaller than 14px.
- Spacing: 4, 8, 12, 16, 24, 32. 16px side gutter; content max width 640px. Headings get more space above than below (24 above, 8 below).
- Tap targets: list rows, chips, every link and every `<summary>` (the source line, "… full quote", "How to read this") and next/back links are at least 44px tall.
- Every `<summary>` hides the browser's own disclosure marker (`list-style: none` and `::-webkit-details-marker { display: none }`) and carries both glyphs, each in an `aria-hidden="true"` span: CSS shows ▸ while closed and ▾ under `details[open]`, with no JavaScript, so Chrome and Safari give the same cue.
- Links are underlined, except list rows and chips, whose chevron or border marks them as tappable. Links that leave the page use `--visited` once visited; in-page links (chips, rows, "All races") keep their color, since a reader returns to them. The focus ring is a 2px `--accent` outline with a 2px offset. `::selection` uses `--accent` at 25% opacity.
- The accent teal belongs to no US party. Red and blue are never used, even for status.

One reading column at every width, capped at 640px and centered. Tablets and laptops get the same stack, not a grid. Each race's container (the element carrying its contest-id anchor) sets `content-visibility: auto` with `contain-intrinsic-size: auto 1200px`; topic sections inside a race do not, so a long ballot does not lay out every race at once on a slow phone; the placeholder size keeps the scrollbar and anchor jumps roughly stable as races render.

Page budget: the whole file, fonts included, should stay under 1MB. `publish` prints its size and warns above that (SKILL.md step 6.5).

## Accessibility

- `lang="en"` and a `<main>` landmark.
- Heading levels: h1 is the ballot or contest title, h2 is a section, h3 is a candidate. Under Positions, h3 is an issue and h4 a candidate. Measure and retention races have no h3: their sections are h2.
- The chips are a `<nav aria-label="Topics in this race">`.
- Each receipt `<summary>` is spoken in full: it shows "Candidate's own words · Source ▸" but reads "Candidate's own words. Source for Cand. A, Money section", using visually hidden text, so every section name reads cleanly ("Source for Cand. A, On the ballot section"). Under Positions it adds the issue: "Source for Cand. A, Positions section, Taxes and spending".
- Each excerpt is a `<blockquote>`, with the source name in `<cite>`.
- Decorative glyphs (○, ✓, ›, ▸, ▾, ↗, ↑, →, ←, and the source line's "·") sit in `aria-hidden="true"` spans, so screen readers skip them.
- At 200% text size nothing overlaps and nothing scrolls sideways. Long contest titles and candidate names wrap.

**Publish device check**, before the first publish of each ballot and, through `publish --device-check`, after any layout change. `publish` prints this list and waits for confirmation (SKILL.md step 6.5):

1. iPhone Safari at the largest text size.
2. One Android phone in Chrome.
3. VoiceOver through one full race.
4. A chip and a "Next on your ballot" link each land on their target.
5. Dark mode on both phones.

## Scope order

1. Ballot and race screens with receipts (the first deliverable).
2. My weights screen, later: sliders and ratings in localStorage only, with Unknown and out-of-scope sections excluded from scoring, plus a private printable cheat sheet. Built only after the top-of-ballot contests are `ready`. It needs JavaScript, which the page CSP and the `<script` refusal in the privacy scan (SKILL.md step 6.2-6.3) forbid, so it waits for a reviewed change to both.
