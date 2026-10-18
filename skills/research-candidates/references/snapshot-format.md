# Snapshot format

A snapshot is one fetched source, saved by `fetch-snapshot` under `<ballot-id>/sources/<contest>/<subject>/<name>.md`. Snapshots are write-once (Rule 3).

```markdown
---
source: FEC candidate totals       # name shown on the page receipt
url: https://api.open.fec.gov/v1/candidate/H0XX00000/totals/   # what was fetched, API keys stripped
fetched: 2026-10-12                # fetch date shown on the receipt
method: api                        # html | pdf | api
tier: T1                           # T1 | T2 | T3 | T4, see source-tiers.md
statements_only: false             # true: claims citing it must be "Says:" claims
subject: jane-example              # candidate id, _race, or _ballot
---
<body>
```

## Body

- `html`: the readable text of the page, with no navigation or ads.
- `pdf`: `pdftotext -layout` output.
- `api`: the JSON response flattened to one `key: value` line per field (nested keys joined with `.`), with a blank line between records. The page shows these lines as the excerpt.

Excerpts are matched against the body only, never the front matter.

## Names

Use a short kebab-case name for the source (`fec-totals.md`). Re-fetching writes a new file with a numeric suffix (`fec-totals-2.md`); a file is never overwritten. Numbers in names are fine: `check` strips link targets, link text and inline code before looking for figures.

## Unfetchable log

`fetch-snapshot` appends sources it could not save to `<ballot-id>/unfetchable.md`. The log sits outside `sources/` because it is append-only, not write-once. One line per entry:

```text
- <url> | <contest>/<subject> | <date> | <reason>
```

An unfetchable source is never paraphrased from search snippets.
