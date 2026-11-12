---
status: accepted
---

# An address leaves the machine only through the researcher

Finding a ballot means telling some official site an address, so that disclosure cannot be removed, only controlled. No script looks up an address. An address leaves the machine in only two ways: the researcher's own browser on an official lookup, or a `--ballot` URL they run and confirm at their terminal (Rule 5, step 2). The model's part is to hand over links, and those links never hold an address, a label or any other private value.

## Enforcement

- [`ballot-import.js`](../../../skills/research-candidates/scripts/lib/ballot-import.js) is the only path. It requires a terminal and a typed `y` or `yes` after showing the URL and role.
- The host must be `T1` in `tiers.yaml` on every redirect hop, so the address goes only to a county or state site the researcher chose to trust.
- The query string may hold the address, so it is not checked for one, but it is dropped along with the fragment before anything is recorded. An API key value is refused anywhere in the URL.
- A private value in the URL's path refuses with the hint `use-ballot-file`. The researcher then saves the file into `downloads/` and uses `--ballot --file`, which records only the page's origin. The full page URL is matched against `tiers.yaml` but never sent, printed or recorded.
- A `--ballot` refusal or failure, and any privacy refusal, is never written to `unfetchable.md`, since the URL is the private text.

## Considered Options

- **A script geocodes the address** (`fetch-snapshot --geocode`, using the Census Geocoder). Rejected by the owner on 2026-10-23, in favor of official lookups the researcher runs in their own browser. A script would send every address to a third party without the researcher's hand on each lookup.

## Consequences

- The researcher does the lookup by hand and tells the session only the county.
- The county or state site still sees the address, along with anything on the network path it passes through. That is the disclosure this decision accepts.
- A saved `_ballot` snapshot records its URL without the query, so the voter's lookup is not kept in the snapshot's `url` field. `ballot.ledger` records only whether a query was present, as `query`, `none` or `unknown`.
- **Amended by [ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md) (2026-11-11):** no address, street line or label is stored, so once tickets 26 to 28 land, the `--ballot` path check matches the ZIP and the other `private_strings` entries, the ballot id and key values, but no longer a street or house number. When a lookup's path shows the address, the researcher saves the page and uses `--ballot --file`, which records only the origin. The address still leaves only through the researcher.
- A sample ballot's body can still name the voter. [ADR 0009](0009-agents-read-a-filtered-view-of-the-sample-ballot.md) covers it.
