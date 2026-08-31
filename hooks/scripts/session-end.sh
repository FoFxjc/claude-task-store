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
export PROJECT_DIR

python3 - <<'PYEOF'
import json, os, sys

state_file = os.environ.get('PROJECT_DIR', os.getcwd()) + '/.claude-task/state.json'
try:
    with open(state_file) as f:
        s = json.load(f)
except Exception:
    sys.exit(0)

status = s.get('status', '')
next_action = s.get('next_action')
current_task = s.get('current_task')

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

exit 0
