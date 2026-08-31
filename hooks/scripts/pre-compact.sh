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

entry = {
    'event': 'pre_compact_checkpoint',
    'trigger': trigger,
    'current_task': state.get('current_task'),
    'status': state.get('status'),
    'next_action': state.get('next_action'),
    'at': datetime.now(timezone.utc).isoformat(),
}

with open(history_file, 'a') as f:
    f.write(json.dumps(entry) + '\n')

print("[task-store] Checkpoint saved before compaction", file=sys.stderr)
PYEOF

exit 0
