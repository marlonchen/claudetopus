# Article format

One article per contest, at `<ballot-id>/articles/<contest>.md`. The format is built so the evidence checker can verify every claim and the page generator can render every receipt.

## Header

The `> Raw:` metadata line lists every snapshot the article cites, one link each. The checker reads evidence only from that line, and `coverage` fails if a claim cites a snapshot missing from it.

## Claim lines

```text
- <claim text> `T1` [s1](../sources/<contest>/<candidate>/<snapshot>.md)
  > <verbatim excerpt>
```

- The tier tag is inline code.
- The link is relative to the article.
- The excerpt is an indented blockquote on its own line, at least 20 characters, copied verbatim from the snapshot body. It needs no quote marks, so it may contain any quote character.
- Matching normalizes both sides the same way: collapse whitespace, map curly quotes to straight and en/em dashes to `-`, and join `pdftotext` hyphenated line breaks. Nothing else.
- Snapshot filenames and link text contain no dates or numbers (`fec-totals.md`, `fec-totals-2.md`), so the checker never mistakes path text for a claimed figure.

## Sections

Every candidate in a contest gets the same sections in the same order. Each section is in exactly one state:

- claims (one or more claim lines);
- `Unknown, no source found` — the checklist was run and nothing usable turned up;
- `Not part of this office's job` — fixed per office type before any compile, never decided per candidate.

Candidate sections follow the research workflow's checklist A-F. Retention and measure contests use their own templates (see [source-tiers.md](source-tiers.md) for what each draws on).

## Wording rules

- No claim without an excerpt.
- Positions use the candidate's own words, quoted, labeled "Says:".
- No adjectives about candidates.
- Derived numbers (for example "61% from PACs") only when both inputs are excerpted and a script recomputes the result. Otherwise show the raw figures.
- Withdrawn candidates keep their ballot position with only the withdrawal receipt. Certified write-ins come after printed candidates with the full template.
