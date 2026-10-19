# TODOS

## research-candidates

### Derived-number claims

**What:** Support derived-number claims (a formula in inline code that `check` recomputes from sibling claims), as described in `skills/research-candidates/references/article-format.md`.

**Why:** Shares such as "61% from PACs" are faster to compare across candidates than two raw totals.

**Pros:** Easier money comparisons on the race screen.

**Cons:** Formula parsing, half-up rounding, tier inheritance, and a keyless claim type in `review-list`. Every one of them is a new branch in the gates.

**Context:** Deferred in the eng review (D1, 2026-10-18) to protect the pre-election schedule. Until this ships, articles show raw figures only, and `check` rejects claims that have no link or excerpt.

**Depends on / blocked by:** `check` and `review-list` shipped, and the first ballot published.

**Priority:** P3

## Completed
