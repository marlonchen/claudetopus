# research-candidates

Candidate research skill for Claude Code. For each voter address it builds a ballot guide where every claim is backed by a verbatim excerpt from a saved source, then publishes one static, phone-friendly page per ballot.

See [SKILL.md](SKILL.md) for the full spec. **Status: scaffold** — the spec and reference formats are in place; the scripts (`fetch-snapshot`, `check`, `coverage`, `publish`) are not built yet.

This directory is the skill's *source*. The research data it works on (addresses, ballots, snapshots, review lists, articles) belongs in a separate **private** repo and must never be committed here: this repo is public.

## Install

Symlink the skill into the private data repo, so changes here take effect there immediately:

```bash
mkdir -p ~/elections/.claude/skills
ln -s ~/src/github/marlonchen/claudetopus/skills/research-candidates ~/elections/.claude/skills/research-candidates
```

Then, from inside the data repo, ask Claude Code to "research my ballot" or "add an address".

## Publishing

Pages are published to a GitHub Pages branch at `https://<user>.github.io/<repo>/<slug>/`, one folder per ballot. The slug is 6 random lowercase letters and digits. It keeps pages out of search and stops guessing, but anyone who browses the Pages branch on GitHub can see every slug folder, so a page must carry only public facts: never addresses, precincts, or the researcher's opinions.
