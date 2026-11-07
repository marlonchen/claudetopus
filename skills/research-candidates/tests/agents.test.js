"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { afterEach, describe, it } = require("node:test");
const { AGENT_TOOLS } = require("../scripts/lib/agent-guard");
const { LAUNCH_WINDOW_MS } = require("../scripts/lib/bindings");
const { load } = require("../scripts/lib/deps");
const { BALLOT } = require("./harness");

// The three agents of SKILL.md Rule 7, as Claude Code runs them: each agent's
// tool list and PreToolUse hook come from its definition in agents/, and the
// data repo's settings hooks check the main session's launch of each agent and
// hand the launch's token to the agent that starts. Hooks run through the
// shell with the tool call on stdin (seam: hook).

const SKILL_DIR = path.join(__dirname, "..");
const AGENTS = ["discovery", "compile", "neutrality"];
const agentName = (agent) => `research-candidates-${agent}`;

// { front: parsed front matter, body } of agents/<name>.md.
const definition = (agent) => {
  const text = fs.readFileSync(path.join(SKILL_DIR, "agents", `${agentName(agent)}.md`), "utf8");
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  assert.ok(m, `${agent}: no front matter`);
  return { front: load("yaml").parse(m[1]), body: m[2] };
};
const settings = JSON.parse(
  fs.readFileSync(path.join(SKILL_DIR, "data-repo-settings.json"), "utf8"),
);

const projects = [];
afterEach(() => {
  while (projects.length) fs.rmSync(projects.pop(), { recursive: true, force: true });
});

const TOKEN = "0123456789abcdef0123456789abcdef";
// Bound to another contest of the same ballot.
const OTHER_TOKEN = "fedcba9876543210fedcba9876543210";
// Another voter's ballot in the same data repo.
const OTHER_BALLOT = "2026-general/yy-otherville-2";
const FETCH = "node .claude/skills/research-candidates/scripts/discovery-fetch";
const agentId = (agent) => `id-${agent}`;

// A data repo holding the skill where the hook commands expect it, us-house-07
// bound to TOKEN and question-1 to OTHER_TOKEN, each agent started with TOKEN,
// and the files the path rules are tried on.
const project = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-agents-"));
  projects.push(root);
  fs.mkdirSync(path.join(root, ".claude", "skills"), { recursive: true });
  fs.symlinkSync(SKILL_DIR, path.join(root, ".claude", "skills", "research-candidates"));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  write("addresses.yaml", "addr-mom: {}\n");
  write(`.bindings/${TOKEN}`, `${BALLOT} us-house-07\n`);
  write(`.bindings/${OTHER_TOKEN}`, `${BALLOT} question-1\n`);
  for (const agent of AGENTS) {
    write(`.bindings/agents/${agentId(agent)}`, `${agentName(agent)} ${TOKEN}\n`);
  }
  write(`${BALLOT}/private.yaml`, "private_strings: []\n");
  for (const ballot of [BALLOT, OTHER_BALLOT]) {
    write(`${ballot}/ballot.yaml`, "contests: []\n");
    write(
      `${ballot}/ballot-view.md`,
      [
        "link: sources/_ballot/sample-ballot.md",
        // A companion line, which the guard never honors in a view with no
        // sha256: lines (viewHeader).
        "read: sources/_ballot/pamphlet.md",
        "Representative in Congress",
        "",
      ].join("\n"),
    );
    write(`${ballot}/sources/_ballot/sample-ballot.md`, "x\n");
    write(`${ballot}/sources/_ballot/pamphlet.md`, "x\n");
    write(`${ballot}/sources/us-house-07/jane-example/bio.md`, "x\n");
    write(`${ballot}/articles/us-house-07.md`, "x\n");
    write(`${ballot}/review/us-house-07.md`, "x\n");
    write(`${ballot}/review/us-house-07.neutrality.md`, "x\n");
  }
  write(`${BALLOT}/sources/question-1/_race/text.md`, "x\n");
  write(`${BALLOT}/articles/question-1.md`, "x\n");
  write(`${BALLOT}/review/question-1.neutrality.md`, "x\n");
  // A planted link out of articles/, to the file no agent may read.
  fs.symlinkSync(
    path.join(root, "addresses.yaml"),
    path.join(root, BALLOT, "articles", "linked.md"),
  );
  // A planted link to a directory, so articles/inner/../secret.md reads as an
  // article but opens a file beside the link's target.
  write("private/inner/x.md", "x\n");
  write("private/secret.md", "x\n");
  fs.symlinkSync(path.join(root, "private", "inner"), path.join(root, BALLOT, "articles", "inner"));
  return root;
};

// Run a hook command as Claude Code does: through the shell, the call on stdin.
const runHook = (command, root, call, env = {}) =>
  spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ cwd: root, ...call }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
    encoding: "utf8",
  });

// Each [call, code] refuses with `code`; each call in `allowed` runs.
const expect = (command, root, refused, allowed) => {
  for (const [call, code] of refused) {
    const result = runHook(command, root, call);
    assert.strictEqual(result.status, 2, `${JSON.stringify(call)} ran`);
    assert.match(result.stderr, new RegExp(` ${code}\\n$`), JSON.stringify(call));
  }
  for (const call of allowed) {
    const result = runHook(command, root, call);
    assert.strictEqual(result.status, 0, `${JSON.stringify(call)}: ${result.stderr}`);
  }
};

// The agent's own hook, run on a call it makes.
const agentHook = (agent) => {
  const [group] = definition(agent).front.hooks.PreToolUse;
  return group.hooks[0].command;
};
const as = (agent) => (tool_name, tool_input) => ({
  tool_name,
  tool_input,
  agent_id: agentId(agent),
  agent_type: agentName(agent),
});

describe("agent definitions", () => {
  // Value: protects=Rule 7: each agent's tools are fixed in its definition, discovery's to web search and Bash (held to its fetch tool), compile's and neutrality's to file tools with no web, fetch or shell; fails_when=a tool is added, or a definition is renamed so Claude Code no longer finds it under the name SKILL.md gives; why_new=new; seam=none; no_claim=Claude Code honoring the list (its docs)
  it("gives each agent only its own tools, and every call to session-guard", () => {
    const tools = {
      discovery: ["Bash", "WebSearch"],
      compile: ["Edit", "Glob", "Grep", "Read", "Write"],
      neutrality: ["Glob", "Grep", "Read", "Write"],
    };
    for (const agent of AGENTS) {
      // session-guard's own list, which refuses any other tool, is the same.
      assert.deepStrictEqual([...AGENT_TOOLS[agentName(agent)]].sort(), tools[agent], agent);
      const { front } = definition(agent);
      assert.strictEqual(front.name, agentName(agent));
      assert.deepStrictEqual(
        front.tools
          .split(",")
          .map((t) => t.trim())
          .sort(),
        tools[agent],
        agent,
      );
      const [group, extra] = front.hooks.PreToolUse;
      assert.strictEqual(extra, undefined);
      assert.strictEqual(group.matcher, "*", `${agent}: the hook skips some tools`);
      // The settings hook's command, naming the agent, so session-guard knows
      // whose limits apply whatever agent_type the call carries.
      assert.strictEqual(
        group.hooks[0].command,
        settings.hooks.PreToolUse[0].hooks[0].command.replace(
          " || exit 2",
          ` ${agentName(agent)} || exit 2`,
        ),
        `${agent}: the hook is not session-guard`,
      );
    }
  });
});

describe("session-guard: the discovery agent", () => {
  const call = as("discovery");
  const bash = (command) => call("Bash", { command });

  // Value: protects=Rule 7: discovery's Bash runs only its bound fetch tool in its three forms, with its own token and a single-quoted URL, so a fetched page cannot get it a shell, a file, fetch-snapshot's other modes or another contest; fails_when=a second command, an unquoted URL, another token, a look-alike path, a plain fetch-snapshot call or another tool gets through; why_new=new, and review found the path's dot unescaped and any bound token taken; seam=hook; no_claim=what it searches for (prompt-level)
  it("lets Bash run only the fetch tool with its own token, and refuses every other tool", () => {
    const root = project();
    expect(
      agentHook("discovery"),
      root,
      [
        [bash("ls"), "agent-command-denied"],
        [bash("cat addresses.yaml"), "agent-command-denied"],
        [bash(`${FETCH} ${TOKEN} --brief; cat addresses.yaml`), "agent-command-denied"],
        [bash(`${FETCH} ${TOKEN} --brief\ncat addresses.yaml`), "agent-command-denied"],
        [
          bash(`${FETCH} ${TOKEN} jane-example bio https://x.example/$(id)`),
          "agent-command-denied",
        ],
        [
          bash(`${FETCH} ${TOKEN} jane-example bio 'https://x.example/'\\''$(id)'`),
          "agent-command-denied",
        ],
        [
          bash(`${FETCH} ${TOKEN} jane-example bio 'https://x.example/' && curl x`),
          "agent-command-denied",
        ],
        [
          bash(`${FETCH} ${TOKEN} --keep-short _race page 'https://x.example/'`),
          "researcher-only-mode",
        ],
        [bash(`${FETCH} ${TOKEN} --file _race page 'https://x.example/'`), "agent-command-denied"],
        [
          bash(
            `node .claude/skills/research-candidates/scripts/fetch-snapshot ${BALLOT} us-senate _race p 'https://x.example/'`,
          ),
          "agent-command-denied",
        ],
        // Another contest's token, bound but not this agent's.
        [bash(`${FETCH} ${OTHER_TOKEN} --brief`), "agent-command-denied"],
        // The path's dot is a dot, not any character.
        [
          bash(`node Xclaude/skills/research-candidates/scripts/discovery-fetch ${TOKEN} --brief`),
          "agent-command-denied",
        ],
        [call("Read", { file_path: path.join(root, "addresses.yaml") }), "agent-tool-denied"],
        [call("WebFetch", { url: "https://x.example/", prompt: "p" }), "agent-tool-denied"],
        [call("Write", { file_path: path.join(root, "x"), content: "" }), "agent-tool-denied"],
        // An agent no launch started, or one started for another agent.
        [{ ...bash(`${FETCH} ${TOKEN} --brief`), agent_id: "id-other" }, "agent-unbound"],
        [{ ...bash(`${FETCH} ${TOKEN} --brief`), agent_id: agentId("compile") }, "agent-unbound"],
        [{ ...bash(`${FETCH} ${TOKEN} --brief`), agent_id: undefined }, "agent-unbound"],
      ],
      [
        bash(`${FETCH} ${TOKEN} --brief`),
        bash(`${FETCH} ${TOKEN} --searched jane-example 4`),
        bash(`${FETCH} ${TOKEN} --searched _race 6`),
        bash(`${FETCH} ${TOKEN} jane-example bio 'https://news.example.com/a/b?c=d&e=f'`),
        // The bare name refused in the main session stays open to a source's URL.
        bash(`${FETCH} ${TOKEN} jane-example bio 'https://x.example/downloads'`),
        call("WebSearch", { query: "Jane Example congressional district 7" }),
      ],
    );
  });
});

describe("session-guard: the compile and neutrality agents", () => {
  const at = (root, rel) => path.join(root, rel);

  // Value: protects=Rule 7: the compile agent reads only its ballot's ballot.yaml and ballot-view.md, its own contest's sources and articles/ (plus the skill's references), never the sample ballot, a companion, another contest's sources, another ballot or a private file, even through a link, and writes only its own contest's article; fails_when=a path outside the allow list, the sample ballot, a link out of it, a Glob or Grep without a path, or a write to another article gets through; why_new=new, and review found the lists covering every ballot and contest, and read: lines honored before any script writes them; seam=hook; no_claim=none
  it("holds the compile agent to its contest's read and write allow lists", () => {
    const root = project();
    const call = as("compile");
    const read = (rel) => call("Read", { file_path: at(root, rel) });
    const writeTo = (rel) => call("Write", { file_path: at(root, rel), content: "" });
    expect(
      agentHook("compile"),
      root,
      [
        [read("addresses.yaml"), "agent-path-denied"],
        [read(`${BALLOT}/private.yaml`), "agent-path-denied"],
        [read("publish.yaml"), "agent-path-denied"],
        [read(`.bindings/${TOKEN}`), "agent-path-denied"],
        [read(`${BALLOT}/sources/_ballot/sample-ballot.md`), "agent-path-denied"],
        [read(`${BALLOT}/sources/_ballot/pamphlet.md`), "agent-path-denied"],
        [read(`${BALLOT}/sources/question-1/_race/text.md`), "agent-path-denied"],
        [read(`${BALLOT}/unfetchable.md`), "agent-path-denied"],
        [read(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [read(`${BALLOT}/articles/linked.md`), "agent-path-denied"],
        [read(OTHER_BALLOT), "agent-path-denied"],
        [read(`${OTHER_BALLOT}/ballot.yaml`), "agent-path-denied"],
        [read(`${OTHER_BALLOT}/ballot-view.md`), "agent-path-denied"],
        [read(`${OTHER_BALLOT}/sources/us-house-07/jane-example/bio.md`), "agent-path-denied"],
        [read(`${OTHER_BALLOT}/articles/us-house-07.md`), "agent-path-denied"],
        [
          call("Read", { file_path: `${root}/${BALLOT}/articles/../private.yaml` }),
          "agent-path-denied",
        ],
        [
          call("Read", { file_path: `${root}/${BALLOT}/articles/inner/../secret.md` }),
          "agent-path-denied",
        ],
        [read(`${BALLOT}/articles/inner/x.md`), "agent-path-denied"],
        [read("/etc/passwd"), "agent-path-denied"],
        [call("Glob", { pattern: "**/*.yaml" }), "agent-path-denied"],
        [
          call("Glob", { pattern: "../../*.yaml", path: at(root, `${BALLOT}/articles`) }),
          "agent-path-denied",
        ],
        [call("Glob", { pattern: `${root}/**` }), "agent-path-denied"],
        [call("Glob", { pattern: "**", path: at(root, BALLOT) }), "agent-path-denied"],
        [
          call("Grep", { pattern: "Elm", path: at(root, `${BALLOT}/sources`) }),
          "agent-path-denied",
        ],
        [call("Grep", { pattern: "Elm" }), "agent-path-denied"],
        [
          call("Glob", { pattern: "{..,x}/*.yaml", path: at(root, `${BALLOT}/articles`) }),
          "agent-path-denied",
        ],
        // A call that does not say it is this agent's is refused, never let through.
        [
          { tool_name: "Read", tool_input: { file_path: at(root, "addresses.yaml") } },
          "agent-type-mismatch",
        ],
        [{ ...read(`${BALLOT}/ballot.yaml`), agent_type: "Explore" }, "agent-type-mismatch"],
        [{ ...read(`${BALLOT}/ballot.yaml`), agent_id: "id-other" }, "agent-unbound"],
        [
          call("Grep", { pattern: "Elm", path: at(root, `${BALLOT}/articles`), glob: "../*.yaml" }),
          "agent-path-denied",
        ],
        [writeTo(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/articles/question-1.md`), "agent-path-denied"],
        [writeTo(`${OTHER_BALLOT}/articles/us-house-07.md`), "agent-path-denied"],
        [
          call("Edit", {
            file_path: at(root, `${BALLOT}/ballot.yaml`),
            old_string: "a",
            new_string: "b",
          }),
          "agent-path-denied",
        ],
        [call("Bash", { command: "ls" }), "agent-tool-denied"],
        [call("WebSearch", { query: "x" }), "agent-tool-denied"],
        [call("WebFetch", { url: "https://x.example/", prompt: "p" }), "agent-tool-denied"],
      ],
      [
        read(`${BALLOT}/ballot.yaml`),
        read(`${BALLOT}/ballot-view.md`),
        read(`${BALLOT}/sources/us-house-07/jane-example/bio.md`),
        read(`${BALLOT}/articles/us-house-07.md`),
        read(`${BALLOT}/articles/question-1.md`),
        read(".claude/skills/research-candidates/references/article-format.md"),
        call("Glob", { pattern: "**/*.md", path: at(root, `${BALLOT}/sources/us-house-07`) }),
        call("Glob", { pattern: "*.md", path: at(root, `${BALLOT}/articles`) }),
        call("Grep", {
          pattern: "school board",
          path: at(root, `${BALLOT}/sources/us-house-07`),
          glob: "*.md",
        }),
        writeTo(`${BALLOT}/articles/us-house-07.md`),
        call("Edit", {
          file_path: at(root, `${BALLOT}/articles/us-house-07.md`),
          old_string: "a",
          new_string: "b",
        }),
      ],
    );
  });

  // Value: protects=Rule 7: the neutrality pass reads only articles/ (and its own contest's flags file, which Write needs read first) and writes only that flags file; fails_when=it reads sources or ballot.yaml, or writes the review list, an article, another contest's flags or another ballot's; why_new=new, and review found the lists covering every ballot and contest; seam=hook; no_claim=what it flags (five-trap eval)
  // Value: protects=Rule 7: the compile agent opens a companion only from a read: line of a regular-file ballot-view.md whose sha256 lines still agree with ballot.yaml, the sample ballot and the companion itself, never the link target, a role: sample_ballot snapshot or a retired companion; fails_when=a read: line naming the sample ballot, a linked or stale view, a superseded sample ballot or a retired companion gets through, or an honest companion is refused; why_new=ticket 19 builds the read: lines this list takes; seam=hook; no_claim=ballot-check writing the view (ballot-check.test.js)
  it("opens the companions on the read: lines of a view that still agrees", () => {
    const root = project();
    const call = as("compile");
    const read = (name) =>
      call("Read", { file_path: path.join(root, BALLOT, "sources", "_ballot", `${name}.md`) });
    const write = (rel, text) => fs.writeFileSync(path.join(root, BALLOT, rel), text);
    const hash = (rel) =>
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(path.join(root, BALLOT, rel)))
        .digest("hex");
    const snapshot = (role) => `---\nsource: County\nrole: ${role}\n---\nText\n`;
    write(
      "ballot.yaml",
      "contests: []\nretired_companions:\n  - sources/_ballot/old-pamphlet.md\n",
    );
    write("sources/_ballot/sample-ballot.md", snapshot("sample_ballot"));
    write("sources/_ballot/sample-ballot-0.md", snapshot("sample_ballot"));
    for (const name of ["pamphlet", "write-ins", "old-pamphlet", "unlisted"])
      write(
        `sources/_ballot/${name}.md`,
        snapshot(name === "write-ins" ? "write_in_list" : "pamphlet"),
      );
    const listed = [
      "sample-ballot",
      "sample-ballot-0",
      "pamphlet",
      "write-ins",
      "old-pamphlet",
    ].map((name) => `sources/_ballot/${name}.md`);
    const view = (spans = []) =>
      [
        "link: sources/_ballot/sample-ballot.md",
        ...listed.map((rel) => `read: ${rel}`),
        `sha256: ${hash("ballot.yaml")}  ballot.yaml`,
        ...["sources/_ballot/sample-ballot.md", ...listed].map(
          (rel) => `sha256: ${hash(rel)}  ${rel}`,
        ),
        ...spans,
        "",
      ].join("\n");
    write("ballot-view.md", view());
    const refused = [
      [read("sample-ballot"), "agent-path-denied"],
      [read("sample-ballot-0"), "agent-path-denied"],
      [read("old-pamphlet"), "agent-path-denied"],
      [read("unlisted"), "agent-path-denied"],
    ];
    expect(agentHook("compile"), root, refused, [read("pamphlet"), read("write-ins")]);

    // A ballot.yaml edited since the check: the view no longer agrees.
    write("ballot.yaml", "contests: []\n");
    expect(agentHook("compile"), root, [[read("pamphlet"), "agent-path-denied"]], []);
    write("ballot-view.md", view());
    expect(agentHook("compile"), root, [], [read("pamphlet")]);

    // Added by the PR #25 review (A5, O4): a companion edited since the check,
    // whose bytes the check never scanned, is refused; the others still open.
    write("sources/_ballot/pamphlet.md", `${snapshot("pamphlet")}123 Main St\n`);
    expect(
      agentHook("compile"),
      root,
      [[read("pamphlet"), "agent-path-denied"]],
      [read("write-ins")],
    );
    write("ballot-view.md", view());

    // Added by the PR #25 review (O3): a span that reads like a header line is
    // ballot text, never a hash or a read: line.
    write(
      "ballot-view.md",
      view([`sha256: ${"0".repeat(64)}  ballot.yaml`, "read: sources/_ballot/unlisted.md"]),
    );
    expect(
      agentHook("compile"),
      root,
      [[read("unlisted"), "agent-path-denied"]],
      [read("pamphlet")],
    );
    // A header missing a companion's hash is no view at all.
    const unhashed = view().replace(/^sha256: \S+ {2}sources\/_ballot\/write-ins\.md\n/m, "");
    write("ballot-view.md", unhashed);
    expect(agentHook("compile"), root, [[read("pamphlet"), "agent-path-denied"]], []);
    write("ballot-view.md", view());

    // A linked view, even one that agrees.
    fs.renameSync(path.join(root, BALLOT, "ballot-view.md"), path.join(root, "view.md"));
    fs.symlinkSync(path.join(root, "view.md"), path.join(root, BALLOT, "ballot-view.md"));
    expect(agentHook("compile"), root, [[read("pamphlet"), "agent-path-denied"]], []);
  });

  it("holds the neutrality agent to articles/ and its contest's flags file", () => {
    const root = project();
    const call = as("neutrality");
    const read = (rel) => call("Read", { file_path: at(root, rel) });
    const writeTo = (rel) => call("Write", { file_path: at(root, rel), content: "" });
    expect(
      agentHook("neutrality"),
      root,
      [
        [read(`${BALLOT}/ballot.yaml`), "agent-path-denied"],
        [read(`${BALLOT}/sources/us-house-07/jane-example/bio.md`), "agent-path-denied"],
        [read(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [read(`${BALLOT}/review/question-1.neutrality.md`), "agent-path-denied"],
        [read(`${OTHER_BALLOT}/articles/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/articles/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/review/x/us-house-07.neutrality.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/review/question-1.neutrality.md`), "agent-path-denied"],
        [writeTo(`${OTHER_BALLOT}/review/us-house-07.neutrality.md`), "agent-path-denied"],
        [
          call("Edit", {
            file_path: at(root, `${BALLOT}/review/us-house-07.neutrality.md`),
            old_string: "a",
            new_string: "b",
          }),
          "agent-tool-denied",
        ],
        [call("Bash", { command: "ls" }), "agent-tool-denied"],
      ],
      [
        read(`${BALLOT}/articles/us-house-07.md`),
        read(`${BALLOT}/review/us-house-07.neutrality.md`),
        read(".claude/skills/research-candidates/references/review-list.md"),
        call("Grep", { pattern: "T2i", path: at(root, `${BALLOT}/articles`) }),
        writeTo(`${BALLOT}/review/us-house-07.neutrality.md`),
      ],
    );
  });

  // Value: protects=Rule 7: a link to a file that does not exist yet cannot land a write outside the allow list (.git/hooks, .claude/agents), as a link to one that does cannot (the planted links above); fails_when=a link to nothing passes as the contest's article or flags file; why_new=review created .git/hooks/pre-commit through a dangling link; seam=hook; no_claim=hard links (undetectable)
  it("refuses a write through a link to nothing", () => {
    const root = project();
    const article = at(root, `${BALLOT}/articles/us-house-07.md`);
    const flags = at(root, `${BALLOT}/review/us-house-07.neutrality.md`);
    const cases = [
      ["compile", article, path.join(root, ".git", "hooks", "pre-commit")],
      ["neutrality", flags, path.join(root, ".claude", "agents", "x.md")],
    ];
    for (const [agent, file, target] of cases) {
      fs.rmSync(file);
      fs.symlinkSync(target, file);
      expect(
        agentHook(agent),
        root,
        [
          [as(agent)("Write", { file_path: file, content: "" }), "agent-path-denied"],
          ...(agent === "compile"
            ? [
                [
                  as(agent)("Edit", { file_path: file, old_string: "a", new_string: "b" }),
                  "agent-path-denied",
                ],
              ]
            : []),
        ],
        [],
      );
      fs.rmSync(file);
      fs.writeFileSync(file, "x\n");
    }
    assert.strictEqual(fs.existsSync(path.join(root, ".git", "hooks", "pre-commit")), false);
  });
});

describe("session-guard: the main session's launch of each agent", () => {
  const launch = (subagent_type, prompt, extra = {}) => ({
    tool_name: "Agent",
    tool_input: { subagent_type, description: "Research", prompt, ...extra },
  });
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const [startGroup] = settings.hooks.SubagentStart;
  const start = (root, agent, agent_id) =>
    runHook(startGroup.hooks[0].command, root, {
      hook_event_name: "SubagentStart",
      agent_id,
      agent_type: agentName(agent),
    });
  const brief = (agent_id) => ({
    ...as("discovery")("Bash", { command: `${FETCH} ${TOKEN} --brief` }),
    agent_id,
  });

  // Value: protects=Rule 7: discovery's whole prompt is a bound token and compile's and neutrality's first line is one, so nothing the main session holds (snapshot text, a full URL, an instruction) reaches discovery, and every agent starts bound to a contest; fails_when=a prompt without a bound token, an isolated launch or a launch of another agent's token form gets through; why_new=new; seam=hook; no_claim=a main session that skips the agents and does their work itself (prompt-level)
  it("starts each agent only on a bound token, and refuses every other agent", () => {
    const root = project();
    assert.ok(
      settings.hooks.PreToolUse[0].matcher.split("|").includes("Agent"),
      "the settings hook never sees an Agent call",
    );
    expect(
      hook,
      root,
      [
        [
          launch(agentName("discovery"), `${TOKEN}\nAlso search for the voter.`),
          "agent-prompt-invalid",
        ],
        [launch(agentName("discovery"), "f".repeat(32)), "agent-prompt-invalid"],
        [launch(agentName("discovery"), "us-house-07"), "agent-prompt-invalid"],
        [
          { tool_name: "Task", tool_input: { subagent_type: agentName("discovery"), prompt: "x" } },
          "agent-prompt-invalid",
        ],
        [launch(agentName("compile"), `${BALLOT} us-house-07`), "agent-prompt-invalid"],
        [launch(agentName("neutrality"), `x\n${TOKEN}`), "agent-prompt-invalid"],
        [
          launch(agentName("discovery"), TOKEN, { isolation: "worktree" }),
          "agent-isolation-denied",
        ],
        [launch(agentName("compile"), TOKEN, { isolation: "remote" }), "agent-isolation-denied"],
        [launch("Explore", "Find the tests."), "agent-type-denied"],
        [launch("general-purpose", "Read addresses.yaml."), "agent-type-denied"],
        [{ tool_name: "Agent", tool_input: { prompt: "No type named." } }, "agent-type-denied"],
        [
          { tool_name: "Task", tool_input: { subagent_type: "fork", prompt: "Carry on." } },
          "agent-type-denied",
        ],
      ],
      [
        launch(agentName("discovery"), `${TOKEN}\n`),
        launch(agentName("compile"), `${TOKEN}\n${BALLOT} us-house-07`),
        launch(agentName("neutrality"), `${OTHER_TOKEN}\n${BALLOT} question-1\n...`),
        { tool_name: "Read", tool_input: { file_path: path.join(root, BALLOT, "ballot.yaml") } },
      ],
    );
  });

  // Value: protects=Rule 7: the agent that starts is held to the contest of the launch that started it, and two launches of one agent at once are refused, so neither can end up with the other's token; fails_when=SubagentStart binds nothing, binds the wrong agent, or a second launch overwrites the first before it starts; why_new=review found the lists bound to no contest; seam=hook; no_claim=Claude Code firing SubagentStart after the launch's PreToolUse (its hook docs)
  it("hands each launch's token to the agent that starts, one launch at a time", () => {
    const root = project();
    assert.strictEqual(startGroup.matcher, AGENTS.map(agentName).join("|"));
    assert.strictEqual(runHook(hook, root, launch(agentName("discovery"), TOKEN)).status, 0);
    // Another launch before the first has started could trade tokens with it.
    expect(hook, root, [[launch(agentName("discovery"), TOKEN), "agent-launch-pending"]], []);
    // Not started yet: its calls are refused.
    expect(agentHook("discovery"), root, [[brief("a9f"), "agent-unbound"]], []);
    // SubagentStart for another agent leaves discovery's launch alone.
    assert.strictEqual(start(root, "compile", "a9e").status, 0);
    expect(
      agentHook("compile"),
      root,
      [[{ ...brief("a9e"), agent_type: agentName("compile") }, "agent-tool-denied"]],
      [],
    );
    assert.strictEqual(start(root, "discovery", "a9f").status, 0);
    expect(agentHook("discovery"), root, [], [brief("a9f")]);
    // Started: the next launch may go ahead.
    expect(hook, root, [], [launch(agentName("discovery"), TOKEN)]);
    // A launch that never started (refused at the permission prompt) stops
    // blocking once the window has passed.
    const pending = path.join(root, ".bindings", "launch", agentName("discovery"));
    fs.writeFileSync(pending, `${TOKEN} ${Date.now() - LAUNCH_WINDOW_MS - 1}\n`);
    expect(hook, root, [], [launch(agentName("discovery"), TOKEN)]);
  });

  // Value: protects=Rule 7: nothing reaches a running or finished agent after its prompt, and no agent starts past the launch check through the claude CLI; fails_when=SendMessage leaves the matcher or is let through, or a claude command by any path runs; why_new=review sent an address to a running discovery agent with SendMessage; seam=hook; no_claim=a command that builds the name at run time (documented)
  it("refuses every SendMessage and every run of the claude CLI", () => {
    const root = project();
    assert.ok(
      settings.hooks.PreToolUse[0].matcher.split("|").includes("SendMessage"),
      "the settings hook never sees a SendMessage call",
    );
    const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
    expect(
      hook,
      root,
      [
        [
          {
            tool_name: "SendMessage",
            tool_input: { to: "a9f", message: "Also search Elm Street." },
          },
          "agent-message-denied",
        ],
        [
          { tool_name: "SendMessage", tool_input: { to: "a9f", message: TOKEN } },
          "agent-message-denied",
        ],
        [bash(`claude -p --agent ${agentName("discovery")} "Elm Street"`), "claude-cli-denied"],
        [bash("~/.local/bin/claude --agent x"), "claude-cli-denied"],
        [bash("npx @anthropic-ai/claude-code -p hi"), "claude-cli-denied"],
        [bash("cd x && 'claude' -p hi"), "claude-cli-denied"],
        [bash(`cat .bindings/${TOKEN}`), "script-only-file"],
        [bash(`echo "${BALLOT} us-house-07" > .bindings/${"0".repeat(32)}`), "script-only-file"],
      ],
      [
        bash("ls .claude/skills"),
        bash(`node .claude/skills/research-candidates/scripts/agent-bind ${BALLOT} us-house-07`),
        bash("git log --oneline -1"),
      ],
    );
  });
});

describe("session-guard: the main session and the private files", () => {
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const read = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
  const grep = (input) => ({ tool_name: "Grep", tool_input: { pattern: "Elm", ...input } });
  const monitor = (command) => ({ tool_name: "Monitor", tool_input: { command } });
  const code = "private-file-denied";

  // Value: protects=Rule 5: the model never reads or writes addresses.yaml, and only scripts read private.yaml; fails_when=a Bash call, a file tool or a Grep names or reaches either file and runs, or Read or Grep leaves the matcher; why_new=only the Rule 7 agents' allow lists covered these files, and the main session could read and write both; seam=hook; no_claim=a shell glob, which names neither file (README.md, Data-repo settings)
  it("refuses a read or write of either file, and leaves other files alone", () => {
    const root = project();
    const matcher = settings.hooks.PreToolUse[0].matcher.split("|");
    assert.ok(matcher.includes("Read"), "the settings hook never sees a Read");
    assert.ok(matcher.includes("Grep"), "the settings hook never sees a Grep");
    assert.ok(matcher.includes("Monitor"), "the settings hook never sees a Monitor command");
    const deny = settings.permissions.deny;
    for (const rule of [
      "Read(/addresses.yaml)",
      "Read(/**/private.yaml)",
      "Edit(/addresses.yaml)",
      "Edit(/**/private.yaml)",
    ]) {
      assert.ok(deny.includes(rule), `${rule} is not denied`);
    }
    expect(
      hook,
      root,
      [
        [bash("cat addresses.yaml"), code],
        [bash(`cat ${BALLOT}/private.yaml`), code],
        [bash("echo x >> addresses.yaml"), code],
        [bash("cat addr''esses.yaml"), code],
        // A case-insensitive filesystem opens the file under this name too.
        [bash("cat ./ADDRESSES.YAML"), code],
        [read(path.join(root, "addresses.yaml")), code],
        [read(path.join(root, BALLOT, "private.yaml")), code],
        [{ tool_name: "Write", tool_input: { file_path: "addresses.yaml", content: "x" } }, code],
        [
          {
            tool_name: "Edit",
            tool_input: { file_path: `${BALLOT}/private.yaml`, old_string: "a", new_string: "b" },
          },
          code,
        ],
        [
          {
            tool_name: "MultiEdit",
            tool_input: { file_path: "addresses.yaml", edits: [{ old_string: "a" }] },
          },
          code,
        ],
        // A script the model could run later.
        [
          {
            tool_name: "Write",
            tool_input: { file_path: "/r/x.sh", content: "cat addresses.yaml\n" },
          },
          code,
        ],
        // A search from the root, an election or a ballot reaches the files
        // without naming them.
        [grep({}), code],
        [grep({ path: "." }), code],
        [grep({ path: root }), code],
        [grep({ path: path.dirname(root) }), code],
        [grep({ path: BALLOT.split("/")[0] }), code],
        [grep({ path: BALLOT }), code],
        [grep({ path: `${BALLOT}/private.yaml` }), code],
      ],
      [
        read(path.join(root, BALLOT, "ballot.yaml")),
        grep({ path: `${BALLOT}/articles` }),
        grep({ path: `${BALLOT}/ballot.yaml` }),
        bash("git status"),
        bash("node .claude/skills/research-candidates/scripts/ballot-check x"),
        { tool_name: "Write", tool_input: { file_path: "notes.md", content: "x" } },
      ],
    );
  });

  // Value: protects=Rule 5 past the Bash tool's own name: a Monitor command is a shell command, and every Bash refusal holds for it; fails_when=Monitor leaves the matcher or session-guard lets it through because of its tool_name; why_new=Claude Code before 2.1.314 does not run a Bash matcher on Monitor commands, so cat addresses.yaml ran unchecked; seam=hook; no_claim=a WebSocket watch's frames, which no file read produces
  it("holds a Monitor command to every Bash refusal", () => {
    const root = project();
    expect(
      hook,
      root,
      [
        [monitor("cat addresses.yaml"), code],
        [monitor(`tail -f ${BALLOT}/private.yaml`), code],
        [monitor("rg Elm"), code],
        [monitor("ballot-check --show x"), "researcher-only-mode"],
        [monitor("cat .bindings/x"), "script-only-file"],
        [{ tool_name: "Monitor", tool_input: { ws: { url: "wss://x" } } }, "hook-input-invalid"],
      ],
      [monitor("tail -f build.log")],
    );
  });

  // Value: protects=Rule 5 in a default session: Claude Code has no Grep tool on macOS, Linux or WSL, so the search a session really runs goes through Bash; fails_when=a recursive search from the root, an election or a ballot runs, or a search that stays below a ballot directory is refused; why_new=grep -rn Elm . read both files with the Grep check never called; seam=hook; no_claim=a shell glob, a search tool not listed, or a directory given only in a variable
  it("refuses a recursive shell search that reaches either file, and leaves deeper ones alone", () => {
    const root = project();
    const election = BALLOT.split("/")[0];
    expect(
      hook,
      root,
      [
        [bash("grep -rn Elm ."), code],
        [bash("grep -R Elm"), code],
        [bash("grep --recursive Elm ."), code],
        [bash("egrep -nr Elm ."), code],
        [bash("rg Elm"), code],
        [bash("rg -e Elm"), code],
        [bash("ugrep Elm ."), code],
        [bash("ag Elm"), code],
        // A flag's value is no path, so this searches where it runs.
        [bash("rg -t yaml Elm"), code],
        [bash("rg -g '*.yaml' Elm"), code],
        [bash(`rg Elm ${election}`), code],
        [bash(`grep -r Elm ${BALLOT}`), code],
        [bash(`grep -r Elm ${root}`), code],
        [bash(`rg Elm ${path.dirname(root)}`), code],
        [bash("sudo rg Elm"), code],
        [bash("cat x; rg Elm"), code],
        [bash("find . -name '*.yaml' -exec cat {} +"), code],
        [bash("find . -type f -exec grep Elm {} ;"), code],
        [bash("find . ( -name a -o -name b ) -exec cat {} +"), code],
        [bash("find . -name '*.yaml' | xargs cat"), code],
        [bash(`find ${BALLOT} -name '*.yaml' -okdir cat {} ;`), code],
        // Only the search's own path counts, wherever it is spelled.
        [bash(`rg -e Elm ${BALLOT} ${BALLOT}/articles`), code],
      ],
      [
        bash(`grep -rn Elm ${BALLOT}/articles`),
        bash(`rg Elm ${BALLOT}/sources/us-house-07`),
        bash(`rg -e Elm ${BALLOT}/articles`),
        bash(`rg Elm ${BALLOT}/ballot.yaml`),
        bash(`find ${BALLOT}/articles -name '*.md' -exec wc -l {} +`),
        bash(`grep Elm ${BALLOT}/ballot.yaml`),
        bash("cat x | grep Elm"),
        bash("find . -name '*.md'"),
        bash("rg --files"),
        bash("git log --oneline | grep Elm"),
      ],
    );
    // A shell's own cwd counts as the Grep tool's does.
    assert.strictEqual(
      runHook(hook, root, { ...bash("rg Elm"), cwd: path.join(root, BALLOT, "articles") }).status,
      0,
    );
    assert.strictEqual(
      runHook(hook, root, { ...bash("rg Elm"), cwd: path.join(root, BALLOT) }).status,
      2,
    );
  });

  // Value: protects=Rule 5 in the searches a session really types: a search is let through only when a start is placed, so a form the check cannot read costs a retry, not a leak; fails_when=a search with no start it can place runs, or a listed tool that is not the command's first word goes unseen; why_new=review of #52 printed both files with rg Elm 2>/dev/null and a for loop of grep -rn, since an operand with a slash switched the check off and only first words counted; seam=hook; no_claim=a shell glob given to a plain cat or grep, or a value flag not listed
  it("refuses a search unless a start is placed, wherever the search sits", () => {
    const root = project();
    const election = BALLOT.split("/")[0];
    fs.writeFileSync(path.join(root, "pats.txt"), "Elm\n");
    expect(
      hook,
      root,
      [
        // A redirect or a flag's value is no start.
        [bash("rg Elm 2>/dev/null"), code],
        [bash("grep -rn Elm 2>/dev/null"), code],
        [bash("rg Elm 2>&1"), code],
        [bash("rg Elm > out.txt"), code],
        [bash("rg Elm -g '**/*.yaml'"), code],
        [bash("rg -g 'a/*' -g 'b/*' Elm"), code],
        [bash("rg -e a/b -e Elm"), code],
        [bash("rg -f pats.txt"), code],
        [bash(`rg -e ${BALLOT}/articles`), code],
        // A start the shell expands, or one that is not there, is not placed.
        [bash("grep -r Elm */"), code],
        [bash("rg Elm ./*"), code],
        [bash(`rg Elm $PWD/${election}`), code],
        [bash(`rg Elm $(pwd)/${election}`), code],
        [bash(`rg Elm ${BALLOT}/articles \`pwd\``), code],
        [bash(`rg Elm ~someone/${election}`), code],
        [bash(`rg Elm {${election},x}`), code],
        [bash("rg Elm no/such/dir"), code],
        [bash("grep -rn Elm no/such/dir"), code],
        // A listed tool, wherever it sits.
        [bash('for x in Elm Oak; do grep -rn "$x" .; done'), code],
        [bash("if grep -rq Elm .; then echo y; fi"), code],
        [bash("{ rg Elm; }"), code],
        [bash("! grep -r Elm ."), code],
        [bash("timeout 5 rg Elm"), code],
        [bash("nice -n 5 rg Elm"), code],
        [bash("/opt/homebrew/bin/rg Elm"), code],
        [bash("bash -c 'rg Elm .'"), code],
        [bash('sh -c "cd x; rg Elm"'), code],
        [bash('echo "$(rg Elm)"'), code],
        [bash("cat <(rg Elm)"), code],
        [bash("echo `rg Elm`"), code],
        [bash("$'rg' Elm"), code],
        // Each spelling of a recursive grep.
        [bash("grep -rnA3 Elm ."), code],
        [bash("grep -rC2 Elm ."), code],
        [bash("grep -2r Elm ."), code],
        [bash("grep -d recurse Elm ."), code],
        [bash("grep --directories recurse Elm ."), code],
        [bash("grep --directories=recurse Elm ."), code],
        [bash("grep --dir=recurse Elm ."), code],
        [bash("grep --rec Elm ."), code],
        [bash("grep --dereference-rec Elm ."), code],
        // grep -r reads the tree even when a pipe feeds it.
        [bash("cat x | grep -r Elm"), code],
        [bash("cat x | ugrep -r Elm"), code],
        // find's own flags come before its starts.
        [bash("find -L . -exec cat {} +"), code],
        [bash(`find -H ${BALLOT} -name '*.yaml' -exec cat {} +`), code],
        // A file list hands a tool paths the hook never sees.
        [bash("git ls-files | xargs grep -n Elm"), code],
        [bash("rg --files | xargs grep Elm"), code],
        [bash(`ls ${BALLOT} | xargs cat`), code],
      ],
      [
        bash(`rg 'Elm|Oak' ${BALLOT}/articles`),
        bash(`grep -rnE 'Elm|Oak' ${BALLOT}/articles`),
        bash(`rg 'Elm; Oak' ${BALLOT}/articles`),
        bash(`rg "Elm & Oak" ${BALLOT}/articles`),
        bash(`rg Elm ${BALLOT}/articles 2>/dev/null`),
        bash(`rg -g '*.md' Elm ${BALLOT}/articles`),
        bash(`rg -t md Elm ${BALLOT}/articles`),
        bash(`grep -rn -A3 Elm ${BALLOT}/articles`),
        bash(`grep -rn --include='*.md' Elm ${BALLOT}/articles`),
        bash(`rg -f pats.txt ${BALLOT}/articles`),
        bash(`timeout 5 rg Elm ${BALLOT}/articles`),
        bash(`find ${BALLOT}/articles -type f -exec rg Elm {} +`),
        // A tree search a pipe feeds reads the pipe, not the tree.
        bash("git log --oneline | rg Elm"),
        bash(`ls ${election} | rg xx`),
        bash("git log | rg -i Elm 2>/dev/null | head -5"),
      ],
    );
  });

  // Value: protects=Rule 5 once ADR 0003 sends a session deeper: a command's own cd moves a search off the cwd the hook reads, and cwd then stays deep so cd .. climbs back; fails_when=a search in a command that changes directory runs, or a plain cd stops working; why_new=cd .. && rg Elm from <ballot>/articles printed private.yaml, while rg Elm .. was refused; seam=hook; no_claim=a directory changed by a script the command runs
  it("refuses a search in a command that changes directory", () => {
    const root = project();
    const election = BALLOT.split("/")[0];
    const articles = path.join(root, BALLOT, "articles");
    const from = (command, cwd) => runHook(hook, root, { ...bash(command), cwd });
    assert.strictEqual(from("cd .. && rg Elm", articles).status, 2);
    assert.strictEqual(from("pushd .. && rg Elm .", articles).status, 2);
    assert.strictEqual(from("(cd ..; rg Elm)", articles).status, 2);
    assert.strictEqual(from("find -L .. -exec cat {} +", articles).status, 2);
    assert.strictEqual(from(`cd ${election} && rg Elm ./xx-exampleton-1`, root).status, 2);
    // A retry in two calls is placed, since the hook's cwd follows the cd.
    assert.strictEqual(from(`cd ${BALLOT}/articles`, root).status, 0);
    assert.strictEqual(from("rg Elm", articles).status, 0);
    assert.strictEqual(from("cd .. && ls", articles).status, 0);
  });

  // Value: protects=the setup Rule 5 stands on: a session told to fix a ballot-check failure must not replace the researcher's merged settings or the attributes; fails_when=a command naming the settings or attributes runs, a file tool can edit them, or the skill's own copies stop being readable; why_new=step 3 said fix every failure and cp over .claude/settings.json was allowed; seam=hook; no_claim=a name built at run time
  it("keeps the data repo's settings and attributes from the model", () => {
    const root = project();
    const skill = ".claude/skills/research-candidates";
    const denied = "script-only-file";
    for (const rule of [
      "Edit(/.claude/settings.json)",
      "Edit(/.claude/settings.local.json)",
      "Edit(/.gitattributes)",
    ]) {
      assert.ok(settings.permissions.deny.includes(rule), `${rule} is not denied`);
    }
    expect(
      hook,
      root,
      [
        [bash(`cp ${skill}/data-repo-settings.json .claude/settings.json`), denied],
        [bash(`cp ${skill}/data-repo-gitattributes .gitattributes`), denied],
        [bash("rm .gitattributes"), denied],
        [bash("sed -i '' s/Grep// .claude/settings.json"), denied],
        [bash("echo x >> .claude/settings.local.json"), denied],
      ],
      [bash(`cat ${skill}/data-repo-settings.json`), bash(`cat ${skill}/data-repo-gitattributes`)],
    );
  });

  // Value: protects=the header's "anything it cannot read is refused" for a search's start; fails_when=a ~ path, a differently cased root, a link to the root or a path that does not exist reads as somewhere safe, or a directory beside the root or a hidden one is refused; why_new=the check resolved ~ under cwd, kept a path's case and allowed what it could not stat; seam=hook; no_claim=a directory given only in a variable
  it("places a search's start however it is spelled, and refuses one it cannot", () => {
    const root = project();
    const beside = fs.mkdtempSync(path.join(os.tmpdir(), "rc-beside-"));
    projects.push(beside);
    fs.symlinkSync(root, path.join(beside, "link"));
    const home = { HOME: path.dirname(root) };
    assert.strictEqual(runHook(hook, root, grep({ path: "~" }), home).status, 2);
    assert.strictEqual(runHook(hook, root, bash("rg Elm ~"), home).status, 2);
    assert.strictEqual(
      runHook(hook, root, grep({ path: `~/${path.basename(root)}` }), home).status,
      2,
    );
    assert.strictEqual(
      runHook(hook, root, grep({ path: `~/${path.basename(beside)}` }), home).status,
      0,
    );
    const refused = [
      [grep({ path: "no-such-dir" }), code],
      [grep({ path: "~/no-such-dir" }), code],
      [grep({ path: "~someone-else/x" }), code],
      [grep({ path: path.join(beside, "link") }), code],
    ];
    // On a case-insensitive filesystem the root opens under this name too.
    const upper = root.toUpperCase();
    if (fs.existsSync(upper)) refused.push([grep({ path: upper }), code]);
    expect(hook, root, refused, [
      grep({ path: beside }),
      bash(`rg Elm ${beside}`),
      grep({ path: ".claude" }),
      grep({ path: ".claude/skills" }),
      grep({ path: ".bindings" }),
    ]);
  });

  // Value: protects=the model's ordinary work around these files; fails_when=text that reads nothing (a Bash description, a Grep pattern) is refused, or a body the model writes stops being read; why_new=every string in tool_input was matched, so a description naming a file refused a plain git status with a code that explained nothing; seam=hook; no_claim=an Edit that names a file in its text, which stays refused so a script cannot be planted
  it("reads only the input that can name a file", () => {
    const root = project();
    const described = (description) => ({
      tool_name: "Bash",
      tool_input: { command: "git status", description },
    });
    expect(
      hook,
      root,
      [
        [
          {
            tool_name: "Grep",
            tool_input: { pattern: "x", path: `${BALLOT}/articles`, glob: "private.yaml" },
          },
          code,
        ],
        [
          {
            tool_name: "Edit",
            tool_input: { file_path: "a", old_string: "a", new_string: "cat addresses.yaml" },
          },
          code,
        ],
      ],
      [
        described("Check no private.yaml edits are staged"),
        grep({ pattern: "private\\.yaml", path: ".claude/skills/research-candidates/references" }),
      ],
    );
  });

  // Value: protects=Rule 7: only the three agents run in the data repo, however a subagent started, and each stays held by its own hook; fails_when=a subagent no launch saw (a skill's fork, a workflow) makes a hooked call, or the settings hook refuses a Rule 7 agent's legitimate text; why_new=launchRefusal sees only Agent and Task, and the settings hook matched file names in agents' article text and URLs; seam=hook; no_claim=a subagent that calls only tools outside the matcher (README.md, Data-repo settings)
  it("refuses every subagent but the Rule 7 agents, and leaves those to their own hooks", () => {
    const root = project();
    const fork = (call) => ({ ...call, agent_id: "id-fork", agent_type: "general-purpose" });
    const denied = "agent-type-denied";
    expect(
      hook,
      root,
      [
        [fork(read(path.join(root, BALLOT, "ballot.yaml"))), denied],
        [fork(read(path.join(root, BALLOT, "sources/_ballot/sample-ballot.md"))), denied],
        [fork(grep({ path: `${BALLOT}/articles` })), denied],
        [fork(bash("git status")), denied],
        [{ ...bash("git status"), agent_id: "id-fork" }, denied],
      ],
      [
        as("compile")("Write", {
          file_path: `${BALLOT}/articles/us-house-07.md`,
          content: "The county posted private.yaml.\n",
        }),
        as("discovery")("Bash", {
          command: `${FETCH} ${TOKEN} jane-example a 'https://x.gov/private.yaml'`,
        }),
      ],
    );
    // The agent's own hook still holds it to its allow list.
    expect(
      agentHook("compile"),
      root,
      [
        [
          as("compile")("Read", { file_path: path.join(root, BALLOT, "private.yaml") }),
          "agent-path-denied",
        ],
      ],
      [],
    );
  });
});

describe("session-guard: the main session and the ballot files", () => {
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  const read = (file_path) => ({ tool_name: "Read", tool_input: { file_path } });
  const grep = (input) => ({ tool_name: "Grep", tool_input: { pattern: "Elm", ...input } });

  // Value: protects=Rule 5 and Rule 7: the sample ballot and downloads can name or locate the voter, and unfetchable.md holds attacker-chosen URLs, so the main session reads none of them while the compile agent still reads its companions; fails_when=a main-session call names or reaches one and runs, or the settings hook refuses a Rule 7 agent's own read; why_new=the hook covered only addresses.yaml and private.yaml; seam=hook; no_claim=a glob, which names none of them (README.md, Data-repo settings)
  it("refuses the main session, and leaves the compile agent's reads alone", () => {
    const root = project();
    const deny = settings.permissions.deny;
    for (const rule of ["Read(/downloads/**)", "Read(/**/unfetchable.md)"]) {
      assert.ok(deny.includes(rule), `${rule} is not denied`);
    }
    assert.ok(
      !deny.some((rule) => rule.startsWith("Read(") && rule.includes("_ballot")),
      "a Read deny on _ballot also stops the compile agent",
    );
    const code = "session-file-denied";
    const ballotDir = path.join(root, BALLOT);
    expect(
      hook,
      root,
      [
        [read(path.join(ballotDir, "sources", "_ballot", "sample-ballot.md")), code],
        [read(path.join(ballotDir, "sources", "_ballot", "pamphlet.md")), code],
        [read(path.join(ballotDir, "unfetchable.md")), code],
        [read(path.join(root, "downloads", "ballot.pdf")), code],
        [bash(`cat ${BALLOT}/sources/_ballot/sample-ballot.md`), code],
        [bash(`cd ${BALLOT}/sources && cat _ballot/sample-ballot.md`), code],
        [bash(`cat ${BALLOT}/unfetch''able.md`), code],
        // A case-insensitive filesystem opens the file under this name too.
        [bash(`cat ${BALLOT}/UNFETCHABLE.MD`), code],
        // A script the model could run later.
        [
          {
            tool_name: "Write",
            tool_input: { file_path: "/r/x.sh", content: "cat sources/_ballot/*\n" },
          },
          code,
        ],
        // A search from sources/ reaches _ballot/ without naming it.
        [grep({ path: `${BALLOT}/sources` }), code],
        [grep({ path: `${BALLOT}/sources/_ballot` }), code],
        [bash(`rg Elm ${BALLOT}/sources`), code],
        [bash(`grep -rn Elm ${BALLOT}/sources`), code],
      ],
      [
        read(path.join(ballotDir, "ballot-view.md")),
        read(path.join(ballotDir, "sources", "us-house-07", "jane-example", "bio.md")),
        grep({ path: `${BALLOT}/sources/us-house-07` }),
        bash(`rg Elm ${BALLOT}/sources/us-house-07`),
        // A pattern or a description reads no file.
        grep({ pattern: "_ballot", path: `${BALLOT}/sources/us-house-07` }),
        { tool_name: "Bash", tool_input: { command: "ls", description: "unfetchable.md" } },
        bash(
          `node .claude/skills/research-candidates/scripts/review-list --refused-hosts ${BALLOT} us-house-07`,
        ),
        // The settings hook runs on an agent's calls too.
        as("compile")("Read", {
          file_path: path.join(ballotDir, "sources", "_ballot", "pamphlet.md"),
        }),
      ],
    );
  });

  // Value: protects=Rule 5: downloads/ holds the raw sample ballot, and --ballot --file reads what is planted there, so a session must not get in by the name with no slash; fails_when=a command or Grep path naming downloads bare runs, the researcher's ~/Downloads is treated differently by spelling, or prose saying "downloads" in a file body or a longer name is refused; why_new=only downloads/ with its slash matched, so cd downloads && cat ballot.pdf ran; seam=hook; no_claim=a glob, or a name built at run time
  it("refuses a bare downloads in a command or a Grep path, not in a file body", () => {
    const root = project();
    const code = "session-file-denied";
    expect(
      hook,
      root,
      [
        [bash("cd downloads && cat ballot.pdf"), code],
        [bash("cd downloads; grep Elm *"), code],
        [bash("tar cf - downloads | tar xOf -"), code],
        [bash("cp -r downloads /tmp/d"), code],
        [bash("cd downloads && cp /etc/hosts ballot.pdf"), code],
        [bash("cd down''loads"), code],
        [{ tool_name: "Monitor", tool_input: { command: "ls downloads" } }, code],
        // The home folder too: the researcher may save a personalized ballot there.
        [bash("ls ~/Downloads"), code],
        [read("~/Downloads/report.pdf"), code],
      ],
      [
        { tool_name: "Write", tool_input: { file_path: "/r/a.md", content: "offers downloads" } },
        {
          tool_name: "Edit",
          tool_input: { file_path: "/r/a.md", old_string: "x", new_string: "downloads" },
        },
        bash(`cat ${BALLOT}/articles/downloads.md`),
        bash("ls my-downloads downloads-old"),
      ],
    );
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "rc-home-"));
    projects.push(home);
    fs.mkdirSync(path.join(home, "Downloads"));
    const result = runHook(hook, root, grep({ path: "~/Downloads" }), { HOME: home });
    assert.strictEqual(result.status, 2);
    assert.match(result.stderr, / session-file-denied\n$/);
  });

  // Value: protects=Rule 5 once this guard sends sessions to the contest level: every search form the private-file check catches must also stop at sources/, whose _ballot/ holds the sample ballot; fails_when=a search hidden behind a keyword, a wrapper or a redirect, or a cwd in sources/ or a climb out of a contest, reads sources/; why_new=the sources/ check ran on the word-splitting reading the private-file check replaced; seam=hook; no_claim=a directory changed by a script the command runs
  it("refuses every search form from sources/, not only the plain one", () => {
    const root = project();
    const sources = path.join(root, BALLOT, "sources");
    const contest = path.join(sources, "us-house-07");
    const code = "session-file-denied";
    const from = (command, cwd) => runHook(hook, root, { ...bash(command), cwd });
    expect(
      hook,
      root,
      [
        [bash(`for d in a; do rg Elm ${BALLOT}/sources; done`), code],
        [bash(`timeout 5 grep -rn Elm ${BALLOT}/sources`), code],
        [bash(`grep -rnA3 Elm ${BALLOT}/sources`), code],
        [bash(`bash -c 'rg Elm ${BALLOT}/sources'`), code],
      ],
      [],
    );
    for (const [command, cwd] of [
      ["rg Elm 2>/dev/null", sources],
      ["rg Elm .", sources],
      ["rg Elm ..", contest],
    ]) {
      const result = from(command, cwd);
      assert.strictEqual(result.status, 2, `${command} ran`);
      assert.match(result.stderr, / session-file-denied\n$/, command);
    }
    // The check for the private files refuses these first: nothing is placed.
    for (const command of ["cd .. && rg Elm", "cd ../.. && rg Elm"]) {
      const result = from(command, contest);
      assert.strictEqual(result.status, 2, `${command} ran`);
      assert.match(result.stderr, / private-file-denied\n$/, command);
    }
    assert.strictEqual(from("rg Elm", contest).status, 0);
  });

  // Value: protects=the searches this guard leaves open: a false refusal pushes a session toward forms the hook misses; fails_when=a sources directory three parts down that is no ballot's is refused; why_new=the check tested only the part count and the last name; seam=hook; no_claim=a directory named sources directly under a ballot's sibling, which is a ballot by its shape
  it("leaves alone a sources directory that is no ballot's", () => {
    const root = project();
    fs.mkdirSync(path.join(root, ".claude", "x", "sources"), { recursive: true });
    const beside = fs.mkdtempSync(path.join(path.dirname(root), "rc-beside-"));
    projects.push(beside);
    fs.mkdirSync(path.join(beside, "sources"));
    const relative = path.relative(root, path.join(beside, "sources"));
    expect(
      hook,
      root,
      [],
      [
        grep({ path: ".claude/x/sources" }),
        bash("rg Elm .claude/x/sources"),
        grep({ path: relative }),
        bash(`rg Elm ${relative}`),
      ],
    );
  });
});

describe("agent prompts carry the references' text", () => {
  const read = (rel) => fs.readFileSync(path.join(SKILL_DIR, rel), "utf8");
  const SKILL = read("SKILL.md");

  // Value: protects=Rule 7 and source-tiers.md: discovery works the same checklist coverage and the search log assume, item for item; fails_when=an item changes in one place only; why_new=new; seam=none; no_claim=the agent following it (five-trap eval)
  it("gives discovery the discovery checklist, word for word", () => {
    const items = read("references/source-tiers.md").match(
      /\n(1\. \*\*Federal[\s\S]*?padding\.)\n/,
    );
    assert.ok(items, "source-tiers.md no longer holds the checklist items");
    assert.ok(definition("discovery").body.includes(items[1]), "the discovery checklist differs");
    assert.match(definition("discovery").body, /item 3 runs after item 4/);
  });

  // Value: protects=step 4.3 and article-format.md Figures: the compile prompt states the figure rule as SKILL.md does; fails_when=either wording changes alone; why_new=new; seam=none; no_claim=the agent following it (five-trap eval)
  it("gives compile the figure rule and the Not researched yet rule of step 4.3", () => {
    // The sentence, up to its link to article-format.md.
    const rule = SKILL.match(/Copy each figure, [^(]*?(?= \(\[)/);
    assert.ok(rule, "SKILL.md step 3 no longer states the figure rule");
    assert.ok(
      definition("compile").body.includes(`${rule[0]}.`),
      "the compile figure rule differs",
    );
    assert.match(
      definition("compile").body,
      /`Not researched yet` only where the contest's `not_researched`/,
    );
  });

  // Value: protects=review-list.md Neutrality pass: the neutrality prompt carries its full flag list, the figure mistakes check cannot read included; fails_when=a flag is added to or dropped from one place only; why_new=new; seam=none; no_claim=the agent's judgment (five-trap eval)
  it("gives neutrality the full flag list of the Neutrality pass", () => {
    const flags = read("references/review-list.md").match(
      /It flags (any claim whose wording adds[\s\S]*?\("twenty terms" on "two terms"\)\.)/,
    );
    assert.ok(flags, "review-list.md no longer states the flag list");
    assert.ok(definition("neutrality").body.includes(`Flag ${flags[1]}`), "the flag lists differ");
  });

  // Value: protects=the install: SKILL.md names each agent where its step runs, and the README installs agents/ into the data repo; fails_when=an agent is renamed or added without the docs; why_new=new; seam=none; no_claim=none
  it("names each agent in SKILL.md and installs every file in agents/", () => {
    const files = fs.readdirSync(path.join(SKILL_DIR, "agents")).sort();
    assert.deepStrictEqual(files, AGENTS.map((agent) => `${agentName(agent)}.md`).sort());
    for (const agent of AGENTS) assert.ok(SKILL.includes(`\`${agentName(agent)}\``), agent);
    assert.match(
      read("README.md"),
      /cp \.claude\/skills\/research-candidates\/agents\/\*\.md \.claude\/agents\//,
    );
  });
});
