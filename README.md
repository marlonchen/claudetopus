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

### 2. Trust the config

```bash
mise trust
```

Required, not optional, and deliberately a step of its own: `.config/mise/config.toml`
sets environment variables, so mise refuses to parse it — or to run any task in this
repo — until you trust it. That is a decision about letting this checkout's config act
on your machine, so it stays an explicit thing you do rather than something a setup
task does on your behalf. (Run `mise init` first and mise will prompt you for it; in a
non-interactive environment there is no prompt, only an error.)

### 3. Set up the repo

```bash
mise init
```

One task for both mechanical setup steps:

1. **Hooks** — `mise run hooks:init` points git's `core.hooksPath` at `.config/git`, so
   the tracked scripts run directly and can never drift from a stale copy in
   `.git/hooks`. `pre-commit` rejects partial commits and runs `mise run lint` plus
   `mise run test`; `commit-msg` enforces the message format below.
2. **Tools** — `mise install` fetches the three standalone binaries below.

`mise init` is this repo's task, not a mise builtin — `mise <task>` is shorthand for
`mise run <task>`, and `mise run init` is the unambiguous form. It is idempotent: run it
again any time to re-check the setup.

The tools `mise install` provisions:

| Tool | Covers | Config |
| --- | --- | --- |
| [biome](https://biomejs.dev) | JavaScript lint + format | `biome.jsonc` |
| [rumdl](https://github.com/rvben/rumdl) | Markdown lint + format | `.rumdl.toml` |
| [yamlfmt](https://github.com/google/yamlfmt) | YAML lint + format | `.yamlfmt` |

## Tasks

```bash
mise tasks   # list them all
```

| Task | Does |
| --- | --- |
| `mise run init` | Install the tools and the git hooks |
| `mise run hooks:init` | Just the git hooks half of `init` |
| `mise run lint` | All of the below |
| `mise run lint:js` | Biome check over `skills/` |
| `mise run lint:md` | rumdl over the prose docs and reference templates |
| `mise run lint:yaml` | yamlfmt over `.yaml`/`.yml` and `.yamlfmt`, plus `SKILL.md` frontmatter validation |
| `mise run format` | All of the below, writing fixes in place |
| `mise run format:js` | Biome |
| `mise run format:md` | rumdl |
| `mise run format:yaml` | yamlfmt |
| `mise run test` | `node --test` over `skills/*/tests/*.test.js`, failing if it finds none |

Two deliberate scoping rules, both worth knowing before you widen a task:

- `skills/mywiki/examples/` is excluded from Markdown linting and formatting. Those two
  files are byte-exact test fixtures — the suite asserts they produce zero fidelity
  suspects, which requires every number, date, and quote to match verbatim between the
  raw file and the article. A formatter run over them breaks the tests silently.
- `SKILL.md` frontmatter is validated but never reformatted. Rewriting it means splicing
  YAML back into a Markdown file, and the long `description:` field is what decides
  whether the skill triggers at all.

## Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every pull request, on every
push to `main`, and on demand from the Actions tab. Two jobs, both running the tasks above:

| Job | Runs |
| --- | --- |
| Lint | `mise run lint`, once |
| Test (Node 20, 22, 24, 26) | `mise run test`, one leg per Node version |

The test matrix exists because the mywiki checker claims to run on any Node 20+: CI exercises
the floor of that claim, the current LTS line, and the version the repo is developed on. Each
leg asserts that `mise exec -- node --version` really is the version it advertises, so pinning
a Node in `.config/mise/config.toml` later cannot quietly collapse four legs into one.

Nothing runs in CI that you cannot run locally — these are the same two commands the
`pre-commit` hook runs. One caveat worth knowing: the three linters track `latest`, so a red
lint job can come from an upstream tool release rather than from the diff under review.

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
  git/               # hook scripts, installed by `mise init`
  mise/
    config.toml      # tool pins and env
    tasks/           # init, lint/, format/, test/, hooks/
.github/
  workflows/ci.yml   # runs lint + test on pull requests and pushes to main
skills/
  mywiki/            # the skill: SKILL.md, references, scripts, tests
biome.jsonc          # JavaScript lint + format config
.rumdl.toml          # Markdown lint config
.yamlfmt             # YAML lint + format config
```
