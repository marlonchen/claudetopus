# Review list

One file per contest, at `<ballot-id>/review/<contest>.md`, written by `review-list`. The researcher reviews these items, not every claim.

## What goes on it

Only these items, each as a checkbox with the claim, its excerpt, its source and its key:

- claims about third-party actions or quotes, meaning the snapshot's `subject` is not the candidate (or retention official) the claim sits under (misattribution risk). Claims citing a `_ballot` snapshot (the official ballot record) and all measure claims are exempt;
- every claim in a section marked `always reviewed` in [sections.md](sections.md) (controversies, discipline), with its status: allegation, investigation, finding, judgment, or conviction;
- every `T2i` claim;
- every claim, in any section, whose text or excerpt contains an allegation word, so a controversy compiled into the wrong section still reaches a human. Words match whole and case folded, each bare or with one of its parenthesized endings: `alleg(e|ed|es|ation|ations|edly)`, `accus(e|ed|es|ation|ations)`, `charged`, `charges`, `indict(ed|ment|ments)`, `convict(ed|ion|ions)`, `sues`, `sued`, `suing`, `lawsuit(s)`, `investigat(e|ed|ion|ions|ing)`, `arrest(ed|s)`, `sanction(ed|s)`, `disciplin(e|ed|ary)`, `settlement(s)`, `fraud(ulent)`, `felon(y|ies)`, `misconduct`, `guilty`, `plead(ed)`, `pled`, `plea(s)`, `subpoena(s|ed)`, `complaint(s)`, `probe(s)`, `censur(e|ed)`, `impeach(ed|ment)`, `resign(ed|ation)`. Bare stems such as `charg` or `settle` would also match "in charge of" or "settled in";
- every entry in `unfetchable.md` for the contest, except `domain not in tiers.yaml` refusals and entries for a URL and subject that a later snapshot saved;
- every claim whose key is not accepted yet (an edited or added claim, see below);
- every claim the neutrality pass flags.

All but the last are mechanical, and `review-list` adds them itself, so completeness does not rest on the compile step.

## Item keys

```text
- [ ] <claim text> `T2i` [s3](../sources/...) <!-- id:9f2c41ab -->
  > <excerpt>
```

The key is a short hash of the candidate id (the retention official's id, or the contest id for a measure), the section heading text as written in [sections.md](sections.md), the claim text, its tag, the excerpt and the snapshot path. For an unfetchable entry it is a hash of the URL and subject. `review-list` reads only the trailing `<!-- id:... -->` comment on an item line, and recomputes each key from the item's fields rather than trusting the comment. For a derived claim, the formula takes the place of the excerpt and the snapshot path is empty. Two candidates with the same claim text get different keys, and swapping only the excerpt, the tag or the source changes the key.

## Accepted keys

A claim key is accepted when it is in `review/<contest>.baseline` or `review/<contest>.accepted`. The first run writes the baseline once. `review-list` appends the key of each item the researcher marked `[x]` to `.accepted`, which only grows, so an accepted item can leave the list without losing its acceptance. The review file ends with an `<!-- accepted: ... -->` comment listing the set for reading; `publish` ignores the comment and recomputes the set from the two files. It refuses if either file lost a line or the baseline changed after its first data-repo commit, unless that change is a researcher's commit with the message `reset review <contest>`. The set grows two ways and nothing else:

- On the first run for a contest, every claim that is not on the list for another reason is accepted as the baseline, but only once the neutrality pass has read them: `review-list` refuses to write the baseline unless `review/<contest>.neutrality.md` exists and its `reviewed` line holds exactly the current article's claim keys. A first run means no baseline exists for the contest yet. A missing review file next to an existing baseline is rebuilt from the articles, the baseline and `.accepted`, and is never a first run. To start a contest's review over, the researcher deletes its review file, baseline and `.accepted` in one commit with the message `reset review <contest>`.
- On every run, the key of each item marked `[x]` is appended to `.accepted`.

Running `review-list` again never accepts anything by itself. A key outside the set stays on the list, unchecked, until the researcher marks it, however many times the script runs. `publish` compares the current articles against the same set.

## Neutrality pass

After compile, a separate agent with no compile context reads each claim next to its excerpt. It flags any claim whose wording adds, drops or strengthens anything relative to the excerpt: loaded verbs, characterizations, missing qualifiers, a vote described as a stance, an interpreting T2 claim not marked `T2i`, or a claim in a section it does not belong to (sections.md). This is still model judgment; the backstop is that the page shows every excerpt.

Before the pass, `review-list --keys` prints every claim's location (article path and line) and key, plus whether the key is accepted, without writing anything. The pass copies keys from that output and never computes one. It writes its flags to `review/<contest>.neutrality.md`: a first line `<!-- reviewed: <key> <key> ... -->` listing every key it read, then one line per flagged claim (`- <key> | <reason>`), and `review-list` merges them. On every later run, the pass reads only the claims whose keys are not accepted, so an edited claim is checked again.

## Clearing it

- To accept an item, mark it `[x]`.
- To change a claim, edit the article, not the review list. Then rerun SKILL.md steps 4.4-4.5 (`check` and `coverage`, `review-list --keys`, the neutrality pass, `review-list`). The edited claim gets a new key and comes back as an unchecked item, and the old item is dropped. A single `[x]` then clears it.

On every run, `review-list` keeps a mark only when an item with the same key still exists. A contest is `ready` when `check` and `coverage` pass, no box is unchecked, and every claim key in the article is accepted. `publish` recomputes this itself rather than trusting the file (SKILL.md step 6).
