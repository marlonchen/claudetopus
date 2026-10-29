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
- The link points at exactly one snapshot and is relative to the article. Its text is `s` and a number (`s1`); the page never shows it.
- The excerpt is an indented blockquote on its own line, copied verbatim from the body of *that* snapshot. `check` matches each excerpt against the one snapshot its own claim links to, never against other snapshots the article cites. It needs no quote marks, so it may contain any quote character.
- The excerpt is 20 to 400 characters, except a sample-ballot excerpt, which is exactly one whole span from `ballot-view.md` whatever its length (a short entry such as `Jo Li REP`). The compile step keeps an excerpt under 280 characters where the claim allows, so little of it hides behind the page's ~200-character cut ([page.md](page.md)); `check` does not enforce this. For a short value (a roll-call "Yea", a dollar figure), quote enough of the surrounding line to reach 20, for example the bill number and the vote together. The cap keeps the figure check meaningful and keeps long stretches of a news article off the page.

## Matching

Excerpt matching and the ballot check normalize both sides the same way, and nothing else:

1. Unicode NFKC, which also expands ligatures such as `ﬁ` and turns non-breaking and other Unicode spaces into plain spaces.
2. Remove default-ignorable code points, such as soft hyphens and zero-width spaces.
3. Collapse runs of whitespace to one space.
4. Map curly quotes to straight quotes, and every dash (Unicode category Pd and the minus sign U+2212) to `-`.
5. Join `pdftotext` hyphenated line breaks, in the snapshot body only, whatever its `method`, since HTML text can carry them too.

A hyphenated line break is a body line that ends, after NFKC and any trailing spaces, in a letter or digit and a hyphen (`-`, U+2010 or a soft hyphen), where the next line starts, after any leading spaces, with a letter or digit. It is found in the body's own lines, after NFKC and with every default-ignorable character but the soft hyphen removed, and before any other step, so a hidden character next to the hyphen neither makes nor hides a break, and no space or dash the folds make can create one. `check` reads each break between two letters both ways, joined (`Spring-` and `field` on the next line read as `Springfield`) and unjoined (as `Spring-field`, the hyphen kept and the line break dropped), and an excerpt may take either form at each break. A break with a digit on either side is read unjoined only (`2014-` and `2022` on the next line read as `2014-2022`), so a range never fuses into one number; typesetting hyphenates only words, so a hyphen beside a digit is the source's own. An excerpt is one line, so it is never joined: `Spring- field` matches neither form, and neither does `2014- 2022`. `ballot-check` normalizes one line at a time and joins nothing ([ballot-format.md](ballot-format.md#ballot-check)).

The unjoined form keeps a hyphen inside the word, which the privacy scan reads as a space, so `publish` also scans each claim and excerpt with every hyphen between two letters removed (SKILL.md step 6.2). The joined form can drop a hyphen the value itself holds (`Mary-` and `Jane Lane` read as `MaryJane Lane`), so the scan also matches each value with its own hyphens removed. A private phrase split at a break is then read whole in either form.

Matching is case-sensitive, and an excerpt starts and ends on word boundaries: no letter, mark or digit of the body touches an end of the excerpt that is itself a letter, mark or digit, so `fit for office` is not found in `unfit for office`. A hyphen, the unjoined form's included, is a boundary.

## Figures

The claim text that `check` reads figures in leaves out the tag and the link, so snapshot names and contest ids (`us-house-07`, `fec-totals-2.md`) are never read as claimed figures. A claim line holds exactly one inline code span (the tag) and one link (the snapshot) whose text is `s` and a number, so no figure hides in either: link text of any other form, or claim text with a backtick, an inline or reference link (`](`, `][`), an autolink, an HTML tag, a bare URL (`https://`, `www.`), an email address or a `mailto:` link fails `claim-format`. A contest id written in the claim text itself is read as figures like any other text.

Each figure left in the claim is copied from that claim's own excerpt, not from anywhere else in the snapshot, and is never rounded or rescaled, as the Wording rules say: money and vote figures are shown raw, as the excerpt gives them. Every run of digits is a figure, years, counts and bill numbers included, with its decimal point and thousands commas (a decimal may start at its point, `.5%`), any letters or `%` written right after it (`12B`, `7th`, `5M`, `61%`), and a scale or percent word after one space or hyphen. A character that normalizing turns into a digit it does not show as one (a superscript, a fraction such as `½`, a circled number) breaks its figure, so `10⁶` never stands for 106. The scale and percent words are `thousand`, `hundred`, `million`, `billion`, `trillion` or `dozen` (or their plurals), `percent`, `per cent`, `pct`, `bn`, `mn`, `mm`, `mil`, `tn`, or a single `K`, `M` or `B`. Each figure in the claim must be one of its excerpt's figures, written the same way once both are normalized as for matching, apart from case, a space before `%`, and a hyphen or a space before the scale word. `$` is not part of a figure. "Raised $1.2 million" matches `raised $1.2 million`, but "Raised $1,200,000" does not, and "$1.22 million" does not match `receipts: 1220000.55`: write the figure as the excerpt does. So "$1 million" never stands for 500,000, and "$5 B" never stands for a bare 5. A scale word not on the list above is not part of the figure, so only its number is matched. A scale or percent word written with no digits before it (`thousand`, `hundred`, `million`, `billion`, `trillion`, `dozen`, their plurals, `percent` or `per cent`) is a figure too, together with the number words right before it (`a`, `an`, `half`, `quarter`, `few`, `several`, and one to ninety-nine written out, joined by spaces, hyphens or `and`): "two million", "half a million", "twenty-five thousand", "thousands". The excerpt must hold the same phrase, so "two million" never stands for 500,000, and a quote such as "thousands of jobs" passes when the excerpt says it. Number words with no scale word (`two terms`) are not figures.

## Command line

```text
check <election>/<ballot-id> [<contest>]...
```

`check` checks `articles/<contest>.md` for each contest given (once, if it is given twice), or every article under `articles/` when none is, and every file under `sources/` against `snapshots.sha256` ([snapshot-format.md](snapshot-format.md#manifest)). Once its arguments parse, it checks Rule 8 and finishes any interrupted save (snapshot-format.md, Manifest), then holds the ballot lock while it reads the manifest, the snapshots and the articles, so a save running at the same time is never half seen. Like every script, it prints only `location code [key]` lines (Rule 5), reports every failure it finds rather than the first, and exits non-zero on any. Locations are relative to the ballot directory: a claim's failure is located by its claim line (`articles/us-house-07.md:12`), a `snapshot-hash` failure by the snapshot's path or by the manifest line (`snapshots.sha256:3`). A path under `sources/` with a part `fetch-snapshot` could not have named (a directory that is not an id, `_race` or `_ballot`, a file whose name is not an id followed by .md) is located by the parts before it and `-` (`sources/us-house-07/-`), since a planted file can be named after private text; so is a link target in a failure line, which is never printed. A pass prints `snapshots.sha256 checked`, then `articles/<contest>.md checked` for each article.

It checks, for every claim (Claim lines):

- the claim line has its tag and its link, with link text `s` and a number, and the next line is its excerpt; any other line of the article that is not a heading, a section state or blank fails too (`claim-format`);
- the link resolves, relative to the article, to an existing snapshot file under the article's own contest (`sources/<contest>/`) or under `sources/_ballot/`, whose every part `fetch-snapshot` could have named (`claim-format`), so a claim never cites another contest's snapshot, which no review rule reads as misfiled; a claim whose link does not resolve still gets every check below that does not need its snapshot;
- a claim citing the sample ballot (the `link:` line of `ballot-view.md`) quotes one whole span of `ballot-view.md`, and a claim citing any other `role: sample_ballot` snapshot, or citing one while there is no `ballot-view.md`, fails, and so does a claim citing a `_ballot` snapshot whose front matter does not give a companion role (`candidate_list`, `pamphlet`, `write_in_list` or `withdrawal_notice`), so a sample ballot whose role cannot be read is never matched like an ordinary source (`ballot-excerpt`);
- any other excerpt is 20 to 400 characters once normalized (`excerpt-length`) and is found in its own snapshot's body (`excerpt-not-found`);
- the claim text and excerpt hold no `<!--` or `-->`, read both raw and normalized, so a fullwidth or dash-folded marker counts too (`comment-marker`);
- the tag fits the cited snapshot's front matter (source-tiers.md, Claim tags): its tier is the snapshot's `tier`, a plain tag is `T1` to `T3` on a snapshot that is not `statements_only`, and `T2i` cites a T2 snapshot that is not `statements_only`; a tag outside the table, or a snapshot whose `tier` or `statements_only` (`true` or `false`) cannot be read, fails too (`tag-mismatch`);
- a claim with an `s` tag starts with `Says:` (`says-missing`); the `says-only` rule is `coverage`'s;
- every figure in the claim text is in its own excerpt (Figures, `figure-missing`);
- neither the claim text (`title-in-claim`) nor the excerpt (`title-in-excerpt`) holds the printed `title` of a contest with a `display_title` in `ballot.yaml`, matched as `publish` matches it (SKILL.md steps 6.2 and 6.3), so a title split at a `pdftotext` break counts too, sample-ballot spans included.

Its other codes: `usage` (a contest that is not an id), `bad-ballot`, `unknown-ballot`, `file-missing` (an article for a contest given does not exist, or `ballot.yaml`, located `ballot.yaml`), `yaml-invalid` (`ballot.yaml` does not parse, located `ballot.yaml`), the Rule 8 codes `guard-no-publish-yaml`, `guard-skill-source-clone`, `guard-skill-source-remote`, `guard-remote-not-private`, `guard-not-git-repo` and `guard-not-repo-root`, `ballot-locked`, `deps-missing` and `internal-error`.

```text
coverage <election>/<ballot-id> [<contest>]...
```

`coverage` checks the shape of `articles/<contest>.md` for each contest given (once, if it is given twice), or every article under `articles/` when none is, against `ballot.yaml`, [sections.md](sections.md) and the contest's search log ([snapshot-format.md](snapshot-format.md#search-log)). Like `check`, it checks Rule 8 and finishes any interrupted save once its arguments parse, holds the ballot lock while it reads, prints only `location code` lines, reports every failure it finds and exits non-zero on any. It reads the article with `check`'s parser and leaves the claims themselves to `check`: a line `check` fails as `claim-format` is never reported here, and a claim line it fails still counts as a claim of its section and cites its snapshot. For each article it checks:

- the `#` heading is the contest id, once and before every block, and the `##` blocks are the contest's candidates in ballot order, printed ones (`on_ballot` and `withdrawn_still_printed`) first and certified write-ins after, each headed by its printed `name`; a retention contest's one block is headed by the official's `name`, and a measure's by the contest id (`block-missing`, located by the heading at fault, or by the `#` heading, or the article when there is none, for a block that is missing);
- each block's `###` sections are the ones sections.md gives it, each headed by its letter and name as there (`### B. Background`), in order and once: every section of the contest's type, or On the ballot alone for a `withdrawn_still_printed` candidate. Under Positions the `####` issues of the contest's `office_type` come in order and once, and no other section has a `####` heading. A heading, state or claim that sits in no section fails too (`section-missing`, located by the heading, state or claim at fault, or by the block's or the Positions heading for one that is missing);
- each section and each Positions issue is in exactly one state, and one it may use (Section states): On the ballot holds claims; a section the contest's `not_researched` names (every section but On the ballot, for `all`) is `Not researched yet` as a whole, and no other section is; Positions in an `office_type: judicial` contest is `Not part of this office's job` as a whole, even when `not_researched` names it or is `all`; every other section, and every issue, holds claims or `Unknown, no source found`; a Positions section with issues holds nothing outside them (`section-state`, located by the section's or the issue's heading);
- every claim in a `says-only` section, Positions issues included, has an `s` tag (`says-missing`, located by the claim line); one with an `s` tag that does not start with `Says:` is `check`'s to fail;
- each `Unknown, no source found` is backed by the search log, read for the block's subject (the candidate's or official's id, or `_race` for a measure), and every line of the log is well formed (`search-not-logged`, located by the state's line, or by the log line, as in the Search log section).

Of headings that are all expected but out of order, those at fault are the fewest that must move for the rest to be in order (a heading that jumped ahead, not every heading it passed); a missing one is located by its parent heading once for each heading missing.

After an article's failures, `coverage` lists each snapshot under `sources/<contest>/` that none of the article's claims links to, as its path and `uncited`, with a path `check` would locate by its named parts and `-` located the same way; an uncited snapshot is not a failure. A passing article prints `articles/<contest>.md passed`, never "covered", since a section `Not researched yet` never counts as covered ([page.md](page.md)). Its other codes: `usage`, `bad-ballot`, `unknown-ballot`, `unknown-contest` (a contest given, or an article's name, that `ballot.yaml` does not list, located by the article), `file-missing`, `yaml-invalid`, `ballot-invalid` (`ballot.yaml` lacks what `coverage` reads: each contest's `id`, `type`, a candidate contest's `office_type`, each candidate's `id`, `name` and `status`, a retention official's `id` and `name`, and a `not_researched` that is a list of the type's section names or `all`; located `ballot.yaml`, which `ballot-check` locates by line), the Rule 8 codes, `ballot-locked`, `deps-missing` and `internal-error`.

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
| `title-in-claim` | Claim text contains the printed title of a contest with a `display_title` |
| `title-in-excerpt` | An excerpt contains the printed title of a contest with a `display_title` |
| `comment-marker` | A claim or excerpt contains `<!--` or `-->` |
| `private-match` | Reported by `publish`: a claim or excerpt matches the privacy scan (SKILL.md step 6.3) |
| `private-source` | Reported by `publish`: a cited snapshot's `source:` name matches the privacy scan |
| `claim-format` | A claim line is malformed, or its link points at a missing snapshot or one outside its contest's `sources/<contest>/` and `sources/_ballot/` |
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
