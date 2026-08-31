---
description: >
  Manages persistent execution state across sessions using the task store.
  Use when resuming work, updating task status, recording failures, or
  checking what was done previously. Automatically invoked at session start
  when .claude-task/state.json exists.
invocation: user-or-claude
---

# Task Store Skill

You are working with **claude-task-store**, a persistent execution checkpoint system.

The task store lives in `.claude-task/state.json` in the project root. It answers:
1. What are we trying to achieve?
2. What has already been done?
3. What are we doing now?
4. What remains?
5. What failed or was tried already?
6. What should the next session do next?

## Reading the Current State

At session start, if state exists it is injected automatically. If not shown, read it:

```bash
task-store status
```

Or for the compact resume context:

```bash
task-store resume
```

## Critical Behavioral Rules

**ALWAYS** follow these rules when using the task store:

1. **Never mark a task done without evidence.** Evidence means: a file path that was created/modified, test output showing passing tests, or other concrete proof. Without evidence, use `done` with explicit references.

2. **Record failed approaches immediately.** When something doesn't work, record it before trying the next thing so future sessions don't repeat it.

3. **Keep notes concise.** The task store is a checkpoint, not a diary.
   - BAD: "Claude explored several files and thought about different approaches..."
   - GOOD: "T3 BLOCKED: integration test fails — mock server doesn't support streaming. Tried: direct HTTP mock, in-process stub."

4. **Always set `next_action` before ending a session.** The next model instance needs one explicit starting point.

5. **Update the store at meaningful milestones**, not on every turn. Meaningful milestones:
   - Starting a new task
   - Completing a task
   - Encountering a blocker
   - Recording a key architectural decision
   - Before ending the session

6. **Do not reload historical transcripts.** The task store IS the state. Trust it.

## Workflow

### Starting a new project/goal

```bash
task-store init "Build X feature for Y project" \
  "Write the data model" \
  "Implement API endpoints" \
  "Add validation" \
  "Write tests" \
  "Update documentation"
```

### Beginning work on a task

```bash
task-store start T1
```

### Completing a task (evidence required)

```bash
task-store done T1 -e src/models/user.ts -e "npm test passes: 42/42"
```

### Recording a failure/blocked state

```bash
task-store block T3 "Integration test fails because mock server doesn't support streaming. Need HTTP fixture instead."
```

### Recording a failed approach (so future sessions don't repeat it)

```bash
task-store attempt T3 "Used in-process mock" "Mock doesn't support chunked transfer encoding"
```

### Recording an architectural decision

```bash
task-store decide "Use SQLite not PostgreSQL" "Simpler setup, no external service required for dev"
```

### Setting the next action (always do before ending session)

```bash
task-store next "Resume T3: replace mock with local HTTP fixture in tests/fixtures/mock-server.js"
```

### Checking current state

```bash
task-store status
```

### Adding an unplanned task

```bash
task-store add "Fix discovered memory leak in connection pool"
```

## Compact State Injection Format

When state is injected at session start, it looks like:

```
GOAL: <goal>
STATUS: ACTIVE

CURRENT:
  ▶ [T3] Implement streaming endpoint
    NOTE: Need HTTP fixture for tests
    ✗ tried: in-process mock → doesn't support chunked encoding

DONE:
  ✓ [T1] Write data model
  ✓ [T2] Implement basic endpoints

REMAINING:
  ○ [T4] Write tests
  ○ [T5] Update docs

NEXT ACTION: Replace mock with local HTTP fixture in tests/fixtures/
```

**This context is authoritative.** Use it to resume work without re-reading transcripts.

## Token Budget Awareness

The injected context is designed to stay under 400 tokens. If you're working with a very constrained context window:
- Trust the NEXT ACTION field completely
- Only read the CURRENT task details
- Avoid re-reading files already evidenced as complete

## State File Location

```
<project-root>/
└── .claude-task/
    ├── state.json    ← Human-readable, can be git-committed
    └── history.jsonl ← Append-only audit trail
```

To add task store state to version control (enables cross-developer/model handoffs):
```bash
git add .claude-task/state.json
git commit -m "chore: update task state"
# Usually keep history.jsonl in .gitignore (it's verbose)
```
