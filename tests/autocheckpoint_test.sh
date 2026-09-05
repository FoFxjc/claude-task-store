#!/usr/bin/env bash
# claude-task-store — optional auto-checkpoint mode regression suite
#
# Exercises the feature the way Claude Code actually drives it: through the
# installed hook scripts, with real hook-shaped JSON on stdin, against a real
# install produced by install.sh.
#
# The project path is deliberately hostile (space + apostrophe + dollar sign)
# so path-safety is covered by every single assertion rather than by one
# dedicated check.
#
# The invariants under test, in priority order:
#   1. Default is off, and off means "byte-for-byte v0.1.0 behavior".
#   2. Tool activity marks dirty and NEVER mutates task state.
#   3. No task is ever auto-completed and next_action is never invented.
#   4. Reconciliation is requested at a boundary, once, then debounced.
#   5. Disabling stops all of it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "═══ auto-checkpoint suite ═══"

PASS=0; FAIL=0
check() {
  local desc="$1" cond="$2"
  if [[ "$cond" == "true" ]]; then
    echo "  ✓ $desc"; PASS=$((PASS+1))
  else
    echo "  ✗ FAIL: $desc"; FAIL=$((FAIL+1))
  fi
}

BASE=$(mktemp -d "${TMPDIR:-/tmp}/task-store-autockpt.XXXXXX")
PROJ="$BASE/pat's \$weird project"
mkdir -p "$PROJ"
cleanup() { rm -rf "$BASE"; }
trap cleanup EXIT

git -C "$PROJ" init -q .

# TASK_STORE_SKIP_OPENCODE is a no-op for the auto-checkpoint slice (nothing
# reads it yet) and is set purely so this suite stays fast and focused if an
# OpenCode adapter is added to install.sh later. It is safe either way.
FORCE=1 TASK_STORE_SKIP_OPENCODE=1 bash "$ROOT/install.sh" "$PROJ" >/dev/null 2>&1

CLI="$PROJ/.claude/task-store/bin/task-store.js"
HOOKS="$PROJ/.claude/hooks/scripts"
STATE="$PROJ/.claude-task/state.json"
CONFIG="$PROJ/.claude-task/config.json"
RUNTIME="$PROJ/.claude-task/auto-checkpoint.json"

ts() { node "$CLI" "$@" --root "$PROJ"; }

# Hook invocations get CLAUDE_PROJECT_DIR exactly as Claude Code provides it.
export CLAUDE_PROJECT_DIR="$PROJ"

edit_event='{"tool_name":"Edit","tool_input":{"file_path":"src/a.ts"},"tool_response":{"success":true}}'
bash_event='{"tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":"12 passing"}}'
selfref_event='{"tool_name":"Bash","tool_input":{"command":"task-store done T2 -e src/a.ts"}}'

post_tool() { printf '%s' "$1" | bash "$HOOKS/post-tool-use.sh"; }
stop_hook() { printf '{}' | bash "$HOOKS/stop.sh"; }
precompact_hook() { printf '{"trigger":"auto"}' | bash "$HOOKS/pre-compact.sh"; }
session_end_hook() { printf '{"reason":"exit"}' | bash "$HOOKS/session-end.sh" 2>&1 >/dev/null; }

# Read a scalar out of state.json without depending on jq.
state_field() {
  STATE_PATH="$STATE" FIELD="$1" python3 -c '
import json, os
s = json.load(open(os.environ["STATE_PATH"]))
topic = next(t for t in s["topics"] if t["name"] == s["active_topic"])
print(s.get(os.environ["FIELD"], topic.get(os.environ["FIELD"])))
'
}
task_status() {
  STATE_PATH="$STATE" TID="$1" python3 -c '
import json, os
s = json.load(open(os.environ["STATE_PATH"]))
topic = next(t for t in s["topics"] if t["name"] == s["active_topic"])
print(next(t["status"] for t in topic["tasks"] if t["id"] == os.environ["TID"]))
'
}

# ─── Install sanity ──────────────────────────────────────────────────────────
check "install.sh installs post-tool-use.sh" "$([[ -f "$HOOKS/post-tool-use.sh" ]] && echo true)"
check "install.sh installs stop.sh" "$([[ -f "$HOOKS/stop.sh" ]] && echo true)"

SETTINGS="$PROJ/.claude/settings.json" python3 -c '
import json, os, sys
h = json.load(open(os.environ["SETTINGS"]))["hooks"]
def cmds(ev): return [x["command"] for e in h.get(ev, []) for x in e["hooks"]]
ok  = any("post-tool-use.sh" in c for c in cmds("PostToolUse"))
ok &= any("stop.sh" in c for c in cmds("Stop"))
m = [e.get("matcher") for e in h.get("PostToolUse", [])]
ok &= any(x and "Edit" in x and "Bash" in x and "Read" not in x for x in m)
sys.exit(0 if ok else 1)
' && REG=true || REG=false
check "PostToolUse+Stop registered, PostToolUse scoped to mutating tools only" "$REG"

# ─── 1. Default is off ───────────────────────────────────────────────────────
ts init "Ship the parser" "Write lexer" "Write parser" >/dev/null
ts start T2 >/dev/null
ts next "Implement expression parsing" >/dev/null

check "no config file is created by init (default is implicit)" "$([[ ! -f "$CONFIG" ]] && echo true)"
check "default mode reports off" "$([[ "$(ts config auto-checkpoint)" == "off" ]] && echo true)"
check "status shows Auto-checkpoint: off" "$(ts status | grep -q '^Auto-checkpoint: off$' && echo true)"

# ─── 2. Off == unchanged v0.1.0 behavior ─────────────────────────────────────
REV_BEFORE=$(state_field revision)
post_tool "$edit_event"; post_tool "$bash_event"
check "PostToolUse hook exits 0 when off" "$([[ $? -eq 0 ]] && echo true)"
check "no runtime marker file is written when off" "$([[ ! -f "$RUNTIME" ]] && echo true)"
check "state revision unchanged by tool activity when off" "$([[ "$(state_field revision)" == "$REV_BEFORE" ]] && echo true)"
check "Stop hook is silent when off" "$([[ -z "$(stop_hook)" ]] && echo true)"
check "PreCompact still writes its v0.1.0 checkpoint when off" \
  "$(precompact_hook >/dev/null 2>&1; grep -q pre_compact_checkpoint "$PROJ/.claude-task/history.jsonl" && echo true)"
check "PreCompact emits no reconciliation text when off" "$([[ -z "$(precompact_hook 2>/dev/null)" ]] && echo true)"
check "SessionEnd emits no staleness warning when off" \
  "$(session_end_hook | grep -q 'unreconciled' && echo false || echo true)"

# ─── 3. Conservative mode can be enabled ─────────────────────────────────────
ts config auto-checkpoint conservative >/dev/null
check "mode is persisted as conservative" "$([[ "$(ts config auto-checkpoint)" == "conservative" ]] && echo true)"
check "config lives in .claude-task/config.json" "$([[ -f "$CONFIG" ]] && echo true)"
check "state.json is not polluted with tool configuration" \
  "$(grep -q auto_checkpoint "$STATE" && echo false || echo true)"
check "status shows Auto-checkpoint: conservative" "$(ts status | grep -q '^Auto-checkpoint: conservative$' && echo true)"
# Captured rather than piped: these commands exit non-zero by design, and
# `set -o pipefail` would otherwise propagate that failure past grep's success
# and make the assertion silently un-passable.
AGG_OUT=$(ts config auto-checkpoint aggressive 2>&1 || true)
check "aggressive mode is explicitly rejected" \
  "$(printf '%s' "$AGG_OUT" | grep -q 'not implemented' && echo true)"
BAD_OUT=$(ts config auto-checkpoint sideways 2>&1 || true)
check "invalid mode is rejected" \
  "$(printf '%s' "$BAD_OUT" | grep -q 'invalid mode' && echo true)"
check "rejected mode did not change the setting" "$([[ "$(ts config auto-checkpoint)" == "conservative" ]] && echo true)"

# ─── 4. Tool activity marks dirty but does not mutate task state ─────────────
REV_BEFORE=$(state_field revision)
NEXT_BEFORE=$(state_field next_action)
post_tool "$edit_event"
check "an edit marks the store dirty" "$(ts auto status | grep -q '^stale: true' && echo true)"
check "dirty marking does not bump state revision" "$([[ "$(state_field revision)" == "$REV_BEFORE" ]] && echo true)"
check "dirty marking does not change task status" "$([[ "$(task_status T2)" == "in_progress" ]] && echo true)"
check "dirty marking does not touch next_action" "$([[ "$(state_field next_action)" == "$NEXT_BEFORE" ]] && echo true)"

post_tool "$bash_event"
post_tool "$edit_event"
check "repeated activity accumulates signals" "$(ts auto status | grep -q '^signal_count: 3' && echo true)"
check "a passing test run does NOT mark any task done" "$([[ "$(task_status T2)" == "in_progress" ]] && echo true)"
check "no task was auto-completed" \
  "$(STATE_PATH="$STATE" python3 -c '
import json, os
s = json.load(open(os.environ["STATE_PATH"]))
topic = next(t for t in s["topics"] if t["name"] == s["active_topic"])
print("true" if not any(t["status"] == "done" for t in topic["tasks"]) else "false")')"

# ─── 5. Repeated activity does not repeatedly trigger reconciliation ─────────
# Three dirty signals have accumulated; only the first boundary may ask.
OUT1=$(stop_hook)
check "Stop with dirty state requests reconciliation" "$([[ -n "$OUT1" ]] && echo true)"
OUT2=$(stop_hook)
OUT3=$(stop_hook)
check "immediately repeated Stop does not ask again (no duplicate)" \
  "$([[ -z "$OUT2" && -z "$OUT3" ]] && echo true)"
post_tool "$edit_event"
OUT4=$(stop_hook)
check "more activity within the debounce window still does not re-ask" "$([[ -z "$OUT4" ]] && echo true)"

# ─── 6. The instruction itself ───────────────────────────────────────────────
CTX=$(HOOK_OUT="$OUT1" python3 -c '
import json, os
print(json.loads(os.environ["HOOK_OUT"])["hookSpecificOutput"]["additionalContext"])')
EVT=$(HOOK_OUT="$OUT1" python3 -c '
import json, os
print(json.loads(os.environ["HOOK_OUT"])["hookSpecificOutput"]["hookEventName"])')

check "Stop output is valid hookSpecificOutput for the Stop event" "$([[ "$EVT" == "Stop" ]] && echo true)"
check "instruction states repository/tests outrank task-store" \
  "$(printf '%s' "$CTX" | grep -q 'repository/tests > git state > task-store > model memory' && echo true)"
check "instruction forbids completing without evidence" \
  "$(printf '%s' "$CTX" | grep -qi 'not mark a task done without evidence' && echo true)"
check "instruction forbids inventing a next action" \
  "$(printf '%s' "$CTX" | grep -qi 'not invent decisions, blockers, or a next action' && echo true)"
check "instruction points at the existing CLI, not a new API" \
  "$(printf '%s' "$CTX" | grep -q 'task-store start|done|attempt|block|decide|next' && echo true)"
check "instruction stays small (< 1200 chars)" "$([[ ${#CTX} -lt 1200 ]] && echo true)"

# ─── 7. The agent reconciles through the existing CLI ────────────────────────
ts done T2 -e "src/parser.ts" -e "npm test: 12 passing" >/dev/null
check "explicit CLI call is what actually completes the task" "$([[ "$(task_status T2)" == "done" ]] && echo true)"
check "reconciling via the CLI clears staleness" "$(ts auto status | grep -q '^stale: false' && echo true)"
check "checkpoint now reflects repository reality" "$(ts status | grep -q 'may be stale' && echo false || echo true)"

# A task-store call routed through Bash must not re-dirty the store it just
# wrote — otherwise reconciliation would be self-defeating.
post_tool "$selfref_event"
check "a task-store command in Bash does not re-mark the store dirty" \
  "$(ts auto status | grep -q '^stale: false' && echo true)"
check "Stop is silent once the checkpoint is current" "$([[ -z "$(stop_hook)" ]] && echo true)"

# ─── 8. PreCompact / SessionEnd boundaries ───────────────────────────────────
check "PreCompact with a clean store emits no reconciliation" \
  "$([[ -z "$(precompact_hook 2>/dev/null)" ]] && echo true)"
check "PreCompact with a clean store still writes its checkpoint marker" \
  "$(precompact_hook >/dev/null 2>&1; tail -1 "$PROJ/.claude-task/history.jsonl" | grep -q pre_compact_checkpoint && echo true)"
check "SessionEnd with a clean store emits no staleness warning" \
  "$(session_end_hook | grep -q 'unreconciled' && echo false || echo true)"

# Force a dirty store with an elapsed debounce window by rewinding the
# last-request timestamp. This is the only way to exercise the post-debounce
# path without sleeping for two minutes in CI.
post_tool "$edit_event"
RUNTIME_PATH="$RUNTIME" python3 -c '
import json, os
from datetime import datetime, timedelta, timezone
p = os.environ["RUNTIME_PATH"]
r = json.load(open(p))
r["last_reconcile_request_at"] = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
json.dump(r, open(p, "w"))
'
PC=$(precompact_hook 2>/dev/null)
check "PreCompact with dirty state requests reconciliation" \
  "$(printf '%s' "$PC" | grep -q 'Reconcile it with repository/test reality' && echo true)"
check "PreCompact reconciliation carries the authority order" \
  "$(printf '%s' "$PC" | grep -q 'repository/tests > git state > task-store > model memory' && echo true)"
check "PreCompact consumed the debounce window (Stop does not also ask)" \
  "$([[ -z "$(stop_hook)" ]] && echo true)"

post_tool "$edit_event"
SE=$(session_end_hook)
check "SessionEnd with dirty state warns the user about staleness" \
  "$(printf '%s' "$SE" | grep -q 'unreconciled changes' && echo true)"
check "SessionEnd warning does not consume the debounce window" \
  "$(ts auto status | grep -q '^stale: true' && echo true)"
check "SessionEnd never mutates task state" "$([[ "$(task_status T1)" == "pending" ]] && echo true)"

# ─── 9. Disabling stops everything ───────────────────────────────────────────
ts config auto-checkpoint off >/dev/null
check "disabling clears the runtime marker" "$([[ ! -f "$RUNTIME" ]] && echo true)"
post_tool "$edit_event"; post_tool "$bash_event"
check "no dirty tracking after disabling" "$([[ ! -f "$RUNTIME" ]] && echo true)"
check "Stop is silent after disabling" "$([[ -z "$(stop_hook)" ]] && echo true)"
check "PreCompact emits no reconciliation after disabling" "$([[ -z "$(precompact_hook 2>/dev/null)" ]] && echo true)"
check "SessionEnd emits no warning after disabling" \
  "$(session_end_hook | grep -q 'unreconciled' && echo false || echo true)"
check "status reports off again" "$(ts status | grep -q '^Auto-checkpoint: off$' && echo true)"

# ─── 10. Uninstall remains safe ──────────────────────────────────────────────
bash "$ROOT/uninstall.sh" "$PROJ" >/dev/null 2>&1
check "uninstall removes post-tool-use.sh" "$([[ ! -f "$HOOKS/post-tool-use.sh" ]] && echo true)"
check "uninstall removes stop.sh" "$([[ ! -f "$HOOKS/stop.sh" ]] && echo true)"
check "uninstall deregisters PostToolUse and Stop" \
  "$(SETTINGS="$PROJ/.claude/settings.json" python3 -c '
import json, os
h = json.load(open(os.environ["SETTINGS"]))["hooks"]
print("true" if not h.get("PostToolUse") and not h.get("Stop") else "false")')"
check "uninstall preserves the user's task store and config" \
  "$([[ -f "$STATE" && -f "$CONFIG" ]] && echo true)"

echo ""
echo "═══════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"
[[ $FAIL -eq 0 ]]
