# Review list

One file per contest, at `<ballot-id>/review/<contest>.md`, written by `review-list`. The researcher reviews these items, not every claim.

## What goes on it

Only these items, each as a checkbox with the claim, its excerpt, its source and its key:

- claims about third-party actions or quotes, meaning the snapshot's `subject` is not the candidate (or retention official) the claim sits under (misattribution risk). Measure claims are exempt: their sources are all `_race`;
- every claim in a section marked `always reviewed` in [sections.md](sections.md) (controversies, discipline), with its status: allegation, investigation, finding, judgment, or conviction;
- every `T2i` claim;
- every entry in `unfetchable.md` for the contest;
- every claim whose key is new since the previous `review-list` run (an edited or added claim);
- every claim the neutrality pass flags.

All but the last are mechanical, and `review-list` adds them itself, so completeness does not rest on the compile step. On the first run for a contest there is no previous run, so no claim counts as new.

## Item keys

```text
- [ ] <claim text> `T2i` [s3](../sources/...) <!-- id:9f2c41ab -->
  > <excerpt>
```

The key is a short hash of the candidate id, the section heading text as written in [sections.md](sections.md), the claim text, the excerpt and the snapshot path. For an unfetchable entry it is a hash of the URL and subject. Two candidates with the same claim text get different keys, and swapping only the excerpt or the source changes the key.

The review file ends with a `<!-- seen: ... -->` comment listing the key of every claim in the article at that run. The next run compares against it to find new keys.

## Neutrality pass

After compile, a separate agent with no compile context reads each claim next to its excerpt. It flags any claim whose wording adds, drops or strengthens anything relative to the excerpt: loaded verbs, characterizations, missing qualifiers, a vote described as a stance, or an interpreting T2 claim not marked `T2i`. This is still model judgment; the backstop is that the page shows every excerpt.

The pass writes its flags to `review/<contest>.neutrality.md`, one line per flagged claim (`- <key> | <reason>`), and `review-list` merges them. On every later run, the pass reads only the claims with new keys, so an edited claim is checked again.

## Clearing it

- To accept an item, mark it `[x]`.
- To change a claim, edit the article, not the review list. Then rerun `check`, the neutrality pass and `review-list`. The edited claim gets a new key and comes back as an unchecked item, and the old item is dropped. A single `[x]` then clears it.

On every run, `review-list` keeps a mark only when an item with the same key still exists. A contest is `ready` when `check` and `coverage` pass and no box is unchecked. `publish` recomputes this itself rather than trusting the file (SKILL.md step 6).
