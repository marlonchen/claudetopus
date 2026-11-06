---
status: accepted
---

# Scan the page before and after rendering

A push is permanent, so `publish` is the last and strictest check. It scans twice, because each scan sees what the other cannot. Before rendering, it reads claims, excerpts and source names whole, so a match the page would split is still found. After rendering, it reads the finished HTML, which is what the public gets. The two scans differ in how they fail: a match in research costs one contest, and a match anywhere else costs the whole page.

## Enforcement

[`page-scan.js`](../../../skills/research-candidates/scripts/lib/page-scan.js) uses the matcher from [ADR 0005](0005-one-matcher-for-every-spelling-of-a-private-value.md).

**Step 6.2, before rendering.** Each ready contest's claims, excerpts and cited `source:` names are scanned whole, with word values also matched when split at a `pdftotext` line break. A match drops that contest to "Not ready yet", reported as `private-match` or `private-source`, and the rest of the page goes on.

**Step 6.3, the rendered page.** It refuses:

- this ballot's and any other ballot's id and `private_strings`;
- a private digit run, under the rules in ADR 0005;
- any address, street line, label or ZIP from `addresses.yaml`;
- the printed `title` of a contest with a `display_title`;
- `<script`, any external `src` or `href` that is not a receipt link, and any key parameter or key value.

It also reads a punycode link host back as Unicode, the way a browser shows it. Only the page's generated dates are skipped, and only for digit and ZIP checks. A match refuses the whole page and writes no file. `publish` reports each match by page line and class, and the researcher reads it with `publish --show`.

## Considered Options

- **Let the researcher override a false positive.** Rejected for phase 1 by the owner on 2026-10-23. The other candidates, dropping the claim or adding a "source withheld" state, stay open in TODOS.md, to be settled from what real ballots turn up.
- **Scan only this ballot's values.** Rejected in PR #20: privacy is the family's against the public, not between family members, so one member's precinct must never appear on another's page.

## Consequences

- A false positive outside a claim blocks the whole page until the researcher fixes the source.
- The page's fixed CSS must hold no run of 4 or more digits, or a ZIP such as 55595 could refuse every page. Colors and sizes are written to avoid them (`rgb(85,89,92)`, `75rem`).
- The scan protects only against listed values. A locating fact nobody listed passes, and the contest list and candidate order can narrow a location by themselves, which is why step 6.5 warns the researcher ([ADR 0014](0014-only-the-researcher-can-say-yes-to-publish.md)).
- TODOS.md still lists re-checking every `public_url` and `url` against `tiers.yaml` and the privacy rules at publish.
