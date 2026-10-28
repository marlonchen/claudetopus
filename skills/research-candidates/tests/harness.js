"use strict";

// The command test harness (spec, Testing Decisions, seam 1). Each command runs
// as a subprocess against a temp data repo, with its outside world replaced at
// the same level: a local node:http server for every page and redirect, and a
// stub `gh` on PATH for the visibility and fork-network calls. The CLI runs
// asynchronously so the in-process server can answer it.

const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const SKILL_DIR = path.join(__dirname, "..");
const SCRIPTS_DIR = path.join(SKILL_DIR, "scripts");

const git = (cwd, ...args) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

// The stub gh answers only the one call Rule 8 makes, from a JSON file of
// { "<owner>/<repo>": { visibility, id, sourceId, fail } } keyed in lower case,
// and logs each call's repo to GH_STUB_LOG. A repo missing from the file fails
// like a repo gh cannot see; `visibility: ""` or `id: ""` prints null, as jq
// does for a field gh did not return.
const GH_STUB = `#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const repos = JSON.parse(fs.readFileSync(process.env.GH_STUB_FILE, "utf8"));
const args = process.argv.slice(2);
const fail = (msg) => { process.stderr.write(msg + "\\n"); process.exit(1); };
if (args[0] !== "api" || !/^repos\\/[^/]+\\/[^/]+$/.test(args[1] || "")) {
  fail("gh stub: unexpected call: " + args.join(" "));
}
const name = args[1].slice("repos/".length);
fs.appendFileSync(process.env.GH_STUB_LOG, name + "\\n");
const repo = repos[name.toLowerCase()];
if (!repo || repo.fail) fail("HTTP 404: Not Found");
const field = (value) => (value === "" ? "null" : String(value));
const visibility = field(String(repo.visibility ?? "PRIVATE").toLowerCase());
process.stdout.write(visibility + " " + field(repo.sourceId ?? repo.id ?? 1) + "\\n");
`;

const DEFAULT_TIERS = `- match: county.example.gov
  tier: T1
  owner: third-party
  source: Exampleton County elections
- match: news.example.com
  tier: T2
  owner: third-party
  source: Example News
- match: news.example.com/opinion/
  tier: T4
  statements_only: true
  owner: third-party
  source: Example News opinion page
- match: janeexample.com
  tier: T4
  statements_only: true
  owner: jane-example
  source: Jane Example campaign site
`;

const DEFAULT_BALLOT = `election: 2026-general
state: XX
county: Exampleton County
slug: k3x9qa
contest_count: 2
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
  - id: supreme-court-retention-a
    type: retention
    jurisdiction: XX supreme court
    office_type: judicial
    title: Shall Justice Pat Example of the Supreme Court be retained in office?
    official:
      id: pat-example
      name: Pat Example
`;

const BALLOT = "2026-general/xx-exampleton-1";

// Fictional private values; tests/privacy.test.js plants them in URLs.
const DEFAULT_PRIVATE = `private_strings:
  - Precinct 12
  - Springfield Township
  - BS-0412
ignored_lines:
  - Vote for one
`;

const DEFAULT_ADDRESSES = `addr-mom:
  address: 123 Elm Street Apt 4, Springfield, XX 99999
  street: 123 Elm Street
  ballot: ${BALLOT}
`;

// A private data repo that passes Rule 8: publish.yaml, one private GitHub
// remote, tiers.yaml, addresses.yaml and one ballot with its private.yaml.
// Options override each part.
const makeDataRepo = (options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rc-data-"));
  git(root, "init", "-q");
  if (options.publish !== false) write(path.join(root, "publish.yaml"), "branch: main\n");
  if (options.tiers !== false) write(path.join(root, "tiers.yaml"), options.tiers ?? DEFAULT_TIERS);
  if (options.ballot !== false) {
    write(path.join(root, BALLOT, "ballot.yaml"), options.ballot ?? DEFAULT_BALLOT);
  }
  if (options.ballot !== false && options.private !== false) {
    write(path.join(root, BALLOT, "private.yaml"), options.private ?? DEFAULT_PRIVATE);
  }
  if (options.addresses !== false) {
    write(path.join(root, "addresses.yaml"), options.addresses ?? DEFAULT_ADDRESSES);
  }
  const remotes = options.remotes ?? { origin: ["https://github.com/me/elections.git"] };
  for (const [name, urls] of Object.entries(remotes)) {
    git(root, "remote", "add", name, urls[0]);
    for (const url of urls.slice(1)) git(root, "remote", "set-url", "--add", name, url);
  }
  for (const [name, urls] of Object.entries(options.pushUrls ?? {})) {
    for (const url of urls) git(root, "remote", "set-url", "--add", "--push", name, url);
  }

  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "rc-bin-"));
  write(path.join(bin, "gh"), GH_STUB);
  fs.chmodSync(path.join(bin, "gh"), 0o755);
  const ghFile = path.join(bin, "gh-repos.json");
  const gh = options.gh ?? { "me/elections": { visibility: "PRIVATE", id: 42 } };
  write(ghFile, JSON.stringify(gh));
  const ghLog = path.join(bin, "gh-calls.log");
  write(ghLog, "");

  return {
    root,
    bin,
    ballotDir: path.join(root, BALLOT),
    file: (rel) => path.join(root, rel),
    read: (rel) => fs.readFileSync(path.join(root, rel), "utf8"),
    exists: (rel) => fs.existsSync(path.join(root, rel)),
    // Entries of a directory, sorted; [] when it does not exist.
    list: (rel) =>
      fs.existsSync(path.join(root, rel)) ? fs.readdirSync(path.join(root, rel)).sort() : [],
    write: (rel, text) => write(path.join(root, rel), text),
    // The repos gh was asked about, in order.
    ghCalls: () => fs.readFileSync(ghLog, "utf8").split("\n").filter(Boolean),
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GH_STUB_FILE: ghFile,
      GH_STUB_LOG: ghLog,
    },
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(bin, { recursive: true, force: true });
    },
  };
};

// A local web server. `routes` maps an original URL (as the page would be
// fetched on the open web) to { status, headers, body }. fetch-snapshot sends
// every request here when RESEARCH_CANDIDATES_TEST_HTTP_TARGET is set, carrying
// the original URL in the X-Original-Url header.
const startServer = async (routes) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    const original = req.headers["x-original-url"];
    seen.push(original);
    const route = routes[original];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(route.status ?? 200, {
      "content-type": "text/html; charset=utf-8",
      ...route.headers,
    });
    res.end(route.body ?? "");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    target: `127.0.0.1:${server.address().port}`,
    seen,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

// Run a command in scripts/ with `cwd` as the project root. Resolves with its
// exit code, signal, stdout and stderr.
const runCli = (script, args, { cwd, env = {} }) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(SCRIPTS_DIR, script), ...args], {
      cwd,
      env: { ...process.env, CLAUDECODE: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });

// Runs argv on a new pseudo-terminal, so stdin and stdout are both TTYs, as in
// the researcher's own terminal, unless `pipe` is "stdin" or "stdout": that
// one is a pipe instead. Once the output shows "[y/N] " it types `answer` and
// Enter, once. Prints everything the terminal (and a piped stdout) showed;
// exits with the child's code.
const PTY_RUNNER = `
import os, select, subprocess, sys, time
answer, pipe = sys.argv[1], sys.argv[2]
master, slave = os.openpty()
child = subprocess.Popen(
    sys.argv[3:],
    stdin=subprocess.DEVNULL if pipe == "stdin" else slave,
    stdout=subprocess.PIPE if pipe == "stdout" else slave,
    stderr=slave,
    close_fds=True,
)
os.close(slave)
out = b""
asked = False
deadline = time.time() + 30
while time.time() < deadline:
    ready, _, _ = select.select([master], [], [], 0.1)
    if not ready:
        if child.poll() is not None:
            break
        continue
    try:
        chunk = os.read(master, 4096)
    except OSError:
        break
    if not chunk:
        break
    out += chunk
    if not asked and b"[y/N] " in out:
        os.write(master, answer.encode() + b"\\r")
        asked = True
# A child still waiting (on a prompt never shown) fails rather than hangs.
if child.poll() is None:
    child.kill()
child.wait()
if child.stdout:
    out += child.stdout.read()
sys.stdout.buffer.write(out)
sys.exit(child.returncode)
`;

// Run a command in scripts/ on a pseudo-terminal (PTY_RUNNER), with CLAUDECODE
// unset unless `env` sets it. Resolves with its exit code and what the
// terminal showed, without escape sequences and with line ends as "\n".
const runInTty = (script, args, { cwd, env = {}, answer = "y", pipe = "none" }) =>
  new Promise((resolve) => {
    const base = { ...process.env, ...env };
    if (!Object.hasOwn(env, "CLAUDECODE")) delete base.CLAUDECODE;
    const child = spawn(
      "python3",
      ["-c", PTY_RUNNER, answer, pipe, process.execPath, path.join(SCRIPTS_DIR, script), ...args],
      { cwd, env: base },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    // readline's cursor moves are terminal noise, not output.
    child.on("close", (status) =>
      resolve({
        status,
        stdout: stdout
          .replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g"), "")
          .replace(/\r\n/g, "\n"),
      }),
    );
  });

// A page Readability can read: an article between navigation and a footer.
const articlePage = (title, paragraphs) => `<!doctype html>
<html><head><title>${title}</title></head>
<body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article><h1>${title}</h1>
${paragraphs.map((p) => `<p>${p}</p>`).join("\n")}
</article>
<footer>Copyright Example</footer>
</body></html>`;

module.exports = {
  BALLOT,
  DEFAULT_ADDRESSES,
  DEFAULT_BALLOT,
  DEFAULT_PRIVATE,
  DEFAULT_TIERS,
  SCRIPTS_DIR,
  articlePage,
  git,
  makeDataRepo,
  runCli,
  runInTty,
  startServer,
};
