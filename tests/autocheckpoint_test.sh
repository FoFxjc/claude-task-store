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
#   1. New stores persist conservative; configless legacy stores stay off.
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

edit_event='{"session_id":"test-session","tool_name":"Edit","tool_input":{"file_path":"src/a.ts"},"tool_response":{"success":true}}'
bash_event='{"session_id":"test-session","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":"12 passing"}}'
selfref_event='{"session_id":"test-session","tool_name":"Bash","tool_input":{"command":"task-store done T2 -e src/a.ts"}}'

post_tool() { printf '%s' "$1" | bash "$HOOKS/post-tool-use.sh"; }
stop_hook() { printf '{"session_id":"test-session"}' | bash "$HOOKS/stop.sh"; }
precompact_hook() { printf '{"session_id":"test-session","trigger":"auto"}' | bash "$HOOKS/pre-compact.sh"; }
session_end_hook() { printf '{"session_id":"test-session","reason":"exit"}' | bash "$HOOKS/session-end.sh" 2>&1 >/dev/null; }

# Mark `test-session` as the recorded owner of the auto-checkpoint flow.
# Issue #23 turns the gate on: tool activity and reconciliation requests
# are only honoured when the calling session has explicitly attached. This
# mirrors what a real Claude Code session would do after the user accepts
# the SessionStart prompt.
node "$CLI" attach --session-id test-session --host claude-code --yes --root "$PROJ" >/dev/null

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

# ─── 1. Init defaults and legacy fallback ───────────────────────────────────
NEW_STORE="$BASE/new store"
mkdir -p "$NEW_STORE"
node "$CLI" init "New project" "First task" --root "$NEW_STORE" >/dev/null
check "new init persists a config file" "$([[ -f "$NEW_STORE/.claude-task/config.json" ]] && echo true)"
check "new init defaults to conservative" \
  "$([[ "$(node "$CLI" config auto-checkpoint --root "$NEW_STORE")" == "conservative" ]] && echo true)"

LEGACY_STORE="$BASE/legacy store"
mkdir -p "$LEGACY_STORE/.claude-task"
cp "$NEW_STORE/.claude-task/state.json" "$LEGACY_STORE/.claude-task/state.json"
check "configless legacy store has no config file" \
  "$([[ ! -f "$LEGACY_STORE/.claude-task/config.json" ]] && echo true)"
check "configless legacy store remains off" \
  "$([[ "$(node "$CLI" config auto-checkpoint --root "$LEGACY_STORE")" == "off" ]] && echo true)"

INVALID_STORE="$BASE/invalid config store"
mkdir -p "$INVALID_STORE/.claude-task"
cp "$NEW_STORE/.claude-task/state.json" "$INVALID_STORE/.claude-task/state.json"
printf '%s\n' '{invalid json' > "$INVALID_STORE/.claude-task/config.json"
check "invalid legacy config falls back to off" \
  "$([[ "$(node "$CLI" config auto-checkpoint --root "$INVALID_STORE")" == "off" ]] && echo true)"

EXPLICIT_OFF_STORE="$BASE/explicit off store"
mkdir -p "$EXPLICIT_OFF_STORE"
node "$CLI" init "Opted-out project" "First task" --auto-checkpoint off --root "$EXPLICIT_OFF_STORE" >/dev/null
check "init --auto-checkpoint off persists off" \
  "$([[ "$(node "$CLI" config auto-checkpoint --root "$EXPLICIT_OFF_STORE")" == "off" ]] && echo true)"
check "init rejects an invalid auto-checkpoint mode without creating state" \
  "$(BAD_INIT="$BASE/bad init"; mkdir -p "$BAD_INIT"; node "$CLI" init "Bad" --auto-checkpoint sideways --root "$BAD_INIT" >/dev/null 2>&1 || true; [[ ! -e "$BAD_INIT/.claude-task/state.json" ]] && echo true)"

ts init "Ship the parser" "Write lexer" "Write parser" --auto-checkpoint off >/dev/null
ts start T2 >/dev/null
ts next "Implement expression parsing" >/dev/null

check "explicit-off mode is persisted" "$([[ -f "$CONFIG" && "$(ts config auto-checkpoint)" == "off" ]] && echo true)"
check "status shows Auto-checkpoint: off" "$(ts status | grep -q '^Auto-checkpoint: off$' && echo true)"

# writeMode() preserves unrelated config keys. A value containing the word
# "conservative" must not fool either shell fast path into spawning Node when
# the actual auto_checkpoint mode is off.
CONFIG_PATH="$CONFIG" python3 -c '
import json, os
p = os.environ["CONFIG_PATH"]
cfg = json.load(open(p))
cfg["note"] = "conservative guidance for another tool"
json.dump(cfg, open(p, "w"))
'
SPAWN_PROBE="$BASE/node-spawn-probe.cjs"
SPAWN_MARKER="$BASE/node-spawned"
printf '%s\n' "require('node:fs').writeFileSync(process.env.NODE_SPAWN_MARKER, 'spawned');" > "$SPAWN_PROBE"
export NODE_OPTIONS="--require=$SPAWN_PROBE"
export NODE_SPAWN_MARKER="$SPAWN_MARKER"
post_tool "$edit_event"
check "PostToolUse does not spawn Node for off mode with unrelated conservative text" \
  "$([[ ! -e "$SPAWN_MARKER" ]] && echo true)"
stop_hook >/dev/null
check "Stop does not spawn Node for off mode with unrelated conservative text" \
  "$([[ ! -e "$SPAWN_MARKER" ]] && echo true)"
unset NODE_OPTIONS NODE_SPAWN_MARKER

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

# Re-attach: switching the mode OFF clears the attachment (a session that ends
# while the mode is off would otherwise leave a dead owner behind, and the
# session-end hook deliberately skips its release when the mode is off). The
# enabler is therefore asked to opt in again — which for a real session means
# the attach prompt appearing once more.
node "$CLI" attach --session-id test-session --host claude-code --yes --root "$PROJ" >/dev/null
check "re-enabling conservative asks the session to attach again" \
  "$(node "$CLI" attach status --root "$PROJ" | grep -q 'test-session' && echo true || echo false)"
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
# Issue #23: a session that owns the attachment releases it on SessionEnd, so
# the next session is not forced to confirm a takeover. Assert that here, then
# re-attach — which is exactly what the next session's SessionStart prompt
# would do after the user accepts.
check "SessionEnd releases the owner's attachment (issue #23)" \
  "$(node "$CLI" attach status --root "$PROJ" | grep -q '^attached: none$' && echo true)"
node "$CLI" attach --session-id test-session --host claude-code --yes --root "$PROJ" >/dev/null
check "re-attaching after SessionEnd restores ownership" \
  "$(node "$CLI" attach status --root "$PROJ" | grep -q 'test-session' && echo true)"

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

# ─── 8b. auto take-instruction: owner-gated, one-shot (issue #23) ────────────
# The OpenCode adapter collects the staged reconciliation instruction through
# this verb, so that the ownership check and the delete happen together under
# the store lock. These pin the gates an adapter relies on.
#
# The SessionEnd check directly above released the attachment, so re-establish
# it: everything below is about what the *owner* can collect.
node "$CLI" attach --session-id test-session --host claude-code --yes --root "$PROJ" >/dev/null
STAGED="$PROJ/.claude-task/.pending-reconcile-instruction.txt"
# Written in the core's record format: the staged instruction is bound to the
# session that staged it, so a bare text file is deliberately not collectable
# by anyone (see the unreadable-record case in the Jest suite).
python3 - "$STAGED" <<'PYEOF'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({"session_id": "test-session", "instruction": "STAGED-INSTRUCTION",
               "staged_at": "2026-01-01T00:00:00.000Z"}, f)
PYEOF

TAKE_DETACHED_RC=0
TAKE_DETACHED=$(node "$CLI" auto take-instruction --root "$PROJ" --session-id someone-else 2>&1) || TAKE_DETACHED_RC=$?
check "take-instruction refuses a session that does not own the attachment" \
  "$([[ $TAKE_DETACHED_RC -ne 0 ]] && echo true || echo false)"
check "a refused collection leaves the instruction staged for the owner" \
  "$([[ -s "$STAGED" ]] && echo true || echo false)"

TAKE_MISSING_RC=0
node "$CLI" auto take-instruction --root "$PROJ" >/dev/null 2>&1 || TAKE_MISSING_RC=$?
check "take-instruction refuses a call with no session id" \
  "$([[ $TAKE_MISSING_RC -ne 0 ]] && echo true || echo false)"

TAKE_OK=$(node "$CLI" auto take-instruction --root "$PROJ" --session-id test-session 2>&1)
check "take-instruction hands the instruction to the owning session" \
  "$(printf '%s' "$TAKE_OK" | grep -q 'STAGED-INSTRUCTION' && echo true || echo false)"
check "collection consumed the file (one-shot)" \
  "$([[ ! -f "$STAGED" ]] && echo true || echo false)"

TAKE_AGAIN_RC=0
node "$CLI" auto take-instruction --root "$PROJ" --session-id test-session >/dev/null 2>&1 || TAKE_AGAIN_RC=$?
check "a second collection finds nothing" \
  "$([[ $TAKE_AGAIN_RC -ne 0 ]] && echo true || echo false)"

# An instruction staged before the store went inactive must not be delivered:
# the agent would be told to reconcile a checkpoint it can no longer see.
python3 - "$STAGED" <<'PYEOF'
import json, sys
with open(sys.argv[1], 'w') as f:
    json.dump({"session_id": "test-session", "instruction": "STALE-INSTRUCTION",
               "staged_at": "2026-01-01T00:00:00.000Z"}, f)
PYEOF
node "$CLI" archive --root "$PROJ" >/dev/null 2>&1
TAKE_ARCHIVED_RC=0
node "$CLI" auto take-instruction --root "$PROJ" --session-id test-session >/dev/null 2>&1 || TAKE_ARCHIVED_RC=$?
check "take-instruction refuses while the store is archived" \
  "$([[ $TAKE_ARCHIVED_RC -ne 0 ]] && echo true || echo false)"
check "the stale instruction is left in place, not silently dropped" \
  "$([[ -s "$STAGED" ]] && echo true || echo false)"
rm -f "$STAGED"
node "$CLI" init "Post-archive goal" "Only task" --root "$PROJ" >/dev/null 2>&1
node "$CLI" config auto-checkpoint conservative --root "$PROJ" >/dev/null 2>&1

# ─── 8c. SessionStart attach prompt fails closed ─────────────────────────────
# `attach status` is the only thing that can tell the hook whether to invite
# the user to continue existing work. If that call fails — older runtime,
# partial install, transient error — the hook must inject nothing about
# attachment. Treating a silent failure as the "no owner" sentinel would emit a
# prompt carrying a command this install may not support.
#
# Exercised against a stub runtime so the failure is deterministic: the real
# CLI has no way to be selectively broken.
STUB="$BASE/stub project"
mkdir -p "$STUB/.claude/task-store/bin" "$STUB/.claude-task"
cp "$STATE" "$STUB/.claude-task/state.json"
cat > "$STUB/.claude/task-store/bin/task-store.js" <<'STUBEOF'
#!/usr/bin/env node
// Minimal stand-in for the real runtime: successful `config` and `resume`,
// and an `attach status` whose behaviour is set by ATTACH_STUB_MODE.
const args = process.argv.slice(2);
const mode = process.env.ATTACH_STUB_MODE || "fail";
if (args[0] === "config") { process.stdout.write("conservative\n"); process.exit(0); }
if (args[0] === "resume") { process.stdout.write("TASK STORE — RESUME CONTEXT\nGOAL: stub\n"); process.exit(0); }
if (args[0] === "attach" && args[1] === "status") {
  if (mode === "fail") process.exit(1);
  if (mode === "empty") process.exit(0);
  if (mode === "none") { process.stdout.write("attached: none\n"); process.exit(0); }
  process.stdout.write("attached: session_id=other host=claude-code attached_at=2026-01-01T00:00:00Z\n");
  process.exit(0);
}
process.exit(1);
STUBEOF

# Run the real hook against the stub runtime. The mode must be passed as a
# real command word's environment — `VAR=x OUT=$(cmd)` does NOT work here,
# because the command substitution is expanded before the temporary
# assignment takes effect, which silently runs the stub in its default mode
# and makes a fail-closed assertion pass for the wrong reason.
stub_hook() {
  ATTACH_STUB_MODE="$1" CLAUDE_PROJECT_DIR="$STUB" \
    bash "$ROOT/hooks/scripts/session-start.sh" <<< '{"session_id":"fresh-session"}' 2>/dev/null
}

PROMPT_MARKER='Continue those tasks in this session'

OUT_FAIL=$(stub_hook fail)
check "SessionStart emits no attach prompt when 'attach status' fails" \
  "$(printf '%s' "$OUT_FAIL" | grep -q "$PROMPT_MARKER" && echo false || echo true)"
check "SessionStart still injects resume context when 'attach status' fails" \
  "$(printf '%s' "$OUT_FAIL" | grep -q 'RESUME CONTEXT' && echo true || echo false)"

OUT_EMPTY=$(stub_hook empty)
check "SessionStart emits no attach prompt on an empty (unrecognised) status" \
  "$(printf '%s' "$OUT_EMPTY" | grep -q "$PROMPT_MARKER" && echo false || echo true)"

# Guard the guard: with a well-formed "no owner" status the prompt must appear,
# so the checks above cannot pass by the prompt branch being dead.
OUT_NONE=$(stub_hook none)
check "SessionStart still prompts on a well-formed 'attached: none' status" \
  "$(printf '%s' "$OUT_NONE" | grep -q "$PROMPT_MARKER" && echo true || echo false)"

# A different session already attached: still a prompt, and the takeover path.
OUT_OTHER=$(stub_hook other)
check "SessionStart prompts a fresh session when another session owns the store" \
  "$(printf '%s' "$OUT_OTHER" | grep -q "$PROMPT_MARKER" && echo true || echo false)"

# ─── 8d. Zero materialization (issue #23 review) ─────────────────────────────
# withStoreLock() creates `.claude-task/`, so taking the store lock is itself a
# write. An `auto` verb in a project that never ran `task-store init` must not
# create the directory the no-op was supposed to leave alone — the OpenCode
# plugin calls mark-dirty on every tool call, so this is a hot path in exactly
# the project that has no store.
BARE=$(mktemp -d)
git -C "$BARE" init -q .

for verb in "mark-dirty" "check" "reconciled" "stage-instruction" "take-instruction"; do
  node "$CLI" auto "$verb" --root "$BARE" --session-id s1 >/dev/null 2>&1 || true
done
check "no task store: auto verbs create no .claude-task/ directory" \
  "$([[ ! -d "$BARE/.claude-task" ]] && echo true || echo false)"

node "$CLI" auto status --root "$BARE" >/dev/null 2>&1 || true
check "no task store: auto status still creates nothing" \
  "$([[ ! -d "$BARE/.claude-task" ]] && echo true || echo false)"

# Adapter attrs (mark-dirty / check) with no store must not materialize either.
node "$CLI" auto mark-dirty edit --root "$BARE" --session-id test-session >/dev/null 2>&1 || true
node "$CLI" auto check --instruction --root "$BARE" --session-id test-session >/dev/null 2>&1 || true
check "no task store: adapter calls create no .claude-task/ directory" \
  "$([[ ! -d "$BARE/.claude-task" ]] && echo true || echo false)"

# Off is the other half of the invariant: a project that opted out must not get
# auto-checkpoint writes, and must not have a stale owner left behind either.
node "$CLI" init "Off project" "T1" --root "$BARE" >/dev/null 2>&1
node "$CLI" config auto-checkpoint off --root "$BARE" >/dev/null 2>&1
node "$CLI" attach --session-id off-session --host claude-code --yes --root "$BARE" >/dev/null 2>&1
rm -f "$BARE/.claude-task/auto-checkpoint.json"
node "$CLI" auto mark-dirty edit --root "$BARE" --session-id off-session >/dev/null 2>&1 || true
node "$CLI" auto reconciled --root "$BARE" --session-id off-session >/dev/null 2>&1 || true
check "auto-checkpoint off: no runtime file is written" \
  "$([[ ! -f "$BARE/.claude-task/auto-checkpoint.json" ]] && echo true || echo false)"

# Switching the mode off clears the attachment: the session-end hook releases
# only in conservative mode, so nothing else would ever clear a dead owner and
# the next session to opt in would be forced through a takeover.
# (off-session still owns this throwaway store, so take over explicitly — the
# point here is the mode transition, not the attach policy.)
node "$CLI" attach --session-id dead-owner --host claude-code --takeover --confirm --root "$BARE" >/dev/null 2>&1
node "$CLI" config auto-checkpoint conservative --root "$BARE" >/dev/null 2>&1
node "$CLI" config auto-checkpoint off --root "$BARE" >/dev/null 2>&1
check "switching the mode off clears the attachment (no dead owner survives)" \
  "$(node "$CLI" attach status --root "$BARE" | grep -q '^attached: none$' && echo true || echo false)"

# ─── 8e. auto reconciled is owner-gated (issue #23 review) ───────────────────
# Clearing the shared dirty window is the most destructive verb in the set: a
# detached session doing it tells the real owner its checkpoint is clean while
# its work signal is still pending.
rm -rf "$BARE/.claude-task"
node "$CLI" init "Reconcile owner" "T1" --root "$BARE" >/dev/null 2>&1
node "$CLI" config auto-checkpoint conservative --root "$BARE" >/dev/null 2>&1
node "$CLI" attach --session-id owner-session --host claude-code --yes --root "$BARE" >/dev/null 2>&1
node "$CLI" auto mark-dirty edit --root "$BARE" --session-id owner-session >/dev/null

REC_OTHER_RC=0
node "$CLI" auto reconciled --root "$BARE" --session-id side-session >/dev/null 2>&1 || REC_OTHER_RC=$?
check "auto reconciled refuses a detached session" \
  "$([[ $REC_OTHER_RC -ne 0 ]] && echo true || echo false)"
check "a refused reconciled leaves the owner's dirty window intact" \
  "$(node "$CLI" auto status --root "$BARE" | grep -E '^dirty_since:' | grep -qv '(clean)' && echo true || echo false)"

node "$CLI" auto reconciled --root "$BARE" --session-id owner-session >/dev/null 2>&1
check "the owner can still record reconciliation" \
  "$(node "$CLI" auto status --root "$BARE" | grep -q '^dirty_since: (clean)$' && echo true || echo false)"

# ─── 8f. auto stage-instruction is owner-gated (issue #23 review) ────────────
# The staging half of the race: the adapter used to ask the CLI and then write
# the instruction file itself, with the lock released in between.
node "$CLI" auto mark-dirty edit --root "$BARE" --session-id owner-session >/dev/null
STAGE_OTHER_RC=0
node "$CLI" auto stage-instruction --root "$BARE" --session-id side-session >/dev/null 2>&1 || STAGE_OTHER_RC=$?
check "auto stage-instruction refuses a detached session" \
  "$([[ $STAGE_OTHER_RC -ne 0 ]] && echo true || echo false)"
check "a refused stage writes no pending instruction" \
  "$([[ ! -f "$BARE/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

STAGE_OWNER=$(node "$CLI" auto stage-instruction --root "$BARE" --session-id owner-session 2>&1)
check "the owner stages the canonical instruction" \
  "$(printf '%s' "$STAGE_OWNER" | grep -q 'repository/tests > git state > task-store > model memory' && echo true || echo false)"
check "the staged record is bound to the staging session" \
  "$(grep -q '"session_id": "owner-session"' "$BARE/.claude-task/.pending-reconcile-instruction.txt" && echo true || echo false)"

# A staged instruction is collectable by its owner, and only by its owner.
TAKE_SIDE_RC=0
node "$CLI" auto take-instruction --root "$BARE" --session-id side-session >/dev/null 2>&1 || TAKE_SIDE_RC=$?
check "a non-owner cannot collect the staged instruction" \
  "$([[ $TAKE_SIDE_RC -ne 0 ]] && echo true || echo false)"
check "the refused collection left it staged for the owner" \
  "$([[ -s "$BARE/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"
node "$CLI" auto take-instruction --root "$BARE" --session-id owner-session >/dev/null 2>&1
check "the owner collects it" \
  "$([[ ! -f "$BARE/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

# ─── 8g. CLI ergonomics: --release and attachment flags ─────────────────────
node "$CLI" attach --session-id owner-session --host claude-code --yes --root "$BARE" >/dev/null 2>&1
check "attach --release works without --host" \
  "$(node "$CLI" attach --release --session-id owner-session --root "$BARE" | grep -q 'released' && echo true || echo false)"
check "attach --release without --session-id is still an error" \
  "$(node "$CLI" attach --release --host claude-code --root "$BARE" >/dev/null 2>&1 && echo false || echo true)"
check "attach (write form) still requires --host" \
  "$(node "$CLI" attach --session-id x --yes --root "$BARE" >/dev/null 2>&1 && echo false || echo true)"

for flag in "--host claude-code" "--yes" "--takeover" "--confirm" "--release"; do
  # shellcheck disable=SC2086
  check "auto mark-dirty rejects meaningless $flag" \
    "$(node "$CLI" auto mark-dirty edit --session-id x $flag --root "$BARE" >/dev/null 2>&1 && echo false || echo true)"
done

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
