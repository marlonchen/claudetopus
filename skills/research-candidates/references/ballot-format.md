# Ballot format

`<ballot-id>/ballot.yaml` is typed by the researcher from the saved official sample ballot. The model never supplies contests, candidates or counts.

```yaml
election: 2026-general
slug: k3x9qa            # random publish slug, 6 lowercase letters and digits
contest_count: 2        # contests the researcher counted on the official ballot
contests:
  - id: us-house-07
    type: candidate
    title: Representative in Congress, 7th District   # exactly as printed
    printed_count: 2    # candidate lines counted on the official ballot
    candidates:
      - name: Jane Example          # exactly as printed
        party: Example Party        # exactly as printed
        status: on_ballot           # on_ballot | withdrawn_still_printed | certified_write_in
      - name: John Sample
        party: Sample Party
        status: on_ballot
  - id: question-1
    type: measure
    title: Question 1             # number and title as printed
```

Contest types: `candidate`, `retention` (one judge or official, yes/no), and `measure`.

## Ballot check

Runs in both directions:

- **Listed to official:** every contest title and printed candidate name must appear verbatim in the `_ballot/` sample-ballot snapshot. A typo fails.
- **Official to listed:** the printed candidates listed (`on_ballot` plus `withdrawn_still_printed`) must equal `printed_count` for each contest, and the number of contests must equal `contest_count`.
- **Write-ins:** `certified_write_in` candidates skip the printed-ballot check and must appear verbatim in a snapshot of the official certified write-in list. If the county publishes none, the page says "Certified write-ins: none published".

Corrections to the sample ballot become a new snapshot plus an edit here. The old snapshot stays.
