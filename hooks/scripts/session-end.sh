#!/usr/bin/env bash
# claude-task-store: SessionEnd / Stop hook
# At session end, check if next_action is set.
# If state is active but next_action is null, write a warning to stderr
# so Claude Code surfaces it to the user.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"

if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

INPUT=$(cat)
# Extract the Claude Code session id so we can release the attachment if
# this session was the recorded owner. Mirrors the other hooks: a missing
# id is a no-op, never a failure, because a checkpoint aid must never
# break a coding session.
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read() or "{}")
except Exception:
    sys.exit(0)
print(data.get("session_id", "") or "")
' 2>/dev/null || echo "")
export PROJECT_DIR

python3 - <<'PYEOF'
import json, os, sys

state_file = os.environ.get('PROJECT_DIR', os.getcwd()) + '/.claude-task/state.json'
try:
    with open(state_file) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)

if s.get('version') == '2':
    active = s.get('active_topic')
    topic = next((t for t in s.get('topics', []) if t.get('name') == active), {})
else:
    topic = s

status = topic.get('status', '')
next_action = topic.get('next_action')
current_task = topic.get('current_task')

if status in ('active', 'blocked') and not next_action:
    # Output a reminder — prints to stderr which Claude Code may surface
    print(
        "\n⚠️  [task-store] Session ending with no next_action set.\n"
        "   Run: task-store next \"<what to do next>\"\n"
        "   This helps the next session resume without re-discovering context.",
        file=sys.stderr
    )
elif status == 'active' and current_task:
    print(
        f"\n[task-store] Session ended with [{current_task}] in progress.\n"
        f"  Next action: {next_action or '(not set)'}",
        file=sys.stderr
    )
PYEOF

# ─── Auto-checkpoint staleness warning (opt-in, conservative mode) ───────────
# Everything above this line is unchanged v0.1.0 behavior. Everything below
# runs ONLY when the project has opted in to conservative mode.
#
# IMPORTANT — this is a WARNING, not a reconciliation request. SessionEnd was
# checked against the installed Claude Code: the event has no channel back to
# the model (exit 0 completes silently; a non-zero exit shows stderr to the
# user only). By the time it fires there is no agent left to reconcile.
#
# So the honest thing to do is tell the human that the checkpoint looks stale
# and how to fix it, and to leave the store untouched. We deliberately do NOT
# call `auto check` here: that would consume the debounce window and record a
# reconciliation "request" that no agent will ever see, suppressing a real
# request at the next session's first Stop boundary.

CONFIG_FILE="$PROJECT_DIR/.claude-task/config.json"

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

# Read-only query. `auto status` never mutates anything.
set +e
AUTO_STATUS=$("${TASK_STORE_CMD[@]}" auto status --root "$PROJECT_DIR" 2>/dev/null)
set -e

if printf '%s' "$AUTO_STATUS" | grep -q '^stale: true'; then
  printf '%s\n' \
    "" \
    "⚠️  [task-store] Session ending with unreconciled changes." \
    "   Files or commands changed repository state after the last checkpoint write," \
    "   so .claude-task/state.json may not reflect reality." \
    "   Reconcile with: task-store status, then start|done|attempt|block|decide|next" \
    >&2
fi

# ─── Release the session-attachment record (issue #23) ────────────────────────
# A session that explicitly opted into the task-store execution should not
# leave its claim dangling when it ends normally — the next session would
# otherwise be forced to confirm a takeover to attach. So we ask the CLI
# to release the record if (and only if) this session was the owner; the
# CLI no-ops when the record belongs to a different session or does not
# exist. Output is silenced: SessionEnd has no model channel, so the user
# would just see noise on stderr for a routine housekeeping action.
#
# The gate is the mode the CLI actually reported, NOT the loose substring
# grep above: that grep is a cheap bash fast-path which deliberately matches
# an unrelated key whose value merely contains "conservative" (see the
# config-note case this suite exercises). Releasing on that match would touch
# the attachment in a project whose auto-checkpoint is off, breaking the
# "off costs nothing" invariant.
if [[ "$AUTO_STATUS" == *"mode: conservative"* ]] \
   && [[ -n "$SESSION_ID" ]] \
   && [[ ${#TASK_STORE_CMD[@]} -gt 0 ]]; then
  "${TASK_STORE_CMD[@]}" attach --release --session-id "$SESSION_ID" --host claude-code --root "$PROJECT_DIR" >/dev/null 2>&1 || true
fi

exit 0
