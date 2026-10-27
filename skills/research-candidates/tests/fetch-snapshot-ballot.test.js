"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
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
  // Value: protects=Rule 5's terminal guard: no TTY means a Bash call from the session, so the mode refuses before reading any file or URL; fails_when=requireTerminal moves after parsing or reading, or drops a condition; why_new=new; seam=cli; no_claim=a pty the session builds itself (the settings deny rule covers that)
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

  // Value: protects=a ledger whose last line has no newline fails before the manifest line is written, so no snapshot lands without its ledger line; fails_when=the check moves after save; why_new=new; seam=cli; no_claim=none
  it("refuses a ledger that does not end in a newline before saving", async () => {
    const data = ballotRepo();
    data.write(`${BALLOT}/ballot.ledger`, "hand-written");
    const url = "https://county.example.gov/sample";
    const result = await ballotVia(data, { [url]: { body: SAMPLE } }, [
      BALLOT,
      "sample_ballot",
      url,
    ]);
    assert.deepEqual(lines(result).slice(-1), ["ballot.ledger ledger-invalid"]);
    assert.ok(!data.exists(`${BALLOT}/snapshots.sha256`));
    assert.ok(!data.exists(`${BALLOT}/sources`));
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

  // Value: protects=a downloaded file is saved under its role's name with only the county origin as url, and nothing is fetched; fails_when=the file name or the full page URL is recorded, or the ledger says url; why_new=new; seam=cli; no_claim=none
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
      "none",
    ]);
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

  // Value: protects=only PDF or HTML files under downloads/ are read, after symlinks resolve; fails_when=the path check uses the unresolved path, or the type check trusts the extension alone; why_new=new; seam=cli; no_claim=none
  it("refuses a file outside downloads/ or of another type", async () => {
    const data = ballotRepo();
    data.write("outside.pdf", pdfBytes("x"));
    data.write("downloads/real.pdf", pdfBytes("x"));
    data.write("downloads/fake.pdf", "<html>not a pdf</html>");
    data.write("downloads/ballot.txt", "Jane Example");
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
  // A Bash rule's * stands in for any text (Claude Code permissions docs).
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

  // Value: protects=Rules 3 and 5: the model's file edits to the four script-only paths are denied, and so is every Bash call running a researcher-only mode; fails_when=a path or mode is dropped from the shipped settings; why_new=new; seam=none; no_claim=Bash commands that write files without naming them (the manifest covers those)
  it("denies the four script-only paths and the researcher-only modes", () => {
    for (const rule of [
      "Edit(/**/sources/**)",
      "Edit(/**/snapshots.sha256)",
      "Edit(/**/search-log/**)",
      "Edit(/**/ballot.ledger)",
    ]) {
      assert.ok(deny.includes(rule), `${rule} is not denied`);
    }
    const script = "node .claude/skills/research-candidates/scripts/fetch-snapshot";
    for (const command of [
      `${script} --ballot ${BALLOT} sample_ballot https://county.example.gov/`,
      `${script} --ballot --file ${BALLOT} sample_ballot downloads/b.pdf https://county.example.gov/`,
      `cd x && ${script} --ballot`,
      `${script} --file downloads/b.pdf`,
      "node scripts/ballot-check --show",
    ]) {
      assert.ok(bashDenies(command), `not denied: ${command}`);
    }
    assert.ok(!bashDenies(`${script} ${BALLOT} us-house-07 _race page https://x.example/`));
  });
});
