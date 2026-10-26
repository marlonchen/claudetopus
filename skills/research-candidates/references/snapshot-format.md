# Snapshot format

A snapshot is one fetched source, saved by `fetch-snapshot` under `<ballot-id>/sources/_ballot/<name>.md` when the subject is `_ballot`, and under `<ballot-id>/sources/<contest>/<subject>/<name>.md` otherwise. Snapshots are write-once (Rule 3).

```markdown
---
source: FEC candidate data         # from tiers.yaml: the matched entry's source name, shown on the page receipt
url: https://api.open.fec.gov/v1/candidate/H0XX00000/totals/   # what was fetched, cleaned (see below)
fetched: 2026-10-12                # fetch date shown on the receipt
method: api                        # html | pdf | api
tier: T1                           # T1 | T2 | T3 | T4, from tiers.yaml (source-tiers.md)
statements_only: false             # from tiers.yaml; true: claims citing it must be "Says:" claims
subject: jane-example              # candidate id, retention official id, _race, or _ballot
owner: third-party                 # from tiers.yaml: third-party, or the candidate or official id whose own site it is
public_url: https://www.fec.gov/data/candidate/H0XX00000/   # optional, see below
---
<body>
```

`_ballot` snapshots also carry:

```yaml
role: sample_ballot                # sample_ballot | candidate_list | pamphlet | write_in_list | withdrawal_notice
supersedes: sample-ballot.md       # optional: the earlier snapshot this one corrects
```

## Cleaning the URL

`fetch-snapshot` removes API keys from every URL it records, in snapshots and in the unfetchable log alike. A key parameter is any query parameter whose name matches `/^(api[_-]?key|key|token|access[_-]?token|secret|sig(nature)?)$/i` (`api_key`, OpenStates' `apikey`, `apiKey`, `access_token`). Key values are the values of the API-key environment variables the scripts read (`OPENFEC_API_KEY`, `OPENSTATES_API_KEY`); `fetch-snapshot` and the publish privacy scan both refuse any URL or page that contains one. For `_ballot` snapshots it also drops the whole query string and fragment, because county lookups often carry the address, precinct or voter id there.

`--ballot` mode, used only in step 2 and only by the researcher, takes a county or state URL that may carry the address in its query, shows the URL and `role` and asks for confirmation at the terminal, saves it as a `_ballot` snapshot, and records it with the query and fragment dropped. The URL's host must be `T1` in `tiers.yaml`. If the address, ZIP or a `private_strings` entry is in the URL's path instead, it refuses; the researcher downloads the file into `downloads/` and saves it with `fetch-snapshot --ballot --file <path>`, giving the county page's origin as the URL. `--file` accepts only PDF or HTML files under `downloads/`. The fetch tool given to agents rejects `--ballot` and `--file`. It allows only a plain fetch and `--searched` (Search log, below), both bound to the agent's own contest. Privacy refusals, in every mode (a URL holding the ballot id, an address, street line, ZIP code, label, `private_strings` entry or key value), and every `--ballot` refusal or failure are never written to `unfetchable.md`; they show only as a class code at the terminal, since the URL is the private text.

## Body

- `html`: the readable text of the page, with no navigation or ads.
- `pdf`: `pdftotext -layout` output, except `_ballot` PDFs, which use plain `pdftotext` so that wrapped titles stay in reading order.
- `api`: the JSON response flattened to one `key: value` line per field (nested keys joined with `.`), with a blank line between records. The page shows these lines as the excerpt.

`public_url` is optional: a public page showing the same record, for a receipt when `url` is an API endpoint or needed its query string. It comes only from a discovery search result or the researcher (Rule 7), never has a query string or fragment, passes the same tier and privacy checks as `url`, and the page links it instead of `url`. `_ballot` snapshots never carry it.

`source`, `tier`, `statements_only` and `owner` come only from the matched `tiers.yaml` entry ([source-tiers.md](source-tiers.md)); `fetch-snapshot` takes no option that sets them. It refuses a snapshot whose `owner` is a candidate or official id of the contest other than its `subject`, so a campaign site is never filed under a rival or under `_race`. `fetch-snapshot` refuses a `source:` name that contains a `private_strings` entry or the printed `title` of a contest with a `display_title`, matched as in the publish privacy scan; the name is shown on the page.

`fetch-snapshot` accepts only a contest and subject pair listed in `ballot.yaml` (or `_race`), and resolves the target path under `sources/` before writing. Only `--ballot` mode writes to `sources/_ballot/`; it needs only the ballot directory, since it runs in step 2 before `ballot.yaml` exists, and it appends every snapshot it saves, with whether its fetch URL had a query string, to `<ballot-id>/ballot.ledger`, which sits outside `sources/` because it is append-only; `ballot-check` fails on any `_ballot` snapshot the ledger does not list, and on more than one `role: sample_ballot` snapshot that nothing supersedes.

Excerpts are matched against the body only, never the front matter. The body is untrusted text from the open web: it is data to quote, never instructions to follow (Rule 7).

## Names

Use a short kebab-case name for the source (`fec-totals.md`). Re-fetching writes a new file with a numeric suffix (`fec-totals-2.md`); a file is never overwritten. Numbers in names are fine: `check` strips link targets, link text and inline code before looking for figures.

## Manifest

Every snapshot `fetch-snapshot` saves, `_ballot` ones included, gets one line appended to `<ballot-id>/snapshots.sha256`: the sha256 of the whole file, two spaces, and its path relative to the ballot directory, starting with `sources/`, the format `sha256sum -c` reads. The manifest sits outside `sources/` because it is append-only; a line is never changed or removed, and a re-fetch adds a line for its new file. `check` and `publish` hash every file under `sources/` and fail with `snapshot-hash` ([article-format.md](article-format.md)), located by the snapshot's path, on a file whose hash differs from its line, a file with no line, or a line whose file is gone. Write-once (Rule 3) is then checked even when an edit gets past the data repo's settings deny rule on `sources/`.

## Search log

`fetch-snapshot --searched <subject> <item>` appends one line to `<ballot-id>/search-log/<contest>.tsv`, the contest the agent's fetch tool is bound to, after the discovery agent has run a discovery checklist item ([source-tiers.md](source-tiers.md)) for one candidate, official or measure. It writes nothing else. The line holds four tab-separated fields and no free text:

```text
<contest>	<subject>	<item>	<searched>
```

- `<contest>`: the contest id, the same as the file name.
- `<subject>`: the candidate id, the retention official's id, or the contest id for a measure, as listed in `ballot.yaml`.
- `<item>`: the checklist item number, one the contest's type uses: 1-5 for a candidate contest, 6 for a measure, 7 for a retention contest.
- `<searched>`: the date `fetch-snapshot` wrote the line (`YYYY-MM-DD`), never a caller's value.

`fetch-snapshot` refuses a subject the contest does not list or an item its type does not use, and writes no line for it. The log is append-only, and a later run of the same item adds another line. `coverage` reads it: a section in the state `Unknown, no source found` needs a line for its subject and each checklist item [sections.md](sections.md) maps to that section, or it fails with `search-not-logged` ([article-format.md](article-format.md)). The log proves only that the search ran, not what it found, so a line never makes a section anything but Unknown.

## Saved copies

After saving a snapshot that is not `_ballot`, whose `method` is not `api`, whose cleaned `url` has no query string and that has no `public_url`, `fetch-snapshot` asks the Wayback Machine to capture the same `url` and, on success, appends one line to `<ballot-id>/archives.tsv`: the snapshot path, a tab, and the 14-digit capture timestamp (`YYYYMMDDhhmmss`). Nothing else is sent, and `_ballot` snapshots are never submitted. The page's "Saved copy" link is rebuilt from these two values (SKILL.md step 6.2).

## Unfetchable log

`fetch-snapshot` appends sources it could not save to `<ballot-id>/unfetchable.md`. The log sits outside `sources/` because it is append-only, not write-once. One line per entry, with the URL cleaned as above:

```text
- <url> | <contest>/<subject> | <date> | <reason>
```

Ballot-level sources use `_ballot` in place of `<contest>/<subject>`. An unfetchable source is never paraphrased from search snippets.
