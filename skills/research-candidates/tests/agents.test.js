"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { afterEach, describe, it } = require("node:test");
const { load } = require("../scripts/lib/deps");
const { BALLOT } = require("./harness");

// The three agents of SKILL.md Rule 7, as Claude Code runs them: each agent's
// tool list and PreToolUse hook come from its definition in agents/, and the
// data repo's settings hook checks the main session's launch of discovery.
// Hooks run through the shell with the tool call on stdin (seam: hook).

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
const FETCH = "node .claude/skills/research-candidates/scripts/discovery-fetch";

// A data repo holding the skill where the hook commands expect it, a bound
// discovery token, and the files the path rules are tried on.
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
  write(`.discovery/${TOKEN}`, `${BALLOT} us-house-07\n`);
  write(`${BALLOT}/ballot.yaml`, "contests: []\n");
  write(`${BALLOT}/private.yaml`, "private_strings: []\n");
  write(
    `${BALLOT}/ballot-view.md`,
    "link: sources/_ballot/sample-ballot.md\nread: sources/_ballot/pamphlet.md\n",
  );
  write(`${BALLOT}/sources/_ballot/sample-ballot.md`, "x\n");
  write(`${BALLOT}/sources/_ballot/pamphlet.md`, "x\n");
  write(`${BALLOT}/sources/us-house-07/jane-example/bio.md`, "x\n");
  write(`${BALLOT}/articles/us-house-07.md`, "x\n");
  write(`${BALLOT}/review/us-house-07.md`, "x\n");
  write(`${BALLOT}/review/us-house-07.neutrality.md`, "x\n");
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
const runHook = (command, root, call) =>
  spawnSync("sh", ["-c", command], {
    input: JSON.stringify({ cwd: root, ...call }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
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
  agent_id: "a1",
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
      assert.strictEqual(
        group.hooks[0].command,
        settings.hooks.PreToolUse[0].hooks[0].command,
        `${agent}: the hook is not session-guard`,
      );
    }
  });
});

describe("session-guard: the discovery agent", () => {
  const call = as("discovery");
  const bash = (command) => call("Bash", { command });

  // Value: protects=Rule 7: discovery's Bash runs only its bound fetch tool in its three forms, with a single-quoted URL, so a fetched page cannot get it a shell, a file or fetch-snapshot's other modes; fails_when=a second command, an unquoted URL, a plain fetch-snapshot call or another tool gets through; why_new=new; seam=hook; no_claim=what it searches for (prompt-level)
  it("lets Bash run only the fetch tool, and refuses every other tool", () => {
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
        [call("Read", { file_path: path.join(root, "addresses.yaml") }), "agent-tool-denied"],
        [call("WebFetch", { url: "https://x.example/", prompt: "p" }), "agent-tool-denied"],
        [call("Write", { file_path: path.join(root, "x"), content: "" }), "agent-tool-denied"],
      ],
      [
        bash(`${FETCH} ${TOKEN} --brief`),
        bash(`${FETCH} ${TOKEN} --searched jane-example 4`),
        bash(`${FETCH} ${TOKEN} --searched _race 6`),
        bash(`${FETCH} ${TOKEN} jane-example bio 'https://news.example.com/a/b?c=d&e=f'`),
        call("WebSearch", { query: "Jane Example congressional district 7" }),
      ],
    );
  });
});

describe("session-guard: the compile and neutrality agents", () => {
  const at = (root, rel) => path.join(root, rel);

  // Value: protects=Rule 7: the compile agent reads only ballot.yaml, ballot-view.md, the companions on its read: lines, the contests' sources and articles/ (plus the skill's references), never the sample ballot or a private file, even through a link, and writes only articles; fails_when=a path outside the allow list, the sample ballot, a link out of it, a Glob or Grep without a path, or a write outside articles/ gets through; why_new=new; seam=hook; no_claim=which contest's article it writes (prompt-level)
  it("holds the compile agent to its read and write allow lists", () => {
    const root = project();
    const call = as("compile");
    const read = (rel) => call("Read", { file_path: at(root, rel) });
    expect(
      agentHook("compile"),
      root,
      [
        [read("addresses.yaml"), "agent-path-denied"],
        [read(`${BALLOT}/private.yaml`), "agent-path-denied"],
        [read("publish.yaml"), "agent-path-denied"],
        [read(`.discovery/${TOKEN}`), "agent-path-denied"],
        [read(`${BALLOT}/sources/_ballot/sample-ballot.md`), "agent-path-denied"],
        [read(`${BALLOT}/unfetchable.md`), "agent-path-denied"],
        [read(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [read(`${BALLOT}/articles/linked.md`), "agent-path-denied"],
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
        [
          call("Grep", { pattern: "Elm", path: at(root, `${BALLOT}/sources`) }),
          "agent-path-denied",
        ],
        [call("Grep", { pattern: "Elm" }), "agent-path-denied"],
        [
          call("Grep", { pattern: "Elm", path: at(root, `${BALLOT}/articles`), glob: "../*.yaml" }),
          "agent-path-denied",
        ],
        [
          call("Write", { file_path: at(root, `${BALLOT}/review/us-house-07.md`), content: "" }),
          "agent-path-denied",
        ],
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
        read(`${BALLOT}/sources/_ballot/pamphlet.md`),
        read(`${BALLOT}/sources/us-house-07/jane-example/bio.md`),
        read(`${BALLOT}/articles/us-house-07.md`),
        read(".claude/skills/research-candidates/references/article-format.md"),
        call("Glob", { pattern: "**/*.md", path: at(root, `${BALLOT}/sources/us-house-07`) }),
        call("Glob", { pattern: "*.md", path: at(root, `${BALLOT}/articles`) }),
        call("Grep", {
          pattern: "school board",
          path: at(root, `${BALLOT}/sources/us-house-07`),
          glob: "*.md",
        }),
        call("Write", { file_path: at(root, `${BALLOT}/articles/us-house-07.md`), content: "" }),
        call("Write", { file_path: at(root, `${BALLOT}/articles/question-1.md`), content: "" }),
        call("Edit", {
          file_path: at(root, `${BALLOT}/articles/us-house-07.md`),
          old_string: "a",
          new_string: "b",
        }),
      ],
    );
  });

  // Value: protects=Rule 7: the neutrality pass reads only articles/ (and its own flags file, which Write needs read first) and writes only review/<contest>.neutrality.md; fails_when=it reads sources or ballot.yaml, or writes the review list or an article; why_new=new; seam=hook; no_claim=what it flags (five-trap eval)
  it("holds the neutrality agent to articles/ and its flags file", () => {
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
        [writeTo(`${BALLOT}/review/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/articles/us-house-07.md`), "agent-path-denied"],
        [writeTo(`${BALLOT}/review/x/us-house-07.neutrality.md`), "agent-path-denied"],
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
});

describe("session-guard: the main session's launch of discovery", () => {
  const launch = (subagent_type, prompt) => ({
    tool_name: "Agent",
    tool_input: { subagent_type, description: "Discover sources", prompt },
  });
  const hook = settings.hooks.PreToolUse[0].hooks[0].command;

  // Value: protects=Rule 7: the discovery agent's whole prompt is a token discovery-bind printed, so nothing the main session holds (snapshot text, a full URL, an instruction) reaches it; fails_when=the prompt carries anything besides a bound token; why_new=new; seam=hook; no_claim=a main session that skips the agent and searches itself (prompt-level)
  it("lets discovery start only on a bound token, and leaves other agents and reads alone", () => {
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
          "discovery-prompt-invalid",
        ],
        [launch(agentName("discovery"), "f".repeat(32)), "discovery-prompt-invalid"],
        [launch(agentName("discovery"), "us-house-07"), "discovery-prompt-invalid"],
        [
          { tool_name: "Task", tool_input: { subagent_type: agentName("discovery"), prompt: "x" } },
          "discovery-prompt-invalid",
        ],
      ],
      [
        launch(agentName("discovery"), TOKEN),
        launch(agentName("discovery"), `${TOKEN}\n`),
        launch(agentName("compile"), "Compile us-house-07."),
        launch("Explore", "Find the tests."),
        { tool_name: "Read", tool_input: { file_path: path.join(root, BALLOT, "ballot.yaml") } },
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
