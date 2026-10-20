# TODOS

## research-candidates

### Agent-to-session hand-off enforced by scripts, not prose

**What:** Replace every model-read signal from the discovery agent with script output that carries no free text:

- [ ] The main session must not read `unfetchable.md` lines. A script (`review-list --refused-hosts <contest>` or a `fetch-snapshot` summary) prints only distinct, IDNA-normalized, valid LDH hosts of the contest's `domain not in tiers.yaml` entries, or a count for anything else (SKILL.md:23, the CRITICAL from cycle 3).
- [ ] Limit the refused-host stop to refusals from the current discovery run, or skip URL+subject pairs a later snapshot saved, so the append-only log cannot block a contest forever. Also say how the researcher continues without adding the domain.
- [ ] Say what happens to privacy refusals during discovery: they are never logged, and the agent replies only `done`, so today they reach no one. Fix the "every other source ... reaches the researcher through `review-list`" sentence.
- [ ] Bind the fetch tool given to each discovery agent to its own contest, the way it already rejects `--ballot`, `--file` and `--geocode`.
- [ ] State that `fetch-snapshot` runs the privacy match before the tier lookup, before any redirect and before any write to `unfetchable.md`.

**Why:** Each prose patch to this hand-off in /ship run 5 opened the next hole: "never read the reply" could not be enforced, and "read refused hosts from `unfetchable.md`" let attacker-chosen URL text into the session that has shell and file tools.

**Context:** /ship run 5, 2026-10-19/20, Step 9 cycles 2-3 (security, maintainability and red-team findings). The owner chose to defer to the scripts build (D7) so the boundary is enforced in code with tests, not prose.

**Effort:** M
**Priority:** P1
**Depends on:** Building `fetch-snapshot` and `review-list`.

### Source metadata the agent chooses must not decide attribution

**What:** Stop trusting agent-chosen snapshot metadata:

- [ ] Give `tiers.yaml` entries an owner (a candidate id for a campaign site, or `third-party`). `fetch-snapshot` copies it into the snapshot from the host match, like the tier. `review-list` lists every `s`-tagged claim whose snapshot owner is not the candidate it sits under (review-list.md:9 trusts `subject` today, the CRITICAL from cycle 3).
- [ ] Derive or check `source:` against the matched `tiers.yaml` entry (for example a `name:` field) instead of accepting a free-form name.
- [ ] Reject control characters and `---` in every front-matter value and write front matter with a real YAML emitter, so a `source:` with a newline cannot inject `public_url:` (snapshot-format.md:7, 38).
- [ ] At publish, re-check every `public_url` and `url` against `tiers.yaml` and the privacy rules.

**Why:** An advocacy group's or an opponent's page filed under a candidate becomes a "Says:" claim labeled "Candidate's own words", with an attribution the agent chose and no human check.

**Context:** Cycle 3 red-team plus Step 11 adversarial finding 2, /ship run 5. Deferred by the owner (D7, D8).

**Effort:** M
**Priority:** P1
**Depends on:** `fetch-snapshot` and `review-list`.

### Privacy scan must normalize Unicode before matching

**What:** Before every privacy comparison (publish scan, `fetch-snapshot` URL and `source:` refusals, `ballot-check` `private_strings`), apply NFKC and strip `\p{Default_Ignorable_Code_Point}` (soft hyphen, zero-width characters, word joiner, BOM), and consider folding confusables. Apply the same to excerpt matching in `check`.

**Why:** "Spring&shy;field Township" or fullwidth letters pass the whole-phrase match (SKILL.md:121) and the NFKC-only excerpt check (article-format.md:39), yet a browser shows the locating string, and a push keeps it in public history.

**Context:** Step 11 adversarial finding 1, /ship run 5, rated the most exploitable. Deferred by the owner (D8).

**Effort:** S
**Priority:** P1
**Depends on:** `check`, `fetch-snapshot` and `publish`.

### Figure check must not let a claim round its way to a different number

**What:** Require a claimed figure to match the excerpt's value within about 1% relative error, or exactly after unit scaling, instead of half-up rounding in the claim's own unit, and require it to match the field the claim names rather than any number in the excerpt (article-format.md:48).

**Why:** Today "$1 million" matches anything from 500,000 to 1,499,999, and "$5M from PACs" passes on a "total: 5000000" field.

**Context:** Step 11 adversarial finding 3, /ship run 5. Deferred by the owner (D8).

**Effort:** S
**Priority:** P1
**Depends on:** `check`.

### Scripts build checklist from the run 5 adversarial review

**What:** Requirements for the scripts, each to become a test:

- [ ] `claim-format` allows exactly one inline code span (the trailing tag) and one link (the trailing snapshot link), so no figure hides in link text or code (article-format.md:46, 66).
- [ ] Join pdftotext hyphenated line breaks before collapsing whitespace, and accept an excerpt that matches either the joined or the unjoined form (article-format.md:40-43; `ballot-check` normalizes per line, ballot-format.md:64).
- [ ] Refuse an excerpt that crosses a blank-line record boundary in an `api` snapshot (snapshot-format.md:36).
- [ ] `publish` recomputes every mechanical review item key, unfetchable entries included, and requires each to be accepted (review-list.md:48, SKILL.md:117).
- [ ] Settle the first-run baseline wording (review-list.md:14 vs 32), and carry a mark only when the comment's key is in the key set computed from the current article (review-list.md:26).
- [ ] The ballot gate requires `git ls-files --error-unmatch` for `review/` and `tiers.yaml` files and uses `git status --porcelain --ignored`, so a data-repo ignore rule cannot fake "committed" (SKILL.md:118).
- [ ] Lock `pages_dir`, commit with `git commit -- <slug>/index.html`, and copy and re-hash the exact bytes that were scanned (SKILL.md:131).
- [ ] Specify `tiers.yaml` matching: WHATWG URL parse, normalized path, prefix match on segment boundaries, normalized host, and the stricter tier across every redirect hop (source-tiers.md:20, 25).
- [ ] Decide what a privacy match outside a claim or source name does (for example a ZIP in a receipt URL path) instead of refusing the whole page, and add a "source withheld" state so dropping a claim does not force "Unknown, no source found" (SKILL.md:129). Needs an owner decision.
- [ ] Decide how much first-run baseline acceptance can rest on the neutrality pass, whose input is untrusted excerpts (review-list.md:32). Needs an owner decision.
- [ ] Decide how "the model never sees an address" is enforced when the main session has Bash and deny rules match by prefix (SKILL.md:20). Needs an owner decision.

**Why:** Each item is an unspecified parse, normalize, lock or gate edge a reviewer found in the prose. They stick only as code with tests.

**Context:** Step 11 adversarial findings 4-14, /ship run 5 (2026-10-20). Deferred by the owner (D8). Findings 1-3 have their own P1 items above.

**Effort:** L
**Priority:** P2
**Depends on:** The scripts they name.

### PageAnchors race set should come from the page, not the chips

**What:** In `tests/spec-parity.test.js` PageAnchors, build the set of valid bare race anchors from the race anchors the wireframe defines (or `exampleIds()`), not only from contests that have chip links, while keeping a stale `#ballot` after a list-anchor rename failing.

**Why:** A correct future link such as `#governor` (page.md:51 says every race has an anchor) would fail with "names no race on the page".

**Context:** Cycle 3 testing finding, /ship run 5. It fires on no current wireframe link. Deferred by the owner (D7).

**Effort:** S
**Priority:** P2
**Depends on:** None.

### Prove a search ran before "Unknown, no source found"

**What:** Have `fetch-snapshot` (or a sibling script) write a structured search log per contest (contest, candidate, checklist item, searched) with no free text, and make `coverage` refuse an `Unknown, no source found` section that has no matching entry.

**Why:** "Unknown" tells voters "we looked and found nothing" (page.md). Today nothing records that the discovery agent actually ran each checklist item, so "never searched", "stopped early" and "a fetched page steered it to skip one candidate" all compile to the same Unknown, and Unknown sections are not review-list items.

**Pros:** An Unknown on the page is backed by a machine-checked record, and an injected page cannot quietly suppress one candidate's research.

**Cons:** A new data file in the Layout, its format, a `coverage` rule and failure code, and spec-parity tests for them.

**Context:** Found in the /ship run 5 pre-landing review (2026-10-19, cycle 2) after the discovery agent's free-text reply was removed as an injection channel; the owner chose to defer it to the scripts build rather than add spec text mid-review.

**Depends on / blocked by:** `fetch-snapshot` and `coverage` being built.

**Priority:** P2

### Derived-number claims

**What:** Support derived-number claims. The removed spec: a derived number ("61% from PACs") is allowed only when both inputs are claims in the same section with their own excerpts, and the derived claim shows its formula in inline code (`` `= 1,220,000 / 2,000,000` ``). It has no link and no excerpt of its own; its tag is the weakest of its inputs' tags. `check` skips the excerpt-figure match for its result, requires each number in the formula to match a figure in a sibling claim, recomputes it, rounds half-up to the decimal places shown, and fails with a `derived-mismatch` code otherwise. Its review key uses the formula in place of the excerpt, with an empty snapshot path and file hash.

**Why:** Shares such as "61% from PACs" are faster to compare across candidates than two raw totals.

**Pros:** Easier money comparisons on the race screen.

**Cons:** Formula parsing, half-up rounding, tier inheritance, and a claim type keyed by its formula instead of an excerpt in `review-list`. Every one of them is a new branch in the gates.

**Context:** Deferred in the eng review (D1, 2026-10-18) to protect the pre-election schedule. Until this ships, articles show raw figures only, and `check` rejects claims that have no link or excerpt.

**Depends on / blocked by:** `check` and `review-list` shipped, and the first ballot published.

**Priority:** P3

## Completed
