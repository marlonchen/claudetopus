---
status: accepted
---

# Ballot ids say no more than the county

Every agent sees the ballot id in the paths it works in, so an id that named a precinct or a township would hand them a locating fact. The id is therefore mechanical: `<state>-<county>-<n>`, such as `xx-exampleton-1`, built from `ballot.yaml` with a 1 or 2 digit number that tells ballots in one county apart. It holds no word the researcher chose, and says no more than the contest list already does.

Ids are still treated as private. In public, a ballot is known only by a random slug.

## Enforcement

- `ballot-check` requires the id to match `^[a-z]{2}-[a-z]+(-[a-z]+)*-[1-9][0-9]?$` and to be derived from `ballot.yaml`'s `state` and `county`, with a fixed set of folds.
- It fails an id whose number equals a digit run of any `private_strings` entry (`ballot-id-private`), so `Precinct 12` rules out `12`.
- It fails a private string in `state` or `county`, and tells the researcher to list a township's full name, not a word it shares with the county (`list-full-place-name`).
- `fetch-snapshot` refuses a URL holding an id, and the publish scan refuses a page holding any ballot's id, in all three forms, so `xx_exampleton_1` and `xx/exampleton/1` match too.
- The slug must match `^[a-z0-9]{6}$` and be unique across the data repo. It comes from `/dev/urandom`, never from a value the model makes up.

## Consequences

- Ending in a number stops the id matching ordinary page text in the scan's spaced form, where it would otherwise read as words.
- Keeping the id private while agents can see it looks inconsistent. It is deliberate: agents and scripts live inside the private repo, and the rule is about what reaches the public.
- A slug has 36^6 values, about 2.2 billion. It prevents guessing a URL, but the `ballots` repo lists every slug anyway ([ADR 0001](0001-three-repos-for-public-and-private-data.md)).
