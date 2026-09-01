#!/usr/bin/env bash
# claude-task-store: Stop hook — RECONCILIATION BOUNDARY
#
# Fires right before Claude concludes its response. This is the primary
# reconciliation boundary for conservative auto-checkpoint mode, and it was
# chosen after checking what the installed Claude Code actually supports:
#
#   Stop        additionalContext is "non-error feedback delivered to the
#               model; the conversation continues so the model can act on
#               it" -- the only boundary that can actually get the agent to
#               reconcile.
#   PreCompact  stdout becomes custom compact instructions (weaker, but a
#               genuine boundary -- also wired up, see pre-compact.sh).
#   SessionEnd  has no channel to the model at all; the session is over.
#               It can only warn the human (see session-end.sh).
#
# What this hook emits is an INSTRUCTION, never a mutation. It does not
# decide that a task is done, does not write next_action, and does not touch
# state.json. The agent reconciles explicitly through the existing CLI verbs
# or it does nothing at all.
#
# Firing is gated by `task-store auto check`, which requires BOTH new work
# since the last request AND the debounce interval to have elapsed. On a
# session with no edits, or one where the checkpoint is already current, this
# hook is silent.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"
CONFIG_FILE="$PROJECT_DIR/.claude-task/config.json"

# Drain stdin so Claude Code's writer never sees an early-closed pipe.
INPUT=$(cat || true)

# Fast path: same cheap bail-out as post-tool-use.sh. Default-off projects
# never spawn Node here.
[[ -f "$STATE_FILE" ]] || exit 0
[[ -f "$CONFIG_FILE" ]] || exit 0
grep -q 'conservative' "$CONFIG_FILE" 2>/dev/null || exit 0

LOCAL_RUNTIME="$PROJECT_DIR/.claude/task-store/bin/task-store.js"
TASK_STORE_CMD=()
if [[ -f "$LOCAL_RUNTIME" ]] && command -v node &>/dev/null; then
  TASK_STORE_CMD=(node "$LOCAL_RUNTIME")
elif command -v task-store &>/dev/null; then
  TASK_STORE_CMD=(task-store)
else
  exit 0
fi

# `auto check` is the single decision point: exit 0 means "ask now" and also
# records the request (opening the debounce window), so this hook cannot nag
# in a loop even if it is invoked repeatedly. Exit 1 means "nothing to do".
set +e
INSTRUCTION=$("${TASK_STORE_CMD[@]}" auto check --instruction --root "$PROJECT_DIR" 2>/dev/null)
CHECK_RC=$?
set -e

if [[ $CHECK_RC -ne 0 ]] || [[ -z "$INSTRUCTION" ]]; then
  exit 0
fi

# Deliver as Stop hookSpecificOutput.additionalContext: non-error feedback
# that the model can act on while the conversation continues. Note this is
# NOT `decision: block` -- blocking would frame a routine checkpoint refresh
# as an error and force the turn to continue even when the agent has nothing
# to reconcile.
#
# INSTRUCTION is passed via an exported env var and read with os.environ --
# never interpolated into Python source -- and the heredoc is quoted, so
# project paths and instruction text containing quotes or apostrophes are
# safe.
export INSTRUCTION
python3 <<'PYEOF'
import json, os

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'Stop',
        'additionalContext': os.environ['INSTRUCTION'],
    }
}))
PYEOF

exit 0
