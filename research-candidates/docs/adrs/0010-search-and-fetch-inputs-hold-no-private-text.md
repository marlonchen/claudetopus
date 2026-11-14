---
status: accepted
---

# Search and fetch inputs hold no private text

Web searches and fetched URLs leave the machine, so they are the likeliest place for a private value to escape without anyone noticing. Rather than filter every query, we control what reaches the discovery agent: it can only search with text that already passed a privacy check. Any URL about to be requested is matched as well.

## Enforcement

**Before searching.** `agent-bind` and `--brief` each run `ballot-check` first, and SKILL.md forbids starting discovery until it passes. [`ballot-privacy.js`](../../../skills/research-candidates/scripts/lib/ballot-privacy.js) fails:

- any private string in `ballot.yaml` (the address, label and ZIP classes were removed, and a ZIP is a private string: [ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)), read both as text and as YAML parses each value, so a quoted escape cannot hide one;
- a hidden printed title in a contest's `id`, `jurisdiction` or `search_terms`;
- any private value of any ballot in a `tiers.yaml` `match` or `source`, since discovery sees every host and a `source` name can reach the page. `fetch-snapshot` repeats this each time it loads the file.

`--brief` gives the agent only the contest id, type, office type, `jurisdiction`, a measure's `search_terms`, the checklist items, candidate ids and names, and the `tiers.yaml` hosts.

**Before fetching.** [`fetch-snapshot`](../../../skills/research-candidates/scripts/lib/fetch-snapshot.js) refuses a URL holding a ballot id, private string (a ZIP among them, [ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)) or key value. It matches the URL as given before it reads `tiers.yaml`. [`fetch-page.js`](../../../skills/research-candidates/scripts/lib/fetch-page.js) then matches each redirect's `Location` in every spelling (as sent, as UTF-8, parsed, and with a Unicode host), before that hop is tier-matched, requested or logged.

Privacy refusals are never written to `unfetchable.md`, since the URL is the private text.

## Consequences

- Query text itself is not machine-checked. The agent's rule to build queries only from its brief and the checklist is an instruction. It holds because the agent has no private value to put in a query, not because a query is inspected.
- The rule never to fetch a URL built from a page's text is also an instruction. The URL refusals and the tier check are what stop a bad one.
- A search discloses the contest's jurisdiction to the search engine. That is accepted, since the contest list is public on the page anyway.
- A privacy refusal during discovery reaches no one: it is not logged, the agent replies only `done`, and `review-list` has no privacy output. SKILL.md's statement that every other unsaved source reaches the researcher does not hold for these. TODOS.md tracks this as open.
- `fetch-snapshot`'s own `source:` name refusal is not built. The `tiers.yaml` check and the publish scan cover names for now.
- Wayback copies send a URL to a third party, and a capture is public and cannot be withdrawn: `fetch-snapshot --archive` sends one only for a snapshot cited by a contest the page shows (ready, and not dropped by `publish`'s step 6.2 scan), only for a non-`_ballot`, non-API snapshot with no query string and no `public_url`, only from bytes that still match its `snapshots.sha256` line as it stood when the run began, and only after the URL passes the match `publish`'s page scan makes, with the same values and classes: every ballot's id and `private_strings`, key values, and the printed title of a contest whose `display_title` hides it. A URL saved before a `private_strings` entry was listed is caught then. Private text the list does not name is not: a URL holding a street name, or a short digit run alone in a path (`/p/12/`), which the match never searches for on its own, is still sent. Since only what the page cites is sent, that exposure equals the page's own original-page links; it comes a little earlier, since the batch runs after `publish`'s local render and before the researcher's yes to push.
