# Ballot format

`<ballot-id>/ballot.yaml` is typed by the researcher from the saved official sample ballot. The model never supplies contests, candidates or counts.

```yaml
election: 2026-general
slug: k3x9qa            # from new-slug, never typed or invented
contest_count: 3        # contests the researcher counted on the official ballot
private_strings:        # precinct names and numbers, and anything else on the ballot that locates the voter
  - Precinct 12
contests:
  - id: us-house-07
    type: candidate
    office_type: legislative   # see sections.md
    title: Representative in Congress, 7th District   # exactly as printed
    printed_count: 2    # candidate lines counted on the official ballot
    candidates:
      - id: jane-example            # directory name under sources/<contest>/
        name: Jane Example          # exactly as printed
        party: Example Party        # exactly as printed
        status: on_ballot           # on_ballot | withdrawn_still_printed | certified_write_in
      - id: john-sample
        name: John Sample
        party: Sample Party
        status: on_ballot
  - id: supreme-court-retention-a
    type: retention
    office_type: judicial
    title: Shall Justice Pat Example of the Supreme Court be retained in office?   # exactly as printed
    official:
      id: pat-example
      name: Pat Example             # exactly as printed
  - id: question-1
    type: measure
    title: Question 1             # number and title as printed
    display_title: Question 1     # optional: page title when the printed title would locate the voter
```

Contest types: `candidate`, `retention` (one judge or official, yes/no), and `measure`. `office_type` is required for candidate and retention contests.

The page shows `display_title` when it is set and `title` otherwise. The ballot check always uses `title`.

## Ballot check

`ballot-check` runs in both directions. It compares text with the same normalization as excerpts ([article-format.md](article-format.md)), because sample ballots are often PDFs.

- **Listed to official:** every contest `title`, candidate `name` and retention `official.name` must appear verbatim in the `_ballot/` sample-ballot snapshot. A typo fails.
- **Official to listed:** the number of contests must equal `contest_count`. For each `candidate` contest, the printed candidates listed (`on_ballot` plus `withdrawn_still_printed`) must equal `printed_count`. Retention and measure contests have no count.
- **Write-ins:** `certified_write_in` candidates skip the printed-ballot check and must appear verbatim in a snapshot of the official certified write-in list. If the county publishes none, the page says "Certified write-ins: none published".

Corrections to the sample ballot become a new snapshot plus an edit to `ballot.yaml`. The old snapshot stays.
