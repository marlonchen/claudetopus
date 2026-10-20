# research-candidates

Candidate research skill for Claude Code. For each voter address it builds a ballot guide where every claim is backed by a verbatim excerpt from a saved source, then publishes one static, phone-friendly page per ballot.

See [SKILL.md](SKILL.md) for the full spec. **Status: scaffold** — the spec and reference formats are in place; none of the scripts in SKILL.md's script table are built yet, and the fonts directory [page.md](references/page.md) embeds from is not bundled yet.

This directory is the skill's *source*. The research data it works on (addresses, ballots, snapshots, review lists, articles) belongs in a separate **private** repo and must never be committed here: this repo is public.

## Install

Symlink the skill into the private data repo, so changes here take effect there immediately:

```bash
mkdir -p ~/elections/.claude/skills
ln -sfn ~/src/github/marlonchen/claudetopus/skills/research-candidates ~/elections/.claude/skills/research-candidates
```

Then, from inside the data repo, ask Claude Code to "research my ballot" or "add an address".

## Publishing

Pages go to a third repo: a separate **public** repo used only for pages, with its own history and nothing from the data repo. They are served at `https://<user>.github.io/<repo>/<slug>/`, one folder per ballot, and the data repo's `publish.yaml` names that repo and its local clone.

The slug is 6 random lowercase letters and digits. It stops people from guessing the URL of a ballot they don't already know. It does not hide anything: the repo is public, so anyone can list every slug folder and read each page's source on github.com, and `noindex` covers only the `github.io` URL. A page must carry only public facts, never addresses, precincts, or the researcher's opinions. Because the history is public, a page that is changed or removed is still readable in old commits.
