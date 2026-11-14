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
const { ID_PATTERN, LEDGER, LEFTOVER, ROLES, SLUG_PATTERN, VIEW } = require("./constants");
const { checkCompanions, checkPeople } = require("./ballot-companions");
const { checkPrivacy } = require("./ballot-privacy");
const { dataRepoSetupFailures } = require("./data-repo-setup");
const {
  ballotEntries,
  faultFreeContests,
  isDir,
  loadPrivate,
  parseContests,
  readYamlDocument,
} = require("./data-files");
const { load } = require("./deps");
const { openBallot, parseBallot } = require("./fetch-common");
const { matchBallot } = require("./ballot-match");
const { normalizeLine } = require("./normalize");
const { Failure, Failures, runCommand } = require("./output");
const { FRONT_MATTER } = require("./snapshot-file");
const { readManifest, sha256, withLock } = require("./snapshot-store");
const { printable, requireTerminal } = require("./terminal");

const BALLOT_DIR = "sources/_ballot";
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
// The line a ballot.yaml failure is located by.
const lineOf = (failure) => Number(failure.location.split(":")[1]);

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
// candidates (for checkPeople), lists: { confirmed_supersedes,
// retired_companions } as [{ path, at }], slug, slugAt, people: [{ id, name,
// at }], hash, parsed: { doc, lineCounter, text, data } }.
const checkBallotYaml = (root, ballot) => {
  const [election, ballotId] = ballot.split("/");
  const { doc, lineCounter, text } = readYamlDocument(
    path.join(root, ballot, "ballot.yaml"),
    "ballot.yaml",
  );
  // An alias copies a value the text never spells out where it is used (a hidden
  // printed title into a jurisdiction), so neither aliases nor anchors are allowed.
  const YAML = load("yaml");
  let aliased = null;
  YAML.visit(doc, (_, node) => {
    if (!YAML.isAlias(node) && !node?.anchor) return undefined;
    aliased = node;
    return YAML.visit.BREAK;
  });
  if (aliased) {
    const line = aliased.range ? lineCounter.linePos(aliased.range[0]).line : 1;
    throw new Failure(`ballot.yaml:${line}`, "ballot-invalid");
  }
  const data = doc.toJS();
  const parsed = { doc, lineCounter, text, data };
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
  if (typeof data.slug !== "string" || !SLUG_PATTERN.test(data.slug))
    fail(["slug"], "slug-invalid");
  // Each list as [{ path, at }], checked against the snapshots later.
  const lists = {};
  for (const key of ["confirmed_supersedes", "retired_companions"]) {
    const list = data[key] ?? [];
    if (!Array.isArray(list) || !list.every(isText)) {
      fail([key], "ballot-invalid");
      lists[key] = [];
    } else lists[key] = list.map((entry, i) => ({ path: entry, at: at([key, i]) }));
  }
  // The rules every script reads contests by (data-files.js), then the rest,
  // reported in line order, so the two read as one list.
  parseContests(data, fail);
  const byLine = () => failures.sort((x, y) => lineOf(x) - lineOf(y));
  if (!Array.isArray(data.contests) || data.contests.length === 0) {
    byLine();
    return {
      failures,
      contests: [],
      candidates: [],
      lists,
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
  const candidates = [];
  for (const [c, contest] of data.contests.entries()) {
    const keys = ["contests", c];
    // parseContests has failed a contest that is not a map or has no type.
    if (!isMap(contest) || typeof contest.type !== "string") continue;
    if (!Object.hasOwn(TYPE_KEYS, contest.type)) continue;
    const { type } = contest;
    unknownKeys(contest, [...CONTEST_KEYS, ...TYPE_KEYS[type]], keys);
    if (!isText(contest.jurisdiction)) fail([...keys, "jurisdiction"], "ballot-invalid");
    const titled = isText(contest.title);
    if (!titled) fail([...keys, "title"], "ballot-invalid");
    if (contest.display_title !== undefined) {
      if (!isText(contest.display_title)) fail([...keys, "display_title"], "ballot-invalid");
      else if (titled && normalizeLine(contest.display_title) === normalizeLine(contest.title)) {
        fail([...keys, "display_title"], "display-title-same");
      }
    }

    const entries = [];
    // One person's name for matching, or null; parseContests judges the id and name.
    const person = (value, pkeys, allowed) => {
      if (!isMap(value)) return null;
      unknownKeys(value, allowed, pkeys);
      if (!isText(value.name)) return null;
      if (typeof value.id === "string")
        people.push({ id: value.id, name: value.name, at: at([...pkeys, "id"]) });
      return { name: normalizeLine(value.name), at: at([...pkeys, "name"]) };
    };

    let voteFor;
    if (type === "candidate") {
      if (!isCount(contest.vote_for)) fail([...keys, "vote_for"], "ballot-invalid");
      else voteFor = contest.vote_for;
      if (Array.isArray(contest.candidates) && contest.candidates.length > 0) {
        let printed = 0;
        for (const [n, candidate] of contest.candidates.entries()) {
          const pkeys = [...keys, "candidates", n];
          const entry = person(candidate, pkeys, CANDIDATE_KEYS);
          if (!isMap(candidate)) continue;
          for (const key of ["party", "party_name"]) {
            if (candidate[key] !== undefined && !isText(candidate[key]))
              fail([...pkeys, key], "ballot-invalid");
          }
          if (candidate.party_name !== undefined && candidate.party === undefined) {
            fail([...pkeys, "party_name"], "ballot-invalid");
          }
          candidates.push({
            name: candidate.name,
            status: candidate.status,
            party: isText(candidate.party) ? candidate.party : undefined,
            partyName: isText(candidate.party_name) ? candidate.party_name : undefined,
            at: Object.fromEntries(
              ["name", "party", "party_name"].map((key) => [key, at([...pkeys, key])]),
            ),
          });
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
  byLine();
  return {
    failures,
    contests,
    candidates,
    lists,
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
    // Its contests read by the rules ballot-check holds this ballot to
    // (data-files.js); a faulted one is skipped, so a half-typed ballot.yaml
    // stops no other ballot's check, and its own check locates the fault.
    const contests = isMap(data) ? faultFreeContests(data) : null;
    if (!contests) {
      codes.push("ballot-invalid");
      continue;
    }
    if (!idMatches(rel.split("/")[1], data.state, data.county)) codes.push("ballot-id-mismatch");
    const names = [...contests.values()].flatMap((contest) =>
      contest.blocks.filter((b) => contest.subjects.has(b.subject)).map((b) => [b.subject, b.name]),
    );
    others.push({ slug: data.slug, names });
  }
  const failures = codes.map((code) => new Failure("-", code));
  return { failures, others };
};

// The _ballot snapshots: every file under sources/_ballot/ must have a
// ballot.ledger line and the role it records, and a hash that matches
// snapshots.sha256. A file whose name fetch-snapshot could not have given is
// located `sources/_ballot/-`. Sample ballots a supersedes link replaces are
// out of every check (ballot-format.md, Corrections); exactly one is left,
// the authoritative sample ballot. `lists` are ballot.yaml's
// confirmed_supersedes and retired_companions. Returns { failures, sample:
// { path, bytes, body, firstLine } | null, companions: [{ path, role, query,
// body, firstLine }] }, the companions in path order and none retired.
const readBallotSnapshots = (ballotDir, lists) => {
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
      if (valid) ledger.set(m[1], { role: m[2], query: m[4] });
      if (!valid || (!ended && n === lines.length - 1))
        failures.push(new Failure(`${LEDGER}:${n + 1}`, "ledger-invalid"));
    }
  }
  const dir = path.join(ballotDir, BALLOT_DIR);
  const hashes = new Map(readManifest(ballotDir).map((line) => [line.path, line.hash]));
  const snapshots = [];
  const entries = isDir(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
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
    const front = FRONT_MATTER.exec(text);
    let fields = null;
    try {
      fields = front ? load("yaml").parse(front[1] ?? "") : null;
    } catch {
      fields = null;
    }
    if (fields?.role !== ledger.get(rel).role) {
      failures.push(new Failure(rel, "ledger-mismatch"));
      continue;
    }
    if (hashes.get(rel) !== sha256(bytes)) failures.push(new Failure(rel, "snapshot-hash"));
    snapshots.push({
      path: rel,
      role: fields.role,
      supersedes: fields.supersedes,
      query: ledger.get(rel).query,
      bytes,
      body: text.slice(front[0].length),
      firstLine: front[0].split("\n").length,
    });
  }

  // Corrections: each valid link replaces its target, confirmed or not, since
  // an unconfirmed one fails the check anyway.
  const byPath = new Map(snapshots.map((s) => [s.path, s]));
  const isSample = (s) => s?.role === "sample_ballot";
  const replaced = new Map();
  for (const s of snapshots.filter((s) => s.supersedes !== undefined)) {
    const target =
      typeof s.supersedes === "string" && SNAPSHOT_NAME.test(s.supersedes)
        ? `${BALLOT_DIR}/${s.supersedes}`
        : null;
    if (!isSample(s) || !isSample(byPath.get(target)) || target === s.path || replaced.has(target))
      failures.push(new Failure(s.path, "supersedes-invalid"));
    else replaced.set(target, s.path);
  }
  // A loop has no first ballot to correct: none of its links count.
  for (const start of [...replaced.keys()]) {
    const seen = [];
    for (let at = start; at && !seen.includes(at); at = replaced.get(at)) seen.push(at);
    const last = replaced.get(seen.at(-1));
    if (last && seen.includes(last)) {
      for (const target of seen.slice(seen.indexOf(last))) {
        if (!replaced.has(target)) continue;
        failures.push(new Failure(replaced.get(target), "supersedes-invalid"));
        replaced.delete(target);
      }
    }
  }
  const confirmed = new Set(lists.confirmed_supersedes.map((entry) => entry.path));
  for (const by of replaced.values())
    if (!confirmed.has(by)) failures.push(new Failure(by, "supersedes-unconfirmed"));
  for (const entry of lists.confirmed_supersedes) {
    if (byPath.get(entry.path)?.supersedes === undefined)
      failures.push(new Failure(entry.at, "ballot-invalid", "confirmed_supersedes"));
  }
  const retired = new Set(lists.retired_companions.map((entry) => entry.path));
  for (const entry of lists.retired_companions) {
    const s = byPath.get(entry.path);
    if (!s || isSample(s))
      failures.push(new Failure(entry.at, "ballot-invalid", "retired_companions"));
  }

  const samples = snapshots.filter((s) => isSample(s) && !replaced.has(s.path));
  if (!snapshots.some(isSample)) failures.push(new Failure(BALLOT_DIR, "no-sample-ballot"));
  if (samples.length > 1) failures.push(new Failure(BALLOT_DIR, "sample-ballot-not-unique"));
  const companions = snapshots.filter((s) => !isSample(s) && !retired.has(s.path));
  return { failures, sample: samples.length === 1 ? samples[0] : null, companions };
};

const parseArgs = (argv) => {
  const show = argv[0] === "--show";
  const rest = show ? argv.slice(1) : argv;
  if (rest.length !== 1 || rest[0].startsWith("--")) throw new Failure("-", "usage");
  parseBallot(rest[0]);
  return { show, ballot: rest[0] };
};

// The view: the link, the companions the compile agent may read, then the
// hashes of what it was checked against, so a later gate can tell a view that
// ballot.yaml, the sample ballot or a companion no longer agree with.
const viewText = (yaml, sample, companions, spans) =>
  [
    `link: ${sample.path}`,
    ...companions.map((companion) => `read: ${companion.path}`),
    `sha256: ${yaml.hash}  ballot.yaml`,
    `sha256: ${sha256(sample.bytes)}  ${sample.path}`,
    ...companions.map((companion) => `sha256: ${sha256(companion.bytes)}  ${companion.path}`),
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
  const failures = dataRepoSetupFailures(root, ballot);
  // No address is stored (ADR 0017), and a leftover file has no guards, so it
  // fails until it is deleted. Only its name is looked at, never its text.
  if (fs.lstatSync(path.join(root, "addresses.yaml"), { throwIfNoEntry: false })) {
    failures.push(
      new Failure("addresses.yaml", "addresses-leftover", undefined, "list-zips-then-delete"),
    );
  }
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
  const privacy = checkPrivacy({ root, ballot, yaml, lists: privateLists, keys: ALLOWED_KEYS });
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

  const found = readBallotSnapshots(
    ballotDir,
    yaml?.lists ?? { confirmed_supersedes: [], retired_companions: [] },
  );
  failures.push(...found.failures, ...checkCompanions(found.companions));
  if (yaml) {
    failures.push(
      ...checkPeople({
        candidates: yaml.candidates,
        sample: found.sample,
        companions: found.companions,
      }),
    );
  }
  let spans = [];
  // The last failure in another ballot carries the hint to run ballot-check on
  // each ballot, which locates its own failures.
  const elsewhere = failures.filter((f) => f.location === "-" && !f.hint);
  if (elsewhere.length) elsewhere.at(-1).hint = "check-each-ballot";
  const warnings = [...privacy.warnings];
  const lines = failures.map((f) => f.line);
  // Lines only --show prints, which fail nothing.
  const shown = [];
  // Matching needs both files; without them it would only add noise.
  if (found.sample && yaml && privateLists) {
    const match = matchBallot({
      ...found.sample,
      contests: yaml.contests,
      privateStrings: privateLists.private_strings,
      ignoredLines: privateLists.ignored_lines,
    });
    spans = match.spans;
    const at = (line) => `${found.sample.path}:${line}`;
    for (const { line, entry } of match.wholeLines)
      warnings.push(`${at(line)} private-whole-line ${entry}`);
    lines.push(...match.failures.map((f) => f.line));
    for (const { line, text } of match.unaccounted) {
      const unaccounted = new Failure(at(line), "line-unaccounted").line;
      lines.push(show ? `${unaccounted}\n    ${printable(text)}` : unaccounted);
    }
    if (show) {
      for (const { line, text } of match.privateLines)
        shown.push(`${at(line)} line-private\n    ${printable(text)}`);
    }
  }
  if (lines.length) throw new Failures([...warnings, ...lines, ...shown]);

  const tmp = `${view}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, viewText(yaml, found.sample, found.companions, spans));
  fs.renameSync(tmp, view);
  return [...warnings, ...shown, `${VIEW} written`];
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

module.exports = { TYPE_KEYS, ballotIdPrefix, check, main };
