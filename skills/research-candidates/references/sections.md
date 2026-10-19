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
| E. Positions | The candidate's own words | 5 | `says-only` |
| F. Controversies and cases | Allegations, investigations, findings, judgments, convictions, each with its status | 2, 3, 4 | `always reviewed` |

A withdrawn candidate who is still printed gets the On the ballot section only, holding the withdrawal receipt from the `_ballot` snapshot that records the withdrawal. Every other candidate, certified write-ins included, gets all six.

## Retention contests

One block for the judge or official on the ballot:

| Section | What goes in it | Rule |
| --- | --- | --- |
| A. On the ballot | Name and office exactly as printed | |
| B. Record in office | Time in office, published rulings or official actions | |
| C. Evaluation findings | The state's judicial or performance evaluation, if any | |
| D. Discipline | Discipline records and their status | `always reviewed` |
| E. Statements | The official's own words | `says-only` |

## Measures

| Section | What goes in it | Rule |
| --- | --- | --- |
| A. What it does | From the official text | |
| B. Fiscal effect | From the official fiscal note | |
| C. Arguments for | From the voter pamphlet, attributed to the argument's signers | `says-only` |
| D. Arguments against | Same, for the arguments against | `says-only` |
| E. Independent analysis | T2 and T3 analysis, attributed | |

## Not part of this office's job

A candidate contest marked `office_type: judicial` in `ballot.yaml` has its Positions section in the state `Not part of this office's job` for every candidate, because judicial ethics rules bar candidates from committing on issues. No other office has exemptions, and no other section may use that state.

Add any new exemption here before the first compile of an election. Adding one later means recompiling every contest it affects.
