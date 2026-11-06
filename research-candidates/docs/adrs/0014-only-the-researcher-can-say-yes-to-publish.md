---
status: accepted
---

# Only the researcher can say yes to publish

A push makes a page public, and it stays in the Pages repo's history after any later change or removal. The decision needs a person who has seen what will change, so it cannot be a line in a conversation. `publish` stops after writing `site/index.html`, and only `publish --push` and `publish --device-check` push. They run only in the researcher's terminal, where they ask for the yes themselves (Rule 6). The model never commits, in either repo.

## Enforcement

[`pages.js`](../../../skills/research-candidates/scripts/lib/pages.js) runs these steps in order under a lock on `pages_dir`:

1. Check the Pages repo ([ADR 0001](0001-three-repos-for-public-and-private-data.md)), and run `git fetch origin --prune` for every branch once.
2. Refuse unless the author and committer are GitHub noreply addresses (`pages-identity-public`), since both stay public for good.
3. Refuse to overwrite a `<slug>/index.html` the ballot's `published.log` does not list (`slug-unrecorded`), so one ballot never publishes over another's page.
4. Copy the scanned bytes, and check that the copy and the staged blob hash the same as the scan.
5. Show the staged diff, the contest list, the file size, and what becomes public.
6. Ask at the terminal. Only `y` or `yes` counts, and Ctrl-C or Ctrl-D is a no that undoes the copy.
7. Check `HEAD` again (`pages-not-at-origin`), append the slug to `published.log`, and commit with a pathspec.
8. Verify that the commit changes only that page, to the scanned blob, and sits right on the remembered tip (`copy-mismatch`).
9. Push with `git push origin HEAD:refs/heads/<branch> --no-follow-tags --recurse-submodules=no`.
10. Print the page URL only after the push succeeds.

## Considered Options

- **A bare `git push`.** Rejected. It can follow `pushRemote` or `pushDefault` to another remote, and tags or submodule commits could go along.

## Consequences

- That the model never commits is an instruction, and so is the rule that nothing else pushes. `session-guard` refuses `publish --push` but not a plain `git commit` or `git push`, so a session could push to the Pages repo directly. TODOS.md tracks enforcing both.
- The researcher is warned that the contest list and candidate order become public and can narrow down where a voter lives, because some states rotate candidate order by precinct. The scan cannot catch this ([ADR 0012](0012-scan-the-page-before-and-after-rendering.md)), so it is the researcher's call.
- `display_name` and the commit author's name are public too.
- A rejected push leaves the local commit for the researcher. They push it or reset `pages_dir`, and step 6.4 refuses until they do.
- `published.log` must be committed to the data repo before the next publish, so a push that added a slug leaves one more step for the researcher.
- The first publish of a slug requires the device check, which is manual.
