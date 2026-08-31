#!/usr/bin/env bash
# claude-task-store: PreCompact hook
# Persists a "checkpoint" history entry before context compaction.
# This does NOT overwrite state — it appends a checkpoint marker to history.jsonl
# so that post-compaction recovery knows where the session was.

set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"
HISTORY_FILE="$PROJECT_DIR/.claude-task/history.jsonl"

if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Read input (compaction trigger info)
INPUT=$(cat)
TRIGGER=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('trigger','auto'))" 2>/dev/null || echo "auto")

# Append a compaction checkpoint marker to history
python3 - <<PYEOF
import json, os
from datetime import datetime, timezone

history_file = '$HISTORY_FILE'
state_file = '$STATE_FILE'

try:
    with open(state_file) as f:
        state = json.load(f)
except Exception:
    import sys; sys.exit(0)

entry = {
    'event': 'pre_compact_checkpoint',
    'trigger': '$TRIGGER',
    'current_task': state.get('current_task'),
    'status': state.get('status'),
    'next_action': state.get('next_action'),
    'at': datetime.now(timezone.utc).isoformat(),
}

with open(history_file, 'a') as f:
    f.write(json.dumps(entry) + '\n')

print(f"[task-store] Checkpoint saved before compaction", file=__import__('sys').stderr)
PYEOF

exit 0
