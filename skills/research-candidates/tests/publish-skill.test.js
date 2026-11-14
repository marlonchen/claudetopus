"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, SKILL, git, runInTty, sourceRepo } = require("./harness");
const { checkedBallot, commit, lines, publish, repos } = require("./publish-fixture");

// publish's installed-skill check (SKILL.md step 6.1, ballot gate), run as a
// subprocess against a temp data repo with real git (seam 1): the stub gh
// serves the skill's source repo by its recorded id from a local git repo
// (harness.js), so no test reaches GitHub. The planted drift cases on the
// fixture ballot are in fixture.test.js.

afterEach(() => {
  while (repos.length) repos.pop().cleanup();
});

const SITE = `${BALLOT}/site/index.html`;

// A data repo whose ballot passes ballot-check and whose installed skill
// matches skill_commit, all committed.
const installed = async () => {
  const data = await checkedBallot();
  commit(data);
  return data;
};

// publish refuses at its ballot gate with exactly `refused`, writing no page.
const refuses = async (data, refused) => {
  const result = await publish(data);
  assert.deepStrictEqual(lines(result), refused);
  assert.strictEqual(result.status, 1);
  assert.ok(!data.exists(SITE));
};

describe("publish: the installed skill is committed", () => {
  // Value: protects=the installed skill publish ran beside is in a researcher's data-repo commit, so the commit they reviewed is the one that ran; fails_when=publish checks only the files on disk, which match the tree before they are committed; why_new=ticket 51; seam=cli; no_claim=a commit the researcher never read
  it("refuses an install that was never committed", async () => {
    const data = await installed();
    git(data.root, "rm", "-r", "-q", "--cached", ".claude/skills");
    git(
      data.root,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "untrack",
    );
    await refuses(data, [`${SKILL} skill-uncommitted`]);
  });

  // Value: protects=a staged change and a file git is told to assume unchanged or skip all count as uncommitted, as for the ballot's own areas; fails_when=the check reads only the worktree diff, skips ls-files -v, or reads only its lowercase tags; why_new=ticket 51, PR #60 review (O2); seam=cli; no_claim=none
  it("refuses a staged change, and a file git is told to assume unchanged or skip", async () => {
    const staged = await installed();
    git(staged.root, "rm", "-q", "--cached", `${SKILL}/references/page.md`);
    await refuses(staged, [`${SKILL} skill-uncommitted`]);

    for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
      const hidden = await installed();
      git(hidden.root, "update-index", flag, `${SKILL}/references/page.md`);
      await refuses(hidden, [`${SKILL} skill-uncommitted`]);
    }
  });

  // Value: protects=a change git tracks under the skill's directory in another letter case still counts, as a case-insensitive filesystem reads it as the skill; fails_when=the git pathspecs drop :(icase); why_new=PR #60 review (O2); seam=cli; no_claim=a skill directory tracked only in another case (O6)
  it("refuses a change git tracks under the skill in another letter case", async () => {
    const data = await installed();
    const blob = git(data.root, "rev-parse", `HEAD:${SKILL}/references/page.md`).trim();
    const other = ".claude/skills/Research-Candidates/references/page.md";
    // Committed from the index alone, with ignorecase off so git keeps the
    // path's case as given, then its deletion staged: a change git reports
    // by that path on any filesystem.
    git(
      data.root,
      "-c",
      "core.ignorecase=false",
      "update-index",
      "--add",
      "--cacheinfo",
      `100644,${blob},${other}`,
    );
    git(data.root, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "case");
    git(data.root, "rm", "-q", "--cached", other);
    await refuses(data, [`${SKILL} skill-uncommitted`]);
  });
});

describe("publish: the installed skill against its tree", () => {
  // Value: protects=a tree file the install or a hand delete lost refuses by its path; fails_when=publish checks only the files on disk; why_new=ticket 51; seam=cli; no_claim=none
  it("refuses a tree file missing on disk, naming it", async () => {
    const data = await installed();
    fs.rmSync(data.file(`${SKILL}/references/page.md`));
    commit(data, "lose a file");
    await refuses(data, [`${SKILL}/references/page.md skill-missing`]);
  });

  // Value: protects=publish refuses with one line when no skill is installed where SKILL.md says, rather than crashing or naming every tree file; fails_when=a missing directory is an internal error, or passes as empty; why_new=ticket 51; seam=cli; no_claim=none
  it("refuses with one line when the skill is not installed", async () => {
    const data = await installed();
    fs.rmSync(data.file(".claude/skills"), { recursive: true });
    commit(data, "uninstall");
    await refuses(data, [`${SKILL} skill-not-installed`]);
  });

  // Value: protects=the installed skill is a real directory in the data repo, not a link to a copy elsewhere that can change under it and that git, tracking only the link, never committed; fails_when=publish follows a symlinked skill directory, .claude/skills or .claude; why_new=ticket 51, PR #60 review (M2); seam=cli; no_claim=none
  for (const linked of [SKILL, ".claude/skills", ".claude"]) {
    it(`refuses a symlinked ${linked}, even to an exact copy`, async () => {
      const data = await installed();
      fs.renameSync(data.file(linked), data.file("elsewhere"));
      fs.symlinkSync(data.file("elsewhere"), data.file(linked));
      commit(data, "link the skill");
      await refuses(data, [`${linked} skill-symlink`]);
    });
  }

  // Value: protects=a second copy of the skill under .claude/skills, such as one an upgrade renamed rather than deleted, refuses, since Claude Code could load it instead; fails_when=publish checks only .claude/skills/research-candidates; why_new=PR #60 review (O5); seam=cli; no_claim=which copy Claude Code loads
  it("refuses another skill directory named research-candidates, by its area", async () => {
    const data = await installed();
    const old = ".claude/skills/research-candidates.bak";
    fs.cpSync(data.file(SKILL), data.file(old), { recursive: true });
    data.write(`${old}/SKILL.md`, data.read(`${old}/SKILL.md`).replace("The rules.", "Old rules."));
    // Another skill of its own name passes.
    data.write(".claude/skills/other/SKILL.md", "---\nname: other\ndescription: x\n---\n");
    commit(data, "leave the old copy");
    await refuses(data, [".claude/skills skill-duplicate"]);
    const shown = await runInTty("publish", ["--show", BALLOT], { cwd: data.root, env: data.env });
    assert.deepStrictEqual(lines(shown), [".claude/skills skill-duplicate", `    ${old}`]);
    assert.strictEqual(shown.status, 1);
  });

  // Value: protects=ADR 0006: a file or symlink found under the skill, whose name a researcher or tool chose, is located by the skill's area alone in output the session reads, so a name holding private text or a key never reaches it, and only --show in the researcher's terminal lists the paths; fails_when=publish names an extra file or symlink by its path, or --show lists none; why_new=PR #60 review (M1); seam=cli; no_claim=a tree path, which comes from the public source repo
  it("names an extra file or symlink only by the skill's area, listing paths only to --show", async () => {
    const data = await installed();
    const names = [
      "Springfield Township ballot",
      "OPENFEC_API_KEY=Fx7kQ2mZpL9vR4tW",
      "Precinct 12",
    ];
    data.write(`${SKILL}/references/${names[0]}`, "private\n");
    data.write(`${SKILL}/scripts/${names[1]}`, "key\n");
    fs.symlinkSync("page.md", data.file(`${SKILL}/references/${names[2]}`));
    commit(data, "plant names");
    const result = await publish(data);
    assert.deepStrictEqual(lines(result), [`${SKILL} skill-extra`, `${SKILL} skill-symlink`]);
    for (const part of names.flatMap((n) => n.split(/[^A-Za-z0-9]+/)))
      assert.ok(!result.stdout.toLowerCase().includes(part.toLowerCase()), part);
    const shown = await runInTty("publish", ["--show", BALLOT], { cwd: data.root, env: data.env });
    assert.deepStrictEqual(lines(shown), [
      `${SKILL} skill-extra`,
      `    ${SKILL}/references/${names[0]}`,
      `    ${SKILL}/scripts/${names[1]}`,
      `${SKILL} skill-symlink`,
      `    ${SKILL}/references/${names[2]}`,
    ]);
    assert.strictEqual(shown.status, 1);
  });
});

describe("publish: skill_commit", () => {
  const pin = (data, value) =>
    data.write(
      "publish.yaml",
      data
        .read("publish.yaml")
        .replace(/^skill_commit: .*\n/m, value ? `skill_commit: ${value}\n` : ""),
    );

  // Value: protects=publish checks against one exact commit: never a missing one, a branch or tag name, which moves, or a short id, which can grow ambiguous and which YAML reads as a number when it is all digits; fails_when=a missing skill_commit skips the check, or anything but a full commit id reaches the API; why_new=ticket 51; seam=cli; no_claim=none
  for (const [name, value] of [
    ["missing", null],
    ["a branch name", "main"],
    ["a short commit id", "1234567"],
  ]) {
    it(`refuses skill_commit ${name}, asking gh nothing`, async () => {
      const data = await installed();
      pin(data, value);
      const calls = data.ghCalls().length;
      await refuses(data, ["publish.yaml publish-invalid skill_commit"]);
      assert.ok(
        !data
          .ghCalls()
          .slice(calls)
          .some((call) => call.includes("repositories/")),
        "gh was asked about the source repo",
      );
    });
  }

  // Value: protects=skill_commit must be reachable from the source repo's default branch as the API names it, read by recorded id on github.com whatever GH_HOST says, so a commit only on another branch or a fork, or one main has not reached yet, is refused; fails_when=publish compares against a fixed branch, reads the repo by name or on another host, or accepts ahead or diverged; why_new=ticket 51, PR #60 review (O1, O4); seam=cli; no_claim=that GitHub's compare API reports behind and identical as the stub does
  for (const [name, at] of [
    ["only on another branch (diverged)", "side"],
    ["main has not reached yet (ahead)", "ahead"],
  ]) {
    it(`refuses a commit ${name}, by the repo's recorded id on github.com`, async () => {
      const data = await installed();
      const { main, [at]: off } = sourceRepo();
      pin(data, off);
      commit(data, "pin another branch");
      const calls = data.ghCalls().length;
      await refuses(data, ["publish.yaml skill-commit-off-default skill_commit"]);
      const api = "api --hostname github.com repositories/1373776339";
      assert.deepStrictEqual(
        data
          .ghCalls()
          .slice(calls)
          .filter((c) => c.includes("repositories/")),
        [api, `${api}/compare/main...${off}`],
      );
      // The default branch's own tip passes, its skill unchanged since.
      pin(data, main);
      const result = await publish(data);
      assert.strictEqual(result.status, 0, result.stdout);
    });
  }

  // Value: protects=publish refuses when it cannot read the pinned tree (GitHub unreachable, an unknown commit, a truncated tree) rather than passing unchecked; fails_when=a gh failure or a truncated tree counts as no drift; why_new=ticket 51; seam=cli; no_claim=none
  it("refuses when gh cannot read the commit or its whole tree", async () => {
    const unknown = await installed();
    pin(unknown, "0123456789abcdef0123456789abcdef01234567");
    await refuses(unknown, ["publish.yaml skill-commit-unread skill_commit"]);

    const offline = await installed();
    delete offline.env.GH_STUB_SOURCE;
    await refuses(offline, ["publish.yaml skill-commit-unread skill_commit"]);

    const truncated = await installed();
    truncated.env.GH_STUB_TRUNCATED = "1";
    await refuses(truncated, ["publish.yaml skill-commit-unread skill_commit"]);
  });

  // Value: protects=a stalled gh refuses within one call's timeout rather than hanging publish past the ballot lock's staleness; fails_when=the gh call has no timeout; why_new=PR #60 review (O3); seam=cli; no_claim=the lock refresh between calls
  it("refuses when gh stalls, without waiting for it", async () => {
    const data = await installed();
    data.env.GH_STUB_SOURCE_SLEEP = "60000";
    const started = Date.now();
    await refuses(data, ["publish.yaml skill-commit-unread skill_commit"]);
    assert.ok(Date.now() - started < 30_000, `${Date.now() - started}ms`);
  });
});
