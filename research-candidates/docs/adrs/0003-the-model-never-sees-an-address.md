---
status: accepted
---

# The model never sees an address

The model reads untrusted web text, so an address it holds could be repeated in a search, a commit or a page. An address it never held cannot be. The model therefore never asks for an address, looks one up, or reads or writes `addresses.yaml` (Rule 5, owner decision 2026-10-23). The researcher types each address into that file under a label, and the model works with the label only. If the researcher pastes an address into the conversation anyway, the model does not repeat or store it, and asks them to move it to the file.

`addresses.yaml` still exists because the privacy checks need the values to match against. Scripts read it only to refuse or to scan.

**Amended by [ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md) (2026-11-11):** the file is being dropped. No address, street line or label is stored. The researcher lists the voter's ZIP in that ballot's `private.yaml` as a `private_strings` entry, and the session names a ballot by its id instead of a label. The rule that the model never sees an address is unchanged. The `addresses.yaml` enforcement below stays until tickets 26 to 28 remove it, and every guard on `private.yaml` stays.

## Enforcement

- **The three Rule 7 agents** are held by `session-guard` to allow lists that exclude `addresses.yaml` and `private.yaml` ([ADR 0008](0008-agents-run-isolated-and-bound-to-one-contest.md)).
- **The main session** is held by [`session-guard.js`](../../../skills/research-candidates/scripts/lib/session-guard.js), which refuses with `private-file-denied` any Bash or `Monitor` command, file write, `Read` or `Grep` naming either file, in any case, and quoted apart too. A file the model writes is read as well, since it could be a script to run later.
- **A `Grep` that names neither** is refused when it starts from the root, an election directory, a ballot directory or above the root, since those hold the files.
- **A recursive shell search** (`grep -r`, `rg`, `ugrep`, `ag`, `ack`, or a `find` with `-exec` or `-ok`) is looked for at every word of a command, inside `bash -c` text and substitutions too, and runs only when it is placed: the shell settles none of its operands at run time, a start exists (with no operand, the working directory is the start), every start sits deeper than a ballot directory, such as `<ballot>/articles`, and the command does not change directory. Anything else is refused, so a form the hook cannot read costs a retry, not a leak. Every `xargs` is refused too. On macOS, Linux and WSL a default session has no `Grep` tool and searches through Bash, so this check is the one that normally runs.
- **Git's output.** [`data-repo-gitattributes`](../../../skills/research-candidates/data-repo-gitattributes) marks both files `-diff`, so a plain `git diff`, `git log -p`, `git show` or `git grep` prints no line of either.
- **Other agents** are refused at launch with `agent-type-denied`. A skill's fork or a workflow starts a subagent with no launch to check, so the settings hook refuses it with the same code at its first hooked call.
- **Settings.** [`data-repo-settings.json`](../../../skills/research-candidates/data-repo-settings.json) adds `Read` and `Edit` denies for both files, and its hook matcher sees `Monitor`, `Read` and `Grep`.
- **Setup.** `ballot-check` fails with `settings-outdated` or `private-diff-shown` until the data repo holds both files' current rules, since upgrading the skill changes neither. SKILL.md step 3 hands both failures to the researcher. `Edit` denies keep the file tools off `.claude/settings.json`, `.claude/settings.local.json` and `.gitattributes`, and the hook refuses a command naming either with `script-only-file`.

Scripts are unaffected, because they read these files as child processes and no command needs to name them.

## Considered Options

- **Look addresses up with a script.** Rejected on 2026-10-23. `fetch-snapshot --geocode` and its Census Geocoder call were removed ([ADR 0004](0004-addresses-leave-only-through-the-researcher.md)).
- **Harden the file.** Not chosen ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)): a sandbox read deny on both files, with the scripts that must read them listed in `sandbox.excludedCommands`. The operating system would then stop a read by any command, a glob or `git --text` included. An excluded command runs with full access, the list matches a call's text, every command in a call must match, and `fetch-snapshot` also needs a network decision, so this needs a live test first.
- **Gitignore both files.** Rejected: the private repo is their only backup, and committed versions would stay in its history.
- **Drop the file.** Chosen on 2026-11-11, narrower than first sketched ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)): the researcher lists only the ZIP under `private_strings`, and no street or address is stored. This removes the file to protect, but loses the checks against an address or street line, and `private.yaml` still needs guarding.
- **Patch each search form as it is found.** Rejected: the next unseen form would leak. Placing every search means the next one is refused instead.
- **Parse the shell with a dependency.** Rejected: it adds a dependency to a hook that runs on every call, and run-time expansion still cannot be resolved. The hook has a small quote-aware tokenizer.
- **Run the hook on every tool.** Rejected for now: scanning an unknown tool's strings would refuse an `AskUserQuestion` or `TodoWrite` that names `addresses.yaml`, which SKILL.md step 1 needs, and exempting those tools leaves the same default open. TODOS.md tracks this.

## Consequences

- The data repo cannot use any other agent type, Explore included, and a skill's fork stops at its first hooked call.
- Some correct commands are refused and take a retry. A search in a command that runs `cd` must split: `cd` in one call, then the search, since the hook's working directory follows it. A glob start (`rg Elm <ballot>/articles/*.md`) needs `-g` instead, and a word that only reads as a search tool (`echo rg`) is refused too.
- The researcher merges the settings and attributes, since the model's changes to them are refused. The check cannot tell a read from a write, so `cat .gitattributes` is refused too.
- Turning on Claude Code's sandbox today would probably stop `ballot-check` reading these files, since `Read` deny rules are merged into the sandbox's configuration. This has not been tested.
- A pasted address stays in the session's transcript even when the model never repeats it.

## Limits

This stops mistakes, not a hostile session ([ADR 0007](0007-researcher-only-modes-need-their-own-terminal.md)). The hook reads a command's text and each call's tool name, so these still get past it. This is the one list, and it covers the files [ADR 0009](0009-agents-read-a-filtered-view-of-the-sample-ballot.md) keeps from the main session too; the skill's README and the hook's header link here.

- A shell glob given to anything but a recursive search: `cat *.yaml`, `grep Elm *`.
- A working directory already inside `sources/_ballot/` or `downloads/`, since nothing a call names says so. Getting there takes a glob `cd`, which is the case above.
- A name built at run time, from a variable or an encoding.
- A file list in a shell loop or substitution: `find . -type f | while read f; do cat "$f"; done`, `cat $(find . -type f)`.
- Git told to print binary files, or writing them out: `git diff --text`, `git log -p --text`, `git show --text`, `git grep -a`, `git archive HEAD | tar -xO`.
- A search tool the hook does not list, or a script that searches or changes directory for its caller.
- A search flag the hook does not list, whose value reads as a start.
- A symlink to either file, which the hook does not resolve, though the settings' `Read` deny applies to a link's target.
- A tool outside the hook's matcher. MCP file tools, `LSP` and `Artifact` can take a path, and whether the `Read` denies stop them has not been tested. `ballot-check` passes all the same, since it compares against the same list.
- A subagent that calls only tools outside the matcher, such as `WebSearch` or `Glob`.
- A Rule 7 agent's definition copied without its `hooks:` block, since `ballot-check` checks the settings and attributes but not `.claude/agents/`.
