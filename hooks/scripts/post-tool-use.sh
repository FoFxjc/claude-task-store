#!/usr/bin/env bash
# claude-task-store: PostToolUse hook — DIRTY MARKING ONLY
#
# Fires after a matched tool call (Write|Edit|MultiEdit|NotebookEdit|Bash).
# Its entire job is to record "repository state may have changed". It never
# reads tasks, never decides anything, and never mutates task state — that
# separation is the core safety property of conservative auto-checkpoint
# mode. Reconciliation happens later, at a boundary, and only via an explicit
# agent decision.
#
# COST: this runs on every matched tool call, so the "is the feature even on?"
# test is done in bash against the config file BEFORE spawning Node. A project
# that is configured off, including a configless legacy project, does no work
# here at all and pays only the cost of this script starting.
#
# Path safety: all values are passed to the CLI as quoted arguments and to
# Python via exported environment variables — never interpolated into source
# text — so project directories containing spaces or apostrophes work.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"
CONFIG_FILE="$PROJECT_DIR/.claude-task/config.json"

# Always drain stdin so Claude Code's writer never sees an early-closed pipe.
INPUT=$(cat || true)

# ── Fast path: bail out before spawning anything ────────────────────────────
# No task store, or no config, or config does not mention conservative mode.
# The CLI remains the authority on what the mode actually is; this is only a
# cheap gate so off and configless legacy projects cost nothing.
[[ -f "$STATE_FILE" ]] || exit 0
[[ -f "$CONFIG_FILE" ]] || exit 0
grep -Eq '"auto_checkpoint"[[:space:]]*:[[:space:]]*"conservative"' "$CONFIG_FILE" 2>/dev/null || exit 0

# ── Resolve the CLI ─────────────────────────────────────────────────────────
# Same resolution order as session-start.sh: the project-local runtime that
# install.sh copies in is preferred, because that is what makes an install
# self-contained. If no CLI is available, auto-checkpoint silently does
# nothing — it degrades to v0.1.0 behavior rather than guessing in bash.
LOCAL_RUNTIME="$PROJECT_DIR/.claude/task-store/bin/task-store.js"
TASK_STORE_CMD=()
if [[ -f "$LOCAL_RUNTIME" ]] && command -v node &>/dev/null; then
  TASK_STORE_CMD=(node "$LOCAL_RUNTIME")
elif command -v task-store &>/dev/null; then
  TASK_STORE_CMD=(task-store)
else
  exit 0
fi

# ── Self-exclusion ──────────────────────────────────────────────────────────
# A `task-store ...` call IS the checkpoint being written; it is not
# repository work. Without this, reconciliation would be self-defeating: the
# agent runs `task-store done T2 -e ...` through Bash, PostToolUse fires
# afterwards, and the checkpoint it just wrote is immediately marked stale
# again — an endless dirty->reconcile->dirty loop.
#
# This matches the raw event JSON rather than parsing out the command, which
# keeps a hot path free of a Python startup (~25ms on every matched tool
# call). The trade-off is deliberate and one-directional: the match is
# coarser, so it also skips edits to files whose path contains "task-store" —
# which is itself task-store activity, and in any case only ever costs one
# fewer reconciliation prompt. It can never cause a wrong task completion.
if [[ "$INPUT" == *task-store* ]]; then
  exit 0
fi

# Mark dirty. No tool label is passed: markDirty() deliberately does not
# persist one (storing tool names or arguments would edge toward the
# conversation-transcript storage this feature is scoped out of), so
# computing one here would be pure cost.
#
# Output is suppressed: a PostToolUse hook that printed on every edit would
# spam the transcript, and this event must stay invisible. Failures are
# swallowed for the same reason a resume failure is — a checkpoint aid must
# never break a coding session.
"${TASK_STORE_CMD[@]}" auto mark-dirty --root "$PROJECT_DIR" >/dev/null 2>&1 || true

exit 0
