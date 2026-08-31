#!/usr/bin/env bash
# claude-task-store: SessionStart hook
# Injects compact task state at session start when .claude-task/state.json exists.
#
# Receives JSON on stdin with SessionStart event data.
# Outputs JSON with context injection if state exists.
# Exit 0 with no output = no injection.
#
# Path safety: project paths are passed to Python exclusively via exported
# environment variables, never interpolated into Python source text, and
# never handled through shell word-splitting. This keeps things correct for
# project directories containing spaces, apostrophes, or other shell
# metacharacters (e.g. "/tmp/pat's project").

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

# Check if state is archived — don't inject archived state.
# STATE_FILE is passed via an exported env var and read with os.environ, and
# the heredoc delimiter is quoted ('PYEOF') so bash performs no interpolation
# on the Python source at all.
export STATE_FILE
STATUS=$(python3 <<'PYEOF'
import json, os

state_file = os.environ['STATE_FILE']
try:
    with open(state_file) as f:
        d = json.load(f)
    print(d.get('status', ''))
except Exception:
    pass
PYEOF
) || STATUS=""

if [[ "$STATUS" == "archived" ]]; then
  exit 0
fi

# ─── Resume context rendering ────────────────────────────────────────────
# The canonical resume renderer is buildResumeContext() in src/core.ts,
# exposed via `task-store resume`. This hook intentionally does NOT
# reimplement that renderer: a second full renderer in Python previously
# existed here and had already drifted from the TypeScript implementation
# (see docs/pre-release-remediation.md item 5). When the CLI is unavailable,
# we degrade to a minimal GOAL / NEXT ACTION fallback rather than
# duplicating the full format.
#
# TASK_STORE_CMD is an array, not a word-split string, so it invokes
# correctly even when $PROJECT_DIR contains spaces.
TASK_STORE_CMD=()
if command -v task-store &>/dev/null; then
  TASK_STORE_CMD=(task-store)
elif [[ -f "$PROJECT_DIR/bin/task-store.js" ]]; then
  TASK_STORE_CMD=(node "$PROJECT_DIR/bin/task-store.js")
elif [[ -f "$PROJECT_DIR/node_modules/.bin/task-store" ]]; then
  TASK_STORE_CMD=("$PROJECT_DIR/node_modules/.bin/task-store")
fi

if [[ ${#TASK_STORE_CMD[@]} -gt 0 ]]; then
  RESUME_CONTEXT=$("${TASK_STORE_CMD[@]}" resume --root "$PROJECT_DIR" 2>/dev/null || echo "")
else
  # Minimal fallback: CLI unavailable (e.g. Node/npm not installed). This is
  # deliberately NOT a full re-implementation of buildResumeContext — just
  # enough to orient the model and point it at the CLI for details.
  export STATE_FILE
  RESUME_CONTEXT=$(python3 <<'PYEOF'
import json, os

state_file = os.environ['STATE_FILE']
try:
    with open(state_file) as f:
        s = json.load(f)
except Exception:
    raise SystemExit(0)

goal = s.get('goal', '(unknown)')
next_action = s.get('next_action') or '(not set — run `task-store status`)'

print(
    "TASK STORE — RESUME CONTEXT (minimal fallback: task-store CLI unavailable)\n"
    f"GOAL: {goal}\n"
    f"NEXT ACTION: {next_action}\n"
    "Run `task-store status` for full details."
)
PYEOF
  ) || RESUME_CONTEXT=""
fi

if [[ -z "$RESUME_CONTEXT" ]]; then
  exit 0
fi

# Output JSON with context injection.
# Claude Code reads this and prepends the context to Claude's system context.
# RESUME_CONTEXT is passed via an exported env var (never interpolated into
# Python source), and the heredoc is quoted so bash performs no expansion.
export RESUME_CONTEXT
python3 <<'PYEOF'
import json, os

ctx = os.environ['RESUME_CONTEXT']
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'SessionStart',
        'additionalContext': ctx
    }
}))
PYEOF
