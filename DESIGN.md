# claude-task-store: Design Document

## What Already Exists

### Claude Code's Built-in Memory

Claude Code provides `CLAUDE.md` for persistent project instructions and **auto memory** for accumulating learnings. These load at session start and give Claude background knowledge. However, they are:
- **Static reference documents**, not dynamic execution state
- Designed for facts and conventions, not in-progress task tracking
- Loaded in full every session regardless of relevance (cost overhead)
- Not structured for "where am I in a multi-step task right now?"

### Existing Memory Plugins (Research Findings)

**General memory systems** (claude-memory, context-memory, similar):
- Focus on long-term knowledge accumulation (facts, code patterns, preferences)
- Use embeddings + vector search to retrieve relevant context
- Retrieve *relevant past knowledge*, not *current execution state*
- Add significant dependencies (vector DBs, embedding models)
- Designed for "what do I know about X?" not "what was I doing?"

**Project Brain (conceptual)**:
- Indexes codebases for code understanding
- Not focused on execution state or task tracking

**CodeMemory / OpenLTM**:
- Long-term memory for code patterns and architectural decisions
- Retrieval-based, not checkpoint-based
- Designed for knowledge recall, not resumption

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

1. **Files, not databases** — `state.json` + `history.jsonl`, human-readable, git-committable
2. **Minimal injection** — Only a compact summary at session start, never on every turn
3. **Checkpoint semantics** — Record meaningful state transitions, not conversation logs
4. **Explicit next action** — Every state update must include `next_action`, so the resuming model has one clear starting point
5. **Evidence required** — Tasks cannot be marked done without evidence (file path, test output, etc.)
6. **Fail fast on corruption** — Validate state on every read; never silently overwrite valid state
7. **Git-friendly** — `.claude-task/state.json` is committable by default; `history.jsonl` is configurable

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
