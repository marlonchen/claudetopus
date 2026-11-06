---
status: accepted
---

# Published pages are self-contained

A voter reading their ballot guide should not tell a third party they did so, and a page built from web text must not be able to run any of it. Each page is one static file with inline CSS, no scripts and no external requests. Receipts are `<details>` elements, and the only links out are receipt links rebuilt from parsed parts.

## Enforcement

**Page headers** (SKILL.md step 6.2):

- `<meta name="robots" content="noindex, nofollow">`
- `<meta name="referrer" content="no-referrer">`
- A Content-Security-Policy of `default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`, where `style-src` is the only loosened directive.

**Content.** [`page.js`](../../../skills/research-candidates/scripts/lib/page.js) HTML-escapes every interpolated value: claims, excerpts, source names, titles, names, parties and dates.

**Receipt links:**

- They allow only `http` and `https`, are rebuilt from scheme, host and path, and carry no query string or fragment.
- A receipt links to `public_url` when the snapshot has one, otherwise to `url`.
- A `url` with a query and no `public_url` gets no link, since dropping the query would open a different page. Neither does an API snapshot with no `public_url`, whose cleaned URL opens an error.
- A `_ballot` receipt links only to the county site's origin, because a per-ballot path can encode the precinct or ballot style.
- A saved-copy link is rebuilt from the snapshot's own cleaned `url` and a 14-digit timestamp, never copied from `archives.tsv`.

**Backstop.** The privacy scan refuses `<script` and any external `src` or `href` not on the receipt list ([ADR 0012](0012-scan-the-page-before-and-after-rendering.md)).

## Considered Options

- **Embed fonts** (Atkinson Hyperlegible Next and Source Serif). Rejected in PR #20. System fonts remove the font byte check, its skip in the scan, and `font-src data:`, which leaves less for the scan to reason about. Type differs a little by device.

## Consequences

- Following a receipt link sends the reader to that source's site. `no-referrer` keeps the page's URL from being sent with the click.
- Some claims have no original-page link, for the reasons above.
- `noindex` covers only the `github.io` URL, not the repo's pages on github.com.
- The planned "My weights" screen needs JavaScript, which the CSP and the `<script` refusal forbid. It waits for a reviewed change to both.
