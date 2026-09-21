# mywiki

Personal journal + knowledge base skill for Claude Code. Two systems, one skill:

- **Journal** — today's dated entry, built from your existing daily template (Weekly Big Three, Habit, Tasks, Meetings, Reflections, Plan for tomorrow, Backlog), with tasks/habits/backlog carried forward from the previous entry.
- **Wiki** — a [Karpathy-style LLM wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) for research and learning material: ingest sources into a source directory (`raw/` by default, configurable via `raw.config`), compile durable articles into `.wiki/`, query with citations, lint for consistency. Adapted from [Astro-Han/karpathy-llm-wiki](https://github.com/Astro-Han/karpathy-llm-wiki) (MIT).

See [SKILL.md](SKILL.md) for the full spec.

This directory is the skill's *source*, versioned in the [claudetopus](../../README.md) repo — develop it here, independently of the journal/wiki data it operates on.

## Install into your journal repo

The skill expects to run with the journal/wiki data directory as its project root (e.g. your `~/j` journal repo, which already has `YYYY-MM/DD.md` entries going back to 2020).

Install with your skill-installer CLI, pointing at this directory, or manually:

```bash
mkdir -p ~/j/.claude/skills
ln -s ~/src/github/marlonchen/claudetopus/skills/mywiki ~/j/.claude/skills/mywiki
```

A symlink (rather than a copy) means updates here take effect in the journal repo immediately, with no separate sync step.

Then, from inside `~/j`, ask Claude Code for "today's journal entry" or "add this to the wiki" — see SKILL.md's trigger phrases.

## Layout once installed

```text
~/j/                     (journal repo root — pre-existing, untouched)
├── 2020-03/ … /2026-09/  existing daily entries
├── raw/                  (new — wiki sources, created on first ingest)
├── .wiki/                (new — compiled wiki articles, created on first ingest)
└── .claude/skills/mywiki -> .../claudetopus/skills/mywiki   (this directory, symlinked)
```

Journal entries and wiki content are kept deliberately separate — the skill never restructures existing day files into wiki pages or vice versa.

## Structure of this skill

```text
SKILL.md                        # the skill: journal workflow + wiki workflow
references/
  daily-entry-template.md       # journal day-file template (matches existing ~/j format)
  raw-template.md                # wiki: raw source file format
  article-template.md            # wiki: compiled article format
  index-template.md              # wiki: index.md format
  archive-template.md            # wiki: archived query-answer format
scripts/
  check_evidence.js              # wiki lint: source-fidelity checker (report-only)
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
