---
name: research-candidates
description: "Objective, cited candidate research for a US election ballot, published as a phone-friendly page. Use when adding a voter address, finding or confirming the ballot for an address, researching the candidates or measures in a contest, reviewing flagged claims, or publishing a ballot guide. Triggers: 'research candidates', 'research my ballot', 'add an address', 'who is on my ballot', 'review the race', 'publish the ballot guide'."
---

# Research Candidates

Builds a ballot guide for each voter address: every contest on the official ballot, every candidate at equal depth, every claim backed by a verbatim excerpt from a saved source. After the researcher reviews a short list of flagged items, the guide is published as one static page per ballot.

**Status: scaffold.** The scripts this spec names (`fetch-snapshot`, `check`, `coverage`, `publish`) are not built yet. Until a script exists, say so and stop instead of improvising its job by hand.

All paths below are relative to the project root (the private data repo this skill is installed in).

## Rules that never bend

1. **The model is a compiler, never a source.** Every claim comes from a saved snapshot, and every claim carries an excerpt found verbatim in that snapshot. Never write a fact from memory, including who is running.
2. **The candidate list comes from the official sample ballot.** District lookups and third-party guides help find it; they never replace it.
3. **Snapshots are write-once.** Never edit a file under `sources/`. A re-fetch writes a new file.
4. **Facts only on the page.** The researcher's own opinions, scores and notes never reach a published page.
5. **Private data stays private.** Addresses, ballot ids and precincts never appear in a page, a URL, a commit message, or any public repo. Only the random slug and the page itself are public.
6. **Publishing asks first.** A push makes the page public. Show what will change and get an explicit yes every time.

## Layout

```text
<project root>/
  addresses.yaml                        # address -> ballot id (private)
  <election>/                           # e.g. 2026-general
    <ballot-id>/                        # e.g. <state>-<county>-<precinct>
      ballot.yaml                       # contests + candidates, publish slug
      sources/_ballot/                  # official sample ballot, candidate list, voter pamphlet
      sources/<contest>/_race/          # debates, multi-candidate articles, measure texts
      sources/<contest>/<candidate>/    # candidate-specific sources
      review/<contest>.md               # review list per contest
      articles/<contest>.md             # compiled article per contest
      site/index.html                   # last generated page
```

Each ballot compiles its own contests. Nothing is shared across ballots.

## Workflow

### 1. Add an address

Trigger: "add an address", "research my ballot" with an address.

Record the address in `addresses.yaml` with a short label (for example, whose address it is) and leave `ballot` empty until step 2. Never echo the full address back into any other file.

### 2. Find the ballot

Look up the address's districts to identify the county and the contests to expect (the US Census Geocoder returns congressional and state legislative districts). Then point the researcher to the county's official sample ballot and save it, plus the county's official candidate list if one exists, under `sources/_ballot/`. Choose a `<ballot-id>` and write it into `addresses.yaml`.

### 3. Confirm the ballot

The researcher types every contest and candidate into `ballot.yaml` from the saved sample ballot (format: [references/ballot-format.md](references/ballot-format.md)), including the counts they make by eye. Assign the ballot's publish slug now: 6 random lowercase letters and digits, generated with a cryptographic random source, never invented by the model.

### 4. Research a contest

Trigger: "research `<contest>`". Work top of ballot first.

1. Discover sources with web search using the fixed checklist in [references/source-tiers.md](references/source-tiers.md). Do not ask the researcher to hunt for URLs.
2. Save each one with `scripts/fetch-snapshot` (planned). Unfetchable pages are logged, never paraphrased from search snippets.
3. Compile `articles/<contest>.md` in the format in [references/article-format.md](references/article-format.md), from snapshots only.
4. Run `check` and `coverage` (planned) and fix every failure.
5. Run the neutrality pass and write `review/<contest>.md` (see [references/review-list.md](references/review-list.md)).

### 5. Review

The researcher clears `review/<contest>.md`, marking each item `[x]` or editing the claim. A contest is `ready` only when `check` and `coverage` pass and the review list has no unchecked items.

### 6. Publish

Trigger: "publish the ballot guide", "publish `<ballot-id>`".

1. Refuse unless every contest shown with content is `ready`. Contests that are not ready appear as "Not yet covered", never blank or partial.
2. Render `site/index.html`: one self-contained file, inline CSS, receipts as `<details>` elements, no external requests, `<meta name="robots" content="noindex, nofollow">`.
3. Copy only that file to `<slug>/index.html` in the Pages worktree. Show the diff and ask before committing and pushing.
4. Give the researcher the page URL to text to the family members on that ballot.

## The page

- **Ballot screen:** contests in ballot order, each with its state and an "N of N candidates on the official ballot covered" banner.
- **Race screen:** candidates side by side in ballot order, one row per section, a tier badge on every cell, a "Says:" label on candidate-statement claims, and the excerpt shown under each claim by default. Tapping opens the receipt: source name, fetch date, link.
- "Unknown, no source found" and "Not part of this office's job" look different, and a "How to read this" note explains both.
- No party colors and no photos.
