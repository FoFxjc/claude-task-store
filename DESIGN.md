# claude-task-store: Design Document

## What Already Exists

### Claude Code's Built-in Memory

Claude Code provides `CLAUDE.md` for persistent project instructions and **auto memory** for accumulating learnings. These load at session start and give Claude background knowledge. However, they are:
- **Static reference documents**, not dynamic execution state
- Designed for facts and conventions, not in-progress task tracking
- Loaded in full every session regardless of relevance (cost overhead)
- Not structured for "where am I in a multi-step task right now?"

### Existing Memory and Checkpoint Projects

**General memory systems** (claude-memory, context-memory, similar):
- Focus on long-term knowledge accumulation (facts, code patterns, preferences)
- Use embeddings + vector search to retrieve relevant context
- Retrieve *relevant past knowledge*, not *current execution state*
- Add significant dependencies (vector DBs, embedding models)
- Designed for "what do I know about X?" not "what was I doing?"

**[ddaanet/handoff](https://github.com/ddaanet/handoff)**:
- A Claude Code-specific task-frame bridge for the `/clear` and `/compact` boundaries
- Stores a single `.claude/handoff-task.md` with the current task frame and open decisions
- Narrowly scoped: session boundary only, no per-project setup required
- Does not track structured tasks, evidence, failed approaches, or decisions across multiple sessions

**[joeeeeey/task-workspace](https://github.com/joeeeeey/task-workspace)**:
- Per-task isolated environments: dedicated worktrees, `goal.md`, `status.md`, `decisions.md`
- Works with Claude Code and Codex; task history is local by default (`.gitignored`)
- Solves a different problem: task isolation and environment management for multi-day work
- Does not target small-context optimization or compact injection

**[stefan-jansen/coding-agent-toolkit](https://github.com/stefan-jansen/coding-agent-toolkit)**:
- Structured idea-to-PR workflow with GitHub as the canonical state machine
- Seven sequential steps writing to `.workspace/`; handoff files contain inline assertions
- Dual Claude/Codex support; GitHub issues/milestones are the persistent record
- Broader scope than an execution checkpoint: requires GitHub, structured workflow adoption

**[jonmmease/jons-plan](https://github.com/jonmmease/jons-plan)**:
- Full workflow engine: typed phases, artifact tracking, parallel subagents, slash interface
- Claude Code v2.1.3+, optional `uv`, optional `graphviz`; significant complexity
- Directly represents the scope that claude-task-store avoids in v1
- Useful reference for what to deliberately not build

**Project Brain / CodeMemory / OpenLTM**:
- Codebase indexing and long-term code pattern memory
- Retrieval-based, not checkpoint-based
- Designed for knowledge recall, not execution resumption

## The Gap This Project Fills

The problem is **execution state loss**, not knowledge loss:

| Situation | What Fails | What's Needed |
|-----------|-----------|---------------|
| Context compaction | Claude loses track of current task and what was tried | An external checkpoint: "I'm on T3, T1+T2 done, T3 failed approach A" |
| Session restart | Claude starts fresh, re-reads files, re-discovers what was done | A resume summary: goal + done + blocked + next |
| Model switch | New model has no conversation history | A structured handoff with decisions and state |
| Long agentic loop | Model drifts from original goal | An anchor: "this is what we're building, these constraints apply" |

**Existing memory systems don't solve this** because they're optimized for "what do I know?" not "where am I?" They use semantic retrieval, which requires large dependencies, and retrieve historical facts rather than current-session execution state.

## Why a Task-Process Store is Different from Long-Term Memory

| Dimension | Long-Term Memory | Task-Process Store (this project) |
|-----------|-----------------|-----------------------------------|
| **Question answered** | "What do I know about X?" | "What am I doing and where am I?" |
| **Retention** | Permanent, accumulated over months | Session/task scoped, archived on completion |
| **Retrieval** | Semantic search (embeddings) | Direct read of current state file |
| **Update frequency** | After significant learnings | After meaningful milestones (~5-10x per session) |
| **Dependencies** | Vector DB, embedding model, API | None (plain JSON file) |
| **Injection** | Relevant facts on-demand | Compact summary at session start |
| **Token budget** | Variable, can be large | Target < 400 tokens, hard cap 800 |
| **Structure** | Unstructured or semi-structured | Strict schema: goal, tasks, blockers, next action |
| **Audience** | Future sessions retrieving knowledge | The *next model instance resuming this work* |

## Design Principles

1. **Preserve only state expensive or ambiguous to reconstruct** — Don't store conversation, don't store code, don't store file contents. Only store what the agent cannot cheaply derive from the repository: goal, current task, completed work, failures, decisions, and next action.

2. **Repository reality is authoritative** — The task store is a navigation checkpoint, not a source of truth. Before acting on a consequential claim (task complete, test passing, file modified), the agent must verify against the repository. Trust hierarchy: `repository/tests > git state > task-store > model memory`.

3. **Resume context has a bounded token budget** — The default resume projection must stay below 400 tokens. This is a hard design constraint, not a benchmark target. Any feature that would inflate the default projection without a cap is not acceptable.

4. **Features that grow state must not grow the projection automatically** — More completed tasks, more decisions, and more attempts must not cause the resume context to grow unboundedly. The projection algorithm must age out older state.

5. **The store must be usable without Claude Code** — Skills and hooks are a convenience layer. Any agent with shell access can fully operate the store via the CLI. Claude Code integration is an adapter, not the core data model.

6. **The CLI is the interoperability boundary** — Cross-agent use (Claude ↔ Codex ↔ other) does not require any agent-specific SDK, hook, or skill. The CLI provides a clean, stable interface that any agent or human can call.

7. **Checkpoint semantics, not diary semantics** — Only persist high-value state transitions: task start, meaningful milestone, failed approach, decision, completion, session exit. Do not record every conversation turn.

8. **State describes execution reality, not model internals** — Fields must be interpretable by any agent. Avoid chain-of-thought, conversation summaries, or provider-specific metadata. Prefer: `goal`, `tasks`, `status`, `attempts`, `decisions`, `blockers`, `evidence`, `next_action`.

## Architecture

```
.claude-task/
├── state.json       # Current execution state (human-readable, committable)
└── history.jsonl    # Append-only audit trail (one JSON object per line)

.claude/
├── settings.json    # Hook configuration
├── skills/
│   └── task-store/
│       └── SKILL.md # Teaches Claude how to use the task store
└── hooks/
    └── scripts/
        ├── session-start.sh  # Inject compact state at session start
        ├── pre-compact.sh    # Persist state before compaction
        └── session-end.sh    # Prompt state update at session end

bin/
└── task-store       # CLI: init, status, add, start, done, block, history

schemas/
└── state.schema.json  # JSON Schema for state.json validation
```
