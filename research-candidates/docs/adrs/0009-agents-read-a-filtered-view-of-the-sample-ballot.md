---
status: accepted
---

# Agents read a filtered view of the sample ballot

A sample ballot is the authority for who is running, but it can also print precinct text, a ballot style or the voter's name. So no agent opens it. `ballot-check` writes `ballot-view.md`, holding only the matched span of each listed contest title, `Vote for` phrase, candidate entry and retention official name. The compile agent reads that view, and a claim citing the sample ballot quotes one whole span from it.

Private text also lives apart from the contest list: `private.yaml` holds it, so `ballot.yaml` can be read next to untrusted snapshots.

## Enforcement

- **What the view holds.** Only matched spans count. A two-column `pdftotext` line holding one listed and one unlisted candidate stays unaccounted for.
- **Unaccounted lines.** `ballot-check` reports them by line number, never text, and the researcher reads them with `ballot-check --show`.
- **Sample ballot.** `ballot-view.md`'s `link:` line names it only as a link target. `session-guard` refuses to open it, and refuses any `sample_ballot` snapshot, superseded or not.
- **Companions.** The candidate list, pamphlet, write-in list and withdrawal notice can be read whole, so they must be county-wide or state-wide. `ballot-check` fails one whose fetch URL had a query string, or whose body holds an address, street line or label.
- **Staleness.** `session-guard` opens a companion only on a `read:` line of a regular-file view whose `sha256:` lines still agree with `ballot.yaml`, the sample ballot and that companion. A companion edited since its check is refused.
- **Retirement.** A companion listed under `retired_companions` leaves the `read:` lines, and it vouches for nothing.
- **Discovery.** It never reads `ballot.yaml`, the view or `sources/_ballot/`, because a printed title can locate the voter. `--brief` prints only checked values.

## Consequences

- The researcher does more by hand: `ignored_lines`, `private_strings` and contest titles are all accounted for against the sample ballot.
- A `--file` companion's query is `unknown`, because its download URL was never seen, so it passes on the body check alone.
- The companion body check matches only addresses, street lines and labels. It skips the ZIP, title, place-name and link checks, which county-wide documents fail by nature, so a precinct name in a companion is not caught here. The publish scan still reads anything quoted from it.
- `ballot-view.md` has an `Edit` deny, but no Bash refusal in `session-guard`.
- The allow lists bind agents only. The main session has no hook on reading the sample ballot ([ADR 0003](0003-the-model-never-sees-an-address.md)).
