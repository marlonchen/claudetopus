# Review list

One file per contest, at `<ballot-id>/review/<contest>.md`, written by `review-list`. The researcher reviews these items, not every claim.

## What goes on it

Only these items, each as a checkbox with the claim, its excerpt, its source and its key:

- claims about third-party actions or quotes, meaning the snapshot's `subject` is not the candidate the claim sits under (misattribution risk);
- every claim in section F (controversies and cases) or retention section D (discipline), with its status: allegation, investigation, finding, judgment, or conviction;
- every `T2i` claim;
- every entry in `unfetchable.md` for the contest;
- every claim the neutrality pass flags.

The first four are mechanical, and `review-list` adds them itself, so completeness does not rest on the compile step. The neutrality pass adds the fifth.

## Item keys

```text
- [ ] <claim text> `T2i` [s3](../sources/...) <!-- id:9f2c41ab -->
  > <excerpt>
```

The key is a short hash of the candidate id, section, claim text, excerpt and snapshot path together. For an unfetchable entry it is a hash of the URL and subject. Two candidates with the same claim text get different keys, and swapping only the excerpt or the source changes the key.

## Neutrality pass

After compile, a separate agent with no compile context reads each claim next to its excerpt. It flags any claim whose wording adds, drops or strengthens anything relative to the excerpt: loaded verbs, characterizations, missing qualifiers, a vote described as a stance, or an interpreting T2 claim not marked `T2i`. This is still model judgment; the backstop is that the page shows every excerpt.

## Clearing it

- To accept an item, mark it `[x]`.
- To change a claim, edit the article, not the review list, then rerun `check` and `review-list`. The edited claim gets a new key and comes back as an unchecked item, and the old item is dropped. A single `[x]` then clears it.

On every run, `review-list` keeps a mark only when an item with the same key still exists. A contest is `ready` when `check` and `coverage` pass and no box is unchecked.
