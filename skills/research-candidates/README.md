# research-candidates

Candidate research skill for Claude Code. For each voter address it builds a ballot guide where every claim is backed by a verbatim excerpt from a saved source, then publishes one static, phone-friendly page per ballot.

See [SKILL.md](SKILL.md) for the full spec. **Status: mostly built**: every script in SKILL.md's script table runs, and so do the discovery, compile and neutrality agents ([Agents](#agents)). SKILL.md's status lists what is not built yet, among them `fetch-snapshot`'s Wayback copies (`archives.tsv`) and `supersedes` field, and `publish`'s installed-skill check.

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

Then install the data repo's Claude Code settings (next section), its agents (the one after) and the scripts' dependencies, and from inside the data repo ask Claude Code to "research my ballot" or "add an address".

## Data-repo settings

[data-repo-settings.json](data-repo-settings.json) holds what Rules 3 and 5 rely on:

- **Deny rules** for the model's file edits to `sources/`, `snapshots.sha256`, `search-log/`, `ballot.ledger` and `published.log` under any ballot, to `ballot-view.md`, which only `ballot-check` writes, and to `downloads/` and `.bindings/`, for the model's reads and edits of `addresses.yaml` and `private.yaml`, for its edits of `.claude/settings.json`, `.claude/settings.local.json` and `.gitattributes`, and for Bash calls running `fetch-snapshot --ballot`, `ballot-check --show` or `publish --show`, which print or prompt with private text and run only in the researcher's own terminal, `fetch-snapshot --keep-short`, which saves a page the short-page rule refused on the researcher's own judgment, and `publish --push` or `publish --device-check`, which push the page after the researcher's own yes.
- **A PreToolUse hook**, [scripts/session-guard](scripts/session-guard), which reads every Bash or `Monitor` command, `Read` and `Grep`, every file the model writes, every agent it starts and every message it sends one before it runs. It refuses `--ballot`, `--show`, `--keep-short`, `--push` or `--device-check` anywhere in them, even quoted apart (`--bal''lot`), and refuses a command or file that names `CLAUDECODE`, empties the environment (`env -i`) or runs a program under a pseudo-terminal (`script`, `expect`, Python's `pty`), since those get past the scripts' terminal guard. It also refuses a Bash command naming `ballot.ledger`, `snapshots.sha256`, `published.log`, `downloads/`, `.bindings/`, `.gitattributes` or `.claude/settings`, so the model cannot plant a file for `--ballot --file`, write a ledger line itself, record a slug it never published, make up a binding, or replace the setup this section describes. It refuses a Bash or `Monitor` command, file write, `Read` or `Grep` naming `addresses.yaml` or `private.yaml`, and a `Grep` from the root, an election or a ballot directory or above the root, which would read them unnamed. It refuses a recursive shell search (`grep -r`, `rg`, `ugrep`, `ag`, `ack`, or a `find` with `-exec` or `-ok`) anywhere in a command unless it is placed: no operand is left for the shell to settle at run time, a start exists, every start is deeper than a ballot directory, and the command runs no `cd`. It refuses every `xargs`. Claude Code leaves the `Grep` tool out of a default session on macOS, Linux and WSL, where searches run through Bash, so the shell check is the one that normally runs. It refuses to start any agent but the [Rule 7 agents](#agents), and refuses any call from another subagent, which a skill's fork or a workflow can start with no launch to check. It refuses to start one of those without a token `agent-bind` printed, to start one in a worktree or on another machine, or to start a second of one agent before the first has started; it refuses every `SendMessage`, so nothing reaches an agent after its prompt, and every Bash command that runs the `claude` CLI, which could start an agent past those checks. It prints only the tool and a code, and if it cannot run (the skill missing, bad input), the hook command exits 2 and the call is refused.
- **A SubagentStart hook**, the same script, which gives each Rule 7 agent the token of the launch that started it, so the agent's own hook can hold it to that contest.

[data-repo-gitattributes](data-repo-gitattributes) marks both private files `-diff`, so a plain `git diff`, `git log -p`, `git show` or `git grep` prints no line of either. Both stay tracked, since the private repo is their backup.

Merge the `deny` list and the two `hooks` entries into the data repo's `.claude/settings.json` (copy the file there if it has none), copy the attributes file, and commit both. Do the merge yourself: the model's changes to both files are refused, and SKILL.md step 3 hands these failures to you. Until both are in place, `ballot-check` fails with `settings-outdated` or `private-diff-shown`:

```bash
cd ~/src/github/<user>/elections
cp .claude/skills/research-candidates/data-repo-settings.json .claude/settings.json   # only when there is none yet
cp .claude/skills/research-candidates/data-repo-gitattributes .gitattributes          # merge it by hand if you have one
```

Start Claude Code at the data repo's top level: Claude Code reads a rule starting with `/` from the session's starting directory, so a session started in `<election>/` loses the `downloads/` and `addresses.yaml` rules, and the hook is found through `$CLAUDE_PROJECT_DIR`. Check the merged file again after each upgrade of the skill.

These layers stop mistakes and the plain ways around the terminal guard. They are not a wall against a session that sets out to get past them: a command that builds the flag or a file name at run time, from a variable or an encoding, still gets through, as does much else that reads `addresses.yaml` or `private.yaml` without naming them, such as a shell glob (`cat *.yaml`). [ADR 0003](../../research-candidates/docs/adrs/0003-the-model-never-sees-an-address.md#limits) lists what gets through. So `snapshots.sha256` records every snapshot's hash (Rule 3), and `ballot.ledger` shows what the researcher imported, not proof against a hostile session.

## Agents

SKILL.md Rule 7 runs three steps as separate agents, each defined in [agents/](agents/) with the tools it gets:

| Agent | Step | Tools |
| --- | --- | --- |
| `research-candidates-discovery` | 4.1-4.2 | Web search, and Bash for its fetch tool, `discovery-fetch`, only |
| `research-candidates-compile` | 4.3-4.4, 5 | Read, Glob, Grep, Write, Edit |
| `research-candidates-neutrality` | 4.5 | Read, Glob, Grep, Write |

Each definition also runs [scripts/session-guard](scripts/session-guard) with the agent's name on every call its agent makes, refusing a call that does not carry that name as its `agent_type`, and holds the agent to SKILL.md's allow lists for the one contest whose token started it: discovery's Bash to one `discovery-fetch` command with that token, compile's reads to `ballot.yaml`, `ballot-view.md`, the companions on its `read:` lines (only while its `sha256:` lines still agree with `ballot.yaml`, the sample ballot and the companion), the contest's sources and `articles/`, and its writes to the contest's article, and neutrality's to `articles/` and the contest's flags file. Both also read the skill's `references/`. A hook on an agent's calls cannot see its prompt, so the settings hook records the token of each launch it lets through and its SubagentStart hook hands it to the agent that starts; an agent with none is refused every call. Copy them into the data repo, overwriting older copies, and commit them:

```bash
cd ~/src/github/<user>/elections
mkdir -p .claude/agents
cp .claude/skills/research-candidates/agents/*.md .claude/agents/
```

Do this after each install or upgrade of the skill, and review the diff before committing. Claude Code runs the agents' hooks only once the data repo's folder is trusted, as it does the settings hook. `agent-bind` and the hooks keep the tokens and the agents started with them under `.bindings/` at the data repo's top level; they are not research data, so add `.bindings/` to the data repo's `.gitignore`.

## Dependencies

The scripts need Node.js 20.19 or later, poppler's `pdftotext` on `PATH` for PDF sample ballots (`brew install poppler`, or `apt install poppler-utils`), and four npm packages, pinned to exact versions in [package.json](package.json) and [package-lock.json](package-lock.json): Readability and linkedom, which reduce an HTML page to readable text, yaml, which reads the data files and writes snapshot front matter, and entities, which decodes HTML entities for the privacy checks as browsers do. Install them from the data repo after each install or upgrade of the skill:

```bash
node .claude/skills/research-candidates/scripts/install-deps
```

This runs `npm ci --ignore-scripts` from the skill's lockfile, which checks every package against the lockfile's integrity hashes and runs no package install scripts, into `~/.cache/research-candidates/<lockfile hash>/` (`$XDG_CACHE_HOME` if set; `RESEARCH_CANDIDATES_DEPS` names another directory). Nothing is written under the installed skill, because publish refuses any file there that the pinned commit's tree lacks. Never run `npm install` inside `.claude/skills/research-candidates`. It prints `- deps-installed`, or `- npm-ci-failed` with npm's own messages on stderr. A new lockfile gets a new cache directory, so an upgrade never runs against the old packages; when a script reports `scripts/install-deps deps-missing`, run the command above.

## Publishing

Pages go to a third repo: a separate **public** repo used only for pages, with its own history and nothing from the data repo. They are served at `https://<user>.github.io/<repo>/<slug>/`, one folder per ballot, and the data repo's `publish.yaml` names that repo and its local clone.

The slug is 6 random lowercase letters and digits. It stops people from guessing the URL of a ballot they don't already know. It does not hide anything: the repo is public, so anyone can list every slug folder and read each page's source on github.com, and `noindex` covers only the `github.io` URL. A page must carry only public facts, never addresses, precincts, or the researcher's opinions. Because the history is public, a page that is changed or removed is still readable in old commits.
