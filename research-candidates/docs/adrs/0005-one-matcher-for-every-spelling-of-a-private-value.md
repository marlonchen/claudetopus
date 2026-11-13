---
status: accepted
---

# One matcher reads every spelling of a private value

A private value reaches a page or a URL in many spellings: `springfield-township` in a path, `?precinct=12`, a ligature, a soft hyphen, an entity. A browser shows all of them as the same locating text, and a push keeps them in public history. One shared matcher, [`privacy.js`](../../../skills/research-candidates/scripts/lib/privacy.js), serves `fetch-snapshot`, `ballot-check` and `publish`, and it refuses on a match in any spelling it can read.

## How it matches

- **Value classes:** ballot id, private string, printed title, and API key. The address or street line, ZIP and label classes were removed with `addresses.yaml`; a ZIP is now a private string ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)).
- **Forms:** the raw text, then decoded and folded text, then that text with `- _ / . + = : , ; ~ &` read as spaces.
- **Variants:** each folded form is built with entities read as page text or as an attribute value, default-ignorable characters removed or read as spaces, and NFKC on or off, which gives 16 variants. A match in any variant refuses.
- **Order:** the ignorable fold and NFKC run first, then the quote, dash and case folds, whitespace collapse and the separators, so NFKC cannot bring back a capital or a separator after it was folded.
- **Boundaries:** text values match as whole phrases on word boundaries, and each value is normalized exactly like the variant it is matched against.
- **Digit runs:** a private string's digit run matches alone at 4 or more digits, and otherwise only beside the entry's other words. A run that reads as a year (1900 to 2099) also needs those words.
- **Keys:** a key value matches anywhere, with case kept, because it is random text. A ZIP, as a private string, matches by the digit-run rule above: alone, never inside a longer run.

## Considered Options

- **A single NFKC pipeline.** Rejected in review. It caught the ligature in `Springﬁeld` but turned `Township¹` into `township1`. Each fold can hide what another finds, hence refusing on any variant (PR #4, run 10).
- **Substring matching.** Rejected. It would hit ordinary page text, which is also why labels had to be distinctive (`addr-mom`, not `mom`) while they existed.
- **One offset per UTF-16 unit.** Replaced by breakpoint segments. A 10 MB page now scans in about 2 s under a 400 MB heap, where it took 13.6 s and 2.5 GB (PR #13).

## Consequences

- The matcher fails closed, so false refusals are accepted. A soft hyphen read as a space can split `Spring­field Township` into a match for `Field Township`.
- Script output reports only the line and class of a match ([ADR 0006](0006-script-output-holds-no-private-text.md)).
- `ballot-check` fails an entry with no letter or digit left after normalization, because the matcher skips such a value.
- Two gaps remain open in TODOS.md. Cyrillic or Greek look-alike letters are not folded, so a confusable spelling can pass every match while a browser shows the locating string. A combining mark after a phrase's last letter keeps it off a word boundary in every variant.
