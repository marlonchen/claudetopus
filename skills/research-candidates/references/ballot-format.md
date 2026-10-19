# Ballot format

`<ballot-id>/ballot.yaml` is typed by the researcher from the saved official sample ballot. The model never supplies contests, candidates or counts.

```yaml
election: 2026-general
slug: k3x9qa            # from the step 3 command, never typed or invented
contest_count: 3        # contests the researcher counted on the official ballot
contests:
  - id: us-house-07
    type: candidate
    jurisdiction: IL congressional district 7   # state and district the office covers
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
    jurisdiction: IL supreme court
    office_type: judicial          # see sections.md; omit for non-judicial offices
    title: Shall Justice Pat Example of the Supreme Court be retained in office?   # exactly as printed
    official:
      id: pat-example
      name: Pat Example             # exactly as printed
  - id: question-1
    type: measure
    title: "Question 1: Springfield Township Library Levy"   # number and title as printed
    display_title: Question 1     # optional: page title when the printed title would locate the voter; must differ from title
```

Text on the ballot that locates or names the voter goes in a separate file, `<ballot-id>/private.yaml`, so that `ballot.yaml` can be read next to untrusted snapshots (Rule 7). Only `publish` reads it:

```yaml
private_strings:
  - Precinct 12         # precinct names and numbers
  - Pat Q. Voter        # voter names printed on a personalized sample ballot
  - Springfield Township   # place names that narrow down the voter's location beyond the contest list
  - BS-0412             # ballot style or split codes, voter ids
```

Contest types: `candidate`, `retention` (one judge or official, yes/no), and `measure`. Set `office_type: judicial` on judicial candidate and retention contests; other contests leave it out.

Candidate and retention contests carry `jurisdiction`: the state and the district or court the office covers, so the discovery agent can search the right state databases and local papers without guessing. It goes into web searches, so it must say no more than the printed contest title already does. Measures leave it out.

The page shows `display_title` when it is set and `title` otherwise. The ballot check always uses `title`, and fails when a `display_title` equals its `title`. For a contest with a `display_title`, `check` fails any excerpt that contains the printed `title`, so the problem shows up at compile time, and the publish privacy scan refuses any page that still contains it. `display_title` hides only the full printed title, so also list its locating part (the place name) under `private_strings`; an excerpt that quotes just that part is then refused too. A measure whose official text cannot be quoted without it stays "Not yet covered".

## Ballot check

`ballot-check` compares `ballot.yaml` with the authoritative sample ballot: the `_ballot/` snapshot with `role: sample_ballot` that no later snapshot `supersedes`. Other `_ballot/` snapshots (candidate list, pamphlet, superseded ballots) never satisfy it. Text is compared with the same normalization as excerpts ([article-format.md](article-format.md)), because sample ballots are often PDFs, except that newlines are kept: the snapshot body is split into raw lines first and each line is normalized on its own. A listed title, or a candidate entry (name plus party), may wrap across several lines; every line inside its matched span counts as accounted for.

- **Listed to official:** every contest `title` must appear in the sample ballot, in `ballot.yaml` order: each title is searched for after the previous title's match, so two contests with the same printed title (several "Judge of the Circuit Court" seats) land on their own places, and a title that cannot be placed in order fails. Each candidate `name` must appear as whole words between its own contest's title and the next contest's title, and each retention `official.name` either there or inside its own contest's title, so a name under the wrong contest, or a prefix of a longer printed name ("John Sample" for "John Samples"), fails.
- **Official to listed:** the number of contests must equal `contest_count`. For each `candidate` contest, the printed candidates listed (`on_ballot` plus `withdrawn_still_printed`) must equal `printed_count`. Retention and measure contests have no count. These counts are the researcher's own, so they check `ballot.yaml` against itself. To catch a contest missed in both, `ballot-check` also lists every line of the sample ballot that is not accounted for. A line is accounted for only when it matches a listed contest title, a line holding a listed candidate or official name (with its party), or an entry in an `ignored_lines:` list in `ballot.yaml` (instructions, headers, page footers). Position on the page never accounts for a line, so a contest left out of both the list and the counts shows up even in the middle of the ballot. The check passes only when the researcher has added each missing contest or copied the line into `ignored_lines`.
- **Slug:** `slug` must match `^[a-z0-9]{6}$` and no other `ballot.yaml` in the data repo may use it, so a copied `ballot.yaml` can never publish over another ballot's page.
- **Write-ins:** `certified_write_in` candidates skip the printed-ballot check and must appear verbatim in the `role: write_in_list` snapshot. If the county publishes none, the page says "Certified write-ins: none published".

Corrections to the sample ballot become a new snapshot with `supersedes` set, plus an edit to `ballot.yaml`. The old snapshot stays.
