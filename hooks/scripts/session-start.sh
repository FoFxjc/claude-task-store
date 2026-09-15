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
ATTACH_FILE="$PROJECT_DIR/.claude-task/attachment.json"

# If no state file exists, do nothing
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Read event input (needed by Claude Code but we mainly need the state file)
INPUT=$(cat)

# ─── Session identity ─────────────────────────────────────────────────────────
# The auto-checkpoint runtime is gated on a session-attachment record
# (src/attachment.ts). Without this session's id we cannot decide whether
# the session is the recorded owner or a fresh side session, so the prompt
# below cannot be tailored. We still continue — every part of this hook is
# useful even when the session_id is missing — but we mark it as unknown
# so the prompt branch falls back to a generic "no session id, ask anyway".
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read() or "{}")
except Exception:
    sys.exit(0)
print(data.get("session_id", "") or "")
' 2>/dev/null || echo "")

# Check if state is archived or completed — don't inject or prompt for
# inactive task-store work. STATE_FILE is passed via an exported env var
# and read with os.environ; the heredoc delimiter is quoted ('PYEOF') so
# bash performs no interpolation on the Python source at all.
export STATE_FILE
TOPIC_STATUS=$(python3 <<'PYEOF'
import json, os

state_file = os.environ['STATE_FILE']
try:
    with open(state_file) as f:
        d = json.load(f)
    if d.get('version') == '2':
        active = d.get('active_topic')
        topic = next((t for t in d.get('topics', []) if t.get('name') == active), {})
        print(topic.get('status', ''))
    else:
        print(d.get('status', ''))
except Exception:
    pass
PYEOF
) || TOPIC_STATUS=""

if [[ "$TOPIC_STATUS" == "archived" || "$TOPIC_STATUS" == "completed" ]]; then
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
# Resolution order is deliberately short and deterministic:
#   1. the project-local runtime install.sh copies into .claude/task-store/
#   2. `task-store` on PATH (global install — an optional convenience)
#   3. the minimal fallback below
# (1) is what makes a default `./install.sh <project>` self-contained: it does
# not depend on the original source checkout still existing, on a global npm
# install, or on a PATH shim.
#
# TASK_STORE_CMD is an array, not a word-split string, so it invokes
# correctly even when $PROJECT_DIR contains spaces or apostrophes.
LOCAL_RUNTIME="$PROJECT_DIR/.claude/task-store/bin/task-store.js"
TASK_STORE_CMD=()
if [[ -f "$LOCAL_RUNTIME" ]] && command -v node &>/dev/null; then
  TASK_STORE_CMD=(node "$LOCAL_RUNTIME")
elif command -v task-store &>/dev/null; then
  TASK_STORE_CMD=(task-store)
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

if s.get('version') == '2':
    active = s.get('active_topic')
    topic = next((t for t in s.get('topics', []) if t.get('name') == active), {})
else:
    active = 'default'
    topic = s

goal = topic.get('goal', '(unknown)')
next_action = topic.get('next_action') or '(not set — run `task-store status`)'

print(
    "TASK STORE — RESUME CONTEXT (minimal fallback: task-store CLI unavailable)\n"
    f"TOPIC: {active}\n"
    f"GOAL: {goal}\n"
    f"NEXT ACTION: {next_action}\n"
    "Run `task-store status` for full details."
)
PYEOF
  ) || RESUME_CONTEXT=""
fi

# ─── Session-attachment check (issue #23) ────────────────────────────────────
# Auto-checkpoint is now session-intent-scoped: this session only has the
# authority to dirty the auto-checkpoint runtime if it has explicitly taken
# over the attachment record. The CLI is the source of truth for who owns
# it, so we ask the CLI rather than reading attachment.json ourselves — that
# way the gate logic stays in one place (src/attachment.ts) and is exercised
# by the same tests as everything else.
#
# Outcomes from `task-store attach status` (parsed below):
#   "attached: none"
#     -> first-time fresh session. We append an attach prompt so the model
#        can ask the user to opt in (issue #23 acceptance criterion).
#   "attached: session_id=<X> host=<H> attached_at=<T>"
#     where <X> matches $SESSION_ID
#     -> this session is the owner. No prompt; resume alone is enough.
#     where <X> differs from $SESSION_ID
#     -> another session is the owner. We append a takeover prompt.
#   CLI unavailable
#     -> we cannot tell who owns the store. Fail closed: inject nothing
#        about attachment, and let resume carry the context. This is the
#        same conservative posture as when no CLI runtime is present.
ATTACH_CONTEXT=""
# The mode gate belongs in the condition rather than a nested branch: the
# prompt is part of the conservative auto-checkpoint flow, so a project with
# `off` — including a configless legacy store, which resolves to off —
# promises no prompts at all, and an attachment there would gate nothing.
# The CLI is asked for the authoritative mode rather than config.json being
# read here.
if [[ ${#TASK_STORE_CMD[@]} -gt 0 ]] && [[ -n "$SESSION_ID" ]] \
   && [[ "$("${TASK_STORE_CMD[@]}" config auto-checkpoint --root "$PROJECT_DIR" 2>/dev/null || echo "")" == "conservative" ]]; then
  # The CLI does not yet expose a JSON view of attach status, so we parse the
  # `attached: ...` text format we know it emits. `attached: none` is the
  # "no owner" sentinel. The status is printed to stdout by `attach status`.
  ATTACH_STATUS=$("${TASK_STORE_CMD[@]}" attach status --root "$PROJECT_DIR" 2>/dev/null || echo "")

  ATTACH_OWNER_ID=""
  ATTACH_OWNER_HOST=""
  ATTACH_OWNER_AT=""
  ATTACH_KIND="none"

  if [[ "$ATTACH_STATUS" == "attached: none" ]]; then
    ATTACH_KIND="none"
  elif [[ "$ATTACH_STATUS" == attached:* ]]; then
    ATTACH_KIND="owner"
    # Parse "attached: session_id=<X> host=<H> attached_at=<T>".
    # Both the host label and the timestamp can contain characters bash
    # would re-tokenise on (host = "opencode (unrecognised)"; timestamp
    # is a free-form ISO string). Use Python so quoting is consistent.
    ATTACH_OWNER_ID=$(printf '%s' "$ATTACH_STATUS" | python3 -c '
import re, sys
m = re.search(r"session_id=([^\s]+)", sys.stdin.read())
print(m.group(1) if m else "")
')
    ATTACH_OWNER_HOST=$(printf '%s' "$ATTACH_STATUS" | python3 -c '
import re, sys
m = re.search(r"host=([^\s]+(?:\s+[^\s]+)*?)\s+attached_at=", sys.stdin.read())
print(m.group(1) if m else "")
')
    ATTACH_OWNER_AT=$(printf '%s' "$ATTACH_STATUS" | python3 -c '
import re, sys
m = re.search(r"attached_at=(\S+)", sys.stdin.read())
print(m.group(1) if m else "")
')
  fi

  if [[ "$ATTACH_KIND" == "owner" && "$ATTACH_OWNER_ID" == "$SESSION_ID" ]]; then
    # This session is the recorded owner. Auto-checkpoint works normally;
    # no prompt needed.
    :
  else
    # Either no owner (fresh project / previous session released cleanly)
    # or a different session owns the store. Either way, this session is
    # detached from auto-checkpoint by design until it explicitly opts in.
    #
    # Path safety: the prompt must contain a command the agent can actually
    # run. A bare `task-store` assumes a global install this project is not
    # required to have, and an unquoted project path breaks on spaces and
    # apostrophes. So we render the resolved argv — the same invocation the
    # hooks themselves use — with every element shell-quoted by shlex, and
    # pass the values in via exported env vars rather than format strings
    # (ATTACH_OWNER_HOST can legitimately contain parentheses).
    export TASK_STORE_ARGV
    TASK_STORE_ARGV="$(printf '%s\n' "${TASK_STORE_CMD[@]}")"

    if [[ "$ATTACH_KIND" == "owner" ]]; then
      export SESSION_ID PROJECT_DIR ATTACH_OWNER_ID ATTACH_OWNER_HOST ATTACH_OWNER_AT
      ATTACH_CONTEXT=$(python3 <<'PYEOF'
import os, shlex

session_id     = os.environ['SESSION_ID']
owner_id       = os.environ['ATTACH_OWNER_ID']
owner_host     = os.environ['ATTACH_OWNER_HOST']
owner_attached = os.environ['ATTACH_OWNER_AT']
argv           = [a for a in os.environ['TASK_STORE_ARGV'].split('\n') if a]
base           = ' '.join(shlex.quote(a) for a in argv)
root           = shlex.quote(os.environ['PROJECT_DIR'])
cmd            = (f"{base} attach --session-id {shlex.quote(session_id)} "
                  f"--host claude-code --root {root} --takeover --confirm")

print(
    "[task-store] Active task-store work is already attached to another session\n"
    f"(session_id={owner_id}, host={owner_host}, since={owner_attached}).\n"
    "\n"
    "This session is detached from auto-checkpoint by design. Ask the user:\n"
    "\"Another session is already attached to this project's task-store work.\"\n"
    "\"Continue those tasks in this session?\"\n"
    f"  yes (take over) -> {cmd}\n"
    "  no              -> do nothing; this session stays detached\n"
)
PYEOF
)
    else
      export SESSION_ID PROJECT_DIR
      ATTACH_CONTEXT=$(python3 <<'PYEOF'
import os, shlex

session_id = os.environ['SESSION_ID']
argv       = [a for a in os.environ['TASK_STORE_ARGV'].split('\n') if a]
base       = ' '.join(shlex.quote(a) for a in argv)
root       = shlex.quote(os.environ['PROJECT_DIR'])
cmd        = (f"{base} attach --session-id {shlex.quote(session_id)} "
              f"--host claude-code --root {root} --yes")

print(
    "[task-store] Active task-store work exists for this project.\n"
    "This session is detached from auto-checkpoint by design. Ask the user:\n"
    "\"This project has active task-store work. Continue those tasks in this session?\"\n"
    f"  yes -> {cmd}\n"
    "  no  -> do nothing; this session stays detached\n"
)
PYEOF
)
    fi
  fi
fi

# Compose the injection: resume is the always-present core, attach prompt
# is appended (separated by a blank line) when this session is detached.
if [[ -n "$ATTACH_CONTEXT" ]]; then
  RESUME_CONTEXT="${RESUME_CONTEXT}"$'\n\n'"${ATTACH_CONTEXT}"
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
