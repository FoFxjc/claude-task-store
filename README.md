# claude-task-store

**Persistent execution checkpoints for Claude Code.**  
Resume long coding tasks across sessions and models without replaying the full conversation.

**Plain JSON · Local-first · <400-token resume state · No cloud · No embeddings · Model-neutral**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml/badge.svg)](https://github.com/FoFxjc/claude-task-store/actions/workflows/ci.yml)

Claude Code and smaller-context models often lose execution state during context compaction, session restarts, model switching, or long multi-step implementations. `claude-task-store` is a lightweight external process store that acts as a **durable working memory checkpoint**.

This is **not** a general-purpose long-term memory system, not a vector database, and not a project management tool. It answers exactly six questions:

1. What am I trying to achieve?
2. What has already been done?
3. What am I doing now?
4. What remains?
5. What failed or was tried already?
6. What should the next model/session do next?

## How It Works

State lives in two plain files in your project:

```
.claude-task/
├── state.json      ← Human-readable, git-committable execution checkpoint
└── history.jsonl   ← Append-only audit trail (optional to commit)
```

At session start, a compact summary (normally < 400 tokens) is automatically injected into Claude's context. Claude reads the current task, done work, and the explicit next action — and continues without re-reading transcripts.

## Installation

### Prerequisites
- Node.js ≥ 18
- Claude Code (latest)
- `python3` (for fallback hooks if Node.js CLI unavailable)

### Install

```bash
git clone https://github.com/FoFxjc/claude-task-store.git
cd claude-task-store
npm install
npm run build

# Install into your project (pass project root as argument)
./install.sh /path/to/your/project
```

Or install globally:

```bash
npm install -g .
```

The installer:
1. Builds the TypeScript CLI
2. Copies the skill to `.claude/skills/task-store/SKILL.md`
3. Copies hook scripts to `.claude/hooks/scripts/`
4. Merges hook config into `.claude/settings.json`
5. Updates `.gitignore`

### Uninstall

```bash
./uninstall.sh /path/to/your/project
```

## Quick Start

```bash
# Initialize with a goal and tasks
task-store init "Implement authentication for the web app" \
  "Create User model with password hashing" \
  "Implement JWT token generation" \
  "Add login/logout endpoints" \
  "Write integration tests"

# Start working on the first task
task-store start T1

# ... do the work ...

# Mark done with evidence (evidence is required)
task-store done T1 -e src/models/user.ts -e "npm test: 15/15 pass"

# Record a failed approach to prevent future repetition
task-store attempt T2 "express-session" "conflicts with JWT stateless design"

# Mark blocked
task-store block T2 "JWT secret rotation policy needs team clarification"

# Always set next action before ending a session
task-store next "Clarify JWT rotation with team, then implement /auth/login"
```

On next session start, Claude receives:

```
╔══════════════════════════════════════╗
║  TASK STORE — RESUME CONTEXT         ║
╚══════════════════════════════════════╝

GOAL: Implement authentication for the web app
STATUS: BLOCKED

CURRENT:
  ▶ [T2] Implement JWT token generation
    NOTE: JWT secret rotation policy needs team clarification
    ✗ tried: express-session → conflicts with JWT stateless design

DONE:
  ✓ [T1] Create User model with password hashing

REMAINING:
  ○ [T3] Add login/logout endpoints
  ○ [T4] Write integration tests

NEXT ACTION: Clarify JWT rotation with team, then implement /auth/login
```

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
task-store start T1 --by claude-code      # record which agent is writing
task-store done T1 --by codex -e proof    # handoff provenance (informational only)
task-store next "action" --expect-rev 14  # reject write if another agent wrote first
```

## Claude Code Skill

The `/task-store` skill is automatically available after installation. Claude uses it when:
- Starting a long-running task
- After meaningful milestones
- When encountering blockers
- Before ending a session

You can invoke it directly: `/task-store`

## Hooks

Three hooks are installed automatically:

| Hook | Event | Action |
|------|-------|--------|
| `session-start.sh` | `SessionStart` | Injects compact resume context if state exists |
| `pre-compact.sh` | `PreCompact` | Saves a compaction checkpoint to history |
| `session-end.sh` | `SessionEnd` | Warns if `next_action` is not set |

## State Schema

```json
{
  "version": "1",
  "revision": 5,
  "goal": "Build X",
  "status": "active | blocked | completed | archived",
  "current_task": "T2",
  "tasks": [
    {
      "id": "T1",
      "title": "...",
      "status": "pending | in_progress | blocked | done | skipped",
      "notes": "...",
      "evidence": ["src/file.ts", "tests pass"],
      "attempts": [
        { "description": "tried X", "outcome": "failed because Y" }
      ]
    }
  ],
  "decisions": [{ "summary": "Use JWT over sessions", "rationale": "..." }],
  "blockers": [{ "description": "...", "task_id": "T2" }],
  "next_action": "Implement /auth/login endpoint",
  "updated_by": "claude-code",
  "created_at": "2024-01-01T00:00:00Z",
  "updated_at": "2024-01-02T00:00:00Z"
}
```

Full JSON schema: [`schemas/state.schema.json`](schemas/state.schema.json)

## Git Integration

**Recommended (cross-session handoff):**
```bash
# Commit state.json so another model/developer can resume
git add .claude-task/state.json
git commit -m "chore: update task state"

# Keep history.jsonl out of git (it's verbose)
# Already added to .gitignore by the installer
```

Options:
- **A. Commit state.json** ← Recommended for team/cross-model handoffs
- **B. Gitignore everything** — For private/noisy work
- **C. Commit both** — Full audit trail in git

## Token Budget

The injected resume context is designed to stay compact:

| Scenario | Chars | Tokens (est.) |
|----------|-------|---------------|
| Typical 5-task project | ~600 | ~150 |
| 15-task project with history | ~1200 | ~300 |
| Hard cap | 3200 | 800 |

Decisions: only the last 3 are injected. Attempts: only the last 2 per task.

## Comparison with Existing Memory Plugins

| | claude-memory / context-memory | **claude-task-store** |
|--|--|--|
| Question answered | "What do I know about X?" | "Where am I in this task?" |
| Storage | SQLite + vector embeddings | Plain JSON files |
| Retrieval | Semantic search | Direct file read |
| Dependencies | sqlite-vec, embeddings | Node.js only (Python fallback) |
| Token injection | Variable (relevant facts) | Compact fixed-structure summary |
| Update trigger | Session end (all turns) | Meaningful milestones only |
| Task tracking | ✗ | ✓ |
| Failure recording | ✗ | ✓ |
| Evidence required | ✗ | ✓ (prevents false completions) |
| Git-committable | Awkward | Native |

See [`DESIGN.md`](DESIGN.md) for full analysis.

## Development

```bash
npm install
npm run build
npm test                           # Unit tests (31)
bash tests/acceptance.sh           # Cross-session recovery test
bash tests/phase2/pressure_test.sh # 22-session pressure test
bash tests/phase3/handoff_test.sh  # Cross-agent handoff test
```

## Security

See [`SECURITY.md`](SECURITY.md).

## License

MIT