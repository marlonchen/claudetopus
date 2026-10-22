# research-candidates

Candidate research skill for Claude Code. For each voter address it builds a ballot guide where every claim is backed by a verbatim excerpt from a saved source, then publishes one static, phone-friendly page per ballot.

See [SKILL.md](SKILL.md) for the full spec. **Status: scaffold** — the spec and reference formats are in place; none of the scripts in SKILL.md's script table are built yet, and the fonts directory [page.md](references/page.md) embeds from is not bundled yet.

This directory is the skill's *source*. The research data it works on (addresses, ballots, snapshots, review lists, articles) belongs in a separate **private** repo and must never be committed here: this repo is public.

## Repos

| Repo | Visibility | Holds |
| --- | --- | --- |
| `claudetopus` (this repo) | Public | The skill: rules, references, page spec, scripts, tests. No research data. |
| `elections` | Private | The installed skill (`.claude/skills/research-candidates`) and all research data. Ballot ids there name the state and county (`xx-exampleton-1`), never a precinct. |
| `ballots` | Public | Published pages only, served by GitHub Pages at `https://<user>.github.io/ballots/<slug>/`. A ballot appears there only as its random slug. |

This repo does not host ballot pages: GitHub Pages is off for it and it has no `gh-pages` branch.

## Install

Install into the private data repo, at project scope:

```bash
cd ~/src/github/<user>/elections
gh skill install marlonchen/claudetopus research-candidates --agent claude-code --pin <commit>
```

Pin a commit of this repo you have read that is on its default branch (`main`; publish refuses a commit only on another branch or a fork), record it as `skill_commit` in `publish.yaml` (publish refuses an installed copy that differs from it), and review the installed files before committing them to the data repo: the skill's rules are its privacy boundary. Do not install it with `npx skills`, which runs whatever version of that package is newest inside the repo that holds the addresses, and never update it with `gh skill update --all`. To upgrade, read the diff, delete `.claude/skills/research-candidates` so files the new commit removed do not linger, run the install again with the new commit, then set `skill_commit` in `publish.yaml` to it and commit both.

Never install it at user scope (`--scope user`): Rule 8 lets it run only in the private data repo, so everywhere else it would only load and refuse. To try local changes before they are pushed, see [Install a skill](../../README.md#install-a-skill), and never run `--from-local` into the real data repo: use a throwaway private repo with made-up addresses, so unreviewed code never runs next to real ones.

Then, from inside the data repo, ask Claude Code to "research my ballot" or "add an address".

## Publishing

Pages go to a third repo: a separate **public** repo used only for pages, with its own history and nothing from the data repo. They are served at `https://<user>.github.io/<repo>/<slug>/`, one folder per ballot, and the data repo's `publish.yaml` names that repo and its local clone.

The slug is 6 random lowercase letters and digits. It stops people from guessing the URL of a ballot they don't already know. It does not hide anything: the repo is public, so anyone can list every slug folder and read each page's source on github.com, and `noindex` covers only the `github.io` URL. A page must carry only public facts, never addresses, precincts, or the researcher's opinions. Because the history is public, a page that is changed or removed is still readable in old commits.
