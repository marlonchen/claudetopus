"use strict";

// Values the references pin; tests/lib.test.js checks each against its reference text.

// The recorded GitHub id of this skill's public source repo, marlonchen/claudetopus (Rule 8).
const SOURCE_REPO_ID = "1373776339";

// SKILL.md Layout: the <election> directory.
const ELECTION_PATTERN = /^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$/;
// ballot-format.md, Ballot ids.
const BALLOT_ID_PATTERN = /^[a-z]{2}-[a-z]+(-[a-z]+)*-[1-9][0-9]?$/;
// ballot-format.md, Ids: contest, candidate and official ids. Snapshot names use it too.
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// snapshot-format.md, Cleaning the URL: the API-key environment variables the scripts read.
const KEY_ENV = ["OPENFEC_API_KEY", "OPENSTATES_API_KEY"];

// snapshot-format.md: the _ballot snapshot roles, and the ledger that lists them.
const ROLES = ["sample_ballot", "candidate_list", "pamphlet", "write_in_list", "withdrawal_notice"];
const LEDGER = "ballot.ledger";

// snapshot-format.md, Manifest: the operating-system and editor leftovers
// that check, ballot-check and the ballot gate skip.
const LEFTOVER = /^(\.DS_Store|Thumbs\.db|.*\.swp)$/;
// ballot-format.md, Ballot check: the sample ballot as the compile agent reads it.
const VIEW = "ballot-view.md";
// article-format.md, Claim lines: an excerpt's length, apart from a sample-ballot span.
const EXCERPT_LENGTH = { min: 20, max: 400 };
// article-format.md, Section states: the states other than claims.
const SECTION_STATES = [
  "Unknown, no source found",
  "Not researched yet",
  "Not part of this office's job",
];

// sections.md: each contest type's sections, by name without the letter.
const SECTIONS = {
  candidate: [
    "On the ballot",
    "Background",
    "Record in public office",
    "Money",
    "Positions",
    "Controversies and cases",
  ],
  retention: [
    "On the ballot",
    "Record in office",
    "Evaluation findings",
    "Discipline",
    "Statements",
  ],
  measure: [
    "What it does",
    "Fiscal effect",
    "Arguments for",
    "Arguments against",
    "Independent analysis",
  ],
};
// sections.md, Positions issues: the office types a candidate contest may carry.
const OFFICE_TYPES = ["federal", "state", "local", "judicial"];
// sections.md, Positions issues: each office type's issues, in order. A
// judicial contest has none: its Positions is the exempt section below.
const POSITIONS_ISSUES = {
  federal: [
    "Taxes and spending",
    "Economy and jobs",
    "Health care",
    "Immigration",
    "Abortion",
    "Energy and environment",
    "Foreign policy and defense",
  ],
  state: [
    "Taxes and the state budget",
    "Economy and jobs",
    "Education",
    "Health care",
    "Public safety",
    "Energy and environment",
    "Abortion",
  ],
  local: [
    "Taxes and budget",
    "Public safety",
    "Schools",
    "Housing and development",
    "Roads and transit",
  ],
  judicial: [],
};
// sections.md, Not part of this office's job: the one exempt section.
const EXEMPTION = { type: "candidate", office_type: "judicial", section: "Positions" };
// sections.md: the sections a withdrawn candidate who is still printed keeps.
const WITHDRAWN_SECTIONS = ["On the ballot"];
// sections.md, the Rule column: the sections marked `says-only`.
const SAYS_ONLY = {
  candidate: ["Positions"],
  retention: ["Statements"],
  measure: ["Arguments for", "Arguments against"],
};
// sections.md, the Rule column: the sections marked `always reviewed`.
const ALWAYS_REVIEWED = {
  candidate: ["Controversies and cases"],
  retention: ["Discipline"],
  measure: [],
};
// review-list.md, What goes on it: the allegation words, each a stem and its
// endings as the list writes them.
const ALLEGATION_WORDS = [
  "alleg(e|ed|es|ing|ation|ations|edly)",
  "accus(e|ed|es|ing|ation|ations)",
  "charged",
  "charges",
  "indict(s|ed|ing|ment|ments)",
  "convict(s|ed|ing|ion|ions)",
  "sues",
  "sued",
  "suing",
  "lawsuit(s)",
  "investigat(e|ed|es|ing|ion|ions)",
  "arrest(s|ed|ing)",
  "sanction(s|ed|ing)",
  "disciplin(e|ed|ary)",
  "settlement(s)",
  "fraud(s|ulent|ulently)",
  "felon(s|y|ies)",
  "misconduct",
  "guilty",
  "plead(s|ed|ing)",
  "pled",
  "plea(s)",
  "subpoena(s|ed)",
  "complaint(s)",
  "probe(s|d)",
  "censur(e|ed|es)",
  "impeach(ed|es|ment)",
  "resign(s|ed|ing|ation)",
  "fined",
  "violat(e|ed|es|ing|ion|ions)",
  "reprimand(s|ed)",
  "admonish(ed|es|ment)",
  "suspen(d|ds|ded|ding|sion|sions)",
  "disbar(red|ment)",
  "scandal(s)",
  "dui",
  "penalt(y|ies)",
];
// sections.md, the Discovery checklist items column: the items each section
// draws on. On the ballot draws on _ballot/ snapshots, never the search log.
const SECTION_ITEMS = {
  candidate: {
    Background: ["4", "5"],
    "Record in public office": ["1", "2"],
    Money: ["1", "2"],
    Positions: ["5"],
    "Controversies and cases": ["2", "3", "4"],
  },
  retention: {
    "Record in office": ["7"],
    "Evaluation findings": ["7"],
    Discipline: ["7"],
    Statements: ["7"],
  },
  measure: {
    "What it does": ["6"],
    "Fiscal effect": ["6"],
    "Arguments for": ["6"],
    "Arguments against": ["6"],
    "Independent analysis": ["6"],
  },
};
// snapshot-format.md, Search log: the checklist items each contest type logs.
const CHECKLIST_ITEMS = { candidate: ["1", "2", "3", "4", "5"], measure: ["6"], retention: ["7"] };
// ballot-format.md: a candidate's status.
const STATUSES = ["on_ballot", "withdrawn_still_printed", "certified_write_in"];

module.exports = {
  ALLEGATION_WORDS,
  ALWAYS_REVIEWED,
  BALLOT_ID_PATTERN,
  CHECKLIST_ITEMS,
  ELECTION_PATTERN,
  EXCERPT_LENGTH,
  EXEMPTION,
  ID_PATTERN,
  KEY_ENV,
  LEDGER,
  LEFTOVER,
  OFFICE_TYPES,
  POSITIONS_ISSUES,
  ROLES,
  SAYS_ONLY,
  SECTION_ITEMS,
  SECTION_STATES,
  SECTIONS,
  SOURCE_REPO_ID,
  STATUSES,
  VIEW,
  WITHDRAWN_SECTIONS,
};
