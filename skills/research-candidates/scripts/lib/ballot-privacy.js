"use strict";

// ballot-check's privacy rules (ballot-format.md, Private text, Ids, Ballot
// ids and Tiers): ballot.yaml, ignored_lines and tiers.yaml go out to web
// searches and page anchors, so none may hold private text. Matching is the
// publish scan's (SKILL.md step 6.3); failures name the field and the class,
// never the matched text (Rule 5).

const { load } = require("./deps");
const { addressValues, tiersPrivacy } = require("./data-files");
const { Failure } = require("./output");
const { CLASSES, YEAR, digitRuns, isEmptyValue, scan } = require("./privacy");

const TEXT_CLASSES = ["address", "label", "private-string"];
// The fields discovery searches with, or the page builds anchors from.
const SEARCHED = ["id", "jurisdiction", "search_terms"];

const classCodes = (text, values, classes) => [
  ...new Set(scan(text, values, classes).map((m) => CLASSES[m.class])),
];

// For each line of ballot.yaml, the key of the field on it, when that key is
// one ballot.yaml allows (`keys`): any other key is the researcher's text.
const keysByLine = (doc, lineCounter, keys) => {
  const YAML = load("yaml");
  const byLine = new Map();
  const lineOf = (offset) => lineCounter.linePos(offset).line;
  YAML.visit(doc, {
    Pair(_, pair) {
      if (!YAML.isScalar(pair.key) || !keys.has(pair.key.value) || !pair.value?.range) return;
      // A map, or a list of maps, spans other fields' lines and comments, so
      // only a scalar or a list of scalars (not_researched) keys its lines.
      const flat = YAML.isSeq(pair.value) && pair.value.items.every((i) => YAML.isScalar(i));
      if (!YAML.isScalar(pair.value) && !flat) return;
      const last = lineOf(Math.max(pair.value.range[0], pair.value.range[1] - 1));
      for (let line = lineOf(pair.key.range[0]); line <= last; line++) {
        byLine.set(line, pair.key.value);
      }
    },
  });
  return byLine;
};

// The ballot.yaml text with the printed title of each contest that has a
// display_title blanked out, keeping every line where it was.
const withoutHiddenTitles = (text, doc) => {
  const YAML = load("yaml");
  let blanked = text;
  const contests = doc.get("contests", true);
  for (const contest of YAML.isSeq(contests) ? contests.items : []) {
    if (!YAML.isMap(contest) || !contest.has("display_title")) continue;
    const title = contest.get("title", true);
    if (!title?.range) continue;
    const [start, end] = title.range;
    blanked =
      blanked.slice(0, start) +
      blanked.slice(start, end).replace(/[^\n]/g, " ") +
      blanked.slice(end);
  }
  return blanked;
};

// The printed titles of contests with a display_title.
const hiddenTitles = (data) =>
  (Array.isArray(data?.contests) ? data.contests : [])
    .filter((c) => c?.display_title !== undefined && typeof c.title === "string")
    .map((c) => c.title);

// { failures: [Failure], warnings: [report line] } for one ballot.
// `yaml` is checkBallotYaml's result (null when ballot.yaml could not be
// read), `lists` private.yaml's (null likewise), `addresses` addresses.yaml's.
const checkPrivacy = ({ root, ballot, yaml, lists, addresses, keys }) => {
  const failures = [];
  const warnings = [];
  const strings = lists?.private_strings ?? [];
  const values = {
    "private-string": strings,
    ...addressValues(addresses ?? []),
  };

  if (yaml) {
    const { doc, lineCounter, text } = yaml.parsed;
    const byLine = keysByLine(doc, lineCounter, keys);
    for (const { line, class: cls } of scan(withoutHiddenTitles(text, doc), values, TEXT_CLASSES)) {
      const key = byLine.get(line);
      const hint = key === "state" || key === "county" ? "list-full-place-name" : undefined;
      failures.push(new Failure(`ballot.yaml:${line}`, CLASSES[cls], key, hint));
    }
    const titles = { title: hiddenTitles(doc.toJS()) };
    const contests = doc.get("contests", true);
    for (const contest of load("yaml").isSeq(contests) ? contests.items : []) {
      for (const key of SEARCHED) {
        const node = contest?.get?.(key, true);
        if (typeof node?.value !== "string") continue;
        if (classCodes(node.value, titles, ["title"]).length) {
          const at = `ballot.yaml:${lineCounter.linePos(node.range[0]).line}`;
          failures.push(new Failure(at, CLASSES.title, key));
        }
      }
    }
  }

  if (lists) {
    for (const entry of lists.ignored_lines) {
      for (const code of classCodes(entry, values, TEXT_CLASSES))
        failures.push(new Failure("private.yaml", code, "ignored_lines"));
    }
    if (strings.some(isEmptyValue))
      failures.push(new Failure("private.yaml", "private-empty", "private_strings"));
    const runs = strings.flatMap((s) => digitRuns(s.normalize("NFKC")));
    const number = Number(ballot.split("-").pop());
    if (runs.some((run) => Number(run) === number))
      failures.push(new Failure("private.yaml", "ballot-id-private"));
    if (runs.some((run) => YEAR.test(run))) warnings.push("private.yaml private-year");
  }

  for (const a of addresses ?? []) {
    if (isEmptyValue(a.address)) failures.push(new Failure(a.at, "private-empty", "address"));
    if (isEmptyValue(a.street)) failures.push(new Failure(a.at, "private-empty", "street"));
    if (isEmptyValue(a.label)) failures.push(new Failure(a.at, "private-empty"));
  }

  try {
    failures.push(...tiersPrivacy(root, ballot, values));
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    failures.push(error);
  }
  return { failures, warnings };
};

module.exports = { checkPrivacy };
