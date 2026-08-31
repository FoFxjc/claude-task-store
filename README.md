# claude-task-store

Persistent execution checkpoints for Claude Code and coding agents.

Keep long-running coding tasks on track across session restarts, context compaction, and model switching — without replaying the full conversation.

**Use smaller models for longer tasks.**

Plain JSON · Local-first · No cloud · No embeddings · No database · No workflow framework

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml/badge.svg)](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml)

---

## Why this exists

Large coding sessions accumulate context quickly. When a session restarts, compacts, or switches models, the next agent often spends tokens rediscovering:

- what was already implemented
- what was attempted and failed
- which architectural decisions were made
- what task should happen next

This is especially costly for smaller-context or lower-cost models that cannot afford to carry long execution histories.

`claude-task-store` treats context as expensive.

Instead of storing conversation history, it keeps a tiny durable execution checkpoint — only the state needed to continue working.

**Without task-store:**
```
Fresh agent
→ re-reads repository
→ reconstructs what was done
→ may retry already-failed approaches
→ spends thousands of tokens regaining orientation
```

**With task-store:**
```
Fresh agent
→ reads .claude-task/state.json  (one file)
→ receives ~100–300 token resume summary
→ continues from next_action
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

## Why smaller models benefit

A smaller-context or lower-cost model may be fully capable of executing a focused local coding task. What degrades reliability is carrying the full weight of prior session history.

`claude-task-store` externalizes execution state so the model can spend its context budget on:

- the current code
- the current task
- immediate reasoning

rather than reconstructing what happened three sessions ago.

> **Note:** This improves continuity and reduces repeated orientation work. It does not make a weaker model equivalent to a stronger one.

---

## Validated results

Measured across automated test scenarios (122 checks pass):

| Scenario | Resume context |
|----------|---------------:|
| 22-session pressure test (max) | 148 tokens |
| 30+ completed tasks (decay test) | 267 tokens |
| Claude → Codex handoff | 299 tokens |
| Codex → Claude handoff | ~190 tokens |

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

Or globally:

```bash
npm install -g .
```

The installer:
1. Builds the TypeScript CLI
2. Copies the skill to `.claude/skills/task-store/SKILL.md`
3. Copies hook scripts to `.claude/hooks/scripts/`
4. Merges hook config into `.claude/settings.json`
5. Updates `.gitignore`

**Uninstall:**
```bash
./uninstall.sh /path/to/your/project
```

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

## What this is not

`claude-task-store` is intentionally not:

- **Conversation memory** — it does not store what was said
- **RAG or semantic search** — no embeddings, no vector database
- **Long-term knowledge base** — not designed for "what do I know about X?"
- **Project management** — no kanban, no sprint planning, no issue tracker
- **Workspace manager** — does not create worktrees or isolated task environments
- **Agent orchestration** — no multi-agent coordination or routing
- **Workflow framework** — does not drive sequences of agent actions
- **Cloud service** — everything stays on your local filesystem

Conversation memory asks: *"What happened before?"*  
`claude-task-store` asks: *"What is the minimum state required to keep working?"*

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

**claude-task-store** targets a different point in this space: a small, drop-in execution checkpoint that requires no workflow adoption, no worktree setup, and no GitHub integration — just a file that keeps any coding agent oriented across session boundaries.

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
- Concurrent agent sessions: last-writer-wins by default. Use `--expect-rev` for conflict detection.
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

122 automated checks pass across unit, acceptance, and integration test suites.

---

## License

MIT — see [`LICENSE`](LICENSE)
