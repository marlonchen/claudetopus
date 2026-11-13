---
status: accepted
---

# Agents run isolated and bound to one contest

Fetched pages are untrusted, and text in one can try to steer whatever reads it. Three steps run as separate agents from fresh context, each with the tools and files its step needs and nothing else (Rule 7). An agent that never held a private value has nothing to leak, however it is steered. The limits sit in each agent's tool configuration and hook, not only in its instructions, so a fetched page cannot widen them.

| Agent | Step | Tools | Reads | Writes |
| --- | --- | --- | --- | --- |
| `research-candidates-discovery` | 4.1-4.2 | `WebSearch`, Bash for `discovery-fetch` only | Its `--brief` output | Snapshots, through `discovery-fetch` |
| `research-candidates-compile` | 4.3-4.4, 5 | `Read`, `Glob`, `Grep`, `Write`, `Edit` | `ballot.yaml`, `ballot-view.md`, listed companions, its contest's sources, `articles/` | `articles/<contest>.md` |
| `research-candidates-neutrality` | 4.5 | `Read`, `Glob`, `Grep`, `Write` | `articles/`, its flags file | `review/<contest>.neutrality.md` |

Compile and neutrality may also read the skill's references. None may read `private.yaml`, `publish.yaml` or `pages_dir`. `private.yaml` is the only file that lists private values: no address is stored ([ADR 0017](0017-no-address-is-stored-the-zip-is-a-private-string.md)).

## Enforcement

- `agent-bind` binds one contest to a random token once `ballot-check` passes. Discovery's whole prompt is the token, and it is the first line of the others' prompts.
- A hook on an agent's calls cannot see its prompt. The settings hook therefore records each launch's token, and SubagentStart hands it to the agent's `agent_id` ([`bindings.js`](../../../skills/research-candidates/scripts/lib/bindings.js)).
- [`agent-guard.js`](../../../skills/research-candidates/scripts/lib/agent-guard.js) then checks every call. It refuses a mismatched `agent_type`, a tool outside the list, an unbound agent, and any path outside the contest's list, with links resolved and `..` and brace patterns refused.
- Discovery's Bash must be exactly one `discovery-fetch` command with its own token and a single-quoted URL.
- Any other agent type is refused at launch (`agent-type-denied`), including a launch that names no type, because it holds no token and no allow list. One started with no launch to check, by a skill's fork or a workflow, is refused with the same code at its first hooked call.
- Launches are refused in a worktree or on another machine, where the hooks may not run. A second launch of an agent is refused until the first starts, within a 2-minute window, so two launches cannot trade tokens.
- Every `SendMessage` and every Bash call running the `claude` CLI is refused, so nothing reaches an agent after its prompt.

## Considered Options

- **Let discovery reply in free text.** Rejected in /ship run 5 as an injection channel. It replies `done`, and the main session acts on nothing in the reply.
- **Rely on prompts alone.** Rejected, because "never read the reply" could not be enforced. The owner chose to put this boundary in code with tests.
- **One token for discovery alone** (`discovery-bind`). Replaced in PR #23's review by `agent-bind`, which binds all three agents to one contest.

## Consequences

- The main session is held only to the refusals in [ADR 0003](0003-the-model-never-sees-an-address.md) and [ADR 0007](0007-researcher-only-modes-need-their-own-terminal.md). Its web tools have no hook, and its reads are refused only for the private files, `sources/_ballot/`, `downloads/` and `unfetchable.md`, so its other limits are instructions.
- `Glob` and `Grep` are checked by their starting path only, relying on Claude Code running them through ripgrep without following links.
- Agent definitions must be copied into the data repo after each upgrade, and `.bindings/` must be gitignored there.
