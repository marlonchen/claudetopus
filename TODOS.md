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

### Finish Unicode normalization for privacy matching

**What:** SKILL.md step 6.3 now applies NFKC, strips default-ignorable characters and folds every Unicode dash in the publish scan, and `fetch-snapshot` and `ballot-check` match `private_strings` the same way (run 10). Still open: strip `\p{Default_Ignorable_Code_Point}` in excerpt matching in `check` (article-format.md:37), and decide whether to fold confusables (Cyrillic or Greek look-alike letters) in all of them.

**Why:** A confusable spelling of a private place name passes every whole-phrase match, yet a browser shows the locating string, and a push keeps it in public history.

**Context:** Step 11 adversarial finding 1, /ship run 5, deferred by the owner (D8). NFKC, ignorable stripping and dash folding in the scan were fixed in /ship run 10 (D2) after four review specialists found the ligature leak.

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
- [ ] Join pdftotext hyphenated line breaks before collapsing whitespace, and accept an excerpt that matches either the joined or the unjoined form (article-format.md:40-43; `ballot-check` normalizes per line, ballot-format.md:67).
- [ ] Refuse an excerpt that crosses a blank-line record boundary in an `api` snapshot (snapshot-format.md:36).
- [ ] `publish` recomputes every mechanical review item key, unfetchable entries included, and requires each to be accepted (review-list.md:48, SKILL.md:118).
- [ ] Settle the first-run baseline wording (review-list.md:14 vs 32), and carry a mark only when the comment's key is in the key set computed from the current article (review-list.md:26).
- [ ] The ballot gate requires `git ls-files --error-unmatch` for `review/` and `tiers.yaml` files and uses `git status --porcelain --ignored`, so a data-repo ignore rule cannot fake "committed" (SKILL.md:119).
- [ ] Lock `pages_dir`, commit with `git commit -- <slug>/index.html`, and copy and re-hash the exact bytes that were scanned (SKILL.md:132).
- [ ] Specify `tiers.yaml` matching: WHATWG URL parse, normalized path, prefix match on segment boundaries, normalized host, and the stricter tier across every redirect hop (source-tiers.md:20, 25).
- [ ] Decide what a privacy match outside a claim or source name does (for example a ZIP in a receipt URL path) instead of refusing the whole page, and add a "source withheld" state so dropping a claim does not force "Unknown, no source found" (SKILL.md:130). Needs an owner decision.
- [ ] Decide how much first-run baseline acceptance can rest on the neutrality pass, whose input is untrusted excerpts (review-list.md:32). Needs an owner decision.
- [ ] Decide how "the model never sees an address" is enforced when the main session has Bash and deny rules match by prefix (SKILL.md:20). Needs an owner decision.

**Why:** Each item is an unspecified parse, normalize, lock or gate edge a reviewer found in the prose. They stick only as code with tests.

**Context:** Step 11 adversarial findings 4-14, /ship run 5 (2026-10-20). Deferred by the owner (D8). Findings 1-3 have their own P1 items above.

**Effort:** L
**Priority:** P2
**Depends on:** The scripts they name.

### Scripts build checklist from the run 9 adversarial review

**What:** Requirements for the scripts build, each with its spec line:
- **Snapshot writes:** `fetch-snapshot` picks a numeric suffix (snapshot-format.md:48) with exclusive create (O_CREAT|O_EXCL, retry the next suffix) through a temp file, writes the `ballot.ledger` line before the rename, and `ballot-check` defines what a ledger line with no file means. Parallel fetches can otherwise take the same name.
- **Review acceptance:** a session with Bash can append to `.accepted` and commit `reset review <contest>` as the researcher (review-list.md:30, SKILL.md:100/119). Require signed commits from a key the session cannot use, or deny `git commit` and writes to `review/` in the data repo's settings.
- **Party names:** decide which sources may vouch for `party_name` (ballot-format.md:74). The sample ballot can vouch for `DEM` as its own full name; a stricter rule must still let all-caps ballots with no pamphlet pass, and must accept hyphenated full names (Democratic-Farmer-Labor) while catching `DFL Party`.
- **Allegation words:** add fined, violat(e|ed|ion|ions), reprimand(ed), admonish(ed|ment), suspen(ded|sion), disbar(red|ment), scandal, plead(s|ed), DUI, penalt(y|ies) to review-list.md:12 and the AllegationWords test.
- **Unfetchable after redirect:** record `requested_url` in snapshot front matter and clear an `unfetchable.md` entry on either URL (review-list.md:13, source-tiers.md:25).
- **Shared-history check:** SKILL.md:131 "shares any commit with it" compares root commits (`git rev-list --max-parents=0 HEAD` in each repo) and never fetches one repo into the other.
- **Referrer:** add `<meta name="referrer" content="no-referrer">` and `rel="noreferrer noopener"` on receipt links (SKILL.md:121).
- **Slug overwrite:** refuse when `<slug>/index.html` exists in `pages_dir` but this ballot has no publish record (ballot-format.md:77, SKILL.md:132).
- **Review keys:** at least 64-bit hashes (review-list.md:21-26). Label Wayback links "Archive copy (captured separately)", since a capture can differ from the snapshot (snapshot-format.md:52).

**Why:** Prose cannot enforce file locking, commit provenance or hash width; each item becomes a script behavior and a test.

**Context:** Step 11 Claude adversarial pass, /ship run 9 (Codex unavailable: model_unusable). The owner fixed findings 1 and 2 (whole-line private entries, quote and dash folding) and deferred these (D8). The party_name item comes from review cycle 2 (D6).

**Effort:** M
**Priority:** P1
**Depends on:** `fetch-snapshot`, `ballot-check`, `review-list` and `publish`.

### Line accounting and scan gaps from the run 10 review

**What:** Spec gaps in the line-accounting rule (ballot-format.md:70) and the privacy scan (SKILL.md:122), each to settle before `ballot-check` and `publish` are built:
- **Whole-line entries:** a line that equals one multi-word entry still counts as "made up wholly of" entries, so pasting "Springfield Township Precinct 12" as one entry passes and leaves the township alone unscanned. Have `ballot-check` warn, by line number and entry index only, when one entry covers a whole line holding a place-type word (Township, Precinct, Ward, Borough, Village, City) or a digit run.
- **Bare numbers:** a header such as "Springfield Township 12" has no safe setup: `12` as its own entry matches all over the page, the whole line as one entry hides the township, and `ignored_lines` refuses it. Let a line be accounted for by private entries plus bare digit runs, scanning those runs only next to the entry's other words.
- **Digit-run wording:** "The publish scan matches each entry whole, never a part of one" contradicts the digit-run rule in step 6.3; reword as "apart from its digit run".
- **Which normalization:** say that accounting by `private_strings` uses the publish-scan matching (case folded, whole phrase, the scan's separator set), as the `ignored_lines` containment check does, so an all-caps header is accounted for by mixed-case entries; define "punctuation" as that separator set.
- **Hidden contests:** a `private_strings` entry equal to a contest title can account for the title line of a contest missing from both the list and the counts; list such lines with `--show`.
- **Two-column ballots:** a pdftotext line holding a listed candidate can also hold an unlisted one from the next column; count a candidate line only for its matched span and report what is left over.
- **Scan separators:** form 3 reads only hyphens, underscores, slashes, dots and plus signs as spaces, so `springfield~township` or `springfield,township` in a receipt URL path survives; read every non-alphanumeric character as a space.

**Why:** Each is a way a private place name reaches the page, or a contest leaves the guide, that prose alone does not stop.

**Context:** /ship run 10 review (security, red-team and Claude adversarial passes; Codex unavailable: model_unusable). Deferred under the owner's land-mode rule (D1): only critical findings in the 8c408a1 layer were fixed.

**Effort:** M
**Priority:** P1
**Depends on:** `ballot-check` and `publish`.

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

### PageAnchors race set should come from the page, not the chips

**What:** In `tests/spec-parity.test.js` PageAnchors, build the set of valid bare race anchors from the race anchors the wireframe defines (or `exampleIds()`), not only from contests that have chip links, while keeping a stale `#ballot` after a list-anchor rename failing.

**Why:** A correct future link such as `#governor` (page.md:51 says every race has an anchor) would fail with "names no race on the page".

**Context:** Cycle 3 testing finding, /ship run 5. It fires on no current wireframe link. Deferred by the owner (D7).

**Effort:** S
**Priority:** P2
**Depends on:** None.
**Completed:** run 7 /ship (2026-10-22): PageAnchors takes races from the wireframe's `<section id>` containers, and WireframeStructure fails any link that lands on no id.

