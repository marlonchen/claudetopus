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
const {
  BALLOT_ID_PATTERN,
  ELECTION_PATTERN,
  ID_PATTERN,
  LEDGER,
  OFFICE_TYPES,
  ROLES,
  SECTIONS,
} = require("./constants");
const { isDir, readYamlDocument } = require("./data-files");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { matchBallot } = require("./ballot-match");
const { normalizeLine } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { readManifest, sha256 } = require("./snapshot-store");
const { requireTerminal } = require("./terminal");

const VIEW = "ballot-view.md";
const BALLOT_DIR = "sources/_ballot";
const STATUSES = ["on_ballot", "withdrawn_still_printed", "certified_write_in"];
// Operating-system and editor leftovers (snapshot-format.md, Manifest).
const LEFTOVER = /^(\.DS_Store|Thumbs\.db|.*\.swp)$/;
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

const idMatches = (id, state, county) =>
  typeof state === "string" &&
  typeof county === "string" &&
  new RegExp(`^${ballotIdPrefix(state, county)}-[1-9][0-9]?$`).test(id);

// ballot.yaml, validated. Returns { failures, contests (for matchBallot),
// slug, people: [{ id, name, at }] }.
const checkBallotYaml = (root, ballot) => {
  const [election, ballotId] = ballot.split("/");
  const { doc, lineCounter } = readYamlDocument(
    path.join(root, ballot, "ballot.yaml"),
    "ballot.yaml",
  );
  const data = doc.toJS();
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
  const unknownKeys = (value, allowed, keys) => {
    for (const key of Object.keys(value))
      if (!allowed.includes(key)) fail([...keys, key], "ballot-invalid");
  };

  if (!isMap(data)) throw new Failure("ballot.yaml", "ballot-invalid");
  unknownKeys(data, TOP_KEYS, []);
  if (data.election !== election) {
    fail(["election"], isText(data.election) ? "election-mismatch" : "ballot-invalid");
  }
  if (typeof data.state !== "string" || !/^[A-Z]{2}$/.test(data.state))
    fail(["state"], "ballot-invalid");
  if (!isText(data.county)) fail(["county"], "ballot-invalid");
  if (
    typeof data.state === "string" &&
    isText(data.county) &&
    !idMatches(ballotId, data.state, data.county)
  ) {
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
    return { failures, contests: [], slug: data.slug, slugAt: at(["slug"]), people: [] };
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
    if (!Object.hasOwn(TYPE_KEYS, type)) {
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
        if (!isCount(contest.printed_count)) fail([...keys, "printed_count"], "ballot-invalid");
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
  return { failures, contests, slug: data.slug, slugAt: at(["slug"]), people };
};

// Every other ballot directory's ballot.yaml, for the cross-ballot id and slug
// rules, and every directory under an <election> directory, for the ballot
// id rules. Failures here are located `-`: no other ballot's id is printed.
const otherBallots = (root, ballot) => {
  const failures = [];
  const others = [];
  for (const election of fs.readdirSync(root).sort()) {
    if (!ELECTION_PATTERN.test(election) || !isDir(path.join(root, election))) continue;
    for (const id of fs.readdirSync(path.join(root, election)).sort()) {
      const rel = `${election}/${id}`;
      if (id.startsWith(".") || !isDir(path.join(root, rel)) || rel === ballot) continue;
      if (!BALLOT_ID_PATTERN.test(id)) {
        failures.push(new Failure("-", "ballot-id-invalid"));
        continue;
      }
      if (!fs.existsSync(path.join(root, rel, "ballot.yaml"))) continue;
      let data;
      try {
        data = readYamlDocument(path.join(root, rel, "ballot.yaml"), "-").doc.toJS();
      } catch (error) {
        if (!(error instanceof Failure)) throw error;
        failures.push(new Failure("-", error.code));
        continue;
      }
      if (!isMap(data) || !Array.isArray(data.contests)) {
        failures.push(new Failure("-", "ballot-invalid"));
        continue;
      }
      if (!idMatches(id, data.state, data.county))
        failures.push(new Failure("-", "ballot-id-mismatch"));
      const names = new Map();
      for (const contest of data.contests) {
        const listed = [
          ...(Array.isArray(contest?.candidates) ? contest.candidates : []),
          contest?.official,
        ];
        for (const p of listed)
          if (typeof p?.id === "string" && typeof p.name === "string") names.set(p.id, p.name);
      }
      others.push({ slug: data.slug, names });
    }
  }
  return { failures, others };
};

// private.yaml: lists of strings under private_strings and ignored_lines.
const loadPrivate = (root, ballot) => {
  const data =
    readYamlDocument(path.join(root, ballot, "private.yaml"), "private.yaml").doc.toJS() ?? {};
  const lists = { private_strings: [], ignored_lines: [] };
  if (!isMap(data)) throw new Failure("private.yaml", "private-invalid");
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(lists, key)) throw new Failure("private.yaml", "private-invalid", key);
    const list = value ?? [];
    if (!Array.isArray(list) || !list.every((s) => typeof s === "string")) {
      throw new Failure("private.yaml", "private-invalid", key);
    }
    lists[key] = list;
  }
  return lists;
};

// The authoritative sample ballot: every file under sources/_ballot/ must have
// a ballot.ledger line and the role it records, and exactly one is a
// sample ballot, whose hash matches snapshots.sha256. Returns { failures,
// sample: { path, body, firstLine } | null }.
const findSampleBallot = (ballotDir) => {
  const failures = [];
  const ledger = new Map();
  const ledgerFile = path.join(ballotDir, LEDGER);
  if (fs.existsSync(ledgerFile)) {
    const text = fs.readFileSync(ledgerFile, "utf8");
    const lines = text.split("\n");
    if (text && !text.endsWith("\n"))
      failures.push(new Failure(`${LEDGER}:${lines.length}`, "ledger-invalid"));
    for (const [n, line] of lines.slice(0, -1).entries()) {
      const m = LEDGER_LINE.exec(line);
      if (!m || !ROLES.includes(m[2]))
        failures.push(new Failure(`${LEDGER}:${n + 1}`, "ledger-invalid"));
      else ledger.set(m[1], m[2]);
    }
  }
  const dir = path.join(ballotDir, BALLOT_DIR);
  const samples = [];
  for (const entry of isDir(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const rel = `${BALLOT_DIR}/${entry.name}`;
    if (entry.isFile() && LEFTOVER.test(entry.name)) continue;
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

// Control characters would act on the researcher's terminal; show them as U+FFFD.
const printable = (text) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: replacing them is the point
  text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, "\ufffd");

const parseArgs = (argv) => {
  const show = argv[0] === "--show";
  const rest = show ? argv.slice(1) : argv;
  if (rest.length !== 1 || rest[0].startsWith("--")) throw new Failure("-", "usage");
  parseBallot(rest[0]);
  return { show, ballot: rest[0] };
};

const main = (argv) =>
  runCommand(async () => {
    // Before anything is read, so no private text reaches a session.
    if (argv[0] === "--show") requireTerminal();
    const { show, ballot } = parseArgs(argv);
    const root = process.cwd();
    const ballotDir = openBallot(root, ballot);
    const view = path.join(ballotDir, VIEW);
    // A view from an earlier pass must never outlive a failing ballot.yaml.
    fs.rmSync(view, { force: true });

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
    const privateLists = orElse(() => loadPrivate(root, ballot), null);
    const cross = otherBallots(root, ballot);
    failures.push(...(yaml?.failures ?? []), ...cross.failures);
    if (typeof yaml?.slug === "string" && cross.others.some((other) => other.slug === yaml.slug)) {
      failures.push(new Failure(yaml.slugAt, "slug-duplicate", "slug"));
    }
    const names = new Map();
    for (const other of cross.others) for (const [id, name] of other.names) names.set(id, name);
    for (const { id, name, at } of yaml?.people ?? []) {
      if (names.has(id) && names.get(id) !== name)
        failures.push(new Failure(at, "id-name-conflict", "id"));
      names.set(id, name);
    }

    const found = findSampleBallot(ballotDir);
    failures.push(...found.failures);
    let spans = [];
    const lines = failures.map((f) => f.line);
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
    if (lines.length) throw new Failures(lines);

    const tmp = `${view}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `link: ${found.sample.path}\n${spans.map((s) => `${s}\n`).join("")}`);
    fs.renameSync(tmp, view);
    return [`${VIEW} written`];
  });

module.exports = { ballotIdPrefix, main };
