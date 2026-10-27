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

module.exports = { BALLOT_ID_PATTERN, ELECTION_PATTERN, ID_PATTERN, SOURCE_REPO_ID };
