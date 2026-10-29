# Review list

One file per contest, at `<ballot-id>/review/<contest>.md`, written by `review-list`. The researcher reviews these items, not every claim.

## What goes on it

Only these items, each as a checkbox with the claim, its excerpt, its source and its key:

- every `s`-tagged ("Says:") claim whose cited snapshot's `owner` is not the candidate (or retention official) the claim sits under: a rival's campaign site, or a third party (a debate host, a questionnaire site, a news report) quoting the candidate (misattribution risk). `owner` comes from `tiers.yaml` ([source-tiers.md](source-tiers.md)), never from the subject directory the discovery agent chose. Claims citing a `_ballot` snapshot (the official ballot record) and all measure claims are exempt;
- every claim, whatever its tag, whose cited snapshot is filed under another candidate or official of the contest (`sources/<contest>/<other id>/`), so a rival's record compiled under the wrong block still reaches a human (misfiling risk). The subject directory cannot clear a claim, only add one; `_race` and `_ballot` snapshots and all measure claims are exempt;
- every claim in a section marked `always reviewed` in [sections.md](sections.md) (controversies, discipline), with its status: allegation, investigation, finding, judgment, or conviction;
- every `T2i` claim;
- every claim, in any section, whose text or excerpt contains an allegation word, so a controversy compiled into the wrong section still reaches a human. Words match whole and case folded, each bare or with one of its parenthesized endings: `alleg(e|ed|es|ation|ations|edly)`, `accus(e|ed|es|ation|ations)`, `charged`, `charges`, `indict(ed|ment|ments)`, `convict(ed|ion|ions)`, `sues`, `sued`, `suing`, `lawsuit(s)`, `investigat(e|ed|ion|ions|ing)`, `arrest(ed|s)`, `sanction(ed|s)`, `disciplin(e|ed|ary)`, `settlement(s)`, `fraud(ulent)`, `felon(y|ies)`, `misconduct`, `guilty`, `plead(s|ed)`, `pled`, `plea(s)`, `subpoena(s|ed)`, `complaint(s)`, `probe(s)`, `censur(e|ed)`, `impeach(ed|ment)`, `resign(ed|ation)`, `fined`, `violat(e|ed|ion|ions)`, `reprimand(ed)`, `admonish(ed|ment)`, `suspen(ded|sion)`, `disbar(red|ment)`, `scandal`, `dui`, `penalt(y|ies)`. Bare stems such as `charg` or `settle` would also match "in charge of" or "settled in", and bare "sue" is left out because it is also a first name;
- every entry in `unfetchable.md` for the contest, except `domain not in tiers.yaml` refusals and entries for a URL and subject that a later snapshot saved (one filed under that contest and subject whose `url` is the entry's URL and whose `fetched` date is on or after the entry's);
- every claim whose key is not accepted yet (an edited or added claim, see below);
- every claim the neutrality pass flags;
- on the first run, every claim whose text is not found whole in its own excerpt (see Accepted keys).

All but the neutrality flags are mechanical, and `review-list` adds them itself, so completeness does not rest on the compile step.

## Item keys

```text
- [ ] <claim text> `T2i` [s3](../sources/...) <!-- id:9f2c41ab07d3e56a -->
  > <excerpt>
```

The key is the first 16 hex digits (64 bits) of a sha256 hash of the candidate id (the retention official's id, or the contest id for a measure), the section heading text as written in [sections.md](sections.md) (under Positions, followed by the issue heading), the claim text, its tag, the excerpt, the snapshot path and a hash of the whole snapshot file. Snapshots are write-once (SKILL.md Rule 3); the file hash makes that checkable, since any later edit to a cited snapshot (its `source:` name, `url`, `public_url`, tier, owner or body) changes the key and puts the claim back on the list. For an unfetchable entry it is a hash of the URL and subject. `review-list` reads only the trailing `<!-- id:... -->` comment on an item line, and recomputes each key from the item's fields rather than trusting the comment. Two candidates with the same claim text get different keys, and swapping only the excerpt, the tag, the source or the snapshot's contents changes the key.

## Accepted keys

A claim key is accepted when it is in `review/<contest>.baseline` or `review/<contest>.accepted`. The first run writes the baseline once. `review-list` appends the key of each item the researcher marked `[x]` to `.accepted`, which only grows, so an accepted item can leave the list without losing its acceptance. The review file ends with an `<!-- accepted: ... -->` comment listing the set for reading; `publish` ignores the comment and recomputes the set from the two files. It refuses if either file lost a line or the baseline changed after its first data-repo commit, unless that change is a researcher's commit with the message `reset review <contest>`. The set grows two ways and nothing else:

- On the first run for a contest, a claim is accepted as the baseline only when a script can check its wording itself: it is not on the list for another reason, and its claim text, with a leading `Says:` and one pair of enclosing quotes removed, is found whole in its own excerpt, on word boundaries, after both are normalized as excerpt matching does ([article-format.md](article-format.md)). Every other claim goes on the list, whatever its tier: an official source does not make the wording neutral, and the neutrality pass is model judgment over untrusted excerpts, so its silence accepts nothing. The baseline is still written only once the neutrality pass has read every claim, so a verbatim claim it flags (a quote cut out of context, a claim in the wrong section) also goes on the list: `review-list` refuses to write the baseline unless `review/<contest>.neutrality.md` exists and its `reviewed` line holds exactly the current article's claim keys. A first run means no baseline exists for the contest yet. A missing review file next to an existing baseline is rebuilt from the articles, the baseline and `.accepted`, and is never a first run. To start a contest's review over, the researcher deletes its review file, baseline and `.accepted` in one commit with the message `reset review <contest>`.
- On every run, the key of each item marked `[x]` is appended to `.accepted`.

Running `review-list` again never accepts anything by itself. A key outside the set stays on the list, unchecked, until the researcher marks it, however many times the script runs. `publish` compares the current articles against the same set.

## Neutrality pass

After compile, a separate agent with no compile context reads each claim next to its excerpt. It flags any claim whose wording adds, drops or strengthens anything relative to the excerpt: loaded verbs, characterizations, missing qualifiers, a vote described as a stance, an interpreting T2 claim not marked `T2i`, a claim in a section it does not belong to (sections.md), and the figure mistakes `check` cannot read (article-format.md, Figures): a figure tied to a different field, subset or period than the excerpt gives it ("$5M from PACs" on a total), a reversed direction ("fell 3%" on "rose 3%"), or a count in words the excerpt does not give ("twenty terms" on "two terms"). This is still model judgment; the backstop is that the page shows every excerpt.

Before the pass, `review-list --keys` prints every claim's location (article path and line) and key, plus whether the key is accepted, without writing anything. The pass copies keys from that output and never computes one. It writes its flags to `review/<contest>.neutrality.md`: a first line `<!-- reviewed: <key> <key> ... -->` listing every key it read, then one line per flagged claim (`- <key> | <reason>`), and `review-list` merges them. On every later run, the pass reads only the claims whose keys are not accepted, so an edited claim is checked again.

## Clearing it

- To accept an item, mark it `[x]`.
- To change a claim, edit the article, not the review list. Then rerun SKILL.md steps 4.4-4.5 (`check` and `coverage`, `review-list --keys`, the neutrality pass, `review-list`). The edited claim gets a new key and comes back as an unchecked item, and the old item is dropped. A single `[x]` then clears it.

On every run, `review-list` keeps a mark only when an item with the same key still exists. A contest is `ready` when `check` and `coverage` pass, no box is unchecked (unfetchable entries included), and every claim key in the article is accepted. `publish` recomputes this itself rather than trusting the file (SKILL.md step 6).

## Command line

```text
review-list <election>/<ballot-id> [<contest>]...
review-list --keys <election>/<ballot-id> [<contest>]...
review-list --refused-hosts <election>/<ballot-id> <contest>
```

The first two forms take each contest given (once, if it is given twice), or every article under `articles/` when none is. Once its arguments parse, `review-list` checks Rule 8 and finishes any interrupted save, then holds the ballot lock while it reads and writes, as `check` does ([article-format.md](article-format.md#command-line)). Like every script, it prints only `location code [key]` lines (Rule 5), reports every failure it finds and exits non-zero on any. A key needs its claim's snapshot, block and section, so for each contest it first runs `check` and `coverage` on the article, and if either fails it prints `articles/<contest>.md check-failed` or `articles/<contest>.md coverage-failed` and goes on to the next contest without writing anything for this one; run that script to see why.

`--keys` writes nothing. For each claim, in article order, it prints its location and whether its key is accepted, then the key: `articles/us-house-07.md:12 unaccepted 9f2c41ab07d3e56a`.

The first form, for each contest, reads everything below and writes only when all of it passes:

- **Accepted set.** `review/<contest>.baseline` and `review/<contest>.accepted`, one key per line, each 16 lowercase hex digits and ending in a newline. A first run is one with no baseline; an `.accepted` with no baseline fails `review-invalid`, and so does a malformed line (located by line) or a review file, baseline or `.accepted` that is not a regular file.
- **Marks.** Each line of `review/<contest>.md` that starts `- [x]` (or `- [X] `) and ends with `<!-- id:<key> -->`. A mark counts only when its key is an item's on this run's list; every other line is ignored, and on a first run the whole file is.
- **Neutrality flags.** `review/<contest>.neutrality.md` (Neutrality pass): its first line `<!-- reviewed: <key> ... -->`, then flag lines `- <key> | <reason>` and blank lines. Any other line, a key that is not 16 lowercase hex digits, a flag whose key is not on the `reviewed` line, or a reason that is empty or holds `<!--` or `-->` fails `neutrality-invalid`, located by line. On a first run the file must exist (`neutrality-missing`) and its `reviewed` keys must be exactly the article's claim keys (`neutrality-stale`, located by its first line). On a later run, once this run's marks are counted, every claim key not yet accepted must be on its `reviewed` line (`neutrality-missing` with no file, `neutrality-stale` otherwise); with every key accepted the file is not needed, and keys and flags for claims no longer in the article are ignored.
- **Unfetchable entries.** Every line of `unfetchable.md` must be an entry as [snapshot-format.md](snapshot-format.md#unfetchable-log) gives it, whose reason holds no `|`, `<` or `>`, or the run fails `unfetchable-invalid`, located by line.

Then, on a first run, it writes the baseline, every claim key not on the list (it may be empty), and prints `review/<contest>.baseline written`; it appends the key of each mark not yet accepted to `.accepted`, once each; it writes the review file and prints `review/<contest>.md written`; and it prints `articles/<contest>.md ready` or `articles/<contest>.md not-ready`, as Clearing it defines `ready`. The review file is:

```markdown
# Review: <contest>

- [ ] <claim text> `<tag>` [s1](../sources/<contest>/<subject>/<name>.md) <!-- id:<key> -->
  > <excerpt>
  - why: <reason>, <reason> (articles/<contest>.md:<line>)
  - neutrality: <the pass's reason>
- [ ] Unfetchable: <url> | <contest>/<subject> | <date> | <reason> <!-- id:<key> -->

<!-- accepted: <key> <key> ... -->
```

Items come in article order, then unfetchable entries in log order, one item per key. An item whose key is accepted is shown checked, so an `always reviewed` claim stays on the list once accepted; an item listed only because its key was not accepted leaves the list once it is. The `why` line names the item's mechanical reasons: `attribution`, `misfiled`, `always-reviewed`, `t2i`, `allegation-word`, `neutrality`, `not-verbatim` (first run) and, only when it has no other reason, `unaccepted`. `publish` recomputes `ready` with the same library function.

`--refused-hosts` reads only `ballot.yaml`, the contest's search log and `unfetchable.md`, never the URLs' paths. It takes the contest's `domain not in tiers.yaml` entries from the current discovery run, those dated on or after the latest date in the contest's search log (every entry when the log has no line), and prints each distinct host, as the WHATWG URL parser gives it (lowercase, internationalized names in their IDNA ASCII form), that is a valid LDH host name: dot-separated labels of 1 to 63 letters, digits and hyphens, none starting or ending with a hyphen, at least two labels, a last label that is not all digits, and at most 253 characters. Each prints as `<contest> domain-not-in-tiers <host>`, sorted; the entries whose host is not one are counted on one line, `<contest> other-hosts <count>`. With no entries it prints `<contest> no-refused-hosts`.

Its codes, beyond the output lines above: `usage`, `bad-ballot`, `unknown-ballot`, `unknown-contest` (a contest `ballot.yaml` does not list, located by its article), `file-missing` (an article for a contest given does not exist, or `ballot.yaml`), `yaml-invalid`, `ballot-invalid`, `check-failed`, `coverage-failed`, `review-invalid`, `neutrality-missing`, `neutrality-stale`, `neutrality-invalid`, `unfetchable-invalid`, `search-log-invalid`, the Rule 8 codes `guard-no-publish-yaml`, `guard-skill-source-clone`, `guard-skill-source-remote`, `guard-remote-not-private`, `guard-not-git-repo` and `guard-not-repo-root`, `ballot-locked`, `deps-missing` and `internal-error`.
