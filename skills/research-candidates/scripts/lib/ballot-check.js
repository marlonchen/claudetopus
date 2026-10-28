"use strict";

// ballot-check <election>/<ballot-id>
// ballot-check --show <election>/<ballot-id>
//
// Steps 3, 4.1 and 6.1: check ballot.yaml against the authoritative sample
// ballot in both directions (ballot-format.md, Ballot check) and, on a pass,
// write ballot-view.md, the only form of the sample ballot the compile agent
// reads (Rule 7). Every failure found is reported, as `location code [key]`
// lines located in the ballot directory, never with a value (Rule 5).
// `--show`, researcher only, adds each unaccounted line's text.

const fs = require("node:fs");
const path = require("node:path");
const { ID_PATTERN, LEDGER, OFFICE_TYPES, ROLES, SECTIONS } = require("./constants");
const { checkPrivacy } = require("./ballot-privacy");
const {
  ballotEntries,
  isDir,
  loadAddresses,
  loadPrivate,
  readYamlDocument,
} = require("./data-files");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { matchBallot } = require("./ballot-match");
const { normalizeLine } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { readManifest, sha256, withLock } = require("./snapshot-store");
const { requireTerminal } = require("./terminal");

const VIEW = "ballot-view.md";
const BALLOT_DIR = "sources/_ballot";
const STATUSES = ["on_ballot", "withdrawn_still_printed", "certified_write_in"];
// Operating-system and editor leftovers (snapshot-format.md, Manifest).
const LEFTOVER = /^(\.DS_Store|Thumbs\.db|.*\.swp)$/;
// The names fetch-snapshot --ballot gives _ballot snapshots; any other name is
// never printed, since a file dropped there can be named after private text.
const SNAPSHOT_NAME = new RegExp(`${ID_PATTERN.source.slice(0, -1)}\\.md$`);
const STATE = /^[A-Z]{2}$/;
const LEDGER_LINE =
  /^(sources\/_ballot\/[^\t/]+\.md)\t([a-z_]+)\t(url|file)\t(query|none|unknown)\t([0-9]{4}-[0-9]{2}-[0-9]{2})$/;

const TOP_KEYS = [
  "election",
  "state",
  "county",
  "slug",
  "contest_count",
  "contests",
  "confirmed_supersedes",
  "retired_companions",
];
const CONTEST_KEYS = ["id", "type", "jurisdiction", "title", "display_title", "not_researched"];
const TYPE_KEYS = {
  candidate: ["office_type", "printed_count", "vote_for", "candidates"],
  retention: ["office_type", "official"],
  measure: ["search_terms"],
};
const CANDIDATE_KEYS = ["id", "name", "party", "party_name", "status"];
const OFFICIAL_KEYS = ["id", "name"];
// Every key ballot.yaml allows, the only ones a report line may name.
const ALLOWED_KEYS = new Set([
  ...TOP_KEYS,
  ...CONTEST_KEYS,
  ...Object.values(TYPE_KEYS).flat(),
  ...CANDIDATE_KEYS,
  ...OFFICIAL_KEYS,
]);

const isText = (v) => typeof v === "string" && v.trim() !== "";
const isCount = (v) => Number.isInteger(v) && v > 0;
const isMap = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The ballot id prefix ballot.yaml's state and county build (ballot-format.md,
// Ballot ids): <state>-<county>, without the 1-2 digit number.
const ballotIdPrefix = (state, county) => {
  const words = county
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, "")
    .replace(/\s+(City and Borough|Borough|Census Area|Municipality|County|Parish)\s*$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${state.toLowerCase()}-${words}`;
};

const idMatches = (id, state, county) => {
  if (typeof state !== "string" || !STATE.test(state) || typeof county !== "string") return false;
  const prefix = `${ballotIdPrefix(state, county)}-`;
  return id.startsWith(prefix) && /^[1-9][0-9]?$/.test(id.slice(prefix.length));
};

// Names compare after normalization and in any case: counties print one
// person's name in their own case ("JANE EXAMPLE", "Jane Example").
const personKey = (name) => normalizeLine(name).toLowerCase();

// ballot.yaml, validated. Returns { failures, contests (for matchBallot),
// slug, slugAt, people: [{ id, name, at }], hash, parsed: { doc, lineCounter, text } }.
const checkBallotYaml = (root, ballot) => {
  const [election, ballotId] = ballot.split("/");
  const { doc, lineCounter, text } = readYamlDocument(
    path.join(root, ballot, "ballot.yaml"),
    "ballot.yaml",
  );
  const data = doc.toJS();
  const parsed = { doc, lineCounter, text };
  const failures = [];
  // The line of the deepest node on `keys` that exists.
  const at = (keys) => {
    for (let n = keys.length; n > 0; n--) {
      const node = doc.getIn(keys.slice(0, n), true);
      if (node?.range) return `ballot.yaml:${lineCounter.linePos(node.range[0]).line}`;
    }
    return "ballot.yaml:1";
  };
  const fail = (keys, code) => {
    const key = [...keys].reverse().find((k) => typeof k === "string");
    failures.push(new Failure(at(keys), code, key));
  };
  // Located by the key's line and never keyed: the key is the researcher's text.
  const unknownKeys = (value, allowed, keys) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) failures.push(new Failure(at([...keys, key]), "ballot-invalid"));
  };

  if (!isMap(data)) throw new Failure("ballot.yaml", "ballot-invalid");
  unknownKeys(data, TOP_KEYS, []);
  if (data.election !== election) {
    fail(["election"], isText(data.election) ? "election-mismatch" : "ballot-invalid");
  }
  const stated = typeof data.state === "string" && STATE.test(data.state);
  if (!stated) fail(["state"], "ballot-invalid");
  if (!isText(data.county)) fail(["county"], "ballot-invalid");
  if (stated && isText(data.county) && !idMatches(ballotId, data.state, data.county)) {
    fail(["county"], "ballot-id-mismatch");
  }
  if (typeof data.slug !== "string" || !/^[a-z0-9]{6}$/.test(data.slug))
    fail(["slug"], "slug-invalid");
  for (const key of ["confirmed_supersedes", "retired_companions"]) {
    const list = data[key];
    if (list !== undefined && (!Array.isArray(list) || !list.every(isText)))
      fail([key], "ballot-invalid");
  }
  if (!Array.isArray(data.contests) || data.contests.length === 0) {
    fail(["contests"], "ballot-invalid");
    return {
      failures,
      contests: [],
      slug: data.slug,
      slugAt: at(["slug"]),
      people: [],
      hash: sha256(text),
      parsed,
    };
  }
  if (!isCount(data.contest_count)) fail(["contest_count"], "ballot-invalid");
  else if (data.contest_count !== data.contests.length)
    fail(["contest_count"], "contest-count-mismatch");

  const contests = [];
  const people = [];
  const contestIds = new Set();
  for (const [c, contest] of data.contests.entries()) {
    const keys = ["contests", c];
    if (!isMap(contest)) {
      fail(keys, "ballot-invalid");
      continue;
    }
    const type = contest.type;
    if (typeof type !== "string" || !Object.hasOwn(TYPE_KEYS, type)) {
      fail([...keys, "type"], "ballot-invalid");
      continue;
    }
    unknownKeys(contest, [...CONTEST_KEYS, ...TYPE_KEYS[type]], keys);
    if (typeof contest.id !== "string" || !ID_PATTERN.test(contest.id) || contest.id === "ballot") {
      fail([...keys, "id"], "id-invalid");
    } else if (contestIds.has(contest.id)) {
      fail([...keys, "id"], "id-duplicate");
    } else {
      contestIds.add(contest.id);
    }
    if (!isText(contest.jurisdiction)) fail([...keys, "jurisdiction"], "ballot-invalid");
    const titled = isText(contest.title);
    if (!titled) fail([...keys, "title"], "ballot-invalid");
    if (contest.display_title !== undefined) {
      if (!isText(contest.display_title)) fail([...keys, "display_title"], "ballot-invalid");
      else if (titled && normalizeLine(contest.display_title) === normalizeLine(contest.title)) {
        fail([...keys, "display_title"], "display-title-same");
      }
    }
    const notResearched = contest.not_researched;
    if (notResearched !== undefined && notResearched !== "all") {
      const allowed = SECTIONS[type].filter((s) => s !== "On the ballot");
      if (
        !Array.isArray(notResearched) ||
        !notResearched.every((s) => allowed.includes(s)) ||
        new Set(notResearched).size !== notResearched.length
      ) {
        fail([...keys, "not_researched"], "not-researched-invalid");
      }
    }

    const entries = [];
    const personIds = new Set();
    const person = (value, pkeys, allowed) => {
      if (!isMap(value)) {
        fail(pkeys, "ballot-invalid");
        return null;
      }
      unknownKeys(value, allowed, pkeys);
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id))
        fail([...pkeys, "id"], "id-invalid");
      else if (personIds.has(value.id)) fail([...pkeys, "id"], "id-duplicate");
      else personIds.add(value.id);
      if (!isText(value.name)) {
        fail([...pkeys, "name"], "ballot-invalid");
        return null;
      }
      if (typeof value.id === "string")
        people.push({ id: value.id, name: value.name, at: at([...pkeys, "id"]) });
      return { name: normalizeLine(value.name), at: at([...pkeys, "name"]) };
    };

    let voteFor;
    if (type === "candidate") {
      if (!OFFICE_TYPES.includes(contest.office_type))
        fail([...keys, "office_type"], "ballot-invalid");
      if (!isCount(contest.vote_for)) fail([...keys, "vote_for"], "ballot-invalid");
      else voteFor = contest.vote_for;
      if (!Array.isArray(contest.candidates) || contest.candidates.length === 0) {
        fail([...keys, "candidates"], "ballot-invalid");
      } else {
        let printed = 0;
        for (const [n, candidate] of contest.candidates.entries()) {
          const pkeys = [...keys, "candidates", n];
          const entry = person(candidate, pkeys, CANDIDATE_KEYS);
          if (!isMap(candidate)) continue;
          if (!STATUSES.includes(candidate.status)) fail([...pkeys, "status"], "ballot-invalid");
          for (const key of ["party", "party_name"]) {
            if (candidate[key] !== undefined && !isText(candidate[key]))
              fail([...pkeys, key], "ballot-invalid");
          }
          if (candidate.party_name !== undefined && candidate.party === undefined) {
            fail([...pkeys, "party_name"], "ballot-invalid");
          }
          const isPrinted = candidate.status !== "certified_write_in";
          if (isPrinted) printed++;
          if (entry) {
            const party = isText(candidate.party) ? normalizeLine(candidate.party) : null;
            entries.push({ ...entry, party, printed: isPrinted });
          }
        }
        // 0 when every candidate is a certified write-in.
        if (!Number.isInteger(contest.printed_count) || contest.printed_count < 0)
          fail([...keys, "printed_count"], "ballot-invalid");
        else if (contest.printed_count !== printed)
          fail([...keys, "printed_count"], "printed-count-mismatch");
      }
    } else if (type === "retention") {
      if (contest.office_type !== undefined && contest.office_type !== "judicial") {
        fail([...keys, "office_type"], "ballot-invalid");
      }
      const entry = person(contest.official, [...keys, "official"], OFFICIAL_KEYS);
      if (entry) entries.push({ ...entry, party: null, printed: true, official: true });
    } else if (!isText(contest.search_terms)) {
      fail([...keys, "search_terms"], "ballot-invalid");
    }

    if (titled) {
      contests.push({
        title: normalizeLine(contest.title),
        at: at([...keys, "title"]),
        vote_for: voteFor,
        entries,
      });
    }
  }
  return {
    failures,
    contests,
    slug: data.slug,
    slugAt: at(["slug"]),
    people,
    hash: sha256(text),
    parsed,
  };
};

// Every other ballot directory's ballot.yaml, for the cross-ballot id and slug
// rules, and every directory under an <election> directory, for the ballot
// id rules. Failures here are located `-`, since no other ballot's id is
// printed. `names` lists [id, name] pairs.
const otherBallots = (root, ballot) => {
  const codes = [];
  const others = [];
  for (const { ballot: rel, valid } of ballotEntries(root)) {
    if (rel === ballot) continue;
    if (!valid) {
      codes.push("ballot-id-invalid");
      continue;
    }
    if (!fs.existsSync(path.join(root, rel, "ballot.yaml"))) continue;
    let data;
    try {
      data = readYamlDocument(path.join(root, rel, "ballot.yaml"), "-").doc.toJS();
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      codes.push(error.code);
      continue;
    }
    if (!isMap(data) || !Array.isArray(data.contests)) {
      codes.push("ballot-invalid");
      continue;
    }
    if (!idMatches(rel.split("/")[1], data.state, data.county)) codes.push("ballot-id-mismatch");
    const names = [];
    for (const contest of data.contests) {
      const listed = [
        ...(Array.isArray(contest?.candidates) ? contest.candidates : []),
        contest?.official,
      ];
      for (const p of listed)
        if (typeof p?.id === "string" && typeof p.name === "string") names.push([p.id, p.name]);
    }
    others.push({ slug: data.slug, names });
  }
  const failures = codes.map((code) => new Failure("-", code));
  return { failures, others };
};

// The authoritative sample ballot: every file under sources/_ballot/ must have
// a ballot.ledger line and the role it records, and exactly one is a
// sample ballot, whose hash matches snapshots.sha256. A file whose name
// fetch-snapshot could not have given is located `sources/_ballot/-`.
// Returns { failures, sample: { path, bytes, body, firstLine } | null }.
const findSampleBallot = (ballotDir) => {
  const failures = [];
  const ledger = new Map();
  const ledgerFile = path.join(ballotDir, LEDGER);
  if (fs.existsSync(ledgerFile)) {
    const lines = fs.readFileSync(ledgerFile, "utf8").split("\n");
    // A last line with no newline is still read, so its file is not also unledgered.
    const ended = lines.at(-1) === "";
    if (ended) lines.pop();
    for (const [n, line] of lines.entries()) {
      const m = LEDGER_LINE.exec(line);
      const valid = m && ROLES.includes(m[2]);
      if (valid) ledger.set(m[1], m[2]);
      if (!valid || (!ended && n === lines.length - 1))
        failures.push(new Failure(`${LEDGER}:${n + 1}`, "ledger-invalid"));
    }
  }
  const dir = path.join(ballotDir, BALLOT_DIR);
  const samples = [];
  for (const entry of isDir(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const rel = `${BALLOT_DIR}/${entry.name}`;
    if (entry.isFile() && LEFTOVER.test(entry.name)) continue;
    if (!SNAPSHOT_NAME.test(entry.name)) {
      failures.push(new Failure(`${BALLOT_DIR}/-`, "ballot-not-in-ledger"));
      continue;
    }
    if (!entry.isFile() || !ledger.has(rel)) {
      failures.push(new Failure(rel, "ballot-not-in-ledger"));
      continue;
    }
    const bytes = fs.readFileSync(path.join(ballotDir, rel));
    const text = bytes.toString("utf8");
    const front = /^---\n([\s\S]*?\n)?---\n/.exec(text);
    let role = null;
    try {
      role = front ? load("yaml").parse(front[1] ?? "")?.role : null;
    } catch {
      role = null;
    }
    if (role !== ledger.get(rel)) {
      failures.push(new Failure(rel, "ledger-mismatch"));
      continue;
    }
    if (role === "sample_ballot") {
      samples.push({
        path: rel,
        bytes,
        body: text.slice(front[0].length),
        firstLine: front[0].split("\n").length,
      });
    }
  }
  if (samples.length === 0) failures.push(new Failure(BALLOT_DIR, "no-sample-ballot"));
  if (samples.length > 1) failures.push(new Failure(BALLOT_DIR, "sample-ballot-not-unique"));
  if (samples.length !== 1) return { failures, sample: null };
  const [sample] = samples;
  const hashes = readManifest(ballotDir).filter((line) => line.path === sample.path);
  if (hashes.at(-1)?.hash !== sha256(sample.bytes))
    failures.push(new Failure(sample.path, "snapshot-hash"));
  return { failures, sample };
};

// Control and format characters would act on the researcher's terminal, or
// reorder what it shows (U+202E); show them as U+FFFD.
const printable = (text) => text.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "\ufffd");

const parseArgs = (argv) => {
  const show = argv[0] === "--show";
  const rest = show ? argv.slice(1) : argv;
  if (rest.length !== 1 || rest[0].startsWith("--")) throw new Failure("-", "usage");
  parseBallot(rest[0]);
  return { show, ballot: rest[0] };
};

// The view, then the hashes of what it was checked against, so a later gate
// can tell a view that ballot.yaml or the sample ballot no longer agree with.
const viewText = (yaml, sample, spans) =>
  [
    `link: ${sample.path}`,
    `sha256: ${yaml.hash}  ballot.yaml`,
    `sha256: ${sha256(sample.bytes)}  ${sample.path}`,
    ...spans,
    "",
  ].join("\n");

const check = (root, ballot, ballotDir, show) => {
  const view = path.join(ballotDir, VIEW);
  // A view from an earlier pass, or a write a crash cut short, must never
  // outlive a failing ballot.yaml.
  fs.rmSync(view, { force: true });
  for (const name of fs.readdirSync(ballotDir))
    if (name.startsWith(`${VIEW}.tmp-`)) fs.rmSync(path.join(ballotDir, name), { force: true });

  // A file that cannot be read at all is one failure; the others still run.
  const failures = [];
  const orElse = (read, fallback) => {
    try {
      return read();
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      failures.push(error);
      return fallback;
    }
  };
  const yaml = orElse(() => checkBallotYaml(root, ballot), null);
  const privateLists = orElse(() => loadPrivate(root, ballot, "private.yaml"), null);
  const addresses = orElse(() => loadAddresses(root), null);
  const privacy = checkPrivacy({
    root,
    ballot,
    yaml,
    lists: privateLists,
    addresses,
    keys: ALLOWED_KEYS,
  });
  const cross = otherBallots(root, ballot);
  failures.push(...(yaml?.failures ?? []), ...privacy.failures, ...cross.failures);
  if (typeof yaml?.slug === "string" && cross.others.some((other) => other.slug === yaml.slug)) {
    failures.push(new Failure(yaml.slugAt, "slug-duplicate", "slug"));
  }
  // Every name each id is given, by every ballot read so far.
  const names = new Map();
  const give = (id, name) => {
    if (!names.has(id)) names.set(id, new Set());
    names.get(id).add(personKey(name));
  };
  for (const other of cross.others) for (const [id, name] of other.names) give(id, name);
  for (const { id, name, at } of yaml?.people ?? []) {
    if ([...(names.get(id) ?? [])].some((given) => given !== personKey(name)))
      failures.push(new Failure(at, "id-name-conflict", "id"));
    give(id, name);
  }

  const found = findSampleBallot(ballotDir);
  failures.push(...found.failures);
  let spans = [];
  // The last failure in another ballot carries the hint to run ballot-check on
  // each ballot, which locates its own failures.
  const elsewhere = failures.filter((f) => f.location === "-" && !f.hint);
  if (elsewhere.length) elsewhere.at(-1).hint = "check-each-ballot";
  const lines = [...privacy.warnings, ...failures.map((f) => f.line)];
  // Matching needs both files; without them it would only add noise.
  if (found.sample && yaml && privateLists) {
    const match = matchBallot({
      ...found.sample,
      contests: yaml.contests,
      privateStrings: privateLists.private_strings,
      ignoredLines: privateLists.ignored_lines,
    });
    spans = match.spans;
    lines.push(...match.failures.map((f) => f.line));
    for (const { line, text } of match.unaccounted) {
      const unaccounted = new Failure(`${found.sample.path}:${line}`, "line-unaccounted").line;
      lines.push(show ? `${unaccounted}\n    ${printable(text)}` : unaccounted);
    }
  }
  if (lines.length > privacy.warnings.length) throw new Failures(lines);

  const tmp = `${view}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, viewText(yaml, found.sample, spans));
  fs.renameSync(tmp, view);
  return [...privacy.warnings, `${VIEW} written`];
};

const main = (argv) =>
  runCommand(async () => {
    // Before anything is read, so no private text reaches a session.
    if (argv[0] === "--show") requireTerminal();
    const { show, ballot } = parseArgs(argv);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    // Under the ballot lock, so a --ballot import never saves between the
    // ledger read and the view write.
    return withLock(ballotDir, () => check(root, ballot, ballotDir, show));
  });

module.exports = { ballotIdPrefix, main };
