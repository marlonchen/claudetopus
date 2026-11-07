---
status: accepted
---

# Facts only on the page, with tamper-evident records

The researcher's opinions are private too, and a guide for family members must not carry them. Their scores, notes and views never reach a page (Rule 4). The page shows only claims, each backed by a verbatim excerpt from a saved snapshot. Those records must also be trustworthy, so only scripts write them, and `publish` can detect a later change (Rule 3).

## Enforcement

**Facts only.** The page has no field for an opinion, because it renders claims with excerpts from articles that the compile agent writes from snapshots. `check` requires each excerpt to be found verbatim in the snapshot it links. The neutrality pass can flag a claim, but it never accepts one, and only the researcher marks a review item.

**Write limits.** `data-repo-settings.json` denies the model's `Edit` of `sources/`, `snapshots.sha256`, `search-log/`, `ballot.ledger`, `published.log`, `downloads/`, `.bindings/` and `ballot-view.md`. `session-guard` also refuses a Bash command naming `ballot.ledger`, `snapshots.sha256`, `published.log`, `downloads/` or `.bindings/`.

**Detection.** The ballot gate in [`ballot-gate.js`](../../../skills/research-candidates/scripts/lib/ballot-gate.js) requires that:

- every file under `sources/` matches its line in `snapshots.sha256`;
- `review/`, `tiers.yaml`, `snapshots.sha256`, `search-log/` and `published.log` have no uncommitted changes, including ignored files and files marked assume-unchanged or skip-worktree, so an ignore rule cannot fake "committed";
- none of those is a symlink or named in another case;
- in every commit, the append-only files keep every line of their parent, and a shallow clone refuses, because its history cannot be checked.

## Consequences

- Nothing detects an opinion in text. Rule 4 holds through the page's structure, the verbatim excerpt check and the neutrality review, not through a scanner.
- The manifest and ledger are checks against mistakes, not proof against a hostile session, which the README states. `session-guard` does not name `sources/` or `search-log/`, so a Bash write there is not refused. For `sources/`, the hash check catches it at `check` and `publish`.
- Only the researcher retires a snapshot, and only the researcher commits the data repo. The second is an instruction, since `session-guard` does not refuse `git commit` ([ADR 0014](0014-only-the-researcher-can-say-yes-to-publish.md)).
- A corrected sample ballot cannot yet be saved as a correction that `ballot-check` accepts, because `fetch-snapshot`'s `supersedes` field is not built and adding it by hand changes the snapshot's hash.
