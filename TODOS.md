# TODOS

## research-candidates

### Agent-to-session hand-off enforced by scripts, not prose

**What:** Replace every model-read signal from the discovery agent with script output that carries no free text:

- [ ] The main session must not read `unfetchable.md` lines. A script (`review-list --refused-hosts <contest>` or a `fetch-snapshot` summary) prints only distinct, IDNA-normalized, valid LDH hosts of the contest's `domain not in tiers.yaml` entries, or a count for anything else (SKILL.md:23, the CRITICAL from cycle 3).
- [ ] Limit the refused-host stop to refusals from the current discovery run, or skip URL+subject pairs a later snapshot saved, so the append-only log cannot block a contest forever. Also say how the researcher continues without adding the domain.
- [ ] Say what happens to privacy refusals during discovery: they are never logged, and the agent replies only `done`, so today they reach no one. Fix the "every other source ... reaches the researcher through `review-list`" sentence.
- [ ] Bind the fetch tool given to each discovery agent to its own contest, the way it already rejects `--ballot` and `--file`; its `--searched` mode is bound the same way (snapshot-format.md, Search log).
- [x] State that `fetch-snapshot` runs the privacy match before the tier lookup, before any redirect and before any write to `unfetchable.md`. **Built (ticket 03):** stated in snapshot-format.md and tested through the command.

**Why:** Each prose patch to this hand-off in /ship run 5 opened the next hole: "never read the reply" could not be enforced, and "read refused hosts from `unfetchable.md`" let attacker-chosen URL text into the session that has shell and file tools.

**Context:** /ship run 5, 2026-10-19/20, Step 9 cycles 2-3 (security, maintainability and red-team findings). The owner chose to defer to the scripts build (D7) so the boundary is enforced in code with tests, not prose.

**Effort:** M
**Priority:** P1
**Depends on:** Building `fetch-snapshot` and `review-list`.

### Source metadata the agent chooses must not decide attribution

**What:** Stop trusting agent-chosen snapshot metadata:

- [ ] Give `tiers.yaml` entries an owner (a candidate id for a campaign site, or `third-party`). `fetch-snapshot` copies it into the snapshot from the host match, like the tier. **Built in `fetch-snapshot` (ticket 02):** owner copied from the match, fixed across redirects, and refused under a rival or `_race`; the `review-list` half remains. `review-list` lists every `s`-tagged claim whose snapshot owner is not the candidate it sits under (the CRITICAL from cycle 3). **Spec written (2026-10-26):** `owner` and `source` are `tiers.yaml` fields copied into each snapshot, and review-list.md's attribution rule reads `owner` (source-tiers.md, snapshot-format.md); building it remains.
- [x] Derive or check `source:` against the matched `tiers.yaml` entry (for example a `name:` field) instead of accepting a free-form name. **Built (ticket 02):** `fetch-snapshot` copies the final hop's entry `source`, with no option that sets it.
- [x] Reject control characters and `---` in every front-matter value and write front matter with a real YAML emitter, so a `source:` with a newline cannot inject `public_url:` (snapshot-format.md:7, 38). **Built (ticket 02):** the `yaml` emitter writes front matter; `unsafe-value` refuses the rest.
- [ ] At publish, re-check every `public_url` and `url` against `tiers.yaml` and the privacy rules.

**Why:** An advocacy group's or an opponent's page filed under a candidate becomes a "Says:" claim labeled "Candidate's own words", with an attribution the agent chose and no human check.

**Context:** Cycle 3 red-team plus Step 11 adversarial finding 2, /ship run 5. Deferred by the owner (D7, D8).

**Effort:** M
**Priority:** P1
**Depends on:** `fetch-snapshot` and `review-list`.

### Finish Unicode normalization for privacy matching

**What:** SKILL.md step 6.3 now checks four variants of the decoded forms (default-ignorable characters removed or read as spaces, NFKC applied or not) and refuses on a match in any, with dashes folded by Unicode category; `fetch-snapshot` and `ballot-check` match `private_strings` the same way (run 10). Still open:
- **Built (ticket 07):** `check` strips `\p{Default_Ignorable_Code_Point}` in excerpt matching (article-format.md, Matching, step 2);
- decide whether to fold confusables (Cyrillic or Greek look-alike letters) everywhere;
- **Defined (ticket 07):** a hyphen break is found in the snapshot's raw lines before whitespace collapses, an excerpt is never joined itself, so `Spring- field Township` matches neither form; the unjoined form (`Spring-field`) still reads as two words to the scan, so SKILL.md step 6.2 has `publish` also scan claims and excerpts with every hyphen between two letters removed. A break with a digit on either side is read unjoined only, so a range never fuses into one number. Build the scan in `publish` (ticket 12);
- make `ballot-check` refuse a `private_strings`, address or label entry with no letters or digits left after normalization, since an empty entry would match every page or none;
- **Built (ticket 03), in `scripts/lib/privacy.js` and stated in SKILL.md step 6.3:** the fold order and the value-normalization items below; NFKC-made digits (`9410³`, `①`) count for the ZIP and digit-run checks; reading ZWNJ, ZWJ and soft hyphens as spaces may split a word into a short private entry (`Spring­field Township` matching `Field Township`), and that refusal is accepted, since the matcher fails closed. Still open: confusables, the combining-mark NFD variant, refusing an excerpt that crosses an `api` record boundary in `check`, and the parity-test items.
- fold order: in the NFKC variants, apply the ignorable fold and NFKC first, then the quote, dash and case folds, whitespace collapse and form 3's separators (or NFKC_Casefold), since NFKC run last brings back capitals (`𝐒𝐩𝐫𝐢𝐧𝐠𝐟𝐢𝐞𝐥𝐝` becomes `Springfield`) and creates separators (`／`, `․`) after they were read as spaces; collapse whitespace after the ignorable fold, so `Pat <ZWSP> Voter` still reads as `pat voter`;
- say that each searched value is normalized the same way as the form and variant it is matched against, ignorable fold and NFKC included, so an entry holding a soft hyphen still matches page text whose soft hyphen the variant removed; add a parity case;
- decide whether digits NFKC creates (`9410³` becomes `94103`, `①` becomes `1`) count for the ZIP and digit-run checks, and whether reading ZWNJ, ZWJ and soft hyphens as spaces may split ordinary words into a short private entry (`Spring­field Township` matching `Field Township`);
- a combining mark after the last letter of a private phrase keeps it off a word boundary in every variant; consider an NFD variant with marks dropped;
- the parity test compares only the text before each excerpt fold step's first comma or period, and `between(ARTICLE, "## Matching")` has no end marker; compare whole step lines up to the next heading, and drop the value card's subset claim while the hyphen-join gap is open.

**Why:** A confusable spelling of a private place name passes every whole-phrase match, yet a browser shows the locating string, and a push keeps it in public history.

**Context:** Step 11 adversarial finding 1, /ship run 5, deferred by the owner (D8). /ship run 10 added NFKC after four review specialists found the ligature leak (D2), then the refuse-on-any-variant rule when the single NFKC pipeline turned `Township¹` into `township1` (D4).

**Effort:** S
**Priority:** P1
**Depends on:** `check`, `fetch-snapshot` and `publish`.

### Figure check must not let a claim round its way to a different number

**What:** Require a claimed figure to match the excerpt's value within about 1% relative error, or exactly after unit scaling, instead of half-up rounding in the claim's own unit, and require it to match the field the claim names rather than any number in the excerpt (article-format.md:48).

**Why:** Today "$1 million" matches anything from 500,000 to 1,499,999, and "$5M from PACs" passes on a "total: 5000000" field.

**Context:** Step 11 adversarial finding 3, /ship run 5. Deferred by the owner (D8).

**Closed (ticket 08).** Built by removing rounding: a claimed figure is copied from its excerpt, never rounded or rescaled: it must be one of the excerpt's figures written the same way, scale and percent words included (owner decision, 2026-10-28, replacing the half-up-and-1% rule decided earlier that day, and matching the Wording rule that money and vote figures are shown raw). So "$1 million" no longer matches 500,000, and no figure can round its way to another (article-format.md, Figures). What `check` cannot read now belongs to the neutrality pass (review-list.md, Neutrality pass), and ticket 16's eval traps it: the field the claim names ("$5M from PACs" on a total), signs and direction words ("fell 3%" on "rose 3%"), and a count in words with no scale word ("twenty terms" on "two terms"). Link text must be `s` and a number, so no figure hides in it (`claim-format`), and `check` scans claim text for a hidden printed title as well as excerpts (`title-in-claim`).

**Effort:** S
**Priority:** P1
**Depends on:** `check`.

### Scripts build checklist from the run 5 adversarial review

**What:** Requirements for the scripts, each to become a test:

- [x] `claim-format` allows exactly one inline code span (the trailing tag) and one link (the trailing snapshot link), so no figure hides in link text or code; the link text is `s` and a number (article-format.md, Figures; built in ticket 08, `check`).
- [x] Join pdftotext hyphenated line breaks before collapsing whitespace, and accept an excerpt that matches either the joined or the unjoined form (article-format.md, Matching; built in ticket 07, `check`).
- [ ] Refuse an excerpt that crosses a blank-line record boundary in an `api` snapshot (snapshot-format.md:36).
- [ ] `publish` recomputes every mechanical review item key, unfetchable entries included, and requires each to be accepted (review-list.md:48, SKILL.md:118).
- [ ] Settle the first-run baseline wording (review-list.md:14 vs 32), and carry a mark only when the comment's key is in the key set computed from the current article (review-list.md:26).
- [ ] The ballot gate requires `git ls-files --error-unmatch` for `review/` and `tiers.yaml` files and uses `git status --porcelain --ignored`, so a data-repo ignore rule cannot fake "committed" (SKILL.md:119).
- [ ] Lock `pages_dir`, commit with `git commit -- <slug>/index.html`, and copy and re-hash the exact bytes that were scanned (SKILL.md:132).
- [ ] Specify `tiers.yaml` matching: WHATWG URL parse, normalized path, prefix match on segment boundaries, normalized host, and the stricter tier across every redirect hop (source-tiers.md:20, 25).
- [ ] Decide the final rule for a privacy match outside a claim or source name (for example a ZIP in a receipt URL path): drop the claim, add a "source withheld" state so dropping a claim does not force "Unknown, no source found", or let the researcher override a false positive. **Phase 1 decided (owner, 2026-10-23):** `publish` refuses the whole page, reports each match by page line and class, and the researcher reviews it with `publish --show`; no override (SKILL.md step 6.3). Build that, then settle the final rule from what real ballots turn up.
- [ ] `review-list` builds the first-run baseline from mechanical checks only. **Decided (owner, 2026-10-23, option C):** a claim is baselined only when its text, minus a leading `Says:` and enclosing quotes, is found whole in its own excerpt after excerpt-matching normalization, and nothing else puts it on the list; the neutrality pass can add items but never accepts one (review-list.md, Accepted keys). Test it with a verbatim claim, a reworded claim, a verbatim claim the neutrality pass flags, and a quote whose enclosing quotes are curly.
- [ ] "The model never sees an address." **Decided (owner, 2026-10-23):** the model never looks one up; step 2 gives the researcher links to the state's voter-registration lookup and the county's sample-ballot or district lookup, which the researcher runs in their own browser. `fetch-snapshot --geocode` and the Census Geocoder call are gone (SKILL.md Rule 5, step 2). Still open: `addresses.yaml` stays on disk as privacy-scan input, so a Bash read of it is still stopped only by deny rules that match by prefix. Either harden that (a sandbox read deny on the file) or drop the file and have the researcher list any street or ZIP printed on the ballot under `private_strings`.

**Why:** Each item is an unspecified parse, normalize, lock or gate edge a reviewer found in the prose. They stick only as code with tests.

**Context:** Step 11 adversarial findings 4-14, /ship run 5 (2026-10-20). Deferred by the owner (D8). Findings 1-3 have their own P1 items above.

**Effort:** L
**Priority:** P2
**Depends on:** The scripts they name.

### Scripts build checklist from the run 9 adversarial review

**What:** Requirements for the scripts build, each with its spec line:
- **Snapshot writes:** `fetch-snapshot` picks a numeric suffix (snapshot-format.md:48) with exclusive create (O_CREAT|O_EXCL, retry the next suffix) through a temp file, writes the `ballot.ledger` line before the rename, and `ballot-check` defines what a ledger line with no file means. **Built (ticket 04):** the ledger line is written after the manifest line and before the file lands, so a crash can leave a snapshot with no ledger line (which `ballot-check` refuses) but never a ledger line with no manifest line (snapshot-format.md, Ballot ledger); `ballot-check`'s half remains: a way out for the snapshot such a crash leaves (the next run links it, with no ledger line, and no tool writes a manifest retire line yet), and a rule for `<query>` `unknown` (a `--file` companion; PR #11 review suggests failing it unless it passes the companion address scan). Parallel fetches can otherwise take the same name.
- **Session guard:** the data repo's PreToolUse hook (`scripts/session-guard`, PR #11 review) refuses `--ballot`/`--show`, `CLAUDECODE`, `env -i`, pseudo-terminal wrappers and Bash commands naming `ballot.ledger`, `snapshots.sha256` or `downloads/`, but matches text: a flag or name built at run time gets through. Decide whether `--show` (ticket 05) needs more, such as running sessions in Claude Code's sandbox, before it prints private text. Also run one real-poppler `--ballot` PDF check; the tests use a `pdftotext` stub.
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

**Depends on / blocked by:** `fetch-snapshot` and `coverage` being built. **Spec written (2026-10-26):** `search-log/<contest>.tsv`, `fetch-snapshot --searched` and the `search-not-logged` code (snapshot-format.md, Search log), pinned by spec-parity.

**Priority:** P2

### Check the review-list size against race 1

**What:** Count the review items of race 1's contests (issue 17) against the 5-15 items per contest target (03-ux.md). If the owner rule floods the list, narrow it: flag a `third-party` "Says:" claim only when the snapshot is not `statements_only`, or only an `owner` that is another candidate, and put questionnaire hosts on `statements_only` entries.

**Why:** Every Vote411, Ballotpedia and debate host is `third-party`, so each of their Positions claims is a review item, and the federal and state lists have seven issues each. A three-candidate federal race can reach 21 Positions items before Controversies, `T2i` and allegation words.

**Context:** PR #7 interrogate review (2026-10-26), D5; the owner chose to measure on real data before narrowing.

**Depends on / blocked by:** race 1 compiled and `review-list` built.

**Priority:** P2

### spec-parity contracts as data

**What:** Move the machine contracts (Positions issue lists, checklist-to-section map, failure codes, search-log fields, office types) into one parsed block that the scripts and spec-parity both read, have spec-parity check that the prose agrees with it instead of pinning sentences, and split `spec-parity.test.js` (2,900+ lines) per reference behind a shared helpers module.

**Why:** Sentence pins catch rewording, not contradictions: the `search-not-logged` row said "one of" the items while snapshot-format.md said "each", and both stayed green.

**Context:** PR #7 interrogate review (2026-10-26), N4 and N5; both reviewers raised it. Deferred so it lands with the first script that reads the contracts.

**Depends on / blocked by:** the first script that parses a reference (issue 02 or 07).

**Priority:** P2

### Derived-number claims

**What:** Support derived-number claims. The removed spec: a derived number ("61% from PACs") is allowed only when both inputs are claims in the same section with their own excerpts, and the derived claim shows its formula in inline code (`` `= 1,220,000 / 2,000,000` ``). It has no link and no excerpt of its own; its tag is the weakest of its inputs' tags. `check` skips the excerpt-figure match for its result, requires each number in the formula to match a figure in a sibling claim, recomputes it, rounds half-up to the decimal places shown, and fails with a `derived-mismatch` code otherwise. Its review key uses the formula in place of the excerpt, with an empty snapshot path and file hash.

**Why:** Shares such as "61% from PACs" are faster to compare across candidates than two raw totals.

**Pros:** Easier money comparisons on the race screen.

**Cons:** Formula parsing, half-up rounding, tier inheritance, and a claim type keyed by its formula instead of an excerpt in `review-list`. Every one of them is a new branch in the gates.

**Context:** Deferred in the eng review (D1, 2026-10-18) to protect the pre-election schedule. Until this ships, articles show raw figures only, and `check` rejects claims that have no link or excerpt.

**Depends on / blocked by:** `check` and `review-list` shipped, and the first ballot published.

**Priority:** P3

### fetch-snapshot lock and deps edge cases from the ticket-02 review

**What:** Close three rare cases the cycle-3 /ship review found in `scripts/lib/snapshot-store.js` and `scripts/lib/deps.js`:

- [ ] `.lock.break` is judged stale by age alone and removed by path, so a breaker paused for over 5s mid-break (laptop sleep) can lose it and then remove a live `.lock`. Check its pid with `isStale`, and remove a stale break lock only after confirming its text and inode. **Still open after ticket 03:** the pid check no longer applies (locks are judged by age, below), and confirming text and inode before a remove by path leaves the same window, so this needs its own design.
- [x] `readLock` stats and reads the lock through two path lookups, so on a filesystem that reuses inode numbers (ext4) `seen` can mix a dead lock's age with a live lock's text. Open once and `fstat` plus read the same fd.
- [x] `deps.js` real-paths only the cache side; under `NODE_PRESERVE_SYMLINKS` a symlinked cache gives a false `deps-missing`. Real-path both sides.

Since the PR #8 review a lock is judged by age alone (no pid check, so sandboxed agents in other pid namespaces are safe), and a crashed run's lock delays the next run by up to 30s.

**Why:** Each can let two discovery agents hold a ballot's lock at once (one's recovery then deletes the other's unfinished save, leaving a manifest line with no file) or block every script.

**Context:** /ship run on feat/fetch-snapshot-tracer (2026-10-27), cycle-3 state-machines and adversarial review. The owner deferred them to ship (D6), since no real research runs before ticket 03's privacy refusals land; fix them in that PR. The realistic races (empty lock wedging the ballot, rename-and-put-back takeover) were fixed and are covered by tests.

**Effort:** S
**Priority:** P1
**Depends on:** None

### fetch-snapshot hardening deferred from the ticket-02 review

**What:** Lower-severity findings from the same review, deferred under land mode (D1):

- [ ] Tier path prefixes match case-sensitively on the raw pathname (no percent-decoding), so `/Opinion/` or `/%40jane` can miss a stricter entry.
- [ ] `RESEARCH_CANDIDATES_TEST_HTTP_TARGET`, `_TEST_CRASH` and `_DEPS` are honoured in production; gate them so an agent-controlled environment cannot use them (or give the agents' fetch tool a clean environment, ticket 14).
- [ ] Charset comes only from the Content-Type header: sniff the BOM and `<meta charset>`. Add a test for an unknown charset's UTF-8 fallback.
- [ ] Decide whether a T1/T2 hop may be plain `http:` or follow an https-to-http redirect.
- [ ] Strip C0/C1 controls and bidi overrides from snapshot bodies.
- [ ] `recover` turns any per-partial error into `internal-error` on every run; locate it and use `lstat` for the target check. Refuse symlinks under `sources/`.
- [ ] fsync the `.partial/` and target directories, and check `writeSync`'s byte count, so a power loss cannot leave a manifest line with no file.
- [x] The owner check only covers this contest's subjects; decide whether a campaign site may be filed under a candidate of another contest. **Decided (PR #8 review):** yes. Its content can bear on that subject, and `owner` still records whose words it holds (snapshot-format.md).
- [ ] `html-text.js` walks the DOM recursively; walk iteratively so deep nesting cannot overflow the stack.
- [ ] `unsafe-value` refuses URLs containing `---`; `searchParams.delete` re-encodes the rest of the query.
- [ ] `install-deps`: a leftover non-empty cache directory throws on rename; the fast path trusts any `node_modules`; `RESEARCH_CANDIDATES_DEPS` is not keyed to the lockfile; transitive modules still resolve through parent `node_modules`.
- [ ] Rule 8 guard: a repo with no remotes passes, `GH_HOST` changes which server `gh` asks, and a gitfile or inherited `GIT_DIR` can point the top-level check at another repo.
- [ ] Narrow the body-read `catch` to network and timeout errors, and cancel the reader.
- [ ] Tests: the untested state-matrix cells (`.gstack/tmp/state-machines.*.md` lists them), a two-waiter takeover test, bad-redirect, and install-deps failure paths. The test task needs the network on a cold cache.

**Why:** None is reachable in normal use today, but each weakens a guarantee the spec makes (tier strictness, write-once, Rule 5 output, the lockfile pin) or turns a recoverable error into `internal-error`.

**Context:** /ship run on feat/fetch-snapshot-tracer (2026-10-27): specialists, red team and adversarial passes. Several overlap tickets 03, 14 and 18; pick them up with those.

**Effort:** M
**Priority:** P2
**Depends on:** None

## Completed

### PageAnchors race set should come from the page, not the chips

**What:** In `tests/spec-parity.test.js` PageAnchors, build the set of valid bare race anchors from the race anchors the wireframe defines (or `exampleIds()`), not only from contests that have chip links, while keeping a stale `#ballot` after a list-anchor rename failing.

**Why:** A correct future link such as `#governor` (page.md:51 says every race has an anchor) would fail with "names no race on the page".

**Context:** Cycle 3 testing finding, /ship run 5. It fires on no current wireframe link. Deferred by the owner (D7).

**Effort:** S
**Priority:** P2
**Depends on:** None.
**Completed:** run 7 /ship (2026-10-22): PageAnchors takes races from the wireframe's `<section id>` containers, and WireframeStructure fails any link that lands on no id.

