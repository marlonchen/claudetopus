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

const TEXT_CLASSES = ["address", "zip", "label", "private-string"];
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

// The printed title nodes of contests with a display_title.
const hiddenTitleNodes = (doc) => {
  const YAML = load("yaml");
  const contests = doc.get("contests", true);
  return (YAML.isSeq(contests) ? contests.items : [])
    .filter((contest) => YAML.isMap(contest) && contest.has("display_title"))
    .map((contest) => contest.get("title", true))
    .filter((title) => title?.range);
};

// The ballot.yaml text with the hidden printed titles blanked out, keeping
// every line where it was.
const withoutHiddenTitles = (text, titles) => {
  let blanked = text;
  for (const {
    range: [start, end],
  } of titles) {
    blanked =
      blanked.slice(0, start) +
      blanked.slice(start, end).replace(/[^\n]/g, " ") +
      blanked.slice(end);
  }
  return blanked;
};

// Every string scalar in ballot.yaml but the hidden printed titles, as
// { value, first, last } lines. Its value is what discovery reads: a quoted
// escape (`\u0063`) or a line continuation spells it differently in the text.
const stringScalars = (doc, lineCounter, titles) => {
  const YAML = load("yaml");
  const lineOf = (offset) => lineCounter.linePos(offset).line;
  const scalars = [];
  YAML.visit(doc, {
    Scalar(_, node) {
      if (typeof node.value !== "string" || !node.range || titles.includes(node)) return;
      const [start, end] = node.range;
      scalars.push({
        value: node.value,
        first: lineOf(start),
        last: lineOf(Math.max(start, end - 1)),
      });
    },
  });
  return scalars;
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
    const { doc, lineCounter, text, data } = yaml.parsed;
    const byLine = keysByLine(doc, lineCounter, keys);
    const titleNodes = hiddenTitleNodes(doc);
    const found = scan(withoutHiddenTitles(text, titleNodes), values, TEXT_CLASSES);
    // A value the text scan missed is located by its first line.
    for (const { value, first, last } of stringScalars(doc, lineCounter, titleNodes)) {
      for (const { class: cls } of scan(value, values, TEXT_CLASSES)) {
        const seen = found.some((m) => m.class === cls && m.line >= first && m.line <= last);
        if (!seen) found.push({ line: first, class: cls });
      }
    }
    const order = Object.keys(CLASSES);
    found.sort((a, b) => a.line - b.line || order.indexOf(a.class) - order.indexOf(b.class));
    const located = new Set(found.map((m) => `${m.line} ${m.class}`));
    for (const at of located) {
      const [line, cls] = at.split(" ");
      const key = byLine.get(Number(line));
      const hint = key === "state" || key === "county" ? "list-full-place-name" : undefined;
      failures.push(new Failure(`ballot.yaml:${line}`, CLASSES[cls], key, hint));
    }
    const titles = { title: hiddenTitles(data) };
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

module.exports = { checkPrivacy, hiddenTitles };
