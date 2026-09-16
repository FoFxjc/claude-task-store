# claude-task-store

Persistent execution checkpoints for Claude Code, OpenCode, and other coding agents.

**Your context window should not be your task lifetime.**

Long coding tasks often outlive one model session. The code survives in the repository; what gets lost is the small amount of execution state needed to continue efficiently:

- what the goal is
- what is already done
- what is active or blocked
- what failed and why
- which decisions constrain the work
- what should happen next

claude-task-store keeps that state in plain local files and injects a compact resume projection when a supported coding session starts.

**Plain JSON · Local-first · No cloud · No embeddings · No database · No workflow framework**

[![License: MPL 2.0](https://img.shields.io/badge/License-MPL_2.0-brightgreen.svg)](LICENSE)
[![CI](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml/badge.svg)](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml)

---

## The idea

A fresh session usually does not need the previous transcript. It needs a checkpoint.

Without one:

```
long task
→ context fills / session ends / model changes
→ reread repository
→ reconstruct prior work
→ rediscover failed approaches
→ continue
```

With claude-task-store:

```
long task
→ checkpoint
→ fresh session
→ small resume projection
→ continue from next_action
```

A typical injected projection looks like:

```
GOAL: Add OAuth support to the API

CURRENT:
  ▶ [T4] Write integration tests
    ✗ tried: mocked fetch → does not support streaming responses

DONE:
  ✓ [T1] Database schema migration
  ✓ [T2] Callback route
  ✓ [T3] Token validation

KEY DECISIONS:
  • Use PKCE flow — implicit flow deprecated in OAuth 2.1

NEXT ACTION: Replace mock with local HTTP fixture, then complete T4
```

The default resume projection is intentionally bounded to **under 400 tokens**. Older history stays outside the default prompt and is loaded only when needed.

This is execution continuity, not conversation memory.

---

## Quick start

### Let your coding agent install it

Give your agent this instruction:

> Install `https://github.com/FoFxjc/claude-task-store` into this repository and follow `docs/agent-installation.md`.

The installation runbook is written for coding agents and keeps repository inspection bounded.

### Manual install

Prerequisites: Node.js 18+, `python3`, and Claude Code and/or OpenCode.

```bash
git clone https://github.com/FoFxjc/claude-task-store.git
cd claude-task-store
npm install
npm run build

./install.sh /path/to/your/project
```

The project-local runtime is installed under `.claude/task-store/`; your application dependencies and `package.json` are not modified.

To uninstall the integration while keeping task state:

```bash
./uninstall.sh /path/to/your/project
```

See [docs/agent-installation.md](docs/agent-installation.md) for the exact installation contract.

---

## Use it

Initialize a goal and a few tasks:

```bash
task-store init "Implement OAuth for the API" \
  "Database schema migration" \
  "Callback route" \
  "Token validation" \
  "Integration tests"
```

Track only meaningful execution state:

```bash
task-store start T1

task-store done T1 \
  -e db/migrations/001_oauth.sql \
  -e "npm test: 8/8 pass"

task-store attempt T4   "mocked fetch"   "does not support streaming responses"

task-store decide   "Use PKCE flow"   "implicit flow is deprecated in OAuth 2.1"

task-store next   "Replace mock with local HTTP fixture, then complete T4"
```

Inspect the checkpoint or the compact projection:

```bash
task-store status
task-store resume
task-store show T4
```

For parallel areas of work in the same repository, use named topics:

```bash
task-store topic add docs "Refresh API guide" "Draft examples" "Review links"
task-store topic use docs
task-store topic list
```

Run `task-store --help` for the complete CLI surface.

---

## What gets stored

The durable checkpoint lives in `.claude-task/`:

```
.claude-task/
├── state.json               # execution checkpoint; safe to commit
├── history.jsonl            # append-only local history
├── config.json              # project-local configuration
├── auto-checkpoint.json     # ephemeral freshness bookkeeping
└── attachment.json          # ephemeral auto-checkpoint session owner
```

Only `state.json` is needed to resume the work.

Recommended Git policy:

- commit `.claude-task/state.json` for cross-session / cross-model handoff
- commit `.claude-task/config.json` if the project should share its auto-checkpoint choice
- leave history, runtime bookkeeping, and session attachment local

The installer configures the ephemeral files accordingly.

---

## Repository reality wins

The task store is a navigation checkpoint, not an authoritative record.

```
repository / tests
      >
   git state
      >
  task-store
      >
 model memory
```

If the checkpoint says a task is done but the repository or tests disagree, the repository wins.

For this reason:

- `task-store done` requires evidence
- auto-checkpoint never marks a task complete
- failed approaches and decisions are recorded explicitly instead of inferred from tool activity

---

## Auto-checkpoint

New stores default to **conservative auto-checkpoint**. Existing configless stores remain off until explicitly enabled.

```bash
task-store config auto-checkpoint conservative
task-store config auto-checkpoint off
task-store config auto-checkpoint
```

Conservative mode does not manage tasks for you. It only notices that meaningful work happened and, at a safe boundary, asks the agent to reconcile the checkpoint.

```
tool activity
→ mark checkpoint possibly stale
→ wait for a safe boundary + debounce
→ ask the agent to reconcile
→ agent decides whether ordinary task-store state should change
```

It will never infer:

- file changed → task done
- tests passed → task done
- commit exists → milestone complete
- a next action, blocker, or decision

Those remain explicit checkpoint claims.

### Session attachment

Auto-checkpoint is **session-intent-scoped**.

Opening another terminal or coding-agent session in the same repository does not automatically give that session authority over the active checkpoint. A fresh session is asked whether it should continue the existing task-store work.

- **Yes** → the session attaches and auto-checkpoint operates normally.
- **No** → the session stays detached; ordinary repository work and manual task-store commands still work, but automatic dirty/reconciliation signals are ignored.
- **Another session already owns it** → takeover requires explicit confirmation.

Only one session owns the automatic flow at a time.

This is deliberately an intent boundary, not a session manager: there is no TTL, heartbeat, automatic takeover, session history, or multi-owner orchestration.

Turning auto-checkpoint off clears the ephemeral runtime, attachment, and staged reconciliation state.

---

## Claude Code and OpenCode

Both hosts use the same state schema, resume renderer, CLI, trust hierarchy, and provider-neutral auto-checkpoint core.

| Capability | Claude Code | OpenCode |
|---|---|---|
| Resume injection | `SessionStart` hook | auto-discovered plugin |
| Dirty signal | `PostToolUse` | `tool.execute.after` |
| Reconciliation boundary | `Stop` | `session.idle` |
| Session identity | hook `session_id` | hook/event `sessionID` |
| State format | same | same |
| CLI | same | same |

The adapters are intentionally thin. Any agent with shell access can use the same checkpoint through the CLI, including Codex or another coding harness.

OpenCode compatibility is validated against OpenCode 1.18.25. Its adapter depends on experimental plugin hooks, so future OpenCode releases may require an adapter update.

---

## Cross-agent handoff

No migration is required when changing agents.

A handoff can be as small as:

```bash
task-store status
task-store resume
```

Then open the same repository in another agent.

Optional provenance and concurrency controls:

```bash
task-store start T1 --by claude-code
task-store done T1 --by codex -e "npm test: pass"

task-store next "Implement parser" --expect-rev 14
```

`--expect-rev` provides atomic compare-and-write protection against concurrent CLI writers.

For larger atomic updates, see [docs/batch-commit.md](docs/batch-commit.md).

---

## What this is not

claude-task-store intentionally does **not** try to become:

- conversation memory
- RAG or semantic search
- a long-term knowledge base
- a project-management system
- a worktree/workspace manager
- an agent orchestrator
- a workflow engine
- a cloud service

If you need those things, use a system designed for them.

This project does one small job: **keep a coding task resumable without keeping the whole conversation alive.**

For design rationale and comparison with adjacent approaches, see [DESIGN.md](DESIGN.md).

---

## Architecture

```
coding host
   │
   ├── Claude Code hooks
   └── OpenCode plugin
           │
           ▼
     task-store CLI
           │
           ▼
     .claude-task/state.json
```

The CLI is the interoperability boundary. Host integrations adapt lifecycle events to the same core rather than implementing task semantics themselves.

The state model supports named topics, tasks, evidence, failed attempts, blockers, decisions, and an explicit next action.

Full schema: [schemas/state.schema.json](schemas/state.schema.json)

---

## Useful docs

| Document | Purpose |
|---|---|
| [docs/agent-installation.md](docs/agent-installation.md) | Safe installation runbook for coding agents |
| [DESIGN.md](DESIGN.md) | Design rationale, scope, and adjacent projects |
| [SECURITY.md](SECURITY.md) | Trust model and security considerations |
| [docs/batch-commit.md](docs/batch-commit.md) | Atomic batch checkpoint updates |
| [docs/phase2-reliability-report.md](docs/phase2-reliability-report.md) | Reliability experiments |
| [docs/phase3-cross-agent-handoff.md](docs/phase3-cross-agent-handoff.md) | Cross-agent handoff validation |

---

## Development

```bash
npm install
npm run build
npm run typecheck
npm test

bash tests/acceptance.sh
bash tests/autocheckpoint_test.sh
bash tests/multi_topic_test.sh
bash tests/phase3/handoff_test.sh
bash tests/opencode_install_test.sh
bash tests/opencode_smoke_test.sh
bash tests/opencode_autockpt_smoke_test.sh
```

CI runs the full regression matrix on Node 18, 20, and 22. The OpenCode smoke suites use a real local `opencode` binary when available.

---

## Security

State is injected into an agent's context, so treat `.claude-task/state.json` with the same trust as other repository configuration.

The tool makes no network requests. CLI mutations are serialized with a project-local lock, and optimistic revision checks are available through `--expect-rev`.

See [SECURITY.md](SECURITY.md) for the full threat model and guarantees.

---

## License

[Mozilla Public License 2.0](LICENSE).

Commercial and proprietary use is allowed. MPL-covered source files that you modify remain subject to MPL-2.0.
