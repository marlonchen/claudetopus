# TODOS

## research-candidates

### Derived-number claims

**What:** Support derived-number claims. The removed spec: a derived number ("61% from PACs") is allowed only when both inputs are claims in the same section with their own excerpts, and the derived claim shows its formula in inline code (`` `= 1,220,000 / 2,000,000` ``). It has no link and no excerpt of its own; its tag is the weakest of its inputs' tags. `check` skips the excerpt-figure match for its result, requires each number in the formula to match a figure in a sibling claim, recomputes it, rounds half-up to the decimal places shown, and fails with a `derived-mismatch` code otherwise. Its review key uses the formula in place of the excerpt, with an empty snapshot path and file hash.

**Why:** Shares such as "61% from PACs" are faster to compare across candidates than two raw totals.

**Pros:** Easier money comparisons on the race screen.

**Cons:** Formula parsing, half-up rounding, tier inheritance, and a claim type keyed by its formula instead of an excerpt in `review-list`. Every one of them is a new branch in the gates.

**Context:** Deferred in the eng review (D1, 2026-10-18) to protect the pre-election schedule. Until this ships, articles show raw figures only, and `check` rejects claims that have no link or excerpt.

**Depends on / blocked by:** `check` and `review-list` shipped, and the first ballot published.

**Priority:** P3

### Prove a search ran before "Unknown, no source found"

**What:** Have `fetch-snapshot` (or a sibling script) write a structured search log per contest (contest, candidate, checklist item, searched) with no free text, and make `coverage` refuse an `Unknown, no source found` section that has no matching entry.

**Why:** "Unknown" tells voters "we looked and found nothing" (page.md). Today nothing records that the discovery agent actually ran each checklist item, so "never searched", "stopped early" and "a fetched page steered it to skip one candidate" all compile to the same Unknown, and Unknown sections are not review-list items.

**Pros:** An Unknown on the page is backed by a machine-checked record, and an injected page cannot quietly suppress one candidate's research.

**Cons:** A new data file in the Layout, its format, a `coverage` rule and failure code, and spec-parity tests for them.

**Context:** Found in the /ship run 5 pre-landing review (2026-10-19, cycle 2) after the discovery agent's free-text reply was removed as an injection channel; the owner chose to defer it to the scripts build rather than add spec text mid-review.

**Depends on / blocked by:** `fetch-snapshot` and `coverage` being built.

**Priority:** P2

## Completed
