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

module.exports = {
  BALLOT_ID_PATTERN,
  ELECTION_PATTERN,
  ID_PATTERN,
  KEY_ENV,
  LEDGER,
  OFFICE_TYPES,
  ROLES,
  SECTIONS,
  SOURCE_REPO_ID,
};
