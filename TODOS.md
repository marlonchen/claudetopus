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

## Completed
