# Article format

One article per contest, at `<ballot-id>/articles/<contest>.md`. The format is built so `check` can verify every claim against its own snapshot and the page generator can render every receipt.

## Structure

```markdown
# <contest id, as in ballot.yaml>

## <candidate name, exactly as printed>

### A. On the ballot

- <claim line>

### B. Background

Unknown, no source found

### C. Record in public office

Not researched yet

### D. Money

- <claim line>

### E. Positions

#### Taxes and spending

- <claim line>

#### Economy and jobs

Unknown, no source found

…
```

The example stops partway (`…`): an article has every section and every issue of its list. Section headings come from [sections.md](sections.md), in that order, for every candidate in ballot order. Under Positions, each issue of the contest's office type ([sections.md](sections.md), Positions issues) is a `####` heading, in the list's order, and holds the section state; Positions itself holds only those headings, unless the whole section is `Not researched yet` or `Not part of this office's job`. Retention contests have one `##` block for the judge or official, and measures one `##` block titled with the contest id, never the printed title. The page takes every contest and measure heading from `ballot.yaml` (step 6.2). There is no separate source list: the set of snapshots an article cites is the set of its claim links.

## Claim lines

```text
- <claim text> `T1` [s1](../sources/<contest>/<candidate>/<snapshot>.md)
  > <verbatim excerpt>
```

- The tag is inline code, one of the claim tags in [source-tiers.md](source-tiers.md).
- The link points at exactly one snapshot and is relative to the article.
- The excerpt is an indented blockquote on its own line, copied verbatim from the body of *that* snapshot. `check` matches each excerpt against the one snapshot its own claim links to, never against other snapshots the article cites. It needs no quote marks, so it may contain any quote character.
- The excerpt is 20 to 400 characters, except a sample-ballot excerpt, which is exactly one whole span from `ballot-view.md` whatever its length (a short entry such as `Jo Li REP`). The compile step keeps an excerpt under 280 characters where the claim allows, so little of it hides behind the page's ~200-character cut ([page.md](page.md)); `check` does not enforce this. For a short value (a roll-call "Yea", a dollar figure), quote enough of the surrounding line to reach 20, for example the bill number and the vote together. The cap keeps the figure check meaningful and keeps long stretches of a news article off the page.

## Matching

Excerpt matching and the ballot check normalize both sides the same way, and nothing else:

1. Unicode NFKC, which also expands ligatures such as `ﬁ` and turns non-breaking and other Unicode spaces into plain spaces.
2. Collapse runs of whitespace to one space.
3. Map curly quotes to straight quotes, and en and em dashes to `-`.
4. Join `pdftotext` hyphenated line breaks.

## Figures

Before `check` looks for figures in the claim text, it strips link targets, link text and inline code, so snapshot names and contest ids (`us-house-07`, `fec-totals-2.md`) are never read as claimed figures.

Each figure left in the claim must match a figure in that claim's own excerpt, not just any number in the snapshot. Both sides are canonicalized first: drop `$` and thousands commas, read `K`, `M`, `million` and `billion` as multipliers, and read `%` as a percentage. A claimed figure matches when the excerpt's value, rounded half-up to the decimal places the claim shows, equals it: "$1.22 million" matches `receipts: 1220000.55`, and "$1,220,001" matches it too.

## Failure codes

`check`, `coverage` and `publish` report each failure as a location (article path and line, plus the claim key when there is one) and one code from this list. The main session passes the compile agent only these two (Rule 7).

| Code | Meaning |
| --- | --- |
| `excerpt-not-found` | The excerpt is not in the body of the snapshot the claim links to |
| `excerpt-length` | The excerpt is under 20 or over 400 characters (a sample-ballot excerpt is checked by `ballot-excerpt` instead) |
| `tag-mismatch` | The claim tag does not fit the snapshot's tier or `statements_only` |
| `says-missing` | A "Says:" claim does not start with `Says:`, or a `says-only` section holds another claim |
| `figure-missing` | A figure in the claim is not in its excerpt |
| `ballot-excerpt` | An excerpt citing the sample ballot is not one whole span of `ballot-view.md` |
| `title-in-excerpt` | An excerpt contains the printed title of a contest with a `display_title` |
| `comment-marker` | A claim or excerpt contains `<!--` or `-->` |
| `private-match` | Reported by `publish`: a claim or excerpt matches the privacy scan (SKILL.md step 6.3) |
| `private-source` | Reported by `publish`: a cited snapshot's `source:` name matches the privacy scan |
| `claim-format` | A claim line is malformed, or its link points at a missing snapshot or one outside `sources/` |
| `block-missing` | A candidate, official or measure block is missing, out of ballot order, or under the wrong `#` or `##` heading |
| `section-missing` | A section is missing, out of order or duplicated |
| `section-state` | A section or Positions issue has no state, more than one, or a state it may not use, or `Not researched yet` is used for some candidates in a section but not all, or in a section the contest's `not_researched` does not list, or a listed section is in another state |
| `search-not-logged` | Reported by `coverage`: a section or Positions issue is `Unknown, no source found`, but the contest's search log lacks a line for its subject and each checklist item the section draws on, or the log has a malformed line ([snapshot-format.md](snapshot-format.md)) |
| `snapshot-hash` | Reported by `check` and `publish`, located by snapshot path or manifest line: a snapshot's sha256 differs from its line in `snapshots.sha256`, it has no line or is retired, a line's file is gone and not retired, a path has more than one hash or retire line, a manifest line is malformed, or `sources/` holds a symlink |

## Section states

Each section, and under Positions each issue, is in exactly one state; an issue never uses `Not researched yet`, which only a whole section takes:

- claims (one or more claim lines);
- `Unknown, no source found`: the checklist was run and nothing usable turned up. `coverage` accepts it only when the search log backs it (`search-not-logged`);
- `Not researched yet`: the checklist has not been run for this section yet, so it says nothing about the candidate. It is how a section or a whole contest left for later, when the schedule runs short, says it still needs research; it never stands in for Unknown. Only the researcher decides that, by listing the section under the contest's `not_researched` in `ballot.yaml` ([ballot-format.md](ballot-format.md)). `coverage` accepts it in any section but On the ballot, exactly where that list names the section, and only when the section is in it for every candidate block of the contest that has the section, so no candidate is researched deeper than a rival on one topic. Under Positions it covers the whole section, with no issue headings. It needs no search-log line, and a log line does not change it;
- `Not part of this office's job`: only where [sections.md](sections.md) says so.

On the ballot always holds claims, never `Unknown, no source found` or `Not researched yet`: every block in it is on the official ballot record.

A contest whose `not_researched` is `all`, so that every section apart from On the ballot is `Not researched yet`, is a not-researched contest: the page shows who is on the ballot and says the rest is still to come ([page.md](page.md)).

A withdrawn candidate who is still printed has only the sections [sections.md](sections.md) gives it; the rest are absent, not in any state. Its On the ballot claim cites the `withdrawal_notice` snapshot ([snapshot-format.md](snapshot-format.md)). Certified write-ins come after printed candidates.

## Wording rules

- No claim without a link and an excerpt.
- No `<!--` or `-->` in a claim or excerpt, so claim text can never forge a review key.
- Positions use the candidate's own words, quoted, labeled "Says:". Sections marked `says-only` in [sections.md](sections.md) allow nothing else.
- No adjectives about candidates.
- Money and vote figures are shown raw, as the excerpt gives them. A computed share ("61% from PACs") is not a claim; derived-number claims are not supported yet.
