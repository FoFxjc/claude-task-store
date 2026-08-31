# Phase 3: Cross-Agent Handoff Report

**Date:** 2026-08-31  
**Branch:** fofxjc-claude-task-store-plugin  
**Test suite:** `tests/phase3/handoff_test.sh` — 22/22 checks pass

---

## Primary Question

> Can Agent B correctly continue work started by Agent A using only repository state, git state, and `.claude-task/state.json`, without access to Agent A's conversation history?

**Answer: Yes.**

All four experiments passed. The checkpoint format is model-neutral. The CLI is sufficient as the cross-agent interface. Optimistic concurrency prevents stale overwrites when used.

---

## 1. Protocol Audit: Is the State Schema Model-Neutral?

**Audit result: Schema is model-neutral with no modifications needed.**

Fields in state.json and their neutrality:

| Field | Neutral? | Notes |
|-------|----------|-------|
| `version` | ✓ | Schema version, not model version |
| `revision` | ✓ | NEW — integer write counter |
| `goal` | ✓ | Plain text |
| `status` | ✓ | Enum: active/blocked/completed/archived |
| `current_task` | ✓ | Task ID reference |
| `tasks[].id/title/status` | ✓ | Pure data |
| `tasks[].notes` | ✓ | Free text, any agent can write |
| `tasks[].evidence` | ✓ | File paths or assertions |
| `tasks[].attempts` | ✓ | Structured failure record |
| `decisions[]` | ✓ | Summary + rationale |
| `blockers[]` | ✓ | Description + task_id |
| `next_action` | ✓ | Plain text action |
| `updated_at` | ✓ | ISO timestamp |
| `updated_by` | ✓ | NEW — optional string, no semantics |

**Explicitly absent** (model-specific fields rejected from schema):
- `thoughts`, `chain_of_thought` — model reasoning
- `conversation_summary` — session transcript
- `model_name`, `provider` — execution environment
- `prompt`, `tokens` — LLM-internal

**Checkpoint contract:** The state describes *execution reality* — what was done, what failed, what's next. It does not describe *how the model reasoned* about any of these things.

---

## 2. New Fields Added in Phase 3

### `revision` (integer, backfill-safe)

Monotonically increasing write counter. Incremented on every `writeState` call.

**Purpose:** Enables optimistic concurrency — agents that wrote `--expect-rev N` will fail if another agent wrote in between.

**Backward compatibility:** States without `revision` are backfilled to `0` on read. No migration needed.

```json
{ "revision": 14, ... }
```

CLI:
```sh
task-store status           # shows "(rev N)"
task-store done T1 --expect-rev 14 -e "proof"
# → Error: Revision conflict. Expected rev 14, found rev 15. Re-read state before retrying.
```

### `updated_by` (string, optional)

Records which agent/tool last wrote the state. Never affects execution semantics.

```json
{ "updated_by": "codex" }
```

CLI:
```sh
task-store start T3 --by claude-code
task-store done T3 --by codex -e "proof"
```

**Key property:** `updated_by` is informational only. Its absence does not affect any operation. An agent that ignores it will still work correctly.

---

## 3. Claude → Codex Handoff Experiment

**Setup:** Claude initializes an 8-task URL shortener project, completes 2 tasks, records a failed approach on T3 (nanoid 6-char collision rate), records a design decision (switch to base62 8-char), blocks T3 awaiting review, and sets an explicit next action.

**Fresh Codex session** reads only `state.json` (no conversation history).

| Check | Result |
|-------|--------|
| Goal correctly identified | ✓ |
| Completed work (T1, T2) recognized | ✓ |
| Failed approach (nanoid 6-char) visible | ✓ |
| Design decision (base62) visible | ✓ |
| Blocked task + reason visible | ✓ |
| Next action explicit | ✓ |
| Resume context under 400 tokens | ✓ 299 tokens |
| `updated_by` set to `claude-code` | ✓ |

**Codex continued:** Unblocked T3, completed it with evidence. `updated_by` updated to `codex`.

**Handoff quality metrics:**
- Resume tokens: 299
- Files read before useful work begins: 1 (state.json)
- Duplicate work: 0
- Repeated failed attempts: 0
- Wrong task selection: 0

---

## 4. Codex → Claude Handoff Experiment

**Setup:** Codex initializes a 5-task API pagination project, records a failed approach (offset/limit O(n)), records a design decision (cursor-based pagination), completes T1 with evidence, starts T2, sets explicit next action.

**Fresh Claude session** reads only `state.json`.

| Check | Result |
|-------|--------|
| Goal context visible | ✓ |
| Codex's failed approach (offset/limit) visible | ✓ |
| Key decision (cursor tokens) visible | ✓ |
| Current task (T2) visible | ✓ |
| Claude continued correctly; `updated_by` updated | ✓ |

**Key finding:** Codex's design decisions and failure records were as readable to Claude as Claude's own would be. The format is symmetric.

---

## 5. Optimistic Concurrency / Conflict Test

**Scenario:**
1. Agent A reads state at revision N (e.g., rev 2)
2. Agent B writes independently → revision becomes N+1 (rev 3)
3. Agent A attempts `task-store done T1 --expect-rev 2 -e "proof"`
4. → **Rejected**: `Error: Revision conflict. Expected rev 2, found rev 3. Re-read state before retrying.`
5. Agent A re-reads (`task-store status`), notes current rev is 3
6. Agent A retries with `--expect-rev 3` → **succeeds**

**Result:** 2/2 conflict tests pass.

**When to use `--expect-rev`:** Only when two agents might write simultaneously and you need to detect the race. For sequential single-agent use, it adds friction without benefit — omitting it defaults to last-writer-wins (unchanged from Phase 2).

**Exit code:** Conflict returns exit code 2 (vs. 1 for other errors) to allow script differentiation.

---

## 6. CLI Interoperability Audit

**Question:** Is the existing CLI sufficient as the cross-agent interface, without requiring Claude Code skills or hooks?

**Test:** A simulated "any-agent" session used only CLI commands (no skill, no hook), and the resume context contained all expected fields.

| Operation | CLI command | Result |
|-----------|-------------|--------|
| Read goal and current state | `task-store resume` | ✓ |
| Start a task | `task-store start T1 --by any-agent` | ✓ |
| Record failed approach | `task-store attempt T1 "X" "Y"` | ✓ |
| Record decision | `task-store decide "Z" "rationale"` | ✓ |
| Complete with evidence | `task-store done T1 -e "proof"` | ✓ |
| Block with reason | `task-store block T2 "reason"` | ✓ |
| Set next action | `task-store next "action text"` | ✓ |

**Verdict:** The CLI is sufficient as the interoperability boundary. Non-Claude agents do not need to understand Claude Code skills, hooks, or SKILL.md. They need only the CLI.

**4/4 CLI interop checks pass.**

---

## 7. Implementation Changes Made in Phase 3

| Change | Trigger |
|--------|---------|
| Add `revision` integer to `TaskState` | Conflict test requirement |
| Backfill `revision: 0` in `validateState` | Backward compatibility |
| Increment revision in `writeState` | Automatic on every write |
| Add `compareAndWriteState()` to core | Programmatic optimistic concurrency |
| Add `--expect-rev <N>` CLI flag | Declarative optimistic concurrency |
| Add `updated_by?: string` to `TaskState` | Provenance requirement |
| Thread `updatedBy` through all mutation functions | Clean API without double-writes |
| Add `--by <agent>` CLI flag | Provenance from CLI |
| Show `(rev N)` and `by <agent>` in `status` | Operator visibility |
| Show attempts for blocked tasks in resume context | Failed approach visibility |
| Update JSON schema | Document new fields |

---

## 8. Handoff Quality Metrics Summary

| Experiment | Resume tokens | Files read | Duplicate work | Wrong task |
|-----------|--------------|-----------|---------------|-----------|
| Claude→Codex | 299 | 1 | 0 | 0 |
| Codex→Claude | ~190 | 1 | 0 | 0 |
| Conflict test | — | 1 | 0 | n/a |
| CLI interop | ~178 | 1 | 0 | 0 |

All experiments: 1 file, no duplicate work, no wrong task selection.

---

## 9. Decision Gate

### A. Is the current state schema genuinely model-neutral?

**Yes.** The schema audit found no Claude-specific fields. All fields describe execution reality: task status, evidence, failed approaches, decisions, blockers, next action. The schema is plain JSON with no LLM-internal concepts.

### B. Can another coding agent resume reliably without Claude-specific context?

**Yes.** Both Claude→Codex and Codex→Claude handoffs passed all checks. The resume context is self-contained. An agent reading `state.json` without any conversation history correctly identified goal, completed work, failed approaches, decisions, current task, and next action in every test.

### C. Is the CLI sufficient as the interoperability interface?

**Yes.** The 14-command CLI provides a complete interoperability boundary. Non-Claude agents need no knowledge of Claude Code skills, hooks, or SKILL.md. The `--by` flag makes provenance optional but available. `--expect-rev` makes safe concurrent writes possible when needed.

### D. Should this project remain `claude-task-store`, or extract a generic protocol?

**Remain `claude-task-store` for now.** The experiments demonstrate model-neutrality, but:

1. The name reflects its origin and primary use case — the Claude Code ecosystem
2. The Claude Code skill and hooks are real value-adds for Claude users
3. A rename/extraction should happen when there's an actual consumer in a different ecosystem, not speculatively
4. The protocol itself is already neutral — if another ecosystem wants to adopt it, they can use the CLI directly

If a Codex-native integration or a second concrete non-Claude consumer emerges, the extraction case becomes clear.

---

## 10. Remaining Limitations (Updated)

1. **`--expect-rev` is opt-in:** Default behavior is still last-writer-wins for backward compatibility. Agents that need conflict safety must explicitly use `--expect-rev`.

2. **No distributed lock:** Two agents writing to the same file simultaneously (at the filesystem level) can still produce a race. `--expect-rev` is a read-then-write check, not an atomic CAS. For typical use (sequential sessions), this is fine.

3. **`updated_by` is unauthenticated:** Any agent can claim any identity. This is intentional — provenance is informational, not a security mechanism.

4. **Pi not tested:** Pi was not available in the environment. The protocol neutrality test with Pi is deferred.

---

## 11. Test Results Summary

| Suite | Checks | Result |
|-------|--------|--------|
| Unit tests | 31 | ✓ |
| Acceptance (original) | 17 | ✓ |
| Phase 2: pressure | 13 | ✓ |
| Phase 2: decay | 8 | ✓ |
| Phase 2: recovery | 15 | ✓ |
| Phase 2: safety | 8 | ✓ |
| Phase 2: git workflow | 8 | ✓ |
| Phase 3: handoff | 22 | ✓ |
| **Total** | **122** | **✓ all pass** |
