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
```

Section headings come from [sections.md](sections.md), in that order, for every candidate in ballot order. Retention contests have one `##` block for the judge or official, and measures one `##` block titled with the contest id, never the printed title. The page takes every contest and measure heading from `ballot.yaml` (step 6.2). There is no separate source list: the set of snapshots an article cites is the set of its claim links.

## Claim lines

```text
- <claim text> `T1` [s1](../sources/<contest>/<candidate>/<snapshot>.md)
  > <verbatim excerpt>
```

- The tag is inline code, one of the claim tags in [source-tiers.md](source-tiers.md).
- The link points at exactly one snapshot and is relative to the article.
- The excerpt is an indented blockquote on its own line, copied verbatim from the body of *that* snapshot. `check` matches each excerpt against the one snapshot its own claim links to, never against other snapshots the article cites. It needs no quote marks, so it may contain any quote character.
- The excerpt is 20 to 300 characters, except a sample-ballot excerpt, which is exactly one whole span from `ballot-view.md` whatever its length (a short entry such as `Jo Li REP`). For a short value (a roll-call "Yea", a dollar figure), quote enough of the surrounding line to reach 20, for example the bill number and the vote together. The cap keeps the figure check meaningful and keeps long stretches of a news article off the page.

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
| `excerpt-length` | The excerpt is under 20 or over 300 characters |
| `tag-mismatch` | The claim tag does not fit the snapshot's tier or `statements_only` |
| `says-missing` | A "Says:" claim does not start with `Says:`, or a `says-only` section holds another claim |
| `figure-missing` | A figure in the claim is not in its excerpt |
| `derived-mismatch` | A derived number's formula, inputs or result do not check out |
| `ballot-excerpt` | An excerpt citing the sample ballot is not one whole span of `ballot-view.md` |
| `title-in-excerpt` | An excerpt contains the printed title of a contest with a `display_title` |
| `comment-marker` | A claim or excerpt contains `<!--` or `-->` |
| `private-match` | Reported by `publish`: a claim or excerpt matches the privacy scan (SKILL.md step 6.3) |
| `claim-format` | A claim line is malformed, or its link points at a missing snapshot or one outside `sources/` |
| `block-missing` | A candidate, official or measure block is missing, out of ballot order, or under the wrong `#` or `##` heading |
| `section-missing` | A section is missing, out of order or duplicated |
| `section-state` | A section has no state, more than one, or a state it may not use |

## Section states

Each section is in exactly one state:

- claims (one or more claim lines);
- `Unknown, no source found`: the checklist was run and nothing usable turned up;
- `Not part of this office's job`: only where [sections.md](sections.md) says so.

The one exception is a withdrawn candidate who is still printed: the On the ballot section only, holding the withdrawal receipt. Certified write-ins come after printed candidates and get every section.

## Wording rules

- No claim without an excerpt, except a derived number (below).
- No `<!--` or `-->` in a claim or excerpt, so claim text can never forge a review key.
- Positions use the candidate's own words, quoted, labeled "Says:". Sections marked `says-only` in [sections.md](sections.md) allow nothing else.
- No adjectives about candidates.
- A derived number (for example "61% from PACs") is allowed only when both inputs are claims in the same section with their own excerpts, and the derived claim shows its formula in inline code (`` `= 1,220,000 / 2,000,000` ``). A derived claim is the one claim with no link and no excerpt of its own: its evidence is its inputs. Its tag is the weakest of its inputs' tags (the highest tier number), and `check` verifies that instead of a snapshot's tier. `check` skips the excerpt-figure match for its result, requires each number in the formula to match a figure in a sibling claim, recomputes it, rounds half-up to the decimal places the claim shows, and fails unless the result equals the claimed value. Otherwise show the raw figures.
