# Atomic Batch Commit

Apply a complete checkpoint update atomically in a single `state.json` write.

---

## Why

Individual CLI commands (`start`, `done`, `attempt`, `block`, `decide`, `next`) each hold the store lock only for their own read-modify-write cycle. Interruption between commands can leave a checkpoint that is partially applied.

`task-store commit` holds the lock for the entire batch and writes exactly once.

---

## Usage

```bash
task-store commit --topic <name> [--expect-rev N] < batch.json
```

**Input**: JSON batch from stdin (pipe or redirect).

**Required flag**: `--topic <name>` — names the topic to operate on.

**Optional flag**: `--expect-rev N` — enforce optimistic concurrency (fails if on-disk revision != N).

**Exit codes**:
- `0` — success
- `1` — StateError (parse error, validation failure, topic not found, task not found, etc.)
- `2` — ConflictError (revision mismatch with `--expect-rev`)
- `3` — LockError (could not acquire store lock)

---

## Input Schema

The JSON body contains only `operations`. Topic and revision are set via CLI flags.

```json
{
  "operations": [ ... ]
}
```

`operations` is required and must be a non-empty array.

### Operations

Each operation is a JSON object with a `type` field. Operation order is preserved.

| type | Required fields | Notes |
|------|---------------|-------|
| `add` | `title` | `notes` optional |
| `start` | `taskId` | e.g. `"taskId": "T1"` |
| `done` | `taskId`, `evidence` (non-empty array) | `notes` optional |
| `attempt` | `taskId`, `description`, `outcome` | |
| `block` | `taskId`, `reason` | |
| `resume` | `taskId` | Unblocks the task |
| `decide` | `summary` | `rationale` optional |
| `next` | `action` | |

### Examples

**Minimal batch — add a task, start it, record a failed attempt, block it, set next action:**

```json
{
  "operations": [
    { "type": "add", "title": "Implement rate limiting" },
    { "type": "start", "taskId": "T1" },
    { "type": "attempt", "taskId": "T1", "description": "redis sliding window", "outcome": "too much memory" },
    { "type": "block", "taskId": "T1", "reason": "waiting for architecture decision" },
    { "type": "next", "action": "Decide on rate limiting strategy, then resume T1" }
  ]
}
```

**Complete checkpoint update with `--expect-rev`:**

```bash
# Agent reads current state
REV=$(task-store status --root . 2>/dev/null | grep -o 'rev [0-9]*' | awk '{print $2}')
# 7

# Agent builds and submits a batch
cat << 'EOF' | task-store commit --topic default --expect-rev 7 --by agent-name
{
  "operations": [
    { "type": "start", "taskId": "T3" },
    { "type": "done", "taskId": "T3", "evidence": ["src/parser.ts", "tests pass"] },
    { "type": "decide", "summary": "Use a Pratt parser", "rationale": "Handles precedence naturally" },
    { "type": "next", "action": "Write the code generator for T4" }
  ]
}
EOF
```

**Multi-operation checkpoint without revision check:**

```bash
cat << 'EOF' | task-store commit --topic default
{
  "operations": [
    { "type": "start", "taskId": "T2" },
    { "type": "decide", "summary": "Use PostgreSQL full-text search", "rationale": "Avoids external service dependency" },
    { "type": "next", "action": "Add pg_trgm index for fuzzy matching" }
  ]
}
EOF
```

---

## Guarantees

1. **Single lock acquisition**: the entire batch runs under one O_EXCL lock file. No other `task-store` CLI process can interleave.
2. **Pre-validated**: the entire batch is parsed, checked against current state, and applied in-memory before any write occurs. Parse errors, validation errors, revision conflicts, and missing-topic errors all leave `state.json` untouched.
3. **One write**: exactly one `state.json` write and exactly one revision increment, even for a 10-operation batch. `atomicWrite` uses a temp-file + rename, so the write itself is atomic.
4. **Active topic untouched**: when targeting an inactive topic, `active_topic`, the active topic's timestamp, and the active topic's task fields are never modified.

## What is NOT included

- Topic creation or switching (`topic add`, `topic use`)
- Archive, repair, or configuration operations
- Any workflow DSL or automated completion inference

These remain the exclusive domain of their individual CLI verbs.
