# claudetopus

My Claude Code skills.

## Skills

| Skill | What it does |
| --- | --- |
| [mywiki](skills/mywiki/README.md) | Personal journal (dated daily entries with carry-forward) plus a Karpathy-style LLM wiki: ingest sources, compile durable articles, query with citations, lint for source fidelity. |

## Development setup

There is no `package.json` and no `node_modules` here. Every tool is either a Node
builtin or a standalone binary provisioned by [mise](https://mise.jdx.dev).

### Prerequisites

**Node.js 20+** on your `PATH`. It is deliberately *not* pinned in mise: the mywiki
evidence checker is zero-dependency by design and is meant to run on whatever Node a
developer already has, so `mise run test` should exercise that same Node rather than a
second copy managed here.

### 1. Install mise

```bash
brew install mise        # macOS
curl https://mise.run | sh   # anything else
```

Adding `eval "$(mise activate zsh)"` to your shell rc is optional. `mise run <task>`
resolves the tools it needs on its own, so every command below works without it.

### 2. Trust the config and install the tools

```bash
mise trust
mise install
```

`mise trust` is required, not optional — `.config/mise/config.toml` sets environment
variables, so mise refuses to parse it until the repo is trusted and every later
command fails with a trust error.

`mise install` fetches three standalone binaries:

| Tool | Covers | Config |
| --- | --- | --- |
| [biome](https://biomejs.dev) | JavaScript lint + format | `biome.jsonc` |
| [rumdl](https://github.com/rvben/rumdl) | Markdown lint + format | `.rumdl.toml` |
| [yamlfmt](https://github.com/google/yamlfmt) | YAML lint + format | none |

### 3. Install the git hooks

```bash
mise run hooks:init
```

This points git's `core.hooksPath` at `.config/git`, so the tracked scripts run directly
and can never drift from a stale copy in `.git/hooks`. `pre-commit` rejects partial commits
and runs `mise run lint` plus `mise run test`; `commit-msg` enforces the message format
below.

## Tasks

```bash
mise tasks   # list them all
```

| Task | Does |
| --- | --- |
| `mise run lint` | All of the below |
| `mise run lint:js` | Biome check over `skills/` |
| `mise run lint:md` | rumdl over the prose docs and reference templates |
| `mise run lint:yaml` | yamlfmt over `.yaml`/`.yml`, plus `SKILL.md` frontmatter validation |
| `mise run format` | All of the below, writing fixes in place |
| `mise run format:js` | Biome |
| `mise run format:md` | rumdl |
| `mise run format:yaml` | yamlfmt |
| `mise run test` | `node --test` over `skills/mywiki/tests/` |

Two deliberate scoping rules, both worth knowing before you widen a task:

- `skills/mywiki/examples/` is excluded from Markdown linting and formatting. Those two
  files are byte-exact test fixtures — the suite asserts they produce zero fidelity
  suspects, which requires every number, date, and quote to match verbatim between the
  raw file and the article. A formatter run over them breaks the tests silently.
- `SKILL.md` frontmatter is validated but never reformatted. Rewriting it means splicing
  YAML back into a Markdown file, and the long `description:` field is what decides
  whether the skill triggers at all.

## Commit messages

The `commit-msg` hook requires `type(scope): description`, with the first line at 50
characters or fewer. The scope is optional. Valid types:

```text
feat  fix  docs  style  refactor  test  chore  build  ci  perf  revert
```

For example:

```text
feat(mywiki): add source fidelity linter
fix: handle missing raw.config
```

## Layout

```text
.config/
  git/               # hook scripts, installed by `mise run hooks:init`
  mise/
    config.toml      # tool pins and env
    tasks/           # lint/, format/, test/, hooks/
skills/
  mywiki/            # the skill: SKILL.md, references, scripts, tests
biome.jsonc          # JavaScript lint + format config
.rumdl.toml          # Markdown lint config
```
