---
status: accepted
---

# Script output holds no private or quoted text

The model reads whatever a script prints, so printing a match would hand it the private value this design keeps from it. Printing fetched text would also carry attacker-chosen words into a session that has shell and file tools. Scripts therefore report only locations, keys and codes (Rule 5). For a privacy refusal the code names the class of value that matched, never the value or the text around it. The researcher reads the text with `--show` in their own terminal.

## Enforcement

- [`output.js`](../../../skills/research-candidates/scripts/lib/output.js) gives every command one shape: `location code [key]`, with an optional fixed hint code. An unexpected error prints `- internal-error`.
- [`privacy.js`](../../../skills/research-candidates/scripts/lib/privacy.js) returns only `{ line, class }` unless a caller asks for offsets.
- Locations are chosen to carry nothing. A remote is named `remote:<name>`, never its URL. A failure in another ballot's file is located `-`, so no other ballot's id appears. `uncommitted` names an area, never a file, since a planted file name can take its name from private text.
- `session-guard` prints only `<tool> <code>`, with `-` for a tool name that is not a plain word.
- `review-list --refused-hosts` prints hosts, or a count of hosts it cannot show, so the session has no need to read `unfetchable.md`.

## Considered Options

- **Have the session read refused hosts from `unfetchable.md`.** Rejected in /ship run 5, because it let attacker-chosen URL text into the main session. TODOS.md records that each prose patch to this hand-off opened the next hole, which is why the boundary moved into scripts and tests.

## Consequences

- The main session passes a failure to the compile agent only as a location and a code from the fixed list, and never reads `unfetchable.md`. Both are instructions: `launchRefusal` checks only the prompt's first line, and nothing refuses that read.
- There are two exceptions. `--show` is researcher-only ([ADR 0007](0007-researcher-only-modes-need-their-own-terminal.md)). `discovery-fetch --brief` prints the discovery agent's own prompt, which holds only values that passed `ballot-check`.
- A refusal alone cannot tell the model how to fix a match. Fixes take a round trip through the researcher, or through the compile agent working from a location.
- `internal-error` writes its stack to stderr, and a Bash call returns stderr to the session. This path is the one output the `location code` shape does not cover, so a stack that quotes text would bypass the rule. Whether any stack can hold private text has not been audited.
