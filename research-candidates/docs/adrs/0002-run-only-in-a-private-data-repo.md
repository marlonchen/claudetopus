---
status: accepted
---

# The scripts run only in a confirmed private repo

The skill writes addresses, sample ballots and research into whatever project it runs in, and its source repo is public, so a run in the wrong place would put private data one `git push` from the public. Every script that opens a ballot first proves the project root is the private data repo, and treats anything it cannot prove as public (Rule 8).

## Enforcement

[`repo-guard.js`](../../../skills/research-candidates/scripts/lib/repo-guard.js) runs from `openBallot` in [`fetch-common.js`](../../../skills/research-candidates/scripts/lib/fetch-common.js), which every data command calls. It requires that:

- the working directory is the git top level and holds `publish.yaml`;
- `skills/research-candidates/SKILL.md` is absent, so this is not a clone of the source repo;
- every fetch and push URL of every remote is a GitHub repo that `gh` reports as private;
- no remote's fork-network root (`.source.id // .id`) is the source repo's recorded id, `1373776339`.

A URL that is not on GitHub, a `gh` error or empty output counts as public. Failures name the remote, never its URL.

## Considered Options

- **Compare repo names.** Rejected. Ids are compared, so another letter case, a `.git` suffix, an ssh URL, a rename or a re-registered name cannot stand in for the source repo.
- **Install with `npx skills`.** Rejected, because it runs whatever version of that package is newest inside the repo that holds the addresses. The skill is installed with `gh skill install --pin <commit>` at project scope.
- **Install at user scope.** Rejected, since the skill would load everywhere and could run only in the data repo.
- **Run `npm install` inside the skill.** Rejected, because the installed skill must hold only the pinned commit's files. `install-deps` runs `npm ci --ignore-scripts` from the lockfile into a cache outside the skill, so package hashes are checked and no package install script runs.

## Consequences

- The guard runs when a script starts. It does not stop a later `git remote add`, a `git push` from another tool, or the repo being made public between runs.
- A repo with no remotes passes, because the check loops over remotes. Such a repo has nowhere to push.
- Every data command needs `gh` and network access when the repo has a remote, or it refuses.
- `publish` refuses an installed skill that differs from its tree at `skill_commit` (SKILL.md step 6.1), read through `gh api repositories/<id>/...` by the recorded id. The check runs inside `publish`, so it confirms that the installed skill directory is the one that was reviewed only against accidental drift, never against a hostile edit to `publish` itself.
- The check covers the data repo's installed copy at `.claude/skills/research-candidates`, not the copy `publish` happens to run from. A user-scope install or another clone runs unchecked code while the project copy passes.
- The agent definitions copied into `.claude/agents/` and the npm dependency cache under `~/.cache/research-candidates/` are not checked.
