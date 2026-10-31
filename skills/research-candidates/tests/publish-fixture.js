"use strict";

// The data repo publish's tests run against (publish.test.js): a ballot that
// passes ballot-check with one contest of each shape the page draws, and a
// House contest whose every claim the first review run baselines, so it is
// ready once reviewed. The other contests have no article until a test adds
// one (addContest). Everything is committed, as the ballot gate requires.

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { BALLOT, git, makeDataRepo, runCli, runInTty } = require("./harness");
const { load } = require("../scripts/lib/deps");

const repos = [];

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

const UNKNOWN = "Unknown, no source found";
const NOT_RESEARCHED = "Not researched yet";
// sections.md, Positions issues.
const ISSUES = {
  federal: [
    "Taxes and spending",
    "Economy and jobs",
    "Health care",
    "Immigration",
    "Abortion",
    "Energy and environment",
    "Foreign policy and defense",
  ],
  local: [
    "Taxes and budget",
    "Public safety",
    "Schools",
    "Housing and development",
    "Roads and transit",
  ],
};

const BALLOT_YAML = `election: 2026-general
state: XX
county: Exampleton County
slug: k3x9qa
contest_count: 4
contests:
  - id: us-house-07
    type: candidate
    jurisdiction: XX congressional district 7
    office_type: federal
    title: Representative in Congress, 7th District
    printed_count: 2
    vote_for: 1
    candidates:
      - id: jane-example
        name: Jane Example
        party: Example Party
        status: on_ballot
      - id: john-sample
        name: John Sample
        party: Sample Party
        status: on_ballot
  - id: school-director
    type: candidate
    jurisdiction: XX Exampleton County
    office_type: local
    title: School Director
    printed_count: 3
    vote_for: 2
    not_researched: [Money]
    candidates:
      - id: ann-able
        name: Ann Able
        party: Example Party
        status: on_ballot
      - id: bo-baker
        name: Bo Baker
        party: Example Party
        status: withdrawn_still_printed
      - id: cy-cole
        name: Cy Cole
        party: Example Party
        status: on_ballot
      - id: di-dunn
        name: Di Dunn
        status: certified_write_in
  - id: supreme-court-retention-a
    type: retention
    jurisdiction: XX supreme court
    office_type: judicial
    title: Shall Justice Pat Example of the Supreme Court be retained in office?
    official:
      id: pat-example
      name: Pat Example
  - id: question-1
    type: measure
    jurisdiction: XX Exampleton County
    search_terms: library levy
    title: "Question 1: Springfield Township Library Levy"
    display_title: Question 1
`;

const SAMPLE_BODY = `OFFICIAL SAMPLE BALLOT
Precinct 12
Representative in Congress,
7th District
Vote for one
Jane Example
Example Party
John Sample
Sample Party
School Director
Vote for two
Ann Able
Example Party
Bo Baker
Example Party
Cy Cole
Example Party
Shall Justice Pat Example of the Supreme Court
be retained in office?
Yes
No
Question 1: Springfield Township Library Levy
Yes
No`;

const PRIVATE = `private_strings:
  - Precinct 12
  - Springfield Township
ignored_lines:
  - OFFICIAL SAMPLE BALLOT
  - "Yes"
  - "No"
`;

const SAMPLE_BALLOT = "sources/_ballot/sample-ballot.md";
const JANE_BIO = "sources/us-house-07/jane-example/bio.md";
const JANE_SITE = "sources/us-house-07/jane-example/site.md";

// A snapshot as fetch-snapshot saves it; `extra` adds front matter lines.
const snapshot = ({
  subject,
  url,
  body,
  source = "Example News",
  tier = "T2",
  statementsOnly = false,
  owner = "third-party",
  method = "html",
  fetched = "2026-10-19",
  extra = "",
}) => `---
source: ${source}
url: ${url}
fetched: ${fetched}
method: ${method}
tier: ${tier}
statements_only: ${statementsOnly}
subject: ${subject}
owner: ${owner}
${extra}---
${body}
`;

const SAMPLE_TEXT = snapshot({
  subject: "_ballot",
  source: "Exampleton County elections",
  url: "https://county.example.gov/ballots/precinct-12.pdf",
  tier: "T1",
  method: "pdf",
  extra: "role: sample_ballot\n",
  body: SAMPLE_BODY,
});

const SNAPSHOTS = {
  [JANE_BIO]: snapshot({
    subject: "jane-example",
    url: "https://news.example.com/jane",
    body: "Jane Example taught school in Exampleton for twelve years. She served two terms on the school board.",
  }),
  [JANE_SITE]: snapshot({
    subject: "jane-example",
    source: "Jane Example campaign site",
    url: "https://janeexample.com/issues",
    tier: "T4",
    statementsOnly: true,
    owner: "jane-example",
    body: "Jane Example will cut property taxes for every family in Exampleton.",
  }),
};

const claim = (text, tag, target, excerpt) =>
  `- ${text} \`${tag}\` [s1](../${target})\n  > ${excerpt}`;
// A claim quoting one whole span of the sample ballot.
const ballotClaim = (span) => claim(span, "T1", SAMPLE_BALLOT, span);

const CLAIMS = {
  taught: claim(
    "Jane Example taught school in Exampleton for twelve years.",
    "T2",
    JANE_BIO,
    "Jane Example taught school in Exampleton for twelve years.",
  ),
  taxes: claim(
    "Says: Jane Example will cut property taxes for every family in Exampleton.",
    "T4s",
    JANE_SITE,
    "Jane Example will cut property taxes for every family in Exampleton.",
  ),
};

const section = (heading, body = UNKNOWN) => `### ${heading}\n\n${body}\n`;

// A candidate block: `parts` gives a section's body by name, Unknown otherwise;
// `positions` gives an issue's body, or a string for the whole section.
const block = (name, parts, officeType = "federal") =>
  [
    `## ${name}\n`,
    section("A. On the ballot", parts.onBallot),
    section("B. Background", parts.background),
    section("C. Record in public office", parts.record),
    section("D. Money", parts.money),
    typeof parts.positions === "string"
      ? section("E. Positions", parts.positions)
      : [
          "### E. Positions\n",
          ...ISSUES[officeType].map(
            (issue) => `#### ${issue}\n\n${parts.positions?.[issue] ?? UNKNOWN}\n`,
          ),
        ].join("\n"),
    section("F. Controversies and cases", parts.controversies),
  ].join("\n");

const houseArticle = (jane = {}) =>
  `# us-house-07\n\n${block("Jane Example", {
    onBallot: ballotClaim("Jane Example Example Party"),
    background: CLAIMS.taught,
    positions: { "Taxes and spending": CLAIMS.taxes },
    ...jane,
  })}\n${block("John Sample", { onBallot: ballotClaim("John Sample Sample Party") })}`;

// Search-log lines for each subject and item.
const logLines = (contest, subjects, items) =>
  subjects.flatMap((s) => items.map((i) => `${contest}\t${s}\t${i}\t2026-10-20\n`)).join("");

const appendTo = (data, rel, text) => {
  const file = `${BALLOT}/${rel}`;
  data.write(file, (data.exists(file) ? data.read(file) : "") + text);
};

// Save a snapshot as fetch-snapshot would: its manifest line, then the file.
const plant = (data, rel, text) => {
  appendTo(data, "snapshots.sha256", `${sha256(text)}  ${rel}\n`);
  data.write(`${BALLOT}/${rel}`, text);
};

const run = (data, script, args) => runCli(script, args, { cwd: data.root, env: data.env });

const commit = (data, message = "research") => {
  git(data.root, "add", "-A");
  git(data.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message);
};

// Review `contest` through review-list as the researcher would: keys, a
// neutrality pass that flags nothing, the first run, then every listed item
// marked and counted.
const review = async (data, contest) => {
  const keys = await run(data, "review-list", ["--keys", BALLOT, contest]);
  assert.strictEqual(keys.status, 0, keys.stdout);
  const reviewed = keys.stdout
    .trim()
    .split("\n")
    .map((line) => line.split(" ")[2]);
  data.write(
    `${BALLOT}/review/${contest}.neutrality.md`,
    `<!-- reviewed: ${reviewed.join(" ")} -->\n`,
  );
  const first = await run(data, "review-list", [BALLOT, contest]);
  assert.strictEqual(first.status, 0, first.stdout);
  const file = `${BALLOT}/review/${contest}.md`;
  data.write(file, data.read(file).replaceAll("- [ ] ", "- [x] "));
  const marked = await run(data, "review-list", [BALLOT, contest]);
  assert.strictEqual(marked.status, 0, marked.stdout);
  assert.match(marked.stdout, new RegExp(`articles/${contest}.md ready`));
};

// Add a contest's article, its snapshots and search log, review it and commit.
const addContest = async (data, { id, article, snapshots = {}, log = "" }) => {
  for (const [rel, text] of Object.entries(snapshots)) plant(data, rel, text);
  data.write(`${BALLOT}/articles/${id}.md`, article);
  if (log) data.write(`${BALLOT}/search-log/${id}.tsv`, log);
  await review(data, id);
  commit(data);
};

// A data repo whose ballot passes ballot-check and whose House contest is
// reviewed and ready, all committed. `ballot` and `house` override parts:
// `house` is the House article, `snapshots` more snapshots to save first,
// `sample` the sample ballot's snapshot.
const setup = async ({
  ballot = BALLOT_YAML,
  house = houseArticle(),
  snapshots = {},
  sample = SAMPLE_TEXT,
} = {}) => {
  const data = makeDataRepo({ ballot, private: PRIVATE });
  repos.push(data);
  data.write("publish.yaml", "branch: main\ndisplay_name: Sam\n");
  plant(data, SAMPLE_BALLOT, sample);
  appendTo(data, "ballot.ledger", `${SAMPLE_BALLOT}\tsample_ballot\turl\tnone\t2026-10-20\n`);
  const checked = await run(data, "ballot-check", [BALLOT]);
  assert.strictEqual(checked.status, 0, checked.stdout);
  await addContest(data, {
    id: "us-house-07",
    article: house,
    snapshots: { ...SNAPSHOTS, ...snapshots },
    log: logLines("us-house-07", ["jane-example", "john-sample"], ["1", "2", "3", "4", "5"]),
  });
  return data;
};

const publish = (data, args = [BALLOT]) => run(data, "publish", args);

// A stub ssh that serves git's request from SSH_STUB_ROOT, where each GitHub
// repo is a bare repo at <owner>/<repo>.git, so a Pages clone keeps a real
// GitHub origin URL while its fetches and pushes stay on this machine. It
// logs each request to ssh.log there.
const SSH_STUB = `#!/bin/sh
for last; do :; done
printf '%s\\n' "$last" >>"$SSH_STUB_ROOT/ssh.log"
cd "$SSH_STUB_ROOT" && exec sh -c "$last"
`;

// A Pages repo for publish --push (SKILL.md step 6.4-6.6): a bare repo
// standing in for GitHub's me/ballots, served through the stub ssh, and its
// clone at pages_dir, named by publish.yaml. `seed` commits files to the
// remote's main first; without it the Pages repo is new and empty. `gh`
// overrides me/ballots' stub answer.
const PAGES_REPO = "me/ballots";
const PAGES_URL = `git@github.com:${PAGES_REPO}.git`;
const pagesSetup = (data, { seed, gh = { visibility: "PUBLIC", id: 77 } } = {}) => {
  const stub = fs.mkdtempSync(path.join(os.tmpdir(), "rc-pages-"));
  const bare = path.join(stub, `${PAGES_REPO}.git`);
  fs.mkdirSync(bare, { recursive: true });
  git(bare, "init", "-q", "--bare", "-b", "main");
  fs.writeFileSync(path.join(stub, "ssh"), SSH_STUB);
  fs.chmodSync(path.join(stub, "ssh"), 0o755);
  Object.assign(data.env, {
    GIT_SSH_COMMAND: path.join(stub, "ssh"),
    GIT_SSH_VARIANT: "simple",
    SSH_STUB_ROOT: stub,
    // The researcher's identity in pages_dir. Set here, since git's own
    // variables (a git hook running the tests exports them) override config.
    GIT_AUTHOR_NAME: "Sam",
    GIT_AUTHOR_EMAIL: "sam@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Sam",
    GIT_COMMITTER_EMAIL: "sam@users.noreply.github.com",
  });
  const ghFile = data.env.GH_STUB_FILE;
  const answers = JSON.parse(fs.readFileSync(ghFile, "utf8"));
  fs.writeFileSync(ghFile, JSON.stringify({ ...answers, [PAGES_REPO]: gh }));
  const pagesGit = (cwd, ...args) => {
    const result = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...data.env },
    });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout;
  };
  const dir = path.join(stub, "clone");
  data.write(
    "publish.yaml",
    `pages_repo: ${PAGES_REPO}\npages_dir: ${dir}\nbranch: main\ndisplay_name: Sam\n`,
  );
  const pages = {
    dir,
    bare,
    git: (...args) => pagesGit(dir, ...args),
    // A file in the remote's main, or null when it has none.
    remoteFile: (rel) => {
      const result = spawnSync("git", ["show", `main:${rel}`], { cwd: bare, encoding: "utf8" });
      return result.status === 0 ? result.stdout : null;
    },
    // Push files to the remote's `branch` from a clone of its own, as
    // another machine would. `head` also makes `branch` its default branch.
    pushRemote: (files, { branch = "main", head = false } = {}) => {
      const work = fs.mkdtempSync(path.join(stub, "other-"));
      pagesGit(stub, "clone", "-q", PAGES_URL, work);
      const has = pagesGit(work, "ls-remote", "origin", `refs/heads/${branch}`).trim() !== "";
      pagesGit(work, "checkout", "-q", ...(has ? [branch] : ["--orphan", branch]));
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
        fs.writeFileSync(path.join(work, rel), text);
      }
      pagesGit(work, "add", "-A");
      pagesGit(
        work,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "other",
      );
      pagesGit(work, "push", "-q", "origin", `HEAD:refs/heads/${branch}`);
      if (head) git(bare, "symbolic-ref", "HEAD", `refs/heads/${branch}`);
    },
    // The requests the stub ssh served, in order.
    sshCalls: () => {
      const log = path.join(stub, "ssh.log");
      return fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
    },
    cleanup: () => fs.rmSync(stub, { recursive: true, force: true }),
  };
  repos.push(pages);
  if (seed) pages.pushRemote(seed);
  pagesGit(stub, "clone", "-q", PAGES_URL, dir);
  return pages;
};

// publish --push on a pseudo-terminal, as the researcher runs it, giving
// `answers` to its prompts in turn.
const publishPush = (data, { args = ["--push", BALLOT], answers = ["y", "y"] } = {}) =>
  runInTty("publish", args, { cwd: data.root, env: data.env, answer: answers });

const lines = (result) => result.stdout.split("\n").filter(Boolean);

// The page publish wrote, as a DOM document.
const page = (data) => load("linkedom").parseHTML(data.read(`${BALLOT}/site/index.html`)).document;

// An element's text with its whitespace collapsed.
const text = (el) => el.textContent.replace(/\s+/g, " ").trim();

module.exports = {
  CLAIMS,
  ISSUES,
  JANE_BIO,
  JANE_SITE,
  NOT_RESEARCHED,
  PAGES_REPO,
  SAMPLE_BALLOT,
  SAMPLE_TEXT,
  addContest,
  ballotClaim,
  block,
  claim,
  commit,
  houseArticle,
  lines,
  logLines,
  page,
  pagesSetup,
  publish,
  publishPush,
  repos,
  review,
  section,
  setup,
  snapshot,
  text,
};
