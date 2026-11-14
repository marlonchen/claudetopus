"use strict";

// The contests the page shows (SKILL.md steps 6.1 and 6.2), judged as publish
// judges them: review-list's `ready` decides each contest, a review file
// missing next to its baseline refuses, and a contest whose claims, excerpts
// or cited source names hold private text is dropped. publish renders what
// this returns; fetch-snapshot --archive sends only the snapshots it cites
// (snapshot-format.md, Saved copies).

const path = require("node:path");
const { ID_PATTERN } = require("./constants");
const { contestsOf, familyPrivateValues, hiddenTitles, readYamlDocument } = require("./data-files");
const { Failure, Failures } = require("./output");
const { dropContests } = require("./page-scan");
const { ready } = require("./review-list");

// Run under the ballot lock, once its manifest is verified; `refresh` keeps
// the lock fresh. Returns ballot.yaml as read (`data`), its `contests` and
// valid `ids`, the private `values` the page is scanned with, the `drops`
// dropContests made, and `shown`, ready()'s Map with each dropped contest not
// ready.
const pageContests = (root, ballot, ballotDir, refresh) => {
  // Read once: the page shows the contests ready judged.
  const data = readYamlDocument(path.join(ballotDir, "ballot.yaml"), "ballot.yaml").doc.toJS();
  const contests = contestsOf(data);
  const ids = data.contests.map((c) => c.id).filter((id) => ID_PATTERN.test(id));
  // Once, for every contest, under the ballot lock (review-list.md).
  const answers = ready(ballotDir, ids, { contests, manifestVerified: true });
  refresh();
  // A review file missing next to its baseline refuses: review-list rebuilds it.
  const missing = ids.filter((id) => answers.get(id).reasons.includes("review-missing"));
  if (missing.length)
    throw new Failures(missing.map((id) => new Failure(`review/${id}.md`, "review-missing").line));
  // Step 6.2: a contest whose claims, excerpts or source names hold private
  // text is not ready (SKILL.md step 6.3). The page is public, so private
  // means any ballot's in this data repo, not only this one's.
  const values = { ...familyPrivateValues(root, ballot), title: hiddenTitles(data) };
  const drops = dropContests(ids, answers, values);
  const shown = new Map(answers);
  for (const [id, reasons] of drops.dropped) shown.set(id, { ready: false, reasons });
  return { data, contests, ids, values, drops, shown };
};

// The snapshot paths the claims of shown, ready contests cite, sorted.
const citedSnapshots = (shown) => {
  const cited = new Set();
  for (const answer of shown.values()) {
    if (!answer.ready) continue;
    for (const { snapshot } of answer.claims) if (typeof snapshot === "string") cited.add(snapshot);
  }
  return [...cited].sort();
};

module.exports = { citedSnapshots, pageContests };
