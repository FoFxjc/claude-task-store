#!/usr/bin/env bash
# claude-task-store: PreCompact hook
# Persists a "checkpoint" history entry before context compaction.
# This does NOT overwrite state — it appends a checkpoint marker to history.jsonl
# so that post-compaction recovery knows where the session was.
#
# Path safety: all values (paths, trigger reason) are passed to Python via
# exported environment variables and read with os.environ — never
# interpolated into Python source text — and the heredocs below are quoted
# ('PYEOF') so bash performs no interpolation on the Python source at all.
# This keeps things correct for project directories containing spaces,
# apostrophes, or other shell metacharacters.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"
HISTORY_FILE="$PROJECT_DIR/.claude-task/history.jsonl"

if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Read input (compaction trigger info)
INPUT=$(cat)
export INPUT
TRIGGER=$(python3 <<'PYEOF'
import json, os

try:
    d = json.loads(os.environ.get('INPUT', '') or '{}')
    print(d.get('trigger', 'auto'))
except Exception:
    print('auto')
PYEOF
)

# Append a compaction checkpoint marker to history
export STATE_FILE HISTORY_FILE TRIGGER
python3 <<'PYEOF'
import json, os, sys
from datetime import datetime, timezone

history_file = os.environ['HISTORY_FILE']
state_file = os.environ['STATE_FILE']
trigger = os.environ.get('TRIGGER', 'auto')

try:
    with open(state_file) as f:
        state = json.load(f)
except Exception:
    sys.exit(0)

if state.get('version') == '2':
    active = state.get('active_topic')
    topic = next((t for t in state.get('topics', []) if t.get('name') == active), {})
else:
    active = 'default'
    topic = state

entry = {
    'event': 'pre_compact_checkpoint',
    'trigger': trigger,
    'topic': active,
    'current_task': topic.get('current_task'),
    'status': topic.get('status'),
    'next_action': topic.get('next_action'),
    'at': datetime.now(timezone.utc).isoformat(),
}

with open(history_file, 'a') as f:
    f.write(json.dumps(entry) + '\n')

print("[task-store] Checkpoint saved before compaction", file=sys.stderr)
PYEOF

# ─── Auto-checkpoint reconciliation (opt-in, conservative mode) ──────────────
# Everything above this line is unchanged v0.1.0 behavior and runs regardless
# of configuration. Everything below runs ONLY when the project has opted in
# to conservative auto-checkpoint mode.
#
# PreCompact is a genuine reconciliation boundary: compaction is exactly when
# a stale checkpoint does the most damage, because the conversation detail
# that could have compensated for it is about to be summarized away.
#
# Delivery here is weaker than the Stop hook's: the installed Claude Code
# appends a PreCompact hook's stdout as *custom compact instructions* rather
# than as direct model feedback. That is enough to carry the reconciliation
# request into the post-compaction context, and it is the strongest channel
# this event offers. The Stop hook remains the primary boundary.

CONFIG_FILE="$PROJECT_DIR/.claude-task/config.json"

# Fast path: opted-out projects (the default) do no further work.
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

# Same single decision point as the Stop hook, with the same debounce and the
# same "records the request" side effect — so a compaction immediately after
# a Stop-triggered request does not ask twice.
set +e
INSTRUCTION=$("${TASK_STORE_CMD[@]}" auto check --instruction --root "$PROJECT_DIR" 2>/dev/null)
CHECK_RC=$?
set -e

if [[ $CHECK_RC -eq 0 ]] && [[ -n "$INSTRUCTION" ]]; then
  printf '%s\n' "$INSTRUCTION"
fi

exit 0
