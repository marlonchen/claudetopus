# Source tiers and discovery checklist

Every snapshot carries one tier in its front matter ([snapshot-format.md](snapshot-format.md)). The tier decides how a claim citing it may be worded.

| Tier | What counts | How claims read |
| --- | --- | --- |
| T1 | Official records: roll-call votes, bill text, FEC and state campaign-finance filings, ethics findings, court records, the official sample ballot and voter pamphlet | As facts |
| T1, statements only | Debate transcripts, speeches, interviews | "Says: ..." — evidence the candidate said it, never a fact about the world |
| T2 | Independent reporting and fact-checks (AP, Reuters, FactCheck.org, established local papers) | As facts when reporting; flagged for review when interpreting |
| T3 | Nonpartisan analysis: CBO and JCT scores, state legislative fiscal office, official fiscal notes, university research centers | As analysis, attributed |
| T4, statements only | Campaign sites, Vote411 and Ballotpedia questionnaire answers, advocacy groups | "Says: ..." only, about the candidate's own positions |

"Statements only" sources set `statements_only: true` in their front matter. T4 sources always do.

The tier is never the model's call, and neither is whose words a source holds or what it is called. The data repo's `tiers.yaml` maps sources to a tier, `statements_only`, an owner and a source name, and only the researcher edits it (Rule 7):

```yaml
- match: county.example.gov              # a host, or a host and path prefix
  tier: T1
  owner: third-party                     # third-party, or the candidate or official id whose own site it is
  source: Exampleton County elections    # the name the page receipt shows
- match: www.example-paper.com/opinion/  # the longest match wins
  tier: T4
  statements_only: true
  owner: third-party
  source: Example Paper opinion page
- match: janeexample.com                 # a campaign site: the candidate's own words
  tier: T4
  statements_only: true
  owner: jane-example
  source: Jane Example campaign site
```

A host matches exactly or on a dot-label boundary (`www.county.example.gov` matches `county.example.gov`; `evilcounty.example.gov` does not). `fetch-snapshot` checks the requested URL and again after every redirect, records the final URL, and copies the tier, `statements_only`, `owner` and `source` of the longest match into the snapshot ([snapshot-format.md](snapshot-format.md)); the caller never supplies them. It refuses a URL with no match, and refuses to load a `tiers.yaml` with a T4 or "statements only" entry that lacks `statements_only: true`, or with an entry that lacks `owner` or `source`. An `owner` is `third-party` or a candidate or official id from a `ballot.yaml` in the data repo; a campaign site gets its candidate's id, and everything else, debate hosts and questionnaire sites included, is `third-party`, since the candidate does not control what they publish. `review-list` uses `owner`, never the agent-chosen subject directory, to decide which "Says:" claims need a human check ([review-list.md](review-list.md)). A refused domain is logged to `unfetchable.md` with the reason `domain not in tiers.yaml`; those entries never go on the review list (review-list.md).

## Claim tags

Each claim carries one tag: the cited snapshot's tier, plus an optional mark.

| Tag | Meaning | `check` enforces |
| --- | --- | --- |
| `T1`, `T2`, `T3` | Plain claim | The tier matches the snapshot; the snapshot is not `statements_only` |
| `T1s` ... `T4s` | "Says:" claim, the candidate's own words | The tier matches the snapshot; the claim text starts with `Says:` |
| `T2i` | T2 claim that interprets rather than reports | The snapshot is T2 (`review-list` puts every `T2i` claim on the list) |

A candidate quote reported in a T2 article is `T2s`. The compile step sets the `i` mark; `check` cannot tell interpreting from reporting, so the neutrality pass also flags an unmarked T2 claim that interprets.

## Discovery checklist

Try items 1-5 for every candidate, in order, item 6 for every measure, and item 7 for every retention official. [sections.md](sections.md) maps each item to the sections it fills. After running an item for a candidate, official or measure, the discovery agent logs it with `fetch-snapshot --searched` ([snapshot-format.md](snapshot-format.md)), whatever it found; an item it never ran is never logged, so `coverage` can tell "searched and found nothing" from "never searched".

1. **Federal offices:** FEC candidate and committee totals (OpenFEC API), Congress.gov sponsored bills and roll-call votes for incumbents.
2. **State offices:** the state legislature's member page and vote records (OpenStates API), the state campaign-finance database, the state ethics commission.
3. **Courts:** state and federal court record searches for the candidate's name, when the office or reporting suggests litigation.
4. **Reporting:** AP, Reuters, and the main local papers for the district, plus FactCheck.org and PolitiFact.
5. **Candidate's own words:** campaign site issues page, Vote411 and Ballotpedia questionnaires, debate transcripts.
6. **Measures:** the official text, the official fiscal note, the voter pamphlet's arguments for and against, and independent analysis.
7. **Retention:** the record in office, the state's judicial evaluation findings if any, discipline records, and the official's own statements. Thin records are normal; say so rather than padding.
