# research-candidates

Candidate research skill for Claude Code. For each voter address it builds a ballot guide where every claim is backed by a verbatim excerpt from a saved source, then publishes one static, phone-friendly page per ballot.

See [SKILL.md](SKILL.md) for the full spec. **Status: scaffold** — the spec and reference formats are in place. Of the scripts in SKILL.md's script table, only `fetch-snapshot`'s plain fetch of an HTML page, with its Rule 7 privacy refusals, its `--ballot` import and its `--searched` search log are built, and so are `ballot-check`'s core and privacy rules (without its companion and supersedes rules), `check`, `coverage` and `review-list`; `fetch-snapshot`'s Wayback copies (`archives.tsv`), the other scripts and the fonts directory [page.md](references/page.md) embeds from are not.

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

Then install the data repo's Claude Code settings (next section) and the scripts' dependencies (the one after), and from inside the data repo ask Claude Code to "research my ballot" or "add an address".

## Data-repo settings

[data-repo-settings.json](data-repo-settings.json) holds what Rules 3 and 5 rely on:

- **Deny rules** for the model's file edits to `sources/`, `snapshots.sha256`, `search-log/` and `ballot.ledger` under any ballot and to `downloads/`, and for Bash calls running `fetch-snapshot --ballot`, `ballot-check --show` or `publish --show`, which print or prompt with private text and run only in the researcher's own terminal, and `fetch-snapshot --keep-short`, which saves a page the short-page rule refused on the researcher's own judgment.
- **A PreToolUse hook**, [scripts/session-guard](scripts/session-guard), which reads every Bash command and every file the model writes before it runs. It refuses `--ballot`, `--show` or `--keep-short` anywhere in them, even quoted apart (`--bal''lot`), and refuses a command or file that names `CLAUDECODE`, empties the environment (`env -i`) or runs a program under a pseudo-terminal (`script`, `expect`, Python's `pty`), since those get past the scripts' terminal guard. It also refuses a Bash command naming `ballot.ledger`, `snapshots.sha256` or `downloads/`, so the model cannot plant a file for `--ballot --file` or write a ledger line itself. It prints only the tool and a code, and if it cannot run (the skill missing, bad input), the hook command exits 2 and the call is refused.

Merge the `deny` list and the `hooks` entry into the data repo's `.claude/settings.json` (copy the file there if it has none) and commit it:

```bash
cd ~/src/github/<user>/elections
cp .claude/skills/research-candidates/data-repo-settings.json .claude/settings.json   # only when there is none yet
```

Start Claude Code at the data repo's top level: Claude Code reads a rule starting with `/` from the session's starting directory, so a session started in `<election>/` loses the `downloads/` rule, and the hook is found through `$CLAUDE_PROJECT_DIR`. Check the merged file again after each upgrade of the skill.

These layers stop mistakes and the plain ways around the terminal guard. They are not a wall against a session that sets out to get past them: a command that builds the flag or a file name at run time, from a variable or an encoding, still gets through, so `snapshots.sha256` records every snapshot's hash (Rule 3), and `ballot.ledger` shows what the researcher imported, not proof against a hostile session.

## Dependencies

The scripts need Node.js 20.19 or later, poppler's `pdftotext` on `PATH` for PDF sample ballots (`brew install poppler`, or `apt install poppler-utils`), and four npm packages, pinned to exact versions in [package.json](package.json) and [package-lock.json](package-lock.json): Readability and linkedom, which reduce an HTML page to readable text, yaml, which reads the data files and writes snapshot front matter, and entities, which decodes HTML entities for the privacy checks as browsers do. Install them from the data repo after each install or upgrade of the skill:

```bash
node .claude/skills/research-candidates/scripts/install-deps
```

This runs `npm ci --ignore-scripts` from the skill's lockfile, which checks every package against the lockfile's integrity hashes and runs no package install scripts, into `~/.cache/research-candidates/<lockfile hash>/` (`$XDG_CACHE_HOME` if set; `RESEARCH_CANDIDATES_DEPS` names another directory). Nothing is written under the installed skill, because publish refuses any file there that the pinned commit's tree lacks. Never run `npm install` inside `.claude/skills/research-candidates`. It prints `- deps-installed`, or `- npm-ci-failed` with npm's own messages on stderr. A new lockfile gets a new cache directory, so an upgrade never runs against the old packages; when a script reports `scripts/install-deps deps-missing`, run the command above.

## Publishing

Pages go to a third repo: a separate **public** repo used only for pages, with its own history and nothing from the data repo. They are served at `https://<user>.github.io/<repo>/<slug>/`, one folder per ballot, and the data repo's `publish.yaml` names that repo and its local clone.

The slug is 6 random lowercase letters and digits. It stops people from guessing the URL of a ballot they don't already know. It does not hide anything: the repo is public, so anyone can list every slug folder and read each page's source on github.com, and `noindex` covers only the `github.io` URL. A page must carry only public facts, never addresses, precincts, or the researcher's opinions. Because the history is public, a page that is changed or removed is still readable in old commits.
