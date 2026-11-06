---
status: accepted
---

# API keys stay out of every record

Snapshot metadata is committed, receipts are rendered from it, and an API can echo its request in the response. A key placed in a URL could therefore reach a public page by several routes. Keys are read from the environment, sent only as a header to the one host they belong to, and refused wherever one shows up in text.

## Enforcement

- **Sending.** `OPENFEC_API_KEY` goes only to `api.open.fec.gov` and `OPENSTATES_API_KEY` only to `v3.openstates.org`, over https, as the `X-Api-Key` header ([`constants.js`](../../../skills/research-candidates/scripts/lib/constants.js), [`fetch-page.js`](../../../skills/research-candidates/scripts/lib/fetch-page.js)). A request to either host has its key parameters dropped, so a key the caller put in the URL is never sent.
- **Recording.** `fetch-snapshot` removes any query parameter whose name matches `/^(api[_-]?key|key|token|access[_-]?token|secret|sig(nature)?)$/i` from every URL it records, in snapshots and in `unfetchable.md`.
- **Refusing.** A URL holding a key value refuses with `private-key`. So does a page or API response that holds one, raw or as saved, which is never saved or logged. That covers an API echoing its request.
- **Credentials.** A URL with a username or password fails `bad-url`.
- **Publishing.** The page scan refuses a key value and any key-named query parameter. Key values are matched raw and decoded, with default-ignorable characters removed too, since a browser draws a soft hyphen inside a key as nothing.

## Consequences

- The matcher knows only the values of those two variables. A different secret in a URL is caught only by its parameter name, and one in a URL path is not caught at all.
- Key parameters are removed from what is recorded on any host. On hosts other than the two API hosts, the request itself is sent as given.
- A `method: api` snapshot needs a `public_url` for an original-page link, because its cleaned URL has no key and opens an error ([ADR 0013](0013-pages-are-self-contained.md)).
