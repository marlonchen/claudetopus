# Ballot format

`<ballot-id>/ballot.yaml` is typed by the researcher from the saved official sample ballot. The model never supplies contests, candidates or counts.

```yaml
election: 2026-general
slug: k3x9qa            # from the step 3 command, never typed or invented
contest_count: 3        # contests the researcher counted on the official ballot
contests:
  - id: us-house-07
    type: candidate
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
    office_type: judicial          # see sections.md; omit for non-judicial offices
    title: Shall Justice Pat Example of the Supreme Court be retained in office?   # exactly as printed
    official:
      id: pat-example
      name: Pat Example             # exactly as printed
  - id: question-1
    type: measure
    title: Question 1             # number and title as printed
    display_title: Question 1     # optional: page title when the printed title would locate the voter
```

Text on the ballot that locates or names the voter goes in a separate file, `<ballot-id>/private.yaml`, so that `ballot.yaml` can be read next to untrusted snapshots (Rule 7). Only `publish` reads it:

```yaml
private_strings:
  - Precinct 12         # precinct names and numbers
  - Pat Q. Voter        # voter names printed on a personalized sample ballot
```

Contest types: `candidate`, `retention` (one judge or official, yes/no), and `measure`. Set `office_type: judicial` on judicial candidate and retention contests; other contests leave it out.

The page shows `display_title` when it is set and `title` otherwise. The ballot check always uses `title`, and the publish privacy scan refuses any page that contains the `title` of a contest with a `display_title`.

## Ballot check

`ballot-check` compares `ballot.yaml` with the authoritative sample ballot: the `_ballot/` snapshot with `role: sample_ballot` that no later snapshot `supersedes`. Other `_ballot/` snapshots (candidate list, pamphlet, superseded ballots) never satisfy it. Text is compared with the same normalization as excerpts ([article-format.md](article-format.md)), because sample ballots are often PDFs.

- **Listed to official:** every contest `title` must appear in the sample ballot, in `ballot.yaml` order: each title is searched for after the previous title's match, so two contests with the same printed title (several "Judge of the Circuit Court" seats) land on their own places, and a title that cannot be placed in order fails. Each candidate `name` must appear as whole words between its own contest's title and the next contest's title, and each retention `official.name` either there or inside its own contest's title, so a name under the wrong contest, or a prefix of a longer printed name ("John Sample" for "John Samples"), fails.
- **Official to listed:** the number of contests must equal `contest_count`. For each `candidate` contest, the printed candidates listed (`on_ballot` plus `withdrawn_still_printed`) must equal `printed_count`. Retention and measure contests have no count. These counts are the researcher's own, so they check `ballot.yaml` against itself. To catch a contest missed in both, `ballot-check` also lists every line of the sample ballot that is not accounted for. A line is accounted for only when it matches a listed contest title, a line holding a listed candidate or official name (with its party), or an entry in an `ignored_lines:` list in `ballot.yaml` (instructions, headers, page footers). Position on the page never accounts for a line, so a contest left out of both the list and the counts shows up even in the middle of the ballot. The check passes only when the researcher has added each missing contest or copied the line into `ignored_lines`.
- **Write-ins:** `certified_write_in` candidates skip the printed-ballot check and must appear verbatim in the `role: write_in_list` snapshot. If the county publishes none, the page says "Certified write-ins: none published".

Corrections to the sample ballot become a new snapshot with `supersedes` set, plus an edit to `ballot.yaml`. The old snapshot stays.
