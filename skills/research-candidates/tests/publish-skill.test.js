"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const { afterEach, describe, it } = require("node:test");
const { BALLOT, SKILL, git, sourceRepo } = require("./harness");
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

  // Value: protects=a staged change and a file git is told to assume unchanged both count as uncommitted, as for the ballot's own areas; fails_when=the check reads only the worktree diff, or skips ls-files -v; why_new=ticket 51; seam=cli; no_claim=none
  it("refuses a staged change, and a file git is told to assume unchanged", async () => {
    const staged = await installed();
    git(staged.root, "rm", "-q", "--cached", `${SKILL}/references/page.md`);
    await refuses(staged, [`${SKILL} skill-uncommitted`]);

    const hidden = await installed();
    git(hidden.root, "update-index", "--assume-unchanged", `${SKILL}/references/page.md`);
    await refuses(hidden, [`${SKILL} skill-uncommitted`]);
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

  // Value: protects=the installed skill is a real directory in the data repo, not a link to a copy elsewhere that can change under it; fails_when=publish follows a symlinked skill directory or .claude/skills; why_new=ticket 51; seam=cli; no_claim=a symlinked .claude, which session settings live under
  for (const linked of [SKILL, ".claude/skills"]) {
    it(`refuses a symlinked ${linked}, even to an exact copy`, async () => {
      const data = await installed();
      fs.renameSync(data.file(linked), data.file("elsewhere"));
      fs.symlinkSync(data.file("elsewhere"), data.file(linked));
      commit(data, "link the skill");
      await refuses(data, [`${linked} skill-symlink`]);
    });
  }
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
          .some((call) => call.startsWith("repositories/")),
        "gh was asked about the source repo",
      );
    });
  }

  // Value: protects=skill_commit must be reachable from the source repo's default branch as the API names it, read by recorded id, so a commit only on another branch or a fork is refused; fails_when=publish compares against a fixed branch, reads the repo by name, or accepts ahead or diverged; why_new=ticket 51; seam=cli; no_claim=that GitHub's compare API reports behind and identical as the stub does
  it("refuses a commit the default branch never reached, by the repo's recorded id", async () => {
    const data = await installed();
    const { side, main } = sourceRepo();
    pin(data, side);
    commit(data, "pin another branch");
    const calls = data.ghCalls().length;
    await refuses(data, ["publish.yaml skill-commit-off-default skill_commit"]);
    assert.deepStrictEqual(
      data
        .ghCalls()
        .slice(calls)
        .filter((c) => c.startsWith("repositories/")),
      ["repositories/1373776339", `repositories/1373776339/compare/main...${side}`],
    );
    // The default branch's own tip passes, its skill unchanged since.
    pin(data, main);
    const result = await publish(data);
    assert.strictEqual(result.status, 0, result.stdout);
  });

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
});
