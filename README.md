# claude-task-store

Persistent execution checkpoints for Claude Code and coding agents.

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

**Use smaller models for longer tasks.**

> This improves continuity and reduces repeated orientation work. It does not make a weaker model equivalent to a stronger one, and it does not remove the need for context on the current task.

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

Measured across 203 automated test scenarios:

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

At session start, a compact summary is automatically injected into Claude's context via a `SessionStart` hook. Claude reads the current task, completed work, failed approaches, and the explicit next action — and continues without re-reading transcripts.

---

## Installation

**Prerequisites:** Node.js ≥ 18, Claude Code, `python3`

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

Start Claude Code in that project and the full resume projection is injected at
session start.

The installer:
1. Builds the TypeScript CLI
2. Copies the built runtime to `.claude/task-store/` (the CLI has no runtime dependencies)
3. Copies the skill to `.claude/skills/task-store/SKILL.md`
4. Copies hook scripts to `.claude/hooks/scripts/`
5. Merges hook config into `.claude/settings.json` — only claude-task-store's own hook entries are ever added or removed (matched by exact command path, not substring), so any other hooks you or another plugin registered for `SessionStart`/`PreCompact`/`SessionEnd` are left untouched. A backup is written to `.claude/settings.json.bak` before each rewrite.
6. Updates `.gitignore`

The `SessionStart` hook resolves the CLI in this order:

1. the project-local runtime at `.claude/task-store/` (installed above)
2. `task-store` on `PATH`
3. a minimal goal/next-action fallback, used only when neither is available
   (for example, if Node is missing) and clearly labelled as such

**Optional — `task-store` on your PATH.** Only needed if you want to run the CLI
by hand from any directory; the hooks never require it:

```bash
TASK_STORE_INSTALL_GLOBAL=1 ./install.sh /path/to/your/project
# or, any time:  npm install -g .
```

**Uninstall:**
```bash
./uninstall.sh /path/to/your/project
```
Uninstalling backs up `.claude/settings.json` to `.claude/settings.json.bak` first and removes only claude-task-store's own hook entries, in the same exact-match-safe way as install. It also removes the project-local runtime at `.claude/task-store/`, but only after confirming that directory carries claude-task-store's own marker. Your task state in `.claude-task/` is left in place.

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

On next session start (or in a fresh model session), Claude automatically receives the compact resume context shown above.

---

## Commands

| Command | Description |
|---------|-------------|
| `task-store init "<goal>" [tasks...]` | Initialize a new task store |
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

After installation, three hooks run automatically:

| Hook | Event | Action |
|------|-------|--------|
| `session-start.sh` | `SessionStart` | Injects compact resume context if state exists |
| `pre-compact.sh` | `PreCompact` | Saves a checkpoint to history before compaction |
| `session-end.sh` | `SessionEnd` | Warns if `next_action` is not set |

The `/task-store` skill is also installed. Claude uses it when starting long-running tasks, after milestones, and before ending sessions. Invoke directly with `/task-store`.

---

## Cross-agent use

The state format is model-neutral. Any agent that can run shell commands can read and update the checkpoint using the CLI alone — no Claude Code skills or hooks required.

Validated: Claude Code ↔ Codex handoffs in both directions. See [`docs/phase3-cross-agent-handoff.md`](docs/phase3-cross-agent-handoff.md).

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

---

## Security and limitations

- State files are injected into Claude's context. Treat `.claude-task/state.json` with the same trust as other project config. A malicious state file could inject arbitrary text into the AI context (prompt injection).
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
npm test                           # Unit tests (31)
bash tests/acceptance.sh           # Cross-session recovery test
bash tests/phase2/pressure_test.sh # 22-session pressure test
bash tests/phase3/handoff_test.sh  # Cross-agent handoff test
```

203 automated checks pass across unit, acceptance, and integration test suites
(unit 31, acceptance 17, Phase 2 reliability 52, Phase 3 handoff 22, installer
regression 17, path safety 32, project-local runtime 32). CI runs all of them
on Node 18/20/22.

---

## License

[Mozilla Public License 2.0](LICENSE) — see [`LICENSE`](LICENSE)

- **Commercial use is allowed.** You may use and integrate claude-task-store in commercial and proprietary projects without restriction.
- **Proprietary projects are not affected.** If you use claude-task-store as a tool or integrate it into a Larger Work, your proprietary code is not subject to MPL-2.0.
- **Source file modifications remain MPL-2.0.** If you modify any MPL-covered source files in this repository, those modified files must be made available under MPL-2.0.

See the [MPL 2.0 FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) for details.
