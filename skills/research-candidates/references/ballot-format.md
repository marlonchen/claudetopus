# Ballot format

`<ballot-id>/ballot.yaml` is typed by the researcher from the saved official sample ballot. The model never supplies contests, candidates or counts.

```yaml
election: 2026-general
state: XX                # two-letter state code, from the step 2 district lookup
county: Exampleton County   # the county the step 2 district lookup printed
slug: k3x9qa            # from the step 3 command, never typed or invented
contest_count: 3        # contests the researcher counted on the official ballot
contests:
  - id: us-house-07
    type: candidate
    jurisdiction: XX congressional district 7   # state and district the office covers
    title: Representative in Congress, 7th District   # exactly as printed
    printed_count: 2    # candidate lines counted on the official ballot
    vote_for: 1         # seats to fill, from the printed "Vote for" line
    candidates:
      - id: jane-example            # directory name under sources/<contest>/
        name: Jane Example          # exactly as printed
        party: Example Party        # exactly as printed
        status: on_ballot           # on_ballot | withdrawn_still_printed | certified_write_in
      - id: john-sample
        name: John Sample
        party: SAM                  # exactly as printed, here an abbreviation
        party_name: Sample Party    # the full name, from an official source that spells it out
        status: on_ballot
  - id: supreme-court-retention-a
    type: retention
    jurisdiction: XX supreme court
    office_type: judicial          # see sections.md; omit for non-judicial offices
    title: Shall Justice Pat Example of the Supreme Court be retained in office?   # exactly as printed
    official:
      id: pat-example
      name: Pat Example             # exactly as printed
  - id: question-1
    type: measure
    jurisdiction: XX Exampleton County   # coarser than the township in the printed title
    search_terms: library levy     # measures only: the subject, no place names
    title: "Question 1: Springfield Township Library Levy"   # number and title as printed
    display_title: Question 1     # optional: page title when the printed title would locate the voter; must differ from title
```

Text on the ballot that locates or names the voter goes in a separate file, `<ballot-id>/private.yaml`, so that `ballot.yaml` can be read next to untrusted snapshots (Rule 7). Only scripts read it, never agents: `ballot-check`, `fetch-snapshot` (for its URL and `source:` name refusals) and `publish`; `ballot-check` and `fetch-snapshot` (each time it loads `tiers.yaml`) read every ballot's `private.yaml` and `addresses.yaml` for the `tiers.yaml` check:

```yaml
private_strings:
  - Precinct 12         # precinct names and numbers
  - Pat Q. Voter        # voter names printed on a personalized sample ballot
  - Springfield Township   # place names that narrow down the voter's location beyond the contest list
  - BS-0412             # ballot style or split codes, voter ids
  - Lincoln Elementary Gym   # polling place name and address
ignored_lines:          # sample-ballot lines that are not contests (instructions, headers, footers)
  - Vote for one
```

Contest types: `candidate`, `retention` (one judge or official, yes/no), and `measure`. Set `office_type: judicial` on judicial candidate and retention contests; other contests leave it out.

Candidate contests carry `vote_for`, the number of seats to fill; the page shows "Vote for N" when it is more than 1.

Candidate and retention contests carry `jurisdiction`: the state and the district or court the office covers, so the discovery agent can search the right state databases and local papers without guessing. Measures carry it too, at the level the measure covers (`XX Exampleton County`), plus `search_terms`: a few researcher-written words for the subject (`library levy`), since discovery never sees the title. `ballot-check` applies the same checks to `search_terms` as to `jurisdiction`. It goes into web searches, so it must say no more than the printed contest title already does, and never the locating part of a title that has a `display_title`. `ballot-check` fails a `jurisdiction` or `search_terms` that contains a `private_strings` entry or the printed `title` of a contest with a `display_title`; use a coarser one (the state, or the state and county).

The page shows `display_title` when it is set and `title` otherwise. The ballot check always uses `title`, and fails when a `display_title` equals its `title`. For a contest with a `display_title`, `check` fails any excerpt that contains the printed `title`, so the problem shows up at compile time, and the publish privacy scan refuses any page that still contains it. `display_title` hides only the full printed title, so also list its locating part (the place name) under `private_strings`; an excerpt that quotes just that part is then refused too. A measure whose official text cannot be quoted without it stays "Not ready yet".

## Ballot check

`ballot-check` compares `ballot.yaml` with the authoritative sample ballot: the `_ballot/` snapshot with `role: sample_ballot` that no later snapshot `supersedes`. Other `_ballot/` snapshots (candidate list, pamphlet, superseded ballots) never satisfy it. Text is compared with the same normalization as excerpts ([article-format.md](article-format.md)), because sample ballots are often PDFs, except that newlines are kept: the snapshot body is split into raw lines first and each line is normalized on its own. A listed title, or a candidate entry (name plus party), may wrap across several lines; every line inside its matched span counts as accounted for.

- **Listed to official:** every contest `title` must appear in the sample ballot, in `ballot.yaml` order: each title is searched for after the previous title's match, so two contests with the same printed title (several "Judge of the Circuit Court" seats) land on their own places, and a title that cannot be placed in order fails. Each candidate `name` must appear as whole words between its own contest's title and the next contest's title, and each retention `official.name` either there or inside its own contest's title, so a name under the wrong contest, or a prefix of a longer printed name ("John Sample" for "John Samples"), fails.
- **Official to listed:** the number of contests must equal `contest_count`. For each `candidate` contest, the printed candidates listed (`on_ballot` plus `withdrawn_still_printed`) must equal `printed_count`. Retention and measure contests have no count. These counts are the researcher's own, so they check `ballot.yaml` against itself. To catch a contest missed in both, `ballot-check` also lists the line number of every sample-ballot line that is not accounted for, never its text, which can be the voter's name or address; the researcher reads the lines with `ballot-check --show` (Rule 5). A line is accounted for only when it matches a listed contest title, a line holding a listed candidate or official name (with its party), a line that, after normalization, is exactly a `private_strings` entry, or an entry in the `ignored_lines:` list in `private.yaml` (instructions, headers, page footers). `ignored_lines` lives in `private.yaml` because the leftover lines of a personalized ballot are often next to precinct, voter or polling-place text. It holds only boilerplate; that private text goes under `private_strings`, which the publish scan checks, and `ballot-check` fails an `ignored_lines` entry that contains a `private_strings` entry. Position on the page never accounts for a line, so a contest left out of both the list and the counts shows up even in the middle of the ballot. The check passes only when the researcher has added each missing contest or copied the line into `ignored_lines`.
- **Ballot view:** on a pass, `ballot-check` writes `<ballot-id>/ballot-view.md`: a `link:` line with the path of the authoritative sample-ballot snapshot, which claims link to and no agent may open; one `read:` line per `_ballot` snapshot whose role is `candidate_list`, `pamphlet`, `write_in_list` or `withdrawal_notice`, the only `_ballot` files the compile agent opens and the only ones its allow list takes from this file (never a `role: sample_ballot` snapshot, superseded or not); then the matched span of each listed contest title, candidate entry and retention official name, one per line, in ballot order. This is the only form of the sample ballot the compile agent reads (Rule 7).
- **Companion documents:** `candidate_list`, `pamphlet`, `write_in_list` and `withdrawal_notice` snapshots must be county- or state-wide documents, since the compile agent reads them whole. `ballot-check` fails one whose fetch URL had a query string (`ballot.ledger` records whether it did) or whose body holds a voter-specific value: an address, street line or label from `addresses.yaml`, matched as in the publish privacy scan (SKILL.md step 6.3). It does not apply the scan's ZIP, title, place-name or link checks, which county-wide documents fail by nature. A personalized lookup result is saved only as the sample ballot. A companion that fails, or that the researcher finds personalized, is retired by listing its path under `retired_companions:` in `ballot.yaml`, which keeps it off the `read:` lines; the researcher then saves a county-wide copy.
- **Private text:** no `private_strings` entry may appear in `ballot.yaml` outside the printed `title` of a contest that has a `display_title` (that title is copied exactly as printed, and the page never shows it). A county can share a word with a private township (Washington Township in Washington County), so when an entry appears in the `state` or `county` field, `ballot-check` fails, names that field, and says to list the township's full name, never the bare shared word. When a `private_strings` entry equals a field the page shows (a candidate's printed `name`, or `display_name` in `publish.yaml`), `ballot-check` fails and names the field's key, never the text; a name that is public by nature (the voter is on the ballot) comes out of `private_strings`, and the researcher keeps every other entry. When an entry's digit run reads as a year (1900 to 2099, as in a precinct named 2024), `ballot-check` warns, without quoting the entry, that the publish privacy scan matches that run only next to the entry's other words (SKILL.md step 6.3).
- **Party names:** `party` is copied exactly as printed. When the ballot prints an abbreviation, the researcher adds `party_name`, the party's full name as an official `_ballot/` source (the candidate list or the voter pamphlet) spells it out, and the page shows that ([page.md](page.md)). `ballot-check` fails, with no `party_name`, a `party` with any word written as an abbreviation: all capitals (`D`, `DEM`), or holding a period, slash or hyphen (`Dem.`, `D.F.L.`, `DEM/WF`, `D-NPL`, `Ind. Am.`). A full name such as `Green` or `Working Families` passes; one printed in capitals (`GREEN PARTY`) needs a `party_name`, which may be the same words as an official source writes them, and the check that a snapshot contains it ignores case. It also fails a `party_name` that no `candidate_list` or `pamphlet` snapshot contains, never counting the `sample_ballot` that printed the abbreviation or a retired companion, and a `party_name` that is itself abbreviated: a word holding a period, slash or hyphen, or a single word in all capitals (`DEM`). So the full name is never the researcher's own guess, and never the abbreviation again.
- **Ids:** every contest, candidate and official `id` matches `^[a-z0-9]+(-[a-z0-9]+)*$`, so an id is always a safe directory name, never collides with `_race` or `_ballot`, and never holds `--`, which page anchors use to join a contest id and a section ([page.md](page.md)). A contest id may not be `ballot`, the page's own anchor for the ballot list. Contest ids become page anchors, so `ballot-check` fails a contest id that, with hyphens read as spaces, contains a `private_strings` entry or the printed `title` of a contest with a `display_title`.
- **Ballot ids:** the ballot id, the `<ballot-id>` directory name, is exactly `<state>-<county>-<n>`: `state` from `ballot.yaml` in lower case; `county` from `ballot.yaml` with its letters folded to ASCII (ñ reads as n), apostrophes (' or ’) dropped, one trailing City and Borough, Borough, Census Area, Municipality, County or Parish dropped, longest first (never city alone, so St. Louis city and St. Louis County stay apart), lower case, and every other run of spaces or punctuation read as one hyphen; and a 1-2 digit number the researcher picks to tell ballots in one county apart (the example above is `xx-exampleton-1`; Doña Ana County gives nm-dona-ana-1, and Juneau City and Borough gives ak-juneau-1). So it matches `^[a-z]{2}-[a-z]+(-[a-z]+)*-[1-9][0-9]?$` and holds no word the researcher chose. Ending in a number keeps the privacy scan from matching it in ordinary page text. Agents read paths under it, so `ballot-check` also fails a ballot id whose number equals any digit run of any `private_strings` entry: with `Precinct 12` listed, 12 fails, so pick another. The county words are fixed by `ballot.yaml` and already public through the contest list, so they are not checked against `private_strings`. It checks the ballot directories under every `<election>` directory in the data repo (the Layout gives their pattern), not only the current one, so an id made under an older template is caught. Paths in `ballot.ledger` and `archives.tsv` are relative to the ballot directory, so they never hold the id. To rename a ballot id, the researcher renames its directory and its entry in `addresses.yaml`, then reruns `ballot-check`.
- **Slug:** `slug` must match `^[a-z0-9]{6}$` and no other `ballot.yaml` in the data repo may use it, so a copied `ballot.yaml` can never publish over another ballot's page.
- **Write-ins:** `certified_write_in` candidates skip the printed-ballot check and must appear verbatim in the `role: write_in_list` snapshot. If the county publishes none, the page says "Certified write-ins: none published".
- **Withdrawals:** a `withdrawn_still_printed` candidate must also appear verbatim in a `role: withdrawal_notice` snapshot, the county or state notice of the withdrawal, so a mistyped status can never hide a candidate's record. A candidate list is not proof, since it names every candidate. Their On the ballot claim cites that snapshot. When the county or state publishes no such notice, the candidate stays `on_ballot` and gets every section.
- **Tiers:** `ballot-check` fails any `tiers.yaml` `match` that contains, matched as in the publish privacy scan, a `private_strings` entry of any ballot in the data repo, or any address, street line, label or ZIP code from `addresses.yaml`, because the discovery agent and its web searches see every `tiers.yaml` host. `fetch-snapshot` runs the same check each time it loads `tiers.yaml`.

Corrections to the sample ballot become a new snapshot with `supersedes` set, plus an edit to `ballot.yaml`. The old snapshot stays. `ballot-check` lists every `supersedes` link and passes only when each one is named in a `confirmed_supersedes:` list the researcher keeps in `ballot.yaml`, so a planted snapshot can never become the authoritative ballot.
