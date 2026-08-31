#!/usr/bin/env bash
# claude-task-store: SessionStart hook
# Injects compact task state at session start when .claude-task/state.json exists.
#
# Receives JSON on stdin with SessionStart event data.
# Outputs JSON with context injection if state exists.
# Exit 0 with no output = no injection.

set -euo pipefail

# Find project root from event input (CLAUDE_PROJECT_DIR env var or stdin)
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
STATE_FILE="$PROJECT_DIR/.claude-task/state.json"

# If no state file exists, do nothing
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Read event input (needed by Claude Code but we mainly need the state file)
INPUT=$(cat)

# Check if state is archived — don't inject archived state
STATUS=$(python3 -c "import sys,json; d=json.load(open('$STATE_FILE')); print(d.get('status',''))" 2>/dev/null || echo "")
if [[ "$STATUS" == "archived" ]]; then
  exit 0
fi

# Generate compact resume context using the CLI
TASK_STORE_CMD=""
if command -v task-store &>/dev/null; then
  TASK_STORE_CMD="task-store"
elif [[ -f "$PROJECT_DIR/bin/task-store.js" ]]; then
  TASK_STORE_CMD="node $PROJECT_DIR/bin/task-store.js"
elif [[ -f "$PROJECT_DIR/node_modules/.bin/task-store" ]]; then
  TASK_STORE_CMD="$PROJECT_DIR/node_modules/.bin/task-store"
fi

if [[ -z "$TASK_STORE_CMD" ]]; then
  # Fallback: generate basic context from raw JSON using python3
  RESUME_CONTEXT=$(python3 - <<'PYEOF'
import json, sys, os

state_file = os.environ.get('STATE_FILE', '.claude-task/state.json')
try:
    with open(state_file) as f:
        s = json.load(f)
except Exception as e:
    sys.exit(0)

goal = s.get('goal', '')
status = s.get('status', 'active').upper()
tasks = s.get('tasks', [])
next_action = s.get('next_action', '')
decisions = s.get('decisions', [])

lines = [
    '╔══════════════════════════════════════╗',
    '║  TASK STORE — RESUME CONTEXT         ║',
    '╚══════════════════════════════════════╝',
    '',
    f'GOAL: {goal}',
    f'STATUS: {status}',
    '',
]

done = [t for t in tasks if t.get('status') == 'done']
in_progress = [t for t in tasks if t.get('status') == 'in_progress']
remaining = [t for t in tasks if t.get('status') == 'pending']
blocked = [t for t in tasks if t.get('status') == 'blocked']

if in_progress:
    lines.append('CURRENT:')
    for t in in_progress:
        lines.append(f"  ▶ [{t['id']}] {t['title']}")
        if t.get('notes'):
            lines.append(f"    NOTE: {t['notes']}")
        for a in (t.get('attempts') or [])[-2:]:
            lines.append(f"    ✗ tried: {a.get('description','')} → {a.get('outcome','')}")
    lines.append('')

if done:
    lines.append('DONE:')
    for t in done:
        lines.append(f"  ✓ [{t['id']}] {t['title']}")
    lines.append('')

if remaining:
    lines.append('REMAINING:')
    for t in remaining:
        lines.append(f"  ○ [{t['id']}] {t['title']}")
    lines.append('')

if blocked:
    lines.append('BLOCKED:')
    for t in blocked:
        lines.append(f"  ✗ [{t['id']}] {t.get('notes', t['title'])}")
    lines.append('')

if decisions:
    lines.append('KEY DECISIONS:')
    for d in decisions[-3:]:
        lines.append(f"  • {d.get('summary','')}")
    lines.append('')

lines.append(f"NEXT ACTION: {next_action or '(not set)'}")
lines.append('')
lines.append(f"Updated: {s.get('updated_at','')[:16].replace('T',' ')} UTC")
lines.append('─── /task-status for details | /task-history for audit ───')

print('\n'.join(lines))
PYEOF
  )
  export STATE_FILE
else
  RESUME_CONTEXT=$($TASK_STORE_CMD resume --root "$PROJECT_DIR" 2>/dev/null || echo "")
fi

if [[ -z "$RESUME_CONTEXT" ]]; then
  exit 0
fi

# Output JSON with context injection
# Claude Code reads this and prepends the context to Claude's system context
python3 -c "
import json, sys
ctx = sys.stdin.read()
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': ctx
    }
}))
" <<< "$RESUME_CONTEXT"
