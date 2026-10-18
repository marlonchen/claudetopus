# Article format

One article per contest, at `<ballot-id>/articles/<contest>.md`. The format is built so `check` can verify every claim against its own snapshot and the page generator can render every receipt.

## Structure

```markdown
# <contest title, as in ballot.yaml>

## <candidate name, exactly as printed>

### A. On the ballot

- <claim line>

### B. Background

Unknown, no source found
```

Section headings come from [sections.md](sections.md), in that order, for every candidate in ballot order. Retention contests have one `##` block for the judge or official, and measures one `##` block titled with the measure. There is no separate source list: the set of snapshots an article cites is the set of its claim links.

## Claim lines

```text
- <claim text> `T1` [s1](../sources/<contest>/<candidate>/<snapshot>.md)
  > <verbatim excerpt>
```

- The tag is inline code, one of the claim tags in [source-tiers.md](source-tiers.md).
- The link points at exactly one snapshot and is relative to the article.
- The excerpt is an indented blockquote on its own line, copied verbatim from the body of *that* snapshot. `check` matches each excerpt against the one snapshot its own claim links to, never against other snapshots the article cites. It needs no quote marks, so it may contain any quote character.
- The excerpt is at least 20 characters. For a short value (a roll-call "Yea", a dollar figure), quote enough of the surrounding line to reach 20, for example the bill number and the vote together.
- Matching normalizes both sides the same way: collapse whitespace, map curly quotes to straight and en/em dashes to `-`, and join `pdftotext` hyphenated line breaks. Nothing else.
- Before `check` looks for figures in the claim text, it strips link targets, link text and inline code, so snapshot names and contest ids (`us-house-07`, `fec-totals-2.md`) are never read as claimed figures.

## Section states

Each section is in exactly one state:

- claims (one or more claim lines);
- `Unknown, no source found`: the checklist was run and nothing usable turned up;
- `Not part of this office's job`: only where [sections.md](sections.md) says so for the contest's `office_type`.

The one exception is a withdrawn candidate who is still printed: section A only, holding the withdrawal receipt. Certified write-ins come after printed candidates and get every section.

## Wording rules

- No claim without an excerpt.
- Positions use the candidate's own words, quoted, labeled "Says:".
- No adjectives about candidates.
- A derived number (for example "61% from PACs") is allowed only when both inputs are claims in the same section with their own excerpts, and the derived claim shows its formula in inline code (`` `= 1,220,000 / 2,000,000` ``). `check` recomputes it and fails on a mismatch beyond rounding. Otherwise show the raw figures.
