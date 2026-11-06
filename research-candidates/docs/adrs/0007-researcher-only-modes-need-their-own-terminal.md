---
status: accepted
---

# Researcher-only modes need their own terminal

Some modes must never run through the session: they print private text, prompt with a private URL, save on the researcher's judgment, or make a page public. Those modes refuse unless a person is at a real terminal outside Claude Code, and the data repo's settings deny them to the session as a second layer.

| Mode | Why it is researcher-only |
| --- | --- |
| `fetch-snapshot --ballot` | Prompts with a URL that may hold the address |
| `ballot-check --show`, `publish --show` | Print matched private text |
| `fetch-snapshot --keep-short` | Saves a page the short-page rule refused, on the researcher's judgment |
| `publish --push`, `publish --device-check` | Push the page after the researcher's own yes |

## Enforcement

There are three layers, because each covers what the others cannot:

1. **Terminal guard.** [`terminal.js`](../../../skills/research-candidates/scripts/lib/terminal.js) refuses with `not-a-terminal` when `CLAUDECODE` is set or stdin or stdout is not a TTY, before the mode reads anything. This also stops the session's `!` prefix.
2. **Deny rules.** [`data-repo-settings.json`](../../../skills/research-candidates/data-repo-settings.json) denies these modes to Bash calls. The patterns name the scripts, so `git` and `rg` flags still pass.
3. **Hook.** [`session-guard.js`](../../../skills/research-candidates/scripts/lib/session-guard.js) reads every Bash command and file write. It refuses the flags even when quoted apart (`--bal''lot`), and refuses `CLAUDECODE`, `env -i`, pseudo-terminal tools (`script`, `expect`, `unbuffer`, `socat`, Python's `pty`) and the `claude` CLI. If the hook cannot run, the command exits 2 and the call is refused.

## Considered Options

- **The terminal guard alone.** Rejected. A child process controls both things it checks, and review got past it with `env -u CLAUDECODE script -q /dev/null …` (PR #11).

## Consequences

- These layers stop mistakes and the plain ways around the guard. They are not a wall against a hostile session. Probing `session-guard`, `--bal''lot` was refused, but `f=--bal; scripts/fetch-snapshot ${f}lot x` was allowed. The README states this limit.
- The protection exists only once the researcher merges the settings into the data repo, and starts Claude Code at its top level, since a `/` rule reads from the session's starting directory. The hook runs only once the folder is trusted.
- The researcher must leave the session for these steps, which is the intended cost.
