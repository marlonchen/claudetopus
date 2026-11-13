---
status: accepted
---

# Three repos keep public and private data apart

The skill's source is public, the research data locates voters, and the published guides must be public, so one repo cannot hold all three. We split them: `claudetopus` (public) holds the skill and no research data, `elections` (private) holds the installed skill and all research data, and `ballots` (public) holds only rendered pages, each under a random slug. Privacy then rests on what each repo can hold, not on remembering what to leave out of a commit.

## Enforcement

- Rule 8 refuses to run outside a private repo ([ADR 0002](0002-run-only-in-a-private-data-repo.md)).
- [`pages.js`](../../../skills/research-candidates/scripts/lib/pages.js) (SKILL.md step 6.4) refuses a `pages_dir` that is the data repo or shares any commit with it, whose `origin` is not `pages_repo`, or whose fork-network root is the skill's source repo.
- It also refuses a Pages repo that holds a `skills/*/SKILL.md`, in the working tree, on `origin/<branch>` or on the remote's default branch.
- Only one file ever moves between repos: the scanned page, copied to `<slug>/index.html`, with its hash checked against the scanned bytes.

## Considered Options

- **Host pages from `claudetopus`.** Rejected. GitHub Pages is off there and it has no `gh-pages` branch, so ballot pages never sit beside the skill's source. `publish` compares fork-network ids, so a renamed repo or a fork of a fork is still refused.

## Consequences

- The slug stops someone guessing a page's URL, and it hides nothing else. `ballots` is public, so anyone can list every slug and read each page's source on github.com, and `noindex` covers only the `github.io` URL.
- A page that is changed or removed stays readable in the public history. A page must therefore carry only facts that are safe to publish for good.
- Nothing in the data is encrypted at rest. The private repo's access control and local file permissions are the only protection for `private.yaml` and saved sample ballots. No address is stored there ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)), so `addresses.yaml`, which this once named too, is gone.
