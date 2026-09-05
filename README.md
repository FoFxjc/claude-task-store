# claude-task-store

Persistent execution checkpoints for Claude Code, OpenCode, and coding agents.

**Your context window should not be your task lifetime.**

Long coding tasks often outlive a single model session. When a session restarts, compacts, or switches models, the next agent should not have to reconstruct the entire execution history.

claude-task-store keeps only the small amount of state required to continue:
what is done, what failed, what is active, and what should happen next.

Typical validated resume context: ~100–300 tokens.

Plain JSON · Local-first · No cloud · No embeddings · No database · No workflow framework

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![CI](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml/badge.svg)](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml)

---

## Why this exists

This project came from repeatedly encountering the same failure mode while using coding agents with constrained-context models: the implementation survived in the repository, but the execution state did not.

A typical failure sequence:

1. A coding agent works through a long implementation.
2. It reaches 70–90% completion.
3. The session approaches the model's context limit.
4. A new session must be started.
5. The new session has no compact, reliable record of:
   - the original goal
   - what is already done
   - what failed and why
   - what decisions were made
   - what is currently in progress
   - what should happen next
6. The human ends up manually copying fragments from the old session and reconstructing task state.

After the restart:
- **The code is still there.** Git is still there. Tests are still there.
- **What is missing is the tiny amount of process state needed to continue efficiently.**

This is not a memory problem. It is an execution continuity problem.

Human users were acting as the state synchronization layer between coding-agent sessions. claude-task-store externalizes that state.

**Without task-store:**
```
Long task
→ context fills up
→ new session
→ reread repository
→ reconstruct prior work
→ repeat failed approaches
→ human manually copies old output
→ continue
```

**With task-store:**
```
Long task
→ checkpoint
→ new session
→ read one state file
→ ~100–300 token resume projection
→ continue from next_action
```

---

## 30-second example

A resume context injected at session start looks like this:

```
GOAL: Add OAuth support to the API

CURRENT:
  ▶ [T4] Write integration tests
    ✗ tried: mocked fetch → does not support streaming responses

DONE:
  ✓ [T1] Database schema migration
  ✓ [T2] Callback route
  ✓ [T3] Token validation

REMAINING:
  ○ [T5] Update API documentation

KEY DECISIONS:
  • Use PKCE flow — implicit flow deprecated in OAuth 2.1

NEXT ACTION: Replace mock with local HTTP fixture, then complete streaming test
```

Typical size: 100–300 tokens. One file. No transcript replay.

The <400-token resume ceiling is a **design constraint**: as state accumulates, older completed tasks and historical details stay out of the default projection and are only loaded on explicit request.

---

## Execution state vs. conversation memory

These are different problems.

**Conversation memory** asks: *"What happened before?"*  
It stores dialogue, facts, and learnings accumulated over time.

**Execution state** asks: *"What is the minimum state required to keep working?"*  
It stores only the navigation data needed to continue: goal, current task, completed work, failed attempts, decisions, next action.

claude-task-store stores the latter. It does not record conversation history. It does not summarize sessions. It preserves only what cannot be cheaply derived from the repository — the process state that disappears when a session ends.

---

## What about automatic compaction?

Automatic compaction is useful, and this is not a replacement for it. It solves a
different problem.

Compaction asks: *"What parts of this conversation should remain in context?"*

claude-task-store asks: *"What execution state should not need to live in the
conversation at all?"*

Both can be true at once. But a compacted conversation still consumes context:
the system reads the existing context, generates a summary, and the model carries
that summary forward — where later compactions may compress already-compressed
history again. Execution-critical state also ends up interleaved with
conversational background, so the parts you most need to survive are not stored
separately from the parts you do not.

For execution continuity, a fresh session usually needs much less than a summary
of everything that was said:

- the goal
- what is done
- what failed, and how
- what is active or blocked
- the decisions that constrain the next step
- what happens next

claude-task-store keeps that state outside the conversation and injects only a
small resume projection when a session starts.

**Don't compact what you can externalize.**

Compaction for conversation continuity. Task store for execution continuity.

### Why this matters in auto-compacting harnesses

Coding harnesses that compact automatically — Claude Code and OpenCode among them
— can keep a session alive considerably longer. But task lifetime stays coupled to
an accumulating conversational summary. A durable execution checkpoint decouples
the two: the task survives even when the conversation is discarded completely, so
starting a genuinely fresh session becomes a normal move rather than a loss.

That trade matters most with private or smaller-context models, internal inference
gateways, long-running agents, and workflows where starting clean is cheaper or
more reliable than compressing history again.

|  | Auto-compaction | claude-task-store |
| --- | --- | --- |
| Primary goal | Conversation continuity | Execution continuity |
| Stored form | Conversation summary | Structured execution state |
| Lives in context | Yes | Only a small resume projection |
| Needs the prior transcript | Yes, during compaction | No |
| Survives a fresh session or provider | Platform-dependent | Yes, via local state |
| Typical role | Keep the current session going | Let work continue after the session ends |

---

## For constrained-context models

Many development environments cannot simply use the largest frontier model with effectively unlimited context. Relevant constraints include:

- private or on-prem models (14B / 27B / 32B / 70B)
- internal inference gateways
- privacy or compliance restrictions
- limited GPU capacity
- smaller practical context windows
- agent frameworks that consume substantial context through system prompts, tool definitions, repository files, diffs, test output, and prior conversation

For constrained-context models, execution history competes directly with the code and reasoning needed for the current step.

Externalizing execution state allows:
- fresh sessions with shorter prompts
- cleaner local reasoning on the current task
- lower reorientation cost after context loss
- model switching without transcript replay

Smaller models often do not fail because they cannot perform the next coding step. They fail because too much of their context is occupied by accumulated execution history.

**Make longer tasks more practical on constrained-context models.**

> This improves continuity and reduces repeated orientation work. It does not make a weaker model equivalent to a stronger one, and it does not remove the need for context on the current task.

---

## Context is a budget

A larger context window is genuinely useful, and nothing here argues against it.
But available capacity and justified consumption are separate questions: context
that is carried forward or re-read still costs latency, money, and attention,
whatever the limit happens to be.

claude-task-store tries to reduce unnecessary context use in two directions:

- **Execution** — externalize durable task state instead of carrying execution
  history through every session.
- **Observation** — give an agent the smallest useful view of the environment
  instead of making it rediscover installation and operating boundaries from the
  whole repository.

The second direction applies to setup, not only to running work. For example,
[`docs/agent-installation.md`](docs/agent-installation.md) gives a coding agent a
bounded installation procedure and a minimal observation set, so it does not need
to traverse the target repository broadly just to learn how to install and
operate the tool.

Broad inspection is not forbidden — it is demand-driven. An agent should expand
what it observes when the task actually requires it, such as when installation
validation fails and the cause has to be found.

> Context capacity is not context permission.

---

## Source of truth

The task store is a navigation aid, not an authoritative record.

```
repository / tests
      >
   git state
      >
  task-store
      >
 model memory
```

If the task store claims something is complete but the repository or tests disagree, repository reality wins. Before acting on a consequential claim — task complete, test passing, file modified — verify against the repository.

---

## Validated results

Measured across the 530 automated checks that make up the current suite:

| Scenario | Resume context |
|----------|---------------:|
| 22-session pressure test (max) | 148 tokens |
| 30+ completed tasks (decay test) | 267 tokens |
| Claude → Codex handoff | 299 tokens |
| Codex → Claude handoff | ~190 tokens |

**Design constraint:** default resume projection must remain below 400 tokens. As state accumulates, older completed tasks and historical detail stay outside the default projection and load only on explicit request. Context is treated as an expensive resource.

In every validated handoff scenario:
- no completed work was repeated
- no failed approaches were retried
- correct next task was selected
- only one file was read to resume

See [`docs/phase2-reliability-report.md`](docs/phase2-reliability-report.md) and [`docs/phase3-cross-agent-handoff.md`](docs/phase3-cross-agent-handoff.md) for full experiment details.

---

## How it works

State lives in two plain files inside your project:

```
.claude-task/
├── state.json      ← Human-readable, git-committable execution checkpoint
└── history.jsonl   ← Append-only audit trail (gitignored by default)
```

At session start, a compact summary is automatically injected into the agent's
context. The exact hook surface differs per host — Claude Code uses a
`SessionStart` hook, OpenCode uses an auto-discovered plugin that hooks
`experimental.chat.system.transform` — but both call the same `task-store resume`
CLI and project the same canonical output. The agent reads the current task,
completed work, failed approaches, and the explicit next action — and continues
without re-reading transcripts.

---

## Installation

### Let your coding agent install it for you

You just need to send this to your coding agent:

> Install `https://github.com/FoFxjc/claude-task-store` into this repository and follow `docs/agent-installation.md`.

[`docs/agent-installation.md`](docs/agent-installation.md) is a machine-facing
runbook that tells the agent how to install safely — without modifying your
application or package dependencies, without overwriting unrelated Claude
Code/OpenCode configuration, and without enabling auto-checkpoint unless you
explicitly ask for it. The guide intentionally defines a minimal observation
set, so the agent does not need to broadly inspect the repository unless
installation validation fails.

### Manual installation

**Prerequisites:** Node.js ≥ 18, Claude Code or OpenCode, `python3`

```bash
git clone https://github.com/FoFxjc/claude-task-store.git
cd claude-task-store
npm install && npm run build

# Install into your project
./install.sh /path/to/your/project
```

That is the whole installation. The installer copies the built CLI runtime into
`.claude/task-store/` inside your project, so the hooks can run the canonical
resume renderer without anything else on your machine — no global npm install,
no PATH shim, and no changes to your project's `package.json`. The installed
project is self-contained: you can delete this checkout afterwards.

Start Claude Code or OpenCode in that project and the full resume projection is
injected at session start.

The installer:
1. Builds the TypeScript CLI
2. Copies the built runtime to `.claude/task-store/` (the CLI has no runtime dependencies)
3. Copies the skill to `.claude/skills/task-store/SKILL.md`
4. Copies hook scripts to `.claude/hooks/scripts/`
5. Merges hook config into `.claude/settings.json` — only claude-task-store's own hook entries are ever added or removed (matched by exact command path, not substring), so any other hooks you or another plugin registered for `SessionStart`/`PreCompact`/`SessionEnd` are left untouched. A backup is written to `.claude/settings.json.bak` before each rewrite.
6. Copies the OpenCode adapter (a thin auto-discovered plugin) to `.opencode/plugin/task-store.ts` plus a sibling helper module in `.opencode/plugin/task-store/`. Nothing else under `.opencode/` is touched; no `opencode.json` change is required.
7. Updates `.gitignore`

The `SessionStart` hook (Claude Code) resolves the CLI in this order:

1. the project-local runtime at `.claude/task-store/` (installed above)
2. `task-store` on `PATH`
3. a minimal goal/next-action fallback, used only when neither is available
   (for example, if Node is missing) and clearly labelled as such

The OpenCode plugin uses the same project-local runtime directly and does not
fall back to PATH — install.sh always installs `.claude/task-store/` and the
plugin reads it. To opt out of OpenCode integration in a future install, run
`TASK_STORE_SKIP_OPENCODE=1 ./install.sh /path/to/project`.

**Optional — `task-store` on your PATH.** Only needed if you want to run the CLI
by hand from any directory; the hooks and the OpenCode plugin never require it:

```bash
TASK_STORE_INSTALL_GLOBAL=1 ./install.sh /path/to/your/project
# or, any time:  npm install -g .
```

**Uninstall:**
```bash
./uninstall.sh /path/to/your/project
```
Uninstalling backs up `.claude/settings.json` to `.claude/settings.json.bak` first and removes only claude-task-store's own hook entries, in the same exact-match-safe way as install. It also removes the project-local runtime at `.claude/task-store/`, but only after confirming that directory carries claude-task-store's own marker. It removes the OpenCode plugin at `.opencode/plugin/task-store.ts` (and its sibling helper subdirectory when it contains no other files), but only when the plugin file carries claude-task-store's ownership marker. Anything else under `.claude/` or `.opencode/` — your own hooks, agents, commands, plugins, MCP servers, skills, and `opencode.json` — is left untouched. Your task state in `.claude-task/` is left in place.

---

## Quick start

```bash
# Initialize with a goal and tasks
task-store init "Implement OAuth for the API" \
  "Database schema migration" \
  "Callback route" \
  "Token validation" \
  "Integration tests" \
  "Update API docs"

# Start working
task-store start T1

# Mark done with evidence (required — prevents false completions)
task-store done T1 -e db/migrations/001_oauth.sql -e "npm test: 8/8 pass"

# Record a failed approach so future sessions don't repeat it
task-store attempt T4 "mocked fetch" "does not support streaming responses"

# Mark blocked
task-store block T4 "need local HTTP fixture before streaming test works"

# Always set next action before ending a session
task-store next "Replace mock with local HTTP fixture, then complete T4"
```

On next session start (or in a fresh model session), the agent automatically receives the compact resume context shown above — identically in Claude Code and in OpenCode, since both render it through the same `task-store resume` CLI.

---

## Commands

| Command | Description |
|---------|-------------|
| `task-store init "<goal>" [tasks...] [--auto-checkpoint off\|conservative]` | Initialize a new task store; auto-checkpoint defaults to `conservative` |
| `task-store status` | Show full current state |
| `task-store resume` | Print compact resume context |
| `task-store add "<title>"` | Add a new task |
| `task-store start T1` | Mark task in-progress |
| `task-store done T1 -e <evidence>` | Mark done with evidence |
| `task-store block T1 "<reason>"` | Mark blocked |
| `task-store resume-task T1` | Resume a blocked task |
| `task-store attempt T1 "<tried>" "<why-failed>"` | Record a failed approach |
| `task-store decide "<summary>" [rationale]` | Record a key decision |
| `task-store next "<action>"` | Set the next action |
| `task-store history [--tail N]` | Show history log |
| `task-store archive` | Archive completed state |
| `task-store repair` | Recover from corrupted state |
| `task-store stale` | Detect tasks stuck in-progress >48h |
| `task-store token-estimate` | Estimate injected token count |
| `task-store config` | Show project-local configuration |
| `task-store config auto-checkpoint <off\|conservative>` | Enable/disable auto-checkpoint mode |

### Cross-agent flags

```bash
task-store start T1 --by claude-code       # record which agent is writing
task-store done T1 --by codex -e proof     # handoff provenance (informational)
task-store next "action" --expect-rev 14   # reject write if another agent wrote first
```

`--by` is accepted on every command that writes state (`init`, `add`, `start`, `done`, `block`, `resume-task`, `attempt`, `decide`, `next`, `archive`, `repair`) and is rejected as an unsupported flag if you pass it to a purely read-only command.

`--expect-rev` is enforced atomically: the revision check and the write both happen inside an O_EXCL lock file (`.claude-task/.lock`) held for the full read-compare-write cycle, so two concurrent `task-store` CLI invocations cannot race each other into a lost update. This protects concurrent **CLI** invocations specifically; code that imports `src/core.ts` directly and calls `writeState()` without going through `withStoreLock()` bypasses it. See [`docs/pre-release-remediation.md`](docs/pre-release-remediation.md) item 3 for the exact guarantee.

---

## Claude Code integration

After installation, these hooks run automatically:

| Hook | Event | Action |
|------|-------|--------|
| `session-start.sh` | `SessionStart` | Injects compact resume context if state exists |
| `pre-compact.sh` | `PreCompact` | Saves a checkpoint to history before compaction |
| `session-end.sh` | `SessionEnd` | Warns if `next_action` is not set |
| `post-tool-use.sh` | `PostToolUse` | Auto-checkpoint only — marks the checkpoint possibly stale |
| `stop.sh` | `Stop` | Auto-checkpoint only — asks the agent to reconcile at a boundary |

The last two are installed unconditionally. New stores enable conservative mode during `task-store init`; use `--auto-checkpoint off` to opt out. Configless legacy stores remain inert: each hook exits in a few milliseconds of shell, before starting Node, when `.claude-task/config.json` is absent or not set to `conservative`. See [Auto-checkpoint mode](#auto-checkpoint-mode).

The `/task-store` skill is also installed. Claude uses it when starting long-running tasks, after milestones, and before ending sessions. Invoke directly with `/task-store`.

---

## OpenCode integration

A thin auto-discovered OpenCode plugin is installed alongside the Claude Code
side. It uses OpenCode's `experimental.chat.system.transform` hook to push the
same `task-store resume` projection into the system prompt for every chat
call — including the first user message of a fresh session, which is the
OpenCode analog of Claude Code's `SessionStart`. No `opencode.json` change is
required.

Architecture:

```
OpenCode session
  ↓
.opencode/plugin/task-store.ts        (auto-discovered thin adapter)
  ↓  imports ./task-store/injection.ts
.opencode/plugin/task-store/injection.ts   (helper; not itself a plugin —
                                            OpenCode's discovery glob
                                            .opencode/{plugin,plugins}/*.{ts,js}
                                            is a single level)
  ↓
experimental.chat.system.transform
  ↓
node .claude/task-store/bin/task-store.js resume --root <worktree>
  ↓
merged into output.system[0]   (never pushed as a new array element)
```

**Single system block.** Everything the plugin contributes — the resume
projection and any pending reconciliation instruction — is appended to the
*first* element of `output.system`, after whatever system content OpenCode
already put there. A new element is created only when OpenCode supplied an
empty array. This is deliberate: OpenCode maps each element of
`output.system` to its own `role: "system"` message for OpenAI-compatible
providers, and LiteLLM-backed endpoints reject any request whose system
message is not the first message
(`litellm.BadRequestError: System message must be at the beginning`). The
plugin therefore never increases the number of system message blocks. Order
is fixed: existing OpenCode system content → resume projection → pending
reconciliation instruction.

The plugin contains no task-state logic of its own. It is a thin adapter that
reuses the canonical CLI installed by step 2 of the installer. The same
Claude-compatible SKILL.md at `.claude/skills/task-store/` is also discovered
by OpenCode as an "external skill" (OpenCode auto-loads SKILL.md files from
both `~/.claude/skills/` and `.claude/skills/`), so no duplicate
`.opencode/skills/` copy is needed.

### OpenCode auto-checkpoint parity

OpenCode supports the same conservative auto-checkpoint mode as Claude Code.
The plugin wires the existing provider-neutral core (`src/autocheckpoint.ts`)
through OpenCode's lifecycle hooks:

| Phase | Claude Code | OpenCode |
|---|---|---|
| Tool activity → dirty | `PostToolUse` shell hook | `tool.execute.after` plugin hook |
| Reconciliation boundary | `Stop` hook (`additionalContext`) | `event({type: "session.idle"})` plugin hook, staging the instruction to `.claude-task/.pending-reconcile-instruction.txt` |
| Instruction delivery | Same call (the `Stop` output channel) | Next `experimental.chat.system.transform` (which consumes the pending file once and merges it into `output.system[0]`) |
| Compaction | `PreCompact` writes history marker | `experimental.session.compacting` registered as a deliberate no-op |

Both harnesses invoke the **same** `task-store auto mark-dirty`,
`task-store auto check`, and `task-store resume` commands, so the dirty
window, the 120-second debounce, and the trust hierarchy embedded in
`RECONCILE_INSTRUCTION` are identical.

> **Compatibility note:** verified against OpenCode 1.18.25. Support relies
> on exactly four plugin hooks — two of which OpenCode currently labels
> experimental: `experimental.chat.system.transform` and
> `experimental.session.compacting`, plus the `event()` bus hook (filtered
> to `session.idle`) and the `tool.execute.after` callback. These are not a
> stable API and OpenCode compatibility is not guaranteed across future
> OpenCode releases: if any of them changes, this adapter needs updating.
> The change is contained to one file, and the plugin source ships with the
> install so you can patch it locally.
>
> The plugin does **not** use `experimental.compaction.autocontinue`. That
> is deliberate — see the compaction paragraph below.

Around automatic compaction: the plugin intentionally does not mutate state
at compaction time. `experimental.session.compacting` is registered as a
no-op — the task store is the source of truth for execution state, and the
next chat call re-injects fresh state via `system.transform`, so execution
continuity does not depend on the conversation summary preserving task-store
state.

To opt out of OpenCode integration in a future install, run
`TASK_STORE_SKIP_OPENCODE=1 ./install.sh /path/to/project`. The Claude Code
side is unaffected.

The plugin's behavior is verified end-to-end by two shell suites that run
the locally installed `opencode` binary:

- `tests/opencode_smoke_test.sh` — resume injection
- `tests/opencode_autockpt_smoke_test.sh` — auto-checkpoint parity

---

## Auto-checkpoint mode

**New stores default to `conservative`.** `task-store init` writes that choice explicitly to `.claude-task/config.json`. Use `task-store init ... --auto-checkpoint off` to opt out. Existing stores with no config file—and stores with missing or invalid configuration—continue to resolve to `off`, so upgrading does not silently change their behavior.

`claude-task-store` covers session boundaries well, but not the middle of a long session. The agent can edit files, run tests and finish milestones without ever calling the CLI, and `.claude-task/state.json` quietly falls behind the repository. Auto-checkpoint is a conservative fix for exactly that drift.

**Primarily, auto-checkpoint is interruption insurance.** It reduces recovery
cost when a session ends unexpectedly — a crash, a timeout, a closed terminal —
before the agent has a chance to update the checkpoint manually. It is not
automatic task management: it never decides that a task is finished, and
completion still requires an explicit `task-store done` with evidence.

> Auto-checkpoint does not try to guess what your code means. It only notices that meaningful work happened and asks the agent to reconcile the checkpoint at a safe boundary.

### Enable / disable

```bash
task-store config auto-checkpoint conservative   # turn it on
task-store config auto-checkpoint off            # turn it off
task-store config auto-checkpoint                # print the current mode
```

The setting lives in `.claude-task/config.json`, alongside your state:

```json
{
  "auto_checkpoint": "conservative"
}
```

`task-store status` always shows it, so you never have to open the file to find out whether it is on:

```
Auto-checkpoint: conservative
⚠  task-store may be stale — 4 change signal(s) since the last checkpoint write.
   Reconcile with: task-store start|done|attempt|block|decide|next
```

Only `off` and `conservative` exist. There is no `aggressive` mode; asking for one is an explicit error rather than a silent fallback.

### How conservative mode works

```
tool activity  →  mark possibly stale   (no task-store write)
                        ↓
             wait for a safe boundary + debounce
                        ↓
          ask the agent to reconcile (one short instruction)
                        ↓
      agent uses the ordinary CLI: start | done | attempt | block | decide | next
                        ↓
        checkpoint changes only if the agent decides it should
```

**Dirty signals** are tool calls that can change repository or execution state. In Claude Code that is a specific matcher list — `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash`. Read-only tools are deliberately excluded, so browsing the codebase never marks anything stale. OpenCode classifies against its own host tool lifecycle instead, excluding its read-only tools (`read`, `glob`, `grep`, `list`, `webfetch`, `websearch`, `skill`, `task`, `question`, `todowrite`) and treating the rest as dirty; the dirty/reconcile semantics it feeds are the same provider-neutral ones. Either way, a dirty signal records two timestamps and a counter. It never writes task state.

**Reconciliation boundaries** are where the checkpoint is allowed to be questioned. The events below are Claude Code's; for OpenCode's `session.idle` boundary and its `system.transform` instruction delivery, see [OpenCode auto-checkpoint parity](#opencode-auto-checkpoint-parity):

| Boundary | What happens | Why |
|----------|--------------|-----|
| `Stop` | Emits the reconciliation instruction to the model as `additionalContext`; the conversation continues so the agent can act on it | The only event that can actually get the agent to reconcile |
| `PreCompact` | Emits the same instruction as custom compact instructions | Compaction is when a stale checkpoint hurts most |
| `SessionEnd` | Warns **you** on stderr that the checkpoint looks stale | This event has no channel back to the model — the session is already over |

**Debounce.** A boundary asks only when *both* gates open: new work has arrived since the last request, **and** at least 120 seconds have passed since it. So a burst of fifty edits produces exactly one request, and a rapid back-and-forth does not carry a nag on every turn. No timers, no background processes — just two timestamps compared on demand.

**Freshness** is derived, not scanned. Because every CLI write bumps `state.updated_at`, "stale" simply means *work was signalled and the checkpoint has not been written since*. There is no repository scan, no diffing, and no dependency on Git — it works in a project with no version control at all. It is a hint, never a claim of certainty, which is why the wording is always "may be stale".

### What it will never do

Auto-checkpoint **never mutates your task state.** It emits an instruction; the agent decides. Specifically forbidden, by design rather than by convention:

- ❌ file changed → task done
- ❌ tests passed → related task done
- ❌ commit exists → milestone complete
- ❌ inventing a `next_action`, decision, or blocker

A file edit or a passing test is *evidence that work happened*, not proof that a task is complete. Completion still requires an explicit `task-store done` with evidence, exactly as it does with the feature off. The trust hierarchy is unchanged, and the injected instruction restates it verbatim:

```
repository / tests  >  git state  >  task-store  >  model memory
```

### Cost when off

Zero writes and no Node process. When auto-checkpoint is off—including in a configless legacy project—the hooks bail out in bash before spawning anything. Each matched tool call in conservative mode spawns one short-lived Node process to record the signal.

### Provider neutrality

The core knows nothing about Claude Code event names. Adapters map their own lifecycle onto three verbs — `markDirty()`, `shouldReconcile()`, `markReconciled()` — in [`src/autocheckpoint.ts`](src/autocheckpoint.ts). That is the entire extension surface. The OpenCode adapter reuses the same config file and the same behavior without touching the core.

---

## Cross-agent use

The state format is model-neutral. Any agent that can run shell commands can read and update the checkpoint using the CLI alone — no Claude Code skills or hooks required.

Validated: Claude Code ↔ Codex handoffs in both directions. See [`docs/phase3-cross-agent-handoff.md`](docs/phase3-cross-agent-handoff.md).

Claude Code and OpenCode can both resume from the same execution checkpoint: the
CLI runtime, state schema, resume renderer, and trust hierarchy are shared, and
the only host-specific code is the thin adapter (Claude Code hooks vs the
OpenCode plugin). Handoff between hosts is therefore just "open the same
project in the other host"; the state in `.claude-task/state.json` is the
bridge, with no extra migration step.

---

## Not another memory system

`claude-task-store` is intentionally not:

- **Conversation memory** — it does not store what was said
- **RAG or semantic search** — no embeddings, no vector database
- **Long-term knowledge base** — not designed for "what do I know about X?"
- **Project management** — no kanban, no sprint planning, no issue tracker
- **Workspace manager** — does not create worktrees or isolated task environments
- **Agent orchestration** — no multi-agent coordination or routing
- **Workflow framework** — does not drive sequences of agent actions
- **Cloud service** — everything stays on your local filesystem

**Execution continuity without the workflow system.**

If you do not need a workspace manager, do not create one. claude-task-store is a checkpoint underneath your existing workflow — not a replacement for it.

| | claude-memory / context-memory | **claude-task-store** |
|--|--|--|
| Question answered | "What do I know about X?" | "Where am I in this task?" |
| Storage | SQLite + vector embeddings | Plain JSON files |
| Retrieval | Semantic search | Direct file read |
| Dependencies | sqlite-vec, embeddings | Node.js only |
| Token injection | Variable (relevant facts) | Compact fixed-structure summary |
| Update trigger | Session end (all turns) | Meaningful milestones only |
| Task tracking | ✗ | ✓ |
| Failure recording | ✗ | ✓ |
| Evidence required | ✗ | ✓ |
| Git-committable | Awkward | Native |

See [`DESIGN.md`](DESIGN.md) for full analysis.

---

## Related projects

Several projects solve adjacent problems. This is a known area with multiple active approaches:

- [**ddaanet/handoff**](https://github.com/ddaanet/handoff) — A minimal task-frame bridge for Claude Code. Best suited when the core need is preserving the active task context across `/clear` or `/compact` within a single Claude Code project. No per-project setup required.

- [**joeeeeey/task-workspace**](https://github.com/joeeeeey/task-workspace) — Isolated task environments with dedicated worktrees, `AGENTS.md`, `goal.md`, `decisions.md`, and `status.md`. Better suited when the work requires per-task isolation, artifact tracking, and structured multi-day agent sessions.

- [**stefan-jansen/coding-agent-toolkit**](https://github.com/stefan-jansen/coding-agent-toolkit) — A structured idea-to-PR workflow using GitHub issues/milestones as the canonical state machine. Better suited when adopting a spec-first engineering process with explicit handoff assertions and GitHub integration.

- [**jonmmease/jons-plan**](https://github.com/jonmmease/jons-plan) — A full workflow engine with typed phases, artifact systems, parallel subagents (Opus + Codex CLI), and a `/jons-plan` slash interface. Better suited for sophisticated multi-session planning workflows.

**claude-task-store** targets a different point in this space: execution continuity without workflow adoption. It requires no worktree setup, no GitHub integration, no new process model — just a small durable checkpoint that keeps any coding agent oriented across session boundaries.

---

## State schema

```json
{
  "version": "1",
  "revision": 5,
  "goal": "Add OAuth support",
  "status": "active | blocked | completed | archived",
  "current_task": "T4",
  "tasks": [
    {
      "id": "T4",
      "title": "Write integration tests",
      "status": "blocked",
      "notes": "need local HTTP fixture before streaming test works",
      "evidence": [],
      "attempts": [
        { "description": "mocked fetch", "outcome": "does not support streaming" }
      ]
    }
  ],
  "decisions": [{ "summary": "Use PKCE flow — implicit flow deprecated", "rationale": "..." }],
  "blockers": [{ "description": "need local HTTP fixture", "task_id": "T4" }],
  "next_action": "Replace mock with local HTTP fixture, then complete T4",
  "updated_by": "claude-code",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-02T00:00:00Z"
}
```

Full JSON schema: [`schemas/state.schema.json`](schemas/state.schema.json)

---

## Git integration

**Recommended:** commit `state.json`, ignore `history.jsonl`.

```bash
git add .claude-task/state.json
git commit -m "chore: update task checkpoint"
# history.jsonl is already in .gitignore
```

This enables another developer or model to resume the task from git alone.

Options:
- **Commit state.json** ← Recommended for cross-session/cross-model handoffs
- **Gitignore everything** — For private or transient work
- **Commit both** — Full audit trail in git (history.jsonl grows unbounded)

`.claude-task/config.json` is yours and is committable — commit it to share the project's auto-checkpoint choice. `.claude-task/auto-checkpoint.json` is ephemeral machine-local bookkeeping (dirty/debounce timestamps) and is gitignored by the installer.

---

## Security and limitations

- State files are injected into the agent's context (Claude Code or OpenCode). Treat `.claude-task/state.json` with the same trust as other project config. A malicious state file could inject arbitrary text into the AI context (prompt injection).
- No network requests are made. All state is local.
- Concurrent `task-store` CLI invocations are serialized by an O_EXCL lock file around each command's full read-modify-write cycle; `--expect-rev` makes this an atomic compare-and-write (not last-writer-wins) against other CLI callers. Direct library callers that bypass `withStoreLock()` are not protected. See [`SECURITY.md`](SECURITY.md).
- Evidence (`-e` values) is kept as a plain string array end-to-end — no delimiter-based joining/splitting — so evidence text may safely contain commas, quotes, or other special characters.
- Evidence paths in state.json are claims, not verified proofs. The trust hierarchy is: repository/tests > git state > task-store > model memory.

See [`SECURITY.md`](SECURITY.md) for full details.

---

## Development

```bash
npm install
npm run build
npm run typecheck                  # tsc --noEmit on src/ AND opencode-plugin/
npm test                           # Unit tests
bash tests/acceptance.sh           # Cross-session recovery test
bash tests/phase2/pressure_test.sh # 22-session pressure test
bash tests/phase3/handoff_test.sh  # Cross-agent handoff test
bash tests/autocheckpoint_test.sh  # Auto-checkpoint mode regression
bash tests/opencode_install_test.sh     # OpenCode install/uninstall regression
bash tests/opencode_smoke_test.sh       # Real OpenCode resume-injection smoke
bash tests/opencode_autockpt_smoke_test.sh # Real OpenCode auto-checkpoint smoke
```

The OpenCode smoke tests need a working `opencode` binary on `PATH`. They
skip cleanly (`exit 77`) if it isn't installed; the other suites are pure
shell and run anywhere.

530 automated checks pass across 17 test files: 3 Jest and 14 shell
— unit 134, acceptance 17, Phase 2 reliability 52, Phase 3 handoff 22,
installer regression 17, path safety 32, project-local runtime 32,
auto-checkpoint 66, OpenCode install regression 117, OpenCode resume smoke 21,
OpenCode auto-checkpoint smoke 20.

CI runs every suite on Node 18/20/22 **except** the two real-OpenCode smoke
suites: GitHub runners have no `opencode` binary, so those two steps report
themselves as skipped. The 41 checks they contribute are verified locally
against an installed OpenCode, not by CI.

---

## License

[Mozilla Public License 2.0](LICENSE) — see [`LICENSE`](LICENSE)

- **Commercial use is allowed.** You may use and integrate claude-task-store in commercial and proprietary projects without restriction.
- **Proprietary projects are not affected.** If you use claude-task-store as a tool or integrate it into a Larger Work, your proprietary code is not subject to MPL-2.0.
- **Source file modifications remain MPL-2.0.** If you modify any MPL-covered source files in this repository, those modified files must be made available under MPL-2.0.

See the [MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) for details.
