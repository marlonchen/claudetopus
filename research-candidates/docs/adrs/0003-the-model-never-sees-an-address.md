---
status: accepted
---

# The model never sees an address

The model reads untrusted web text, so an address it holds could be repeated in a search, a commit or a page. An address it never held cannot be. The model therefore never asks for an address, looks one up, or reads or writes `addresses.yaml` (Rule 5, owner decision 2026-10-23). The researcher types each address into that file under a label, and the model works with the label only. If the researcher pastes an address into the conversation anyway, the model does not repeat or store it, and asks them to move it to the file.

`addresses.yaml` still exists because the privacy checks need the values to match against. Scripts read it only to refuse or to scan.

## Enforcement

- **The three Rule 7 agents** are held by `session-guard` to allow lists that exclude `addresses.yaml` and `private.yaml` ([ADR 0008](0008-agents-run-isolated-and-bound-to-one-contest.md)).
- **The main session** is held by [`session-guard.js`](../../../skills/research-candidates/scripts/lib/session-guard.js), which refuses with `private-file-denied` any Bash or `Monitor` command, file write, `Read` or `Grep` naming either file, in any case, and quoted apart too. A file the model writes is read as well, since it could be a script to run later.
- **A search that names neither** is refused when it starts from the root, an election directory, a ballot directory or above the root, since those hold the files. That covers the `Grep` tool and a recursive shell search: `grep -r`, `rg`, `ugrep`, `ag`, `ack`, and a `find` that hands what it finds to a command. A search must start deeper, such as `<ballot>/articles`. On macOS, Linux and WSL a default session has no `Grep` tool and searches through Bash, so the shell check is the one that normally runs.
- **Git's output.** [`data-repo-gitattributes`](../../../skills/research-candidates/data-repo-gitattributes) marks both files `-diff`, so `git diff`, `git log -p`, `git show` and `git grep` print no line of either.
- **Other agents** are refused at launch with `agent-type-denied`. A skill's fork or a workflow starts a subagent with no launch to check, so the settings hook refuses it with the same code at its first hooked call.
- **Settings.** [`data-repo-settings.json`](../../../skills/research-candidates/data-repo-settings.json) adds `Read` and `Edit` denies for both files, and its hook matcher sees `Monitor`, `Read` and `Grep`.
- **Setup.** `ballot-check` fails with `settings-outdated` or `private-diff-shown` until the data repo holds both files' current rules, since upgrading the skill changes neither.

Scripts are unaffected, because they read these files as child processes and no command needs to name them.

## Considered Options

- **Look addresses up with a script.** Rejected on 2026-10-23. `fetch-snapshot --geocode` and its Census Geocoder call were removed ([ADR 0004](0004-addresses-leave-only-through-the-researcher.md)).
- **Harden the file.** Rejected: a sandbox read deny on `addresses.yaml` would also stop the scripts that must read it, since they run under the same Bash call.
- **Gitignore both files.** Rejected: the private repo is their only backup, and committed versions would stay in its history.
- **Drop the file.** Still open in TODOS.md: the researcher lists any street or ZIP printed on the ballot under `private_strings`. This removes the file to protect, but loses the checks against an address the ballot does not print.

## Consequences

- This stops mistakes, not a hostile session ([ADR 0007](0007-researcher-only-modes-need-their-own-terminal.md)). Bash matching reads the command's text, so a shell glob (`cat *.yaml`), `git diff --text`, a search tool the hook does not list or a name built at run time reads the files without naming them. The hook resolves no symlink to either file, though the settings' `Read` deny applies to a link's target.
- The data repo cannot use any other agent type, Explore included, and a skill's fork stops at its first hooked call. A subagent that calls only tools outside the matcher, such as `WebSearch` or `Glob`, is never refused.
- The model cannot merge the settings or attributes itself, because the hook refuses an edit whose text names either file. The researcher merges them.
- A pasted address stays in the session's transcript even when the model never repeats it.
