"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const { BALLOT, articlePage, runInTty } = require("./harness");
const {
  body,
  fetchSnapshot,
  frontMatter,
  repo,
  server,
  sha256,
} = require("./fetch-snapshot-fixture");

// Step 2's import, fetch-snapshot --ballot (snapshot-format.md, Command line
// and Ballot ledger). It runs only at the researcher's terminal, so the tests
// that get past the terminal guard run it on a pseudo-terminal and answer its
// prompt. pdftotext is replaced by a stub on PATH that prints whatever follows
// a "%%TEXT\n" marker in the PDF and logs its arguments.

const PDFTOTEXT_STUB = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.PDFTOTEXT_LOG, JSON.stringify(args) + "\\n");
const pdf = fs.readFileSync(args[args.length - 2], "latin1");
if (pdf.includes("%%BROKEN")) process.exit(1);
const at = pdf.indexOf("%%TEXT\\n");
process.stdout.write(at < 0 ? "\\f" : pdf.slice(at + 7));
`;
const pdfBytes = (text) => `%PDF-1.7\n%stub\n${text === null ? "" : `%%TEXT\n${text}`}`;

// A data repo with the pdftotext stub on PATH.
const ballotRepo = (options) => {
  const data = repo(options);
  fs.writeFileSync(path.join(data.bin, "pdftotext"), PDFTOTEXT_STUB, { mode: 0o755 });
  const log = path.join(data.bin, "pdftotext.log");
  fs.writeFileSync(log, "");
  data.env.PDFTOTEXT_LOG = log;
  data.pdftotextCalls = () =>
    fs.readFileSync(log, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  return data;
};

const SAMPLE = articlePage("Official sample ballot", [
  "Representative in Congress, 7th District. Vote for one.",
  "Jane Example, Example Party. John Sample, Sample Party.",
]);
const LOOKUP = "https://county.example.gov/ballot?addr=123+Elm+Street#top";

// Run --ballot on a pseudo-terminal through a local server holding `routes`.
const ballotVia = async (data, routes, args, { answer = "y", env = {} } = {}) => {
  const web = await server(routes);
  const result = await runInTty("fetch-snapshot", ["--ballot", ...args], {
    cwd: data.root,
    env: { ...data.env, RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target, ...env },
    answer,
  });
  return { ...result, seen: web.seen };
};
// The command's own lines: what the terminal showed after the prompt line.
const lines = (result) => result.stdout.split("\n").filter((l) => l && !l.includes("[y/N]"));
const ledger = (data) => data.read(`${BALLOT}/ballot.ledger`).split("\n").filter(Boolean);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// Nothing reached the ballot directory but its own two files (and the lock
// directory every run past the guards makes).
const assertNothingWritten = (data) => {
  const entries = data.list(BALLOT).filter((name) => name !== ".lock");
  assert.deepEqual(entries, ["ballot.yaml", "private.yaml"]);
  assert.deepEqual(data.list(`${BALLOT}/.lock`), []);
};

describe("fetch-snapshot --ballot runs only at the researcher's terminal", () => {
  // Value: protects=Rule 5's terminal guard: no TTY means a Bash call from the session, so the mode refuses before reading any file or URL; fails_when=requireTerminal moves after parsing or reading, or drops a condition; why_new=new; seam=cli; no_claim=a pty the session builds itself with CLAUDECODE unset (session-guard refuses those commands)
  it("refuses when stdout is not a terminal, before reading anything", async () => {
    // A repo that fails Rule 8 would answer guard-no-publish-yaml if the guard ran first.
    const data = ballotRepo({ publish: false });
    const web = await server({ [LOOKUP]: { body: SAMPLE } });
    for (const args of [
      ["--ballot", BALLOT, "sample_ballot", LOOKUP],
      [
        "--ballot",
        "--file",
        BALLOT,
        "sample_ballot",
        "downloads/x.pdf",
        "https://county.example.gov/",
      ],
      ["--ballot"],
    ]) {
      const result = await fetchSnapshot(data, args, {
        RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target,
      });
      assert.equal(result.stdout, "- not-a-terminal\n");
      assert.equal(result.status, 1);
    }
    assert.deepEqual(web.seen, []);
    assert.deepEqual(data.ghCalls(), []);
    assertNothingWritten(data);
  });

  // Value: protects=the CLAUDECODE half of the guard: the session's `!` prefix runs on a real terminal; fails_when=the CLAUDECODE check is dropped or reads only a non-empty value; why_new=new; seam=cli; no_claim=none
  it("refuses on a terminal when CLAUDECODE is set, even empty", async () => {
    for (const value of ["1", ""]) {
      const data = ballotRepo();
      const result = await ballotVia(
        data,
        { [LOOKUP]: { body: SAMPLE } },
        [BALLOT, "sample_ballot", LOOKUP],
        { env: { CLAUDECODE: value } },
      );
      assert.deepEqual(lines(result), ["- not-a-terminal"]);
      assert.equal(result.status, 1);
      assert.deepEqual(result.seen, []);
      assertNothingWritten(data);
    }
  });

  // Value: protects=each half of the TTY check on its own: the prompt reads stdin and the private text prints to stdout; fails_when=either the stdin or the stdout condition is dropped; why_new=the other tests pipe both or neither, so each condition hid the other; seam=cli; no_claim=none
  it("refuses when only stdin or only stdout is a terminal", async () => {
    for (const pipe of ["stdin", "stdout"]) {
      const data = ballotRepo();
      const web = await server({ [LOOKUP]: { body: SAMPLE } });
      const result = await runInTty(
        "fetch-snapshot",
        ["--ballot", BALLOT, "sample_ballot", LOOKUP],
        {
          cwd: data.root,
          env: { ...data.env, RESEARCH_CANDIDATES_TEST_HTTP_TARGET: web.target },
          pipe,
        },
      );
      assert.deepEqual(lines(result), ["- not-a-terminal"], pipe);
      assert.equal(result.status, 1);
      assert.deepEqual(web.seen, []);
      assertNothingWritten(data);
    }
  });
});

describe("fetch-snapshot --ballot saves a _ballot snapshot", () => {
  // Value: protects=the URL and role are shown and the query (the address) leaves the machine only after a yes, and the record drops it; fails_when=the prompt is skipped, the recorded url keeps its query or fragment, or the name comes from the URL; why_new=new; seam=cli; no_claim=none
  it("asks first, fetches the URL as given and records it without query or fragment", async () => {
    const data = ballotRepo();
    const result = await ballotVia(
      data,
      { "https://county.example.gov/ballot?addr=123+Elm+Street": { body: SAMPLE } },
      [BALLOT, "sample_ballot", LOOKUP],
    );
    assert.match(
      result.stdout,
      /^Fetch https:\/\/county\.example\.gov\/ballot\?addr=123\+Elm\+Street#top as sample_ballot\? \[y\/N\] /,
    );
    assert.deepEqual(lines(result), ["sources/_ballot/sample-ballot.md saved"]);
    assert.equal(result.status, 0);
    assert.deepEqual(result.seen, ["https://county.example.gov/ballot?addr=123+Elm+Street"]);

    const text = data.read(`${BALLOT}/sources/_ballot/sample-ballot.md`);
    const fields = Object.fromEntries(frontMatter(text));
    assert.deepEqual(Object.keys(fields), [
      "source",
      "url",
      "fetched",
      "method",
      "tier",
      "statements_only",
      "subject",
      "owner",
      "role",
    ]);
    assert.equal(fields.url, "https://county.example.gov/ballot");
    assert.equal(fields.source, "Exampleton County elections");
    assert.equal(fields.method, "html");
    assert.equal(fields.tier, "T1");
    assert.equal(fields.subject, "_ballot");
    assert.equal(fields.owner, "third-party");
    assert.equal(fields.role, "sample_ballot");
    assert.match(body(text), /Jane Example, Example Party/);
    assert.ok(!text.includes("Elm"), "the address reached the snapshot");

    assert.equal(
      data.read(`${BALLOT}/snapshots.sha256`),
      `${sha256(text)}  sources/_ballot/sample-ballot.md\n`,
    );
    const [line] = ledger(data);
    const fieldsOf = line.split("\t");
    assert.deepEqual(fieldsOf.slice(0, 4), [
      "sources/_ballot/sample-ballot.md",
      "sample_ballot",
      "url",
      "query",
    ]);
    assert.match(fieldsOf[4], DATE);
    assert.equal(fieldsOf.length, 5);
    assert.ok(!data.exists(`${BALLOT}/unfetchable.md`));
  });

  // Value: protects=names come from the role, numbered on a re-save, and each save gets its own ledger line; fails_when=a re-save overwrites or skips the ledger, or the query flag is always set; why_new=new; seam=cli; no_claim=supersedes (not built)
  it("names each snapshot by its role and logs every one", async () => {
    const data = ballotRepo();
    const routes = {
      "https://county.example.gov/sample": { body: SAMPLE },
      "https://county.example.gov/candidates": { body: SAMPLE },
    };
    for (const [role, url] of [
      ["sample_ballot", "https://county.example.gov/sample"],
      ["sample_ballot", "https://county.example.gov/sample"],
      ["candidate_list", "https://county.example.gov/candidates"],
    ]) {
      const result = await ballotVia(data, routes, [BALLOT, role, url]);
      assert.equal(result.status, 0, result.stdout);
    }
    assert.deepEqual(data.list(`${BALLOT}/sources/_ballot`), [
      "candidate-list.md",
      "sample-ballot-2.md",
      "sample-ballot.md",
    ]);
    assert.deepEqual(
      ledger(data).map((l) => l.split("\t").slice(0, 4).join(" ")),
      [
        "sources/_ballot/sample-ballot.md sample_ballot url none",
        "sources/_ballot/sample-ballot-2.md sample_ballot url none",
        "sources/_ballot/candidate-list.md candidate_list url none",
      ],
    );
  });

  // Value: protects=a redirect that adds a query still marks the ledger line, so ballot-check can refuse a personalized companion; fails_when=only the given URL's query is read; why_new=new; seam=cli; no_claim=none
  it("marks a query picked up on a redirect", async () => {
    const data = ballotRepo();
    const result = await ballotVia(
      data,
      {
        "https://county.example.gov/pamphlet": {
          status: 302,
          headers: { location: "/pamphlet?voter=8812" },
        },
        "https://county.example.gov/pamphlet?voter=8812": { body: SAMPLE },
      },
      [BALLOT, "pamphlet", "https://county.example.gov/pamphlet"],
    );
    assert.equal(result.status, 0, result.stdout);
    assert.deepEqual(ledger(data)[0].split("\t").slice(2, 4), ["url", "query"]);
    const fields = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/_ballot/pamphlet.md`)),
    );
    assert.equal(fields.url, "https://county.example.gov/pamphlet");
  });

  // Value: protects=anything but yes saves nothing and sends nothing; fails_when=confirm defaults to yes or runs after the fetch; why_new=new; seam=cli; no_claim=none
  it("saves and sends nothing without a yes", async () => {
    for (const answer of ["n", "", "yep"]) {
      const data = ballotRepo();
      const result = await ballotVia(
        data,
        { [LOOKUP]: { body: SAMPLE } },
        [BALLOT, "sample_ballot", LOOKUP],
        {
          answer,
        },
      );
      assert.deepEqual(lines(result).slice(-1), ["_ballot not-confirmed"]);
      assert.equal(result.status, 1);
      assert.deepEqual(result.seen, []);
      assertNothingWritten(data);
    }
  });

  // Value: protects=the ledger line comes after the manifest line: a crash between them leaves a manifest line with no ledger line (which ballot-check refuses), never a ledger line for a snapshot the manifest does not list; fails_when=the ledger line moves before the manifest write; why_new=no test pinned the order snapshot-format.md promises; seam=cli; no_claim=ballot-check's handling (ticket 05)
  it("writes no ledger line when it dies right after the manifest line", async () => {
    const data = ballotRepo();
    const url = "https://county.example.gov/sample";
    const result = await ballotVia(
      data,
      { [url]: { body: SAMPLE } },
      [BALLOT, "sample_ballot", url],
      {
        env: { RESEARCH_CANDIDATES_TEST_CRASH: "after-manifest" },
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(
      data.read(`${BALLOT}/snapshots.sha256`),
      / {2}sources\/_ballot\/sample-ballot\.md\n$/,
    );
    assert.ok(!data.exists(`${BALLOT}/ballot.ledger`), "a ledger line was written");
    assert.ok(!data.exists(`${BALLOT}/sources/_ballot/sample-ballot.md`));
  });

  // Value: protects=the ledger line comes before the file lands, so a failed ledger write leaves no snapshot in sources/; fails_when=the ledger line moves after the link; why_new=no test pinned the order; seam=cli; no_claim=none
  it("lands no snapshot when the ledger line cannot be written", async () => {
    const data = ballotRepo();
    data.write(`${BALLOT}/ballot.ledger`, "");
    fs.chmodSync(data.file(`${BALLOT}/ballot.ledger`), 0o444);
    const url = "https://county.example.gov/sample";
    const result = await ballotVia(data, { [url]: { body: SAMPLE } }, [
      BALLOT,
      "sample_ballot",
      url,
    ]);
    // The pseudo-terminal shows stderr too, so the stack follows the code line.
    assert.ok(lines(result).includes("- internal-error"), result.stdout);
    assert.match(result.stdout, /EACCES/);
    assert.ok(!data.exists(`${BALLOT}/sources/_ballot/sample-ballot.md`));
  });

  // Value: protects=a PDF sent as a download (octet-stream) is saved as a PDF when its bytes say so, and a non-PDF octet stream is still refused; fails_when=octet streams are refused, or saved without the %PDF- check; why_new=county sites often send PDFs this way; seam=cli; no_claim=none
  it("accepts a PDF sent as an octet stream, by its first bytes", async () => {
    for (const [bytes, out] of [
      [pdfBytes("Jane Example\n"), "sources/_ballot/sample-ballot.md saved"],
      ["PK\x03\x04 a zip", "_ballot not-html"],
    ]) {
      const data = ballotRepo();
      const url = "https://county.example.gov/ballot";
      const result = await ballotVia(
        data,
        { [url]: { headers: { "content-type": "application/octet-stream" }, body: bytes } },
        [BALLOT, "sample_ballot", url],
      );
      assert.deepEqual(lines(result).slice(-1), [out]);
    }
  });

  // Value: protects=an HTML page that redirects to a PDF is saved as the PDF, at the redirect's URL with credentials, query and fragment dropped; fails_when=the PDF branch only runs on the first hop, or the recorded URL keeps credentials; why_new=new; seam=cli; no_claim=none
  it("follows a redirect to a PDF and records its clean URL", async () => {
    const data = ballotRepo();
    const result = await ballotVia(
      data,
      {
        "https://county.example.gov/ballot": {
          status: 302,
          headers: { location: "https://me:pw@county.example.gov/files/ballot.pdf?v=2" },
        },
        "https://me:pw@county.example.gov/files/ballot.pdf?v=2": {
          headers: { "content-type": "application/pdf" },
          body: pdfBytes("Jane Example\n"),
        },
      },
      [BALLOT, "sample_ballot", "https://county.example.gov/ballot"],
    );
    assert.deepEqual(lines(result), ["sources/_ballot/sample-ballot.md saved"]);
    const fields = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/_ballot/sample-ballot.md`)),
    );
    assert.equal(fields.method, "pdf");
    assert.equal(fields.url, "https://county.example.gov/files/ballot.pdf");
    assert.deepEqual(ledger(data)[0].split("\t").slice(2, 4), ["url", "query"]);
  });
});

describe("fetch-snapshot --ballot refusals", () => {
  // Value: protects=the address in a query goes only to a T1 host, on every hop, and no refusal is logged; fails_when=the T1 check runs only on the first or last hop, or a refusal reaches unfetchable.md; why_new=new; seam=cli; no_claim=none
  it("requires a T1 host before the prompt and on every hop", async () => {
    const cases = [
      ["https://news.example.com/ballot?addr=1", "not-t1", []],
      ["https://unknown.example.net/ballot", "domain-not-in-tiers", []],
      ["https://county.example.gov/hop", "not-t1", ["https://county.example.gov/hop"]],
    ];
    for (const [url, code, seen] of cases) {
      const data = ballotRepo();
      const result = await ballotVia(
        data,
        {
          "https://county.example.gov/hop": {
            status: 302,
            headers: { location: "https://news.example.com/ballot?addr=123+Elm+Street" },
          },
        },
        [BALLOT, "sample_ballot", url],
      );
      assert.deepEqual(lines(result).slice(-1), [`_ballot ${code}`]);
      assert.equal(result.status, 1);
      assert.deepEqual(result.seen, seen);
      assertNothingWritten(data);
    }
  });

  // Value: protects=a private value in the path is refused (dropping the query cannot unsend it) with a pointer to --file, while the query may hold the address; key values are refused anywhere; fails_when=the path check is dropped, the query is checked, or the hint is missing; why_new=new; seam=cli; no_claim=every spelling (privacy.test.js)
  it("refuses a private value in the path and points to --file", async () => {
    for (const [url, out] of [
      [
        "https://county.example.gov/springfield-township/ballot?x=1",
        ["_ballot private-string", "- use-ballot-file"],
      ],
      ["https://county.example.gov/99999/ballot", ["_ballot private-zip", "- use-ballot-file"]],
      [
        "https://county.example.gov/123-elm-street",
        ["_ballot private-address", "- use-ballot-file"],
      ],
      ["https://county.example.gov/ballot?k=s3cr3t-fec-key", ["_ballot private-key"]],
    ]) {
      const data = ballotRepo();
      const result = await ballotVia(
        data,
        { [url]: { body: SAMPLE } },
        [BALLOT, "sample_ballot", url],
        {
          env: { OPENFEC_API_KEY: "s3cr3t-fec-key" },
        },
      );
      assert.deepEqual(lines(result), out);
      assert.ok(!result.stdout.includes("[y/N]"), "asked before refusing");
      assert.deepEqual(result.seen, []);
      assertNothingWritten(data);
    }
  });

  // Value: protects=a redirect's path is checked like the first URL's, before it is requested; fails_when=the ballot check callback is not passed to fetchPage; why_new=new; seam=cli; no_claim=none
  it("checks every redirect's path before requesting it", async () => {
    const data = ballotRepo();
    const result = await ballotVia(
      data,
      {
        "https://county.example.gov/go?addr=123+Elm+Street": {
          status: 302,
          headers: { location: "/precinct-12/ballot" },
        },
      },
      [BALLOT, "sample_ballot", "https://county.example.gov/go?addr=123+Elm+Street"],
    );
    assert.deepEqual(lines(result), ["_ballot private-string", "- use-ballot-file"]);
    assert.deepEqual(result.seen, ["https://county.example.gov/go?addr=123+Elm+Street"]);
    assertNothingWritten(data);
  });

  // Value: protects=--ballot failures stay at the terminal: never logged to unfetchable.md; fails_when=ballot mode reuses the plain fetch's logUnfetchable; why_new=new; seam=cli; no_claim=none
  it("never logs a failed fetch to unfetchable.md", async () => {
    const data = ballotRepo();
    const url = "https://county.example.gov/ballot?addr=123+Elm+Street";
    for (const route of [{ status: 500 }, { headers: { "content-type": "image/png" } }]) {
      const result = await ballotVia(data, { [url]: route }, [BALLOT, "sample_ballot", url]);
      assert.equal(result.status, 1);
      assert.match(lines(result).slice(-1)[0], /^_ballot (http-error|not-html)$/);
    }
    assertNothingWritten(data);
  });

  // Value: protects=a ledger or manifest whose last line has no newline fails before the prompt, so the address is not sent for a save that cannot happen, and no snapshot lands without its ledger line; fails_when=the checks move after the prompt or the fetch; why_new=the review found the URL was sent first; seam=cli; no_claim=none
  it("refuses a ledger or manifest that does not end in a newline before asking", async () => {
    for (const [file, code] of [
      ["ballot.ledger", "ballot.ledger ledger-invalid"],
      ["snapshots.sha256", "snapshots.sha256 manifest-invalid"],
    ]) {
      const data = ballotRepo();
      data.write(`${BALLOT}/${file}`, "hand-written");
      const url = "https://county.example.gov/sample";
      const result = await ballotVia(data, { [url]: { body: SAMPLE } }, [
        BALLOT,
        "sample_ballot",
        url,
      ]);
      assert.deepEqual(lines(result), [code]);
      assert.ok(!result.stdout.includes("[y/N]"), "asked before refusing");
      assert.deepEqual(result.seen, []);
      assert.ok(!data.exists(`${BALLOT}/sources`));
    }
  });

  // Value: protects=bad arguments answer with a code before any prompt; fails_when=parseArgs accepts an unknown role or a credentialed URL; why_new=new; seam=cli; no_claim=none
  it("answers bad arguments with a code", async () => {
    const data = ballotRepo();
    for (const [args, code] of [
      [[BALLOT, "sample_ballot"], "- usage"],
      [[BALLOT, "ballot", "https://county.example.gov/"], "- bad-role"],
      [["2026-general/x", "sample_ballot", "https://county.example.gov/"], "- bad-ballot"],
      [[BALLOT, "sample_ballot", "https://me:pw@county.example.gov/"], "- bad-url"],
      [["--file", BALLOT, "sample_ballot", "downloads/x.pdf"], "- usage"],
    ]) {
      const result = await ballotVia(data, {}, args);
      assert.deepEqual(lines(result), [code]);
    }
    assertNothingWritten(data);
  });
});

describe("fetch-snapshot --ballot PDFs", () => {
  // Value: protects=a PDF ballot is saved as pdftotext's plain output (no -layout) with method pdf; fails_when=PDFs are refused as not-html or converted with -layout; why_new=new; seam=cli; no_claim=real poppler output
  it("converts a fetched PDF with plain pdftotext", async () => {
    const data = ballotRepo();
    const url = "https://county.example.gov/ballot.pdf";
    const result = await ballotVia(
      data,
      {
        [url]: {
          headers: { "content-type": "application/pdf" },
          body: pdfBytes("Jane Example\fJohn Sample\n"),
        },
      },
      [BALLOT, "sample_ballot", url],
    );
    assert.deepEqual(lines(result), ["sources/_ballot/sample-ballot.md saved"]);
    const text = data.read(`${BALLOT}/sources/_ballot/sample-ballot.md`);
    assert.equal(Object.fromEntries(frontMatter(text)).method, "pdf");
    assert.equal(body(text), "Jane Example\nJohn Sample\n");
    const [call] = data.pdftotextCalls();
    assert.ok(!call.includes("-layout"), "_ballot PDFs use plain pdftotext");
    assert.deepEqual(call.slice(-1), ["-"]);
  });

  // Value: protects=a scanned PDF fails loudly instead of saving an empty snapshot; fails_when=empty pdftotext output is saved; why_new=new; seam=cli; no_claim=OCR
  it("fails a PDF with no text layer and one pdftotext cannot read", async () => {
    for (const [bytes, code] of [
      [pdfBytes(null), "pdf-no-text"],
      [pdfBytes("  \n\f\n"), "pdf-no-text"],
      ["%PDF-1.7\n%%BROKEN\n", "pdf-unreadable"],
    ]) {
      const data = ballotRepo();
      const url = "https://county.example.gov/ballot.pdf";
      const result = await ballotVia(
        data,
        { [url]: { headers: { "content-type": "application/pdf" }, body: bytes } },
        [BALLOT, "sample_ballot", url],
      );
      assert.deepEqual(lines(result).slice(-1), [`_ballot ${code}`]);
      assertNothingWritten(data);
    }
  });
});

describe("fetch-snapshot --ballot --file", () => {
  const ORIGIN_PAGE = "https://county.example.gov/elections/precinct-lookup";

  // Value: protects=a downloaded file is saved under its role's name with only the county origin as url, and nothing is fetched; the ledger says the query is unknown, never none; fails_when=the file name or the full page URL is recorded, or the ledger says url or none; why_new=new; seam=cli; no_claim=none
  it("saves a PDF from downloads/ with the origin as its URL", async () => {
    const data = ballotRepo();
    data.write("downloads/sample-ballot-springfield-twp-pct12.pdf", pdfBytes("Jane Example\n"));
    const result = await ballotVia(data, {}, [
      "--file",
      BALLOT,
      "sample_ballot",
      "downloads/sample-ballot-springfield-twp-pct12.pdf",
      "https://county.example.gov/elections/",
    ]);
    assert.deepEqual(lines(result), ["sources/_ballot/sample-ballot.md saved"]);
    assert.deepEqual(result.seen, []);
    const fields = Object.fromEntries(
      frontMatter(data.read(`${BALLOT}/sources/_ballot/sample-ballot.md`)),
    );
    assert.equal(fields.url, "https://county.example.gov/");
    assert.equal(fields.method, "pdf");
    assert.equal(fields.tier, "T1");
    assert.deepEqual(ledger(data)[0].split("\t").slice(0, 4), [
      "sources/_ballot/sample-ballot.md",
      "sample_ballot",
      "file",
      "unknown",
    ]);
  });

  // Value: protects=a query on the page URL the researcher gives is recorded, so ballot-check can refuse a personalized companion, and an API key there is never recorded; fails_when=--file always writes unknown, or records more than the origin; why_new=the review's D3 decision; seam=cli; no_claim=the download URL's own query (unknowable)
  it("records a query on the page URL and only the origin", async () => {
    const data = ballotRepo();
    data.write("downloads/pamphlet.pdf", pdfBytes("Measure A\n"));
    const result = await ballotVia(
      data,
      {},
      [
        "--file",
        BALLOT,
        "pamphlet",
        "downloads/pamphlet.pdf",
        "https://county.example.gov/lookup?addr=123+Elm+Street&k=s3cr3t-fec-key",
      ],
      { env: { OPENFEC_API_KEY: "s3cr3t-fec-key" } },
    );
    assert.deepEqual(lines(result), ["sources/_ballot/pamphlet.md saved"]);
    const text = data.read(`${BALLOT}/sources/_ballot/pamphlet.md`);
    assert.equal(Object.fromEntries(frontMatter(text)).url, "https://county.example.gov/");
    assert.ok(!text.includes("s3cr3t") && !text.includes("Elm"));
    assert.deepEqual(ledger(data)[0].split("\t").slice(2, 4), ["file", "query"]);
  });

  // Value: protects=the tier comes from the page URL, so a T1 entry with a path prefix works and a T1 host does not vouch for a lower-tier path, while only the origin is recorded and a private value in the page path is allowed (it is why --file exists); fails_when=the tier is matched on the origin; why_new=the review found path-prefixed T1 entries refused; seam=cli; no_claim=none
  it("matches the tier on the page URL, not its origin", async () => {
    const tiers = `- match: county.example.gov
  tier: T2
  owner: third-party
  source: Exampleton County
- match: county.example.gov/elections
  tier: T1
  owner: third-party
  source: Exampleton County elections office
`;
    for (const [page, out, source] of [
      [
        "https://county.example.gov/elections/precinct-12/sample",
        "sources/_ballot/sample-ballot.md saved",
        "Exampleton County elections office",
      ],
      ["https://county.example.gov/news/sample", "_ballot not-t1", null],
    ]) {
      const data = ballotRepo({ tiers });
      data.write("downloads/b.pdf", pdfBytes("Jane Example\n"));
      const result = await ballotVia(data, {}, [
        "--file",
        BALLOT,
        "sample_ballot",
        "downloads/b.pdf",
        page,
      ]);
      assert.deepEqual(lines(result), [out], page);
      if (source) {
        const fields = Object.fromEntries(
          frontMatter(data.read(`${BALLOT}/sources/_ballot/sample-ballot.md`)),
        );
        assert.equal(fields.source, source);
        assert.equal(fields.url, "https://county.example.gov/");
      }
    }
  });

  // Value: protects=a private value in the recorded origin is refused (no --file hint: this is --file); fails_when=--file skips the origin check; why_new=no test reached the branch; seam=cli; no_claim=every spelling (privacy.test.js)
  it("refuses a private value in the origin", async () => {
    const data = ballotRepo();
    data.write("downloads/b.pdf", pdfBytes("x"));
    const result = await ballotVia(data, {}, [
      "--file",
      BALLOT,
      "sample_ballot",
      "downloads/b.pdf",
      "https://springfield-township.example.gov/ballot",
    ]);
    assert.deepEqual(lines(result), ["_ballot private-string"]);
    assert.ok(!result.stdout.includes("[y/N]"));
    assertNothingWritten(data);
  });

  // Value: protects=a saved page is read in the charset its <meta> names, and one with no charset that is not UTF-8 is refused rather than garbled; fails_when=--file decodes every file as UTF-8; why_new=the review found accented names garbled; seam=cli; no_claim=UTF-16 files
  it("reads an HTML file in its own charset", async () => {
    const notice = articlePage("Withdrawal notice", [
      "María Peña has withdrawn from the race for county commissioner.",
      "Her name stays printed on the ballot; votes for her will not be counted.",
    ]);
    // windows-1252 bytes: á, í and ñ are single bytes that are not valid UTF-8.
    const page = (meta) => Buffer.from(notice.replace("<head>", `<head>${meta}`), "latin1");
    for (const [meta, out] of [
      ['<meta charset="windows-1252">', "sources/_ballot/withdrawal-notice.md saved"],
      ["", "_ballot bad-file"],
    ]) {
      const data = ballotRepo();
      fs.mkdirSync(data.file("downloads"), { recursive: true });
      fs.writeFileSync(data.file("downloads/notice.html"), page(meta));
      const result = await ballotVia(data, {}, [
        "--file",
        BALLOT,
        "withdrawal_notice",
        "downloads/notice.html",
        "https://county.example.gov/",
      ]);
      assert.deepEqual(lines(result), [out]);
      if (meta) {
        assert.match(data.read(`${BALLOT}/sources/_ballot/withdrawal-notice.md`), /María Peña/);
      }
    }
  });

  // Value: protects=an HTML file is read as a page; fails_when=--file accepts only PDFs; why_new=new; seam=cli; no_claim=none
  it("saves an HTML file as html", async () => {
    const data = ballotRepo();
    data.write("downloads/notice.html", SAMPLE);
    const result = await ballotVia(data, {}, [
      "--file",
      BALLOT,
      "withdrawal_notice",
      "downloads/notice.html",
      "https://county.example.gov/",
    ]);
    assert.deepEqual(lines(result), ["sources/_ballot/withdrawal-notice.md saved"]);
    const text = data.read(`${BALLOT}/sources/_ballot/withdrawal-notice.md`);
    assert.equal(Object.fromEntries(frontMatter(text)).method, "html");
    assert.match(body(text), /John Sample, Sample Party/);
  });

  // Value: protects=only PDF or HTML files under downloads/ are read, after symlinks resolve; fails_when=the path check uses the unresolved path, or the type check trusts the extension alone (for HTML too); why_new=new; seam=cli; no_claim=none
  it("refuses a file outside downloads/ or of another type", async () => {
    const data = ballotRepo();
    data.write("outside.pdf", pdfBytes("x"));
    data.write("downloads/real.pdf", pdfBytes("x"));
    data.write("downloads/fake.pdf", "<html>not a pdf</html>");
    data.write("downloads/ballot.txt", "Jane Example");
    data.write("downloads/archive.html", "PK\x03\x04 a zip, not a page");
    data.write("downloads/sub/ok.html", SAMPLE);
    fs.symlinkSync(data.file("outside.pdf"), data.file("downloads/link.pdf"));
    for (const [file, code] of [
      ["outside.pdf", "file-not-in-downloads"],
      ["downloads/../outside.pdf", "file-not-in-downloads"],
      ["downloads/link.pdf", "file-not-in-downloads"],
      ["downloads/missing.pdf", "file-not-in-downloads"],
      ["downloads", "file-not-in-downloads"],
      ["downloads/sub", "bad-file"],
      ["downloads/fake.pdf", "bad-file"],
      ["downloads/ballot.txt", "bad-file"],
      ["downloads/archive.html", "bad-file"],
    ]) {
      const result = await ballotVia(data, {}, [
        "--file",
        BALLOT,
        "sample_ballot",
        file,
        "https://county.example.gov/",
      ]);
      assert.deepEqual(lines(result), [`_ballot ${code}`], file);
    }
    assert.ok(!data.exists(`${BALLOT}/sources`));
    assert.ok(!data.exists(`${BALLOT}/ballot.ledger`));
  });

  // Value: protects=--file's origin must be T1 like a fetched URL; fails_when=--file skips the tier lookup; why_new=new; seam=cli; no_claim=none
  it("requires a T1 origin", async () => {
    const data = ballotRepo();
    data.write("downloads/b.pdf", pdfBytes("x"));
    const result = await ballotVia(data, {}, [
      "--file",
      BALLOT,
      "sample_ballot",
      "downloads/b.pdf",
      ORIGIN_PAGE.replace("county.example.gov", "news.example.com"),
    ]);
    assert.deepEqual(lines(result), ["_ballot not-t1"]);
  });
});

describe("the data repo's Claude Code settings", () => {
  const settings = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "data-repo-settings.json"), "utf8"),
  );
  const deny = settings.permissions.deny;
  // A Bash rule's * stands in for any text (Claude Code permissions docs). This
  // models the matcher; the hook below is tested by running it.
  const bashDenies = (command) =>
    deny
      .filter((rule) => rule.startsWith("Bash("))
      .map((rule) => rule.slice(5, -1))
      .some((pattern) =>
        new RegExp(
          `^${pattern
            .split("*")
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
        ).test(command),
      );
  const script = "node .claude/skills/research-candidates/scripts/fetch-snapshot";

  // Value: protects=Rules 3 and 5: the model's file edits to the four script-only paths and to downloads/ are denied, and so is every plain Bash call running a researcher-only mode, while git and rg flags that share a prefix are not; fails_when=a path or mode is dropped, or a rule widens to every --show or --file; why_new=the review found git branch --show-current and rg --files denied; seam=none; no_claim=Bash commands that write files or build flags at run time (session-guard narrows those)
  it("denies the script-only paths, downloads/ and the researcher-only modes, nothing else", () => {
    for (const rule of [
      "Edit(/**/sources/**)",
      "Edit(/**/snapshots.sha256)",
      "Edit(/**/search-log/**)",
      "Edit(/**/ballot.ledger)",
      "Edit(/**/published.log)",
      "Edit(/downloads/**)",
    ]) {
      assert.ok(deny.includes(rule), `${rule} is not denied`);
    }
    for (const command of [
      `${script} --ballot ${BALLOT} sample_ballot https://county.example.gov/`,
      `${script} --ballot --file ${BALLOT} sample_ballot downloads/b.pdf https://county.example.gov/`,
      `cd x && ${script} --ballot`,
      "node scripts/ballot-check --show",
      "node scripts/publish --show",
      `node scripts/publish --push ${BALLOT}`,
      `node scripts/publish --device-check ${BALLOT}`,
      `${script} --keep-short ${BALLOT} us-house-07 _race page https://county.example.gov/`,
    ]) {
      assert.ok(bashDenies(command), `not denied: ${command}`);
    }
    for (const command of [
      `${script} ${BALLOT} us-house-07 _race page https://x.example/`,
      "git branch --show-current",
      "git rev-parse --show-toplevel",
      "rg --files",
      "git commit --file=msg.txt",
      "git status --short",
      `node scripts/publish ${BALLOT}`,
      "git push --push-option=x origin main",
    ]) {
      assert.ok(!bashDenies(command), `denied: ${command}`);
    }
  });

  // A data repo holding the skill where the hook command expects it.
  const projectWithSkill = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hook-"));
    fs.mkdirSync(path.join(dir, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(
      path.join(__dirname, ".."),
      path.join(dir, ".claude", "skills", "research-candidates"),
    );
    return dir;
  };
  const [hookGroup] = settings.hooks.PreToolUse;
  // Run the hook command as Claude Code does: through the shell, the tool call on stdin.
  const runHook = (project, call) =>
    spawnSync("sh", ["-c", hookGroup.hooks[0].command], {
      input: typeof call === "string" ? call : JSON.stringify(call),
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      encoding: "utf8",
    });
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

  // Value: protects=D1: the PreToolUse hook refuses the commands that got past the terminal guard in review (CLAUDECODE unset under a pty), quoted flags, and Bash writes to script-only files, and lets ordinary commands run; it fails closed when it cannot run; fails_when=a refusal is dropped, the hook widens to git or rg flags, or a hook failure lets the call through; why_new=the review bypassed the guard from a session; seam=hook; no_claim=a flag or name built at run time (documented)
  it("runs a PreToolUse hook that refuses guard bypasses and fails closed", () => {
    assert.deepEqual(hookGroup.matcher.split("|").sort(), [
      "Bash",
      "Edit",
      "MultiEdit",
      "NotebookEdit",
      "Write",
    ]);
    const project = projectWithSkill();
    try {
      for (const [call, code] of [
        [
          bash(`${script} --ballot ${BALLOT} sample_ballot https://county.example.gov/`),
          "researcher-only-mode",
        ],
        [
          bash(`${script} --bal''lot ${BALLOT} sample_ballot https://county.example.gov/`),
          "researcher-only-mode",
        ],
        [bash(`F=x; node scripts/ballot-check "--show"`), "researcher-only-mode"],
        [bash(`node scripts/publish --pu''sh ${BALLOT}`), "researcher-only-mode"],
        [bash(`yes | node scripts/publish --device-check ${BALLOT}`), "researcher-only-mode"],
        [bash(`echo k3x9qa >> ${BALLOT}/published.log`), "script-only-file"],
        [
          bash(
            `${script} --keep-short ${BALLOT} us-house-07 _race page https://county.example.gov/`,
          ),
          "researcher-only-mode",
        ],
        [
          bash("(sleep 1; printf 'y\\n') | env -u CLAUDECODE script -q /dev/null node x.js"),
          "terminal-guard-bypass",
        ],
        [bash("unset CLAUDE''CODE; node x.js"), "terminal-guard-bypass"],
        [bash("env -i PATH=/usr/bin node x.js"), "terminal-guard-bypass"],
        [bash('python3 -c \'import pty; pty.spawn(["node", "x.js"])\''), "terminal-guard-bypass"],
        [bash("nohup /usr/bin/script -q /dev/null node x.js"), "terminal-guard-bypass"],
        [bash("cat page.html > downloads/x.html"), "script-only-file"],
        [bash(`printf 'x\\n' >> ${BALLOT}/ballot.ledger`), "script-only-file"],
        [bash(`echo x >> ${BALLOT}/snapshots.sha256`), "script-only-file"],
        [
          {
            tool_name: "Write",
            tool_input: { file_path: "/r/x.sh", content: `${script} --ballot a b c` },
          },
          "researcher-only-mode",
        ],
        [
          {
            tool_name: "MultiEdit",
            tool_input: {
              file_path: "/r/x.js",
              edits: [{ old_string: "a", new_string: "delete process.env.CLAUDECODE" }],
            },
          },
          "terminal-guard-bypass",
        ],
        ["not json", "hook-input-invalid"],
        [{ tool_name: "Bash", tool_input: {} }, "hook-input-invalid"],
      ]) {
        const result = runHook(project, call);
        assert.equal(result.status, 2, JSON.stringify(call));
        assert.match(result.stderr, new RegExp(` ${code}\\n$`), JSON.stringify(call));
        assert.ok(!result.stderr.includes("county"), "the hook echoed the command");
      }
      for (const call of [
        bash(`${script} ${BALLOT} us-house-07 _race page https://county.example.gov/`),
        bash("git branch --show-current && git rev-parse --show-toplevel"),
        bash("rg --files sources/ | head"),
        bash("git commit --file=msg.txt"),
        bash(`node scripts/publish ${BALLOT}`),
        bash("git push --push-option=x origin main"),
        bash("git status --short && git log --shortstat -1"),
        bash("grep -rn 'empty' sources/us-house-07"),
        {
          tool_name: "Write",
          tool_input: { file_path: "/r/articles/a.md", content: "Jane Example said…" },
        },
        { tool_name: "Read", tool_input: { file_path: "/r/downloads/b.pdf" } },
      ]) {
        const result = runHook(project, call);
        assert.equal(result.status, 0, `${JSON.stringify(call)}: ${result.stderr}`);
      }
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
    // Without the skill installed, the hook cannot run, and refuses.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "rc-hook-"));
    try {
      assert.equal(runHook(empty, bash("ls")).status, 2);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
