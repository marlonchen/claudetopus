---
status: accepted
---

# No address is stored; the ZIP is a private string

`addresses.yaml` could not be guarded well enough. The main session has Bash, deny rules match a call's text, and [ADR 0003](0003-the-model-never-sees-an-address.md)'s Limits list the reads that still get past the hook. A file that does not exist cannot be read. So the data repo stores no address, street line or label (owner decision 2026-11-11, ticket 22). Only the ZIP code is kept, and the researcher lists it in that ballot's `private.yaml` as its own `private_strings` entry, quoted (`- "99999"`). Addresses and street lines are not moved into `private_strings`, because they are not stored at all.

## Enforcement

- **One matcher.** A `private_strings` digit run of 4 or more digits that is not a year is already searched on its own, with the digit edge the ZIP class uses ([ADR 0005](0005-one-matcher-for-every-spelling-of-a-private-value.md), SKILL.md step 6.3). A five-digit entry is therefore refused wherever a ZIP from `addresses.yaml` is: in a fetch URL's path or query and in ZIP+4 form, in a redirect hop, in a `--ballot` path (with `use-ballot-file`), in `ballot.yaml` and `ignored_lines`, in a `tiers.yaml` `match` or `source`, and on the rendered page. It never matches inside a longer digit run, and the page's generated dates are skipped for it as they are for the ZIP class. No script change was needed. The refusal code is `private-string`, not `private-zip`.
- **Tests through the commands** pin each of those places with the ZIP held only in `private.yaml`. The fixture ballot's `private.yaml` lists its ZIP, and the golden page is unchanged.
- **The reference.** [ballot-format.md](../../../skills/research-candidates/references/ballot-format.md) tells the researcher to list each ZIP as its own entry, in quotes, with an example.
- **Rollout.** Expand, then contract: both sources work side by side first (ticket 25). Then `fetch-snapshot`, `publish` and `ballot-check` stop reading `addresses.yaml` (26, 27), the address, ZIP and label classes and the file's guards go (28), "add a ballot" replaces "add an address" in the workflow (29), and the `elections` data repo is migrated (30).

## Considered Options

- **A sandbox read deny on the file**, with the scripts that read it in `sandbox.excludedCommands` (ADR 0003). Not chosen: an excluded command runs with full access, the list matches a call's text, and `fetch-snapshot` needs a network decision, so it still needed a live test and would still guard a file holding every address.
- **Move each address and street line into `private_strings`.** Not chosen by the owner: an address that is stored still has to be guarded, in `private.yaml` instead. Keeping only the ZIP stores the one value that lookup URLs and county pages most often carry on its own.
- **Keep a ZIP class, read from `private.yaml`.** Not needed: the matcher already treats a five-digit private string as the ZIP class treats a ZIP, so a second class would only add a code.

## Consequences

What is given up, once tickets 26 to 28 stop reading `addresses.yaml`:

- **Street-only matches.** A URL, excerpt or page holding the street line or the full address is no longer refused unless it also holds the ZIP or another listed entry. A `--ballot` URL whose path shows the street now passes the path check; the researcher saves such a page with `--ballot --file` instead ([ADR 0004](0004-addresses-leave-only-through-the-researcher.md)).
- **The companion body check.** It matched only addresses, street lines and labels, since county-wide documents print ZIP codes by nature, so it has nothing left to match. A personalized companion fetched without a query is the researcher's to spot and retire (ticket 27).
- **Labels.** There is nothing to label. The session names a ballot by its ballot id ([ADR 0011](0011-ballot-ids-say-no-more-than-the-county.md)).

Other effects:

- **Scope.** `addresses.yaml` is one file for the family, so today every ballot's checks refuse every address's ZIP. `private_strings` are per ballot: `fetch-snapshot`'s URL refusals and `ballot-check`'s `ballot.yaml` and `ignored_lines` scans read this ballot's entries only, while the page scan and the `tiers.yaml` check read every ballot's. Once ticket 26 lands, another ballot's ZIP in this ballot's fetch URL is no longer refused. Ticket 26 records that as a default for the owner to confirm.
- **Quoting.** YAML reads an unquoted `02134` as the number 2134. `ballot-check` and every script that loads `private.yaml` fail `private-invalid`, so a missing quote fails closed and never drops a leading zero.
- **Reports.** A ZIP is reported as `private-string`, like any other entry, so a report no longer tells a ZIP from another entry's digit run (Rule 5 names only the class). Until ticket 28, a ZIP listed in both files reports both `private-zip` and `private-string`.
- `private.yaml` still holds private text, so its guards stay ([ADR 0003](0003-the-model-never-sees-an-address.md)).
