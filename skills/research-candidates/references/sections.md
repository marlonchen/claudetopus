# Sections

The fixed section list for each contest type. `coverage` checks every article against this file, so "equal depth" means the same headings, in the same order, for every candidate in a contest.

## Candidate contests

| Section | What goes in it | Discovery checklist items ([source-tiers.md](source-tiers.md)) |
| --- | --- | --- |
| A. On the ballot | Name and party exactly as printed, and status (withdrawn, certified write-in) | `_ballot/` snapshots |
| B. Background | Current and past occupation, prior offices held | 4, 5 |
| C. Record in public office | Votes, sponsored bills, official actions | 1, 2 |
| D. Money | Campaign-finance totals and the largest sources by category | 1, 2 |
| E. Positions | The candidate's own words, as "Says:" claims | 5 |
| F. Controversies and cases | Allegations, investigations, findings, judgments, convictions, each with its status | 2, 3, 4 |

A withdrawn candidate who is still printed gets section A only, holding the withdrawal receipt. Every other candidate, certified write-ins included, gets all six.

## Retention contests

One block for the judge or official on the ballot:

| Section | What goes in it |
| --- | --- |
| A. On the ballot | Name and office exactly as printed |
| B. Record in office | Time in office, published rulings or official actions |
| C. Evaluation findings | The state's judicial or performance evaluation, if any |
| D. Discipline | Discipline records and their status |
| E. Statements | The official's own words, as "Says:" claims |

## Measures

| Section | What goes in it |
| --- | --- |
| A. What it does | From the official text |
| B. Fiscal effect | From the official fiscal note |
| C. Arguments for | From the voter pamphlet, as "Says:" claims attributed to the argument's signers |
| D. Arguments against | Same, for the arguments against |
| E. Independent analysis | T2 and T3 analysis, attributed |

## Not part of this office's job

Set per `office_type` (from `ballot.yaml`), never per candidate. A section listed here must have the state `Not part of this office's job` for every candidate with that office type, and no other section may use that state.

| office_type | Sections that are not part of the job |
| --- | --- |
| `legislative` | none |
| `executive` | none |
| `administrative` (clerk, auditor, recorder, treasurer) | none |
| `board` (school, water, other local boards) | none |
| `judicial` | E. Positions (judicial ethics rules bar candidates from committing on issues) |

Edit this table before the first compile of an election. Changing it later means recompiling every contest it affects.
