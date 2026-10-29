"use strict";

// fetch-snapshot --ballot <election>/<ballot-id> <role> <url>
// fetch-snapshot --ballot --file <election>/<ballot-id> <role> <path> <url>
//
// Step 2, researcher only: save the official sample ballot or a companion
// document as sources/_ballot/<role>.md (snapshot-format.md). A county lookup
// URL may carry the address in its query, so this mode runs only at the
// researcher's own terminal, shows the URL and role and asks first, requires a
// T1 host on every hop, and records the URL with its query and fragment
// dropped. A private value in the URL's path is refused, since dropping it
// would not keep it from being sent: the researcher downloads the file into
// downloads/ and saves it with --file instead, whose URL is recorded only as
// its origin. File names come from the role, never the source's own name,
// which can carry a precinct. Nothing in this mode is written to
// unfetchable.md. Every saved snapshot gets a ballot.ledger line, written
// after its manifest line and before the file lands.
//
// The two forms differ only in their source (fromUrl, fromFile): what each
// checks before the prompt, what the prompt shows, and how it gets the text.

const fs = require("node:fs");
const path = require("node:path");
const { LEDGER, ROLES } = require("./constants");
const { loadPrivateValues, loadTiers } = require("./data-files");
const { openBallot, parseBallot, parseHttpUrl } = require("./fetch-common");
const { cleanUrl, decode, fetchPage, isPdf, spellings } = require("./fetch-page");
const { htmlToText } = require("./html-text");
const { Failure, runCommand } = require("./output");
const { pdfText } = require("./pdf-text");
const { URL_CLASSES, findRefusal } = require("./privacy");
const { snapshotText, today } = require("./snapshot-file");
const { MANIFEST, appendLine, checkLog, save, withLock } = require("./snapshot-store");
const { confirm, requireTerminal } = require("./terminal");
const { matchUrl } = require("./tiers");

const WHERE = "_ballot";

const parseArgs = (argv) => {
  const file = argv[1] === "--file";
  const rest = argv.slice(file ? 2 : 1);
  if (rest.length !== (file ? 4 : 3) || rest.some((arg) => arg.startsWith("--"))) {
    throw new Failure("-", "usage");
  }
  const [ballot, role] = rest;
  parseBallot(ballot);
  if (!ROLES.includes(role)) throw new Failure("-", "bad-role");
  const given = rest[rest.length - 1];
  return { ballot, role, given, url: parseHttpUrl(given), file: file ? rest[2] : null };
};

// Text up to its query or fragment: what --ballot sends that the record drops
// is allowed to hold a private value, the rest is not.
const beforeQuery = (text) => text.split(/[?#]/)[0];

// A --ballot URL: checked whole for API keys and up to its query for the
// rest, on every spelling and every redirect; a refusal there points to --file.
const fromUrl = (args, values) => {
  const checkPrivate = (texts) => {
    const key = findRefusal(texts, values, ["key"]);
    if (key) throw new Failure(WHERE, key);
    const code = findRefusal(texts.map(beforeQuery), values, URL_CLASSES);
    if (code) throw new Failure(WHERE, code, undefined, "use-ballot-file");
  };
  checkPrivate(spellings(args.url, args.given));
  return {
    prompt: `Fetch ${args.given} as ${args.role}? [y/N] `,
    acquire: async (entries) => {
      const page = await fetchPage(entries, args.url, checkPrivate, { pdf: true, t1: true });
      if (page.refused) throw new Failure(WHERE, page.refused.code);
      const url = cleanUrl(page.url);
      url.search = "";
      return {
        method: page.kind,
        text: page.kind === "pdf" ? pdfText(page.body, WHERE) : htmlToText(page.body),
        url,
        tiers: page.tiers,
        from: "url",
        // hops[0] is args.url: every URL requested, none unseen.
        query: page.hops.some((hop) => hop.search !== "") ? "query" : "none",
      };
    },
  };
};

// A saved HTML file's text: the charset its <meta> names, else UTF-8, which
// must then be valid; a guess would garble the names ballot-check matches.
const htmlFileText = (bytes) => {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  const charset = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  if (charset) return decode(bytes, `text/html; charset=${charset}`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Failure(WHERE, "bad-file");
  }
};

// The file to import: a regular file under downloads/ (after symlinks are
// resolved), PDF or HTML by both its extension and its first bytes. It is
// read once, here, so the file saved is the file checked.
const readDownload = (root, file) => {
  let real;
  let top;
  try {
    real = fs.realpathSync(path.resolve(root, file));
    top = fs.realpathSync(path.join(root, "downloads"));
  } catch {
    throw new Failure(WHERE, "file-not-in-downloads");
  }
  const rel = path.relative(top, real);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Failure(WHERE, "file-not-in-downloads");
  }
  let bytes;
  let fd;
  try {
    fd = fs.openSync(real, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch {
    // Unreadable, or swapped for a symlink since it was resolved.
    throw new Failure(WHERE, "bad-file");
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Failure(WHERE, "bad-file");
    bytes = fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const ext = path.extname(real).toLowerCase();
  // An HTML file starts with a tag once a UTF-8 BOM and whitespace are skipped.
  const html = /^(\xef\xbb\xbf)?\s*</.test(Buffer.from(bytes.subarray(0, 64)).toString("latin1"));
  if (ext === ".pdf" && isPdf(bytes)) return { path: real, method: "pdf", bytes };
  if ((ext === ".html" || ext === ".htm") && html) return { path: real, method: "html", bytes };
  throw new Failure(WHERE, "bad-file");
};

// A --file import. Only the origin of <url> is recorded, so only it is
// checked; the page URL is matched against tiers.yaml (local, never sent or
// printed) and read for a query, but its path may hold the precinct that sent
// the researcher to --file.
const fromFile = (root, args, values) => {
  const origin = new URL(`${args.url.origin}/`);
  const code = findRefusal(spellings(origin, origin.href), values, URL_CLASSES);
  if (code) throw new Failure(WHERE, code);
  const file = readDownload(root, args.file);
  return {
    prompt: `Save ${path.relative(root, file.path)} as ${args.role}, from ${origin.href}? [y/N] `,
    acquire: async (_entries, tiers) => ({
      method: file.method,
      text:
        file.method === "pdf" ? pdfText(file.bytes, WHERE) : htmlToText(htmlFileText(file.bytes)),
      url: origin,
      tiers,
      from: "file",
      // The download URL is unknown: a query on the page URL is known, its absence is not.
      query: args.url.search !== "" ? "query" : "unknown",
    }),
  };
};

const main = (argv) =>
  runCommand(async () => {
    // Before anything is read, so no private text reaches a session.
    requireTerminal();
    const root = process.cwd();
    const args = parseArgs(argv);
    const ballotDir = openBallot(root, args.ballot);
    const values = loadPrivateValues(root, args.ballot);
    const source = args.file ? fromFile(root, args, values) : fromUrl(args, values);

    const entries = loadTiers(root, args.ballot, values);
    const first = matchUrl(entries, args.url);
    if (!first) throw new Failure(WHERE, "domain-not-in-tiers");
    if (first.tier !== "T1") throw new Failure(WHERE, "not-t1");
    // Also checked under the lock below; checked here so a save that would
    // fail sends nothing.
    const ledger = path.join(ballotDir, LEDGER);
    checkLog(path.join(ballotDir, MANIFEST), "manifest-invalid");
    checkLog(ledger, "ledger-invalid");

    if (!(await confirm(source.prompt))) throw new Failure(WHERE, "not-confirmed");
    const got = await source.acquire(entries, first);
    if (!got.text) throw new Failure(WHERE, "no-readable-text");

    const date = today();
    const fileText = snapshotText(
      {
        source: got.tiers.source,
        url: got.url.href,
        fetched: date,
        method: got.method,
        tier: got.tiers.tier,
        statements_only: got.tiers.statements_only,
        subject: "_ballot",
        owner: got.tiers.owner,
        role: args.role,
      },
      got.text,
    );
    const rel = withLock(ballotDir, () => {
      checkLog(ledger, "ledger-invalid");
      return save(ballotDir, "_ballot", args.role.replaceAll("_", "-"), fileText, (saved) =>
        appendLine(ledger, `${[saved, args.role, got.from, got.query, date].join("\t")}\n`),
      );
    });
    return [`${rel} saved`];
  });

module.exports = { main };
