# mywiki

Personal journal + knowledge base skill for Claude Code. Two systems, one skill:

- **Journal** — today's dated entry, built from your existing daily template (Weekly Big Three, Habit, Tasks, Meetings, Reflections, Plan for tomorrow, Backlog), with tasks/habits/backlog carried forward from the previous entry.
- **Wiki** — a [Karpathy-style LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) for research and learning material: ingest sources into a source directory (`raw/` by default, configurable via `raw.config`), compile durable articles into `.wiki/`, query with citations, lint for consistency. Adapted from [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) (MIT).

See [SKILL.md](SKILL.md) for the full spec.

This directory is the skill's *source*, versioned in the [claudetopus](../../README.md) repo — develop it here, independently of the journal/wiki data it operates on.

## Two ways to install it

The skill runs with the journal/wiki *data* directory as its project root. There are two
starting points, and a given repo is one or the other — pick by what is already there:

- [**An existing journal repo**](#in-an-existing-journal-repo) — day files going back years, and now a wiki alongside them.
- [**A fresh wiki repo**](#in-a-fresh-wiki-repo) — nothing yet, wiki only, no journal.

They are the same mechanism seen from two ends: the wiki always compiles into `.wiki/`,
and the only thing that varies is where sources live. Nothing needs to be configured to
combine them, because there is nothing to combine — one project root has one source
directory and one `.wiki/`.

## In an existing journal repo

For a repo that already holds `YYYY-MM/DD.md` entries (e.g. `~/j`, with entries going back
to 2020). The journal half of the skill picks up the existing format; the wiki half adds
two new directories beside it and never touches the day files.

Install with your skill-installer CLI, pointing at this directory, or manually:

```bash
mkdir -p ~/j/.claude/skills
ln -s ~/src/github/marlonchen/claudetopus/skills/mywiki ~/j/.claude/skills/mywiki
```

The symlink is useful when developing this repository because updates here take effect in
the journal repo immediately, with no separate sync step.

Then, from inside `~/j`, ask Claude Code for "today's journal entry" or "add this to the
wiki" — see SKILL.md's trigger phrases. The first ingest creates the wiki directories.

Layout once installed:

```text
~/j/                      (journal repo root — pre-existing, untouched)
├── 2020-03/ … /2026-09/  existing daily entries
├── raw.config            (optional — where sources live, and which of them get ingested)
├── raw/                  (new — wiki sources, created on first ingest)
├── .wiki/                (new — compiled wiki articles, created on first ingest)
└── .claude/skills/mywiki -> .../claudetopus/skills/mywiki   (this directory, symlinked)
```

`raw.config` is optional here and worth adding for one reason: a repo whose root is already
a long list of `YYYY-MM/` folders may want sources tucked out of the way (`source notes/`,
say) or partly excluded from ingest. Without it, sources go to `raw/` at the root. See
SKILL.md's Configuration section for the directives.

Journal entries and wiki content are kept deliberately separate — the skill never
restructures existing day files into wiki pages or vice versa.

## In a fresh wiki repo

For a new repo with no journal in it. Nothing is configured; the defaults are the whole
setup, and the journal workflow simply never triggers.

```bash
mkdir -p ~/w/.claude/skills && git -C ~/w init
ln -s ~/src/github/marlonchen/claudetopus/skills/mywiki ~/w/.claude/skills/mywiki
```

Then, from inside `~/w`, ask Claude Code to "add this to the wiki" with a URL or a pasted
source. The first ingest creates `raw/` and `.wiki/`; there is no init command to run.

Layout after the first ingest:

```text
~/w/                      (new repo root)
├── raw/                  (wiki sources, created on first ingest)
├── .wiki/                (compiled wiki articles, created on first ingest)
│   ├── index.md          (global index — one row per article)
│   ├── log.md            (append-only operation log)
│   └── <topic>/          (one level of topic directories, no deeper)
└── .claude/skills/mywiki -> .../claudetopus/skills/mywiki   (this directory, symlinked)
```

The compiled wiki lives in `.wiki/` here too — the same hidden directory as in a journal
repo, so articles, relative links, and the lint script mean one thing everywhere. `ls`
will show only `raw/`; use `ls -a`, or read `.wiki/index.md`, which is the intended way in.

Adding a `raw.config` works the same way as above, but in a repo built around the wiki
there is usually nothing to redirect.

## Structure of this skill

```text
SKILL.md                        # the skill: journal workflow + wiki workflow
references/
  daily-entry-template.md       # journal day-file template (matches existing ~/j format)
  raw-template.md               # wiki: raw source file format
  article-template.md           # wiki: compiled article format
  index-template.md             # wiki: index.md format
  archive-template.md           # wiki: archived query-answer format
scripts/
  check_evidence.js             # wiki lint: source-fidelity checker (report-only)
tests/
  check_evidence.test.js
```

## Requirements

Nothing to install. The journal, ingest, and query workflows are pure prompt — no runtime at all.
Only the Lint workflow's mechanical sweep shells out, to `scripts/check_evidence.js`, which needs
**Node.js 20+** and uses `node:` builtins only — no `npm install`, no `node_modules`, works offline.

Run it directly if you want the report outside a Claude session:

```bash
node scripts/check_evidence.js <project-root> [article.md ...]
```
