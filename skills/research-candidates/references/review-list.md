# Review list

One file per contest, at `<ballot-id>/review/<contest>.md`, written by the compile step. The researcher reviews these items, not every claim.

## What goes on it

Only these items, each as an unchecked checkbox with the claim, its excerpt and its source:

- claims about third-party actions or quotes, where the actor is not the snapshot's subject (misattribution risk);
- every controversy, allegation, investigation or case, with its status: allegation, investigation, finding, judgment, or conviction;
- every Tier 2 claim that interprets rather than reports;
- every source logged as unfetchable;
- every claim the neutrality pass flags.

The review-list script checks that every unfetchable log entry and every flagged-tier claim for the contest appears on the list, so completeness does not rest on the compile step alone.

## Neutrality pass

After compile, a separate agent with no compile context reads each claim next to its excerpt. It flags any claim whose wording adds, drops or strengthens anything relative to the excerpt: loaded verbs, characterizations, missing qualifiers, a vote described as a stance. This is still model judgment; the backstop is that the page shows every excerpt.

## Clearing it

The researcher marks an item `[x]` to accept it, or edits the claim. Items are keyed by a hash of the claim text: recompiling keeps the mark only for unchanged claims and reopens changed ones. A contest is `ready` when `check` and `coverage` pass and no box is unchecked.
