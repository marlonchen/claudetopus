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
- **Companions.** The candidate list, pamphlet, write-in list and withdrawal notice can be read whole, so they must be county-wide or state-wide. `ballot-check` fails one whose fetch URL had a query string. It does not scan the body: a personalized companion fetched without a query is the researcher's to spot and retire ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)).
- **Staleness.** `session-guard` opens a companion only on a `read:` line of a regular-file view whose `sha256:` lines still agree with `ballot.yaml`, the sample ballot and that companion. A companion edited since its check is refused.
- **Retirement.** A companion listed under `retired_companions` leaves the `read:` lines, and it vouches for nothing.
- **Main session.** `session-guard` refuses a call naming `sources/_ballot/` or `downloads/`, and a `Grep` or recursive shell search from a `sources/` directory (`session-file-denied`). It checks only calls with no `agent_id`, so the compile agent keeps its companions, and `data-repo-settings.json` has no `Read` deny on `_ballot` for the same reason. A `Read` deny does cover `downloads/`. A command or a `Grep` path also counts `downloads` with no slash, in any case, so the researcher's own `~/Downloads` is refused too. A file the model writes counts only the slash form, since the bare word is mostly prose.
- **Git's output.** [`data-repo-gitattributes`](../../../skills/research-candidates/data-repo-gitattributes) marks `sources/_ballot/`, `downloads/` and `unfetchable.md` `-diff`, so a plain `git diff`, `git log -p`, `git show` or `git grep` prints no line of them, and `ballot-check` fails with `private-diff-shown` until it does. The ballot gate reads history with `diff-tree --raw`, which `-diff` does not change.
- **Discovery.** It never reads `ballot.yaml`, the view or `sources/_ballot/`, because a printed title can locate the voter. `--brief` prints only checked values.

## Consequences

- The researcher does more by hand: `ignored_lines`, `private_strings` and contest titles are all accounted for against the sample ballot.
- A `--file` companion's query is `unknown`, because its download URL was never seen, so it passes.
- No companion body is scanned. It used to be matched for addresses, street lines and labels only, which are no longer stored (ADR 0017); the ZIP, title, place-name and link checks are left out because county-wide documents fail them by nature. So a precinct name, or a personalized page fetched without a query, is not caught here. The publish scan still reads anything quoted from it.
- `ballot-view.md` has an `Edit` deny, but no Bash refusal in `session-guard`.
- The main-session refusal has the [limits in ADR 0003](0003-the-model-never-sees-an-address.md#limits): a glob such as `cat */*/sources/*/*` reads the sample ballot without naming it, and `git show --text` prints it.
- The researcher reads a change to these files with `git diff --text`, since a plain diff calls them binary.
- It also relies on Claude Code sending `agent_id` to the settings hook on an agent's calls. If it did not, the compile agent would be refused its companions, which fails closed.
