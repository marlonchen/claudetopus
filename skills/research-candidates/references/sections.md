# Sections

The fixed section list for each contest type. `coverage` checks every article against this file, so "equal depth" means the same headings, in the same order, for every candidate in a contest.

The Rule column carries two markers that scripts read by name, never by letter:

- `says-only`: every claim in the section has an `s` tag (`T1s` ... `T4s`) and starts with `Says:`, whatever the cited snapshot allows. `coverage` enforces it.
- `always reviewed`: every claim in the section goes on the review list. `review-list` enforces it.

## Candidate contests

| Section | What goes in it | Discovery checklist items ([source-tiers.md](source-tiers.md)) | Rule |
| --- | --- | --- | --- |
| A. On the ballot | Name and party exactly as printed, and status (withdrawn, certified write-in) | `_ballot/` snapshots | |
| B. Background | Current and past occupation, prior offices held | 4, 5 | |
| C. Record in public office | Votes, sponsored bills, official actions | 1, 2 | |
| D. Money | Campaign-finance totals and the largest sources by category | 1, 2 | |
| E. Positions | The candidate's own words, under each issue in [Positions issues](#positions-issues) | 5 | `says-only` |
| F. Controversies and cases | Allegations, investigations, findings, judgments, convictions, each with its status | 2, 3, 4 | `always reviewed` |

A withdrawn candidate who is still printed gets the On the ballot section only, holding the withdrawal receipt from the `withdrawal_notice` snapshot. Every other candidate, certified write-ins included, gets all six.

## Positions issues

Positions is split into a fixed list of issues, set by the contest's `office_type` in `ballot.yaml`, so readers can compare every candidate on one issue. In the article each issue is a `####` heading under Positions, written exactly as below and in this order, and each issue is in exactly one section state ([article-format.md](article-format.md)), for every candidate. `coverage` enforces it, and the `says-only` rule covers every issue. A claim goes under the one issue it is about; a statement that fits no issue on the list stays out of the article.

| Office type | Offices | Issues, in order |
| --- | --- | --- |
| `federal` | U.S. Senate, U.S. House | Taxes and spending; Economy and jobs; Health care; Immigration; Abortion; Energy and environment; Foreign policy and defense |
| `state` | Governor and other statewide offices, state legislature | Taxes and the state budget; Economy and jobs; Education; Health care; Public safety; Energy and environment; Abortion |
| `local` | County, municipal and school board offices | Taxes and budget; Public safety; Schools; Housing and development; Roads and transit |
| `judicial` | Judges | None: Positions is `Not part of this office's job` (below) |

Set the lists before the first compile of an election, like an exemption: changing one later means recompiling every contest of that office type.

## Retention contests

One block for the judge or official on the ballot:

| Section | What goes in it | Discovery checklist items | Rule |
| --- | --- | --- | --- |
| A. On the ballot | Name and office exactly as printed | `_ballot/` snapshots | |
| B. Record in office | Time in office, published rulings or official actions | 7 | |
| C. Evaluation findings | The state's judicial or performance evaluation, if any | 7 | |
| D. Discipline | Discipline records and their status | 7 | `always reviewed` |
| E. Statements | The official's own words | 7 | `says-only` |

## Measures

| Section | What goes in it | Discovery checklist items | Rule |
| --- | --- | --- | --- |
| A. What it does | From the official text | 6 | |
| B. Fiscal effect | From the official fiscal note | 6 | |
| C. Arguments for | From the voter pamphlet, attributed to the argument's signers | 6 | `says-only` |
| D. Arguments against | Same, for the arguments against | 6 | `says-only` |
| E. Independent analysis | T2 and T3 analysis, attributed | 6 | |

## Not part of this office's job

A candidate contest marked `office_type: judicial` in `ballot.yaml` has its Positions section in the state `Not part of this office's job` for every candidate, because judicial ethics rules bar candidates from committing on issues. It keeps that state even when the contest's `not_researched` names Positions or is `all`, since the section is never researched and never needs to be. No other office has exemptions, and no other section may use that state.

Add any new exemption here before the first compile of an election. Adding one later means recompiling every contest it affects.
