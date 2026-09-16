#!/usr/bin/env bash
# claude-task-store: OpenCode auto-checkpoint end-to-end smoke test
#
# Exercises the OpenCode plugin's auto-checkpoint wiring against a real
# `opencode` binary. Verifies that the OpenCode adapter behaves the same
# way the Claude Code PostToolUse + Stop hooks do:
#
#   * When auto_checkpoint = off:
#       - tool activity is a no-op
#       - no runtime marker is written
#       - no pending reconciliation file is written
#       - state.json is never mutated
#
#   * When auto_checkpoint = conservative + dirty state:
#       - session.idle boundary stages the instruction through
#         `task-store auto stage-instruction` (one locked call)
#       - the pending reconciliation file is staged under .claude-task/
#       - the staged instruction contains the trust hierarchy verbatim
#       - state.json is never mutated
#
#   * Debounce opens: a second back-to-back dirty + boundary cycle
#     within the same session does NOT re-fire reconciliation.
#
#   * Resume injection is unaffected by auto-checkpoint mode.
#
# This test does NOT require a working model API: the lifecycle hooks
# (event(session.idle), experimental.chat.system.transform) fire in
# OpenCode's headless `opencode run` mode before any model call. The
# plugin's behavior at those hooks is the contract under test; the model
# never gets involved. (The final report carries the explicit caveat
# about end-to-end model receipt being unproven in this environment.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

# `check <description> <condition-string>` where condition-string is
# exactly "true" or "false". Always wrap shell expressions so the
# condition collapses to one of those two literals.
check() {
  local desc="$1"
  local condition="$2"
  if [[ "$condition" == "true" ]]; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode not found in PATH; skipping."
  exit 77
fi

OPENCODE_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
echo "OpenCode version: $OPENCODE_VERSION"

# Helper: install the project-local CLI runtime into a project directory.
install_cli() {
  local pj="$1"
  mkdir -p "$pj/.claude/task-store/dist" "$pj/.claude/task-store/bin"
  cp "$ROOT/dist/"*.js "$pj/.claude/task-store/dist/"
  cp -R "$ROOT/dist/autocheckpoint" "$pj/.claude/task-store/dist/"
  cp "$ROOT/bin/task-store.js" "$pj/.claude/task-store/bin/"
  cat > "$pj/.claude/task-store/package.json" <<EOF
{
  "name": "claude-task-store-runtime",
  "version": "$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")",
  "private": true,
  "type": "module"
}
EOF
}

# Helper: install the OpenCode plugin (production source, no patches).
install_plugin() {
  local pj="$1"
  mkdir -p "$pj/.opencode/plugin/task-store"
  cp "$ROOT/opencode-plugin/task-store.ts" "$pj/.opencode/plugin/task-store.ts"
  cp "$ROOT/opencode-plugin/task-store/injection.ts" "$pj/.opencode/plugin/task-store/injection.ts"
}

# Helper: create an OpenCode session in `pj`, learn its session id from the
# run log, and attach that session to the project's store.
#
# Issue #23 makes auto-checkpoint session-intent-scoped: the CLI accepts
# mark-dirty / check only for the session recorded in attachment.json. The
# OpenCode plugin learns its session id from OpenCode's own events, so the
# only way to provision a matching attachment is to ask OpenCode for an id
# first and then attach it. Echoes the session id.
#
# `logfile` receives the run log; the caller continues that same session
# afterwards with `--session <id>`, which is exactly the two-step flow a user
# experiences (first turn prompts, user attaches, later turns reconcile).
attach_opencode_session() {
  local pj="$1" cli="$2" logfile="$3"
  ( cd "$pj" && opencode run --print-logs --log-level INFO "exit" ) > "$logfile" 2>&1 || true
  local sid
  sid="$(grep -oE 'ses_[A-Za-z0-9]+' "$logfile" | head -1)"
  [[ -n "$sid" ]] || return 1
  node "$cli" attach --session-id "$sid" --host opencode --yes --root "$pj" >/dev/null
  printf '%s' "$sid"
}

# ── Test 1: auto_checkpoint = off ──────────────────────────────────────────
echo ""
echo "═══ Test 1: auto_checkpoint = off (explicit opt-out) ═══"

T1=$(mktemp -d)
trap 'rm -rf "${T1:-}" "${T2:-}" "${T3:-}" "${T4:-}" "${T5:-}"' EXIT

git init -q "$T1"
install_cli "$T1"

CLI1="$T1/.claude/task-store/bin/task-store.js"
node "$CLI1" init "Build the auth system" "Write models" --auto-checkpoint off --root "$T1" >/dev/null
node "$CLI1" start T1 --root "$T1" >/dev/null
STATE_REV_BEFORE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$T1/.claude-task/state.json")

install_plugin "$T1"

cd "$T1"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_off.log 2>&1 || true

check "auto_checkpoint=off: no auto-checkpoint runtime file is created" \
  "$([[ ! -f "$T1/.claude-task/auto-checkpoint.json" ]] && echo true || echo false)"

check "auto_checkpoint=off: no pending reconciliation file is created" \
  "$([[ ! -f "$T1/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

check "auto_checkpoint=off: state.json revision is unchanged" \
  "$(if [[ -f "$T1/.claude-task/state.json" ]]; then
      r=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$T1/.claude-task/state.json")
      [[ "$r" == "$STATE_REV_BEFORE" ]] && echo true || echo false
    else
      echo false
    fi)"

# ── Test 2: conservative + clean state ─────────────────────────────────────
echo ""
echo "═══ Test 2: conservative + clean state → no reconciliation ═══"

T2=$(mktemp -d)
trap 'rm -rf "${T1}" "${T2}" "${T3:-}" "${T4:-}" "${T5:-}"' EXIT

git init -q "$T2"
install_cli "$T2"

CLI2="$T2/.claude/task-store/bin/task-store.js"
node "$CLI2" init "Build X" "Task A" --root "$T2" >/dev/null
node "$CLI2" config auto-checkpoint conservative --root "$T2" >/dev/null

install_plugin "$T2"

cd "$T2"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_clean.log 2>&1 || true

check "conservative+clean: no auto-checkpoint runtime file (nothing dirty yet)" \
  "$([[ ! -f "$T2/.claude-task/auto-checkpoint.json" ]] && echo true || echo false)"

check "conservative+clean: no pending reconciliation file (CLI returned clean)" \
  "$([[ ! -f "$T2/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

check "conservative+clean: state.json revision is unchanged" \
  "$(r=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$T2/.claude-task/state.json")
    [[ "$r" == "1" ]] && echo true || echo false)"

# ── Test 3: conservative + dirty state → pending file staged ──────────────
echo ""
echo "═══ Test 3: conservative + dirty state → pending file staged at boundary ═══"

T3=$(mktemp -d)
trap 'rm -rf "${T1}" "${T2}" "${T3}" "${T4:-}" "${T5:-}"' EXIT

git init -q "$T3"
install_cli "$T3"

CLI3="$T3/.claude/task-store/bin/task-store.js"
node "$CLI3" init "Build Y" "Task A" "Task B" --root "$T3" >/dev/null
node "$CLI3" start T1 --root "$T3" >/dev/null
node "$CLI3" config auto-checkpoint conservative --root "$T3" >/dev/null
STATE_REV_BEFORE_AC=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$T3/.claude-task/state.json")

# Manually dirty the runtime by invoking mark-dirty (this simulates what
# tool.execute.after would do; we don't need a working model API).
#
# Issue #23: the CLI now honours mark-dirty only for the session recorded in
# attachment.json. The OpenCode plugin learns its session id from OpenCode's
# own events, so the test asks OpenCode for an id first and attaches it, then
# continues that same session to exercise the boundary.
install_plugin "$T3"
SID3="$(attach_opencode_session "$T3" "$CLI3" /tmp/opencode_ac_warmup.log)"
check "conservative+dirty: obtained an OpenCode session id and attached it" \
  "$([[ -n "$SID3" ]] && node "$CLI3" attach status --root "$T3" | grep -q "${SID3:-nomatch}" && echo true || echo false)"

node "$CLI3" auto mark-dirty --root "$T3" --session-id "$SID3" >/dev/null

# Pre-flight: confirm the runtime is dirty.
PRE_FLIGHT=$(node "$CLI3" auto status --root "$T3" | grep -E '^dirty_since:' || true)
check "pre-flight: runtime is dirty after mark-dirty" \
  "$([[ -n "$PRE_FLIGHT" && "$PRE_FLIGHT" != *"dirty_since: (clean)"* ]] && echo true || echo false)"

# Install plugin with a diagnostic patch.

python3 - "$T3/.opencode/plugin/task-store.ts" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'stageReconcileBoundary(worktree, sessionID);',
    '''stageReconcileBoundary(worktree, sessionID);
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(worktree + "/.claude-task/.boundary.log", "BOUNDARY HIT instruction-staged\\n");
    } catch {}'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$T3"
opencode run --session "$SID3" --print-logs --log-level INFO "exit" > /tmp/opencode_ac_dirty.log 2>&1 || true

PENDING="$T3/.claude-task/.pending-reconcile-instruction.txt"

check "conservative+dirty: plugin's boundary hook fired at session.idle" \
  "$(if [[ -f "$T3/.claude-task/.boundary.log" ]]; then
      grep -q 'BOUNDARY HIT' "$T3/.claude-task/.boundary.log" && echo true || echo false
    else
      echo false
    fi)"

check "conservative+dirty: pending reconciliation instruction was staged" \
  "$([[ -s "$PENDING" ]] && echo true || echo false)"

# Trust hierarchy: the actual instruction says
#   "Authority order: repository/tests > git state > task-store > model memory."
# (single spaces around `>`). Match that exactly.
check "conservative+dirty: staged instruction includes the trust hierarchy" \
  "$(if [[ -s "$PENDING" ]]; then
      grep -q 'repository/tests > git state > task-store > model memory' "$PENDING" && echo true || echo false
    else
      echo false
    fi)"

check "conservative+dirty: staged instruction forbids unevidenced completion" \
  "$(if [[ -s "$PENDING" ]]; then
      grep -qi 'not mark a task done without evidence' "$PENDING" && echo true || echo false
    else
      echo false
    fi)"

check "conservative+dirty: staged instruction forbids invented next_action" \
  "$(if [[ -s "$PENDING" ]]; then
      grep -qi 'not invent' "$PENDING" && echo true || echo false
    else
      echo false
    fi)"

check "conservative+dirty: staged instruction points at the existing CLI" \
  "$(if [[ -s "$PENDING" ]]; then
      grep -q 'task-store start|done|attempt|block|decide|next' "$PENDING" && echo true || echo false
    else
      echo false
    fi)"

check "conservative+dirty: state.json revision is unchanged (no auto-completion)" \
  "$(STATE_REV_AFTER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).revision)' "$T3/.claude-task/state.json")
    [[ "$STATE_REV_BEFORE_AC" == "$STATE_REV_AFTER" ]] && echo true || echo false)"

check "conservative+dirty: state.json task statuses unchanged (no auto-completion)" \
  "$(node -e '
      const s = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      // After init/start: T1 was started (in_progress); T2 is still pending.
      // The plugin must not have advanced any status to "done".
      const topic = s.topics.find(t => t.name === s.active_topic);
      const ok = topic.tasks.every(t => t.status !== "done") && topic.tasks.every(t => t.status === "pending" || t.status === "in_progress");
      console.log(ok ? "true" : "false");
    ' "$T3/.claude-task/state.json" | grep -q true && echo true || echo false)"

check "conservative+dirty: auto-checkpoint runtime recorded a reconciliation request (debounce opened)" \
  "$(node "$CLI3" auto status --root "$T3" | grep -E '^last_reconcile_request_at:' | grep -qv 'never' && echo true || echo false)"

# The adapter stages the instruction; the CLI collects it. The file name is
# defined in both places — the adapter ships standalone and cannot import from
# src/ — so this is the only thing that pins the two together. It also pins the
# gates the adapter relies on: collection is owner-only and one-shot.
TAKE_OTHER_RC=0
node "$CLI3" auto take-instruction --root "$T3" --session-id not-the-owner \
  >/dev/null 2>&1 || TAKE_OTHER_RC=$?
check "pending instruction: a session that does not own the store cannot collect it" \
  "$([[ $TAKE_OTHER_RC -ne 0 && -s "$PENDING" ]] && echo true || echo false)"

TAKE_OWNER=$(node "$CLI3" auto take-instruction --root "$T3" --session-id "$SID3")
check "pending instruction: the owning session collects the plugin-staged text" \
  "$(printf '%s' "$TAKE_OWNER" | grep -q 'repository/tests > git state' && echo true || echo false)"
check "pending instruction: collection consumed the file (delivered once)" \
  "$([[ ! -f "$PENDING" ]] && echo true || echo false)"

TAKE_AGAIN_RC=0
node "$CLI3" auto take-instruction --root "$T3" --session-id "$SID3" >/dev/null 2>&1 || TAKE_AGAIN_RC=$?
check "pending instruction: a second collection finds nothing" \
  "$([[ $TAKE_AGAIN_RC -ne 0 ]] && echo true || echo false)"

# ── Test 4: debounce suppresses repeated reconciliation requests ───────────
echo ""
echo "═══ Test 4: debounce suppresses repeated reconciliation requests ═══"

# Already in the dirty+requested state from Test 3. Re-marking dirty
# without elapsed debounce time should NOT reopen reconciliation; the
# next `auto check` returns no-reconcile. This is the gate-2 contract
# from src/autocheckpoint.ts:shouldReconcile.
node "$CLI3" auto mark-dirty --root "$T3" --session-id "$SID3" >/dev/null
check_RC=0
node "$CLI3" auto check --root "$T3" --session-id "$SID3" >/dev/null 2>&1 || check_RC=$?
check "conservative+dirty+debounced: a second back-to-back check returns no-reconcile" \
  "$([[ "$check_RC" == "1" ]] && echo true || echo false)"

# ── Test 5: resume injection still works under conservative mode ──────────
echo ""
echo "═══ Test 5: resume injection unaffected by auto-checkpoint mode ═══"

T5=$(mktemp -d)
trap 'rm -rf "${T1}" "${T2}" "${T3}" "${T4:-}" "${T5}"' EXIT

git init -q "$T5"
install_cli "$T5"

CLI5="$T5/.claude/task-store/bin/task-store.js"
node "$CLI5" init "Resume works under conservative" "Task A" --root "$T5" >/dev/null
node "$CLI5" config auto-checkpoint conservative --root "$T5" >/dev/null

install_plugin "$T5"

# Diagnostic patch: write the injected resume text to a file so the
# test can assert the resume fired even though we cannot observe the
# model directly. Patched into the installed injection helper, which is
# where the resume text is composed; the patch asserts its own anchor so a
# refactor fails loudly rather than silently recording nothing.
python3 - "$T5/.opencode/plugin/task-store/injection.ts" <<'PYEOF'
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

anchor = """  const block = parts.join(SYSTEM_INJECTION_SEPARATOR);"""
if anchor not in content:
    sys.exit("diagnostic anchor not found in " + path)

patched = content.replace(anchor, """  if (resume) {
    try {
      writeFileSync(worktree + "/.claude-task/.system-resume.txt", resume);
    } catch {}
  }
""" + anchor)

with open(path, "w") as f:
    f.write(patched)
PYEOF

cd "$T5"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_resume.log 2>&1 || true

check "resume injection still fires under conservative mode" \
  "$(if [[ -s "$T5/.claude-task/.system-resume.txt" ]]; then
      grep -q 'GOAL: Resume works under conservative' "$T5/.claude-task/.system-resume.txt" && echo true || echo false
    else
      echo false
    fi)"

# ── Test 6: paths with spaces and apostrophes ─────────────────────────────
echo ""
echo "═══ Test 6: paths with spaces and apostrophes (conservative + dirty) ═══"

T4_TEMPLATE="/tmp/pat's odd proj-XXXXXXXX"
T4="$(mktemp -d "$T4_TEMPLATE")"
trap 'rm -rf "${T1:-}" "${T2:-}" "${T3:-}" "${T5:-}" "${T4:-}" "${T6:-}"' EXIT

git init -q "$T4"
install_cli "$T4"

CLI4="$T4/.claude/task-store/bin/task-store.js"
node "$CLI4" init "Spaced goal" "Task A" --root "$T4" >/dev/null
node "$CLI4" config auto-checkpoint conservative --root "$T4" >/dev/null

install_plugin "$T4"
SID4="$(attach_opencode_session "$T4" "$CLI4" /tmp/opencode_ac_spaced_warmup.log)"
check "spaced path: obtained an OpenCode session id and attached it" \
  "$([[ -n "$SID4" ]] && node "$CLI4" attach status --root "$T4" | grep -q "${SID4:-nomatch}" && echo true || echo false)"
node "$CLI4" auto mark-dirty --root "$T4" --session-id "$SID4" >/dev/null

python3 - "$T4/.opencode/plugin/task-store.ts" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'stageReconcileBoundary(worktree, sessionID);',
    '''stageReconcileBoundary(worktree, sessionID);
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(worktree + "/.claude-task/.boundary.log", "BOUNDARY HIT\\n");
    } catch {}'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$T4"
opencode run --session "$SID4" --print-logs --log-level INFO "exit" > /tmp/opencode_ac_spaced.log 2>&1 || true

check "spaced path: boundary hook fired" \
  "$(if [[ -f "$T4/.claude-task/.boundary.log" ]]; then
      grep -q 'BOUNDARY HIT' "$T4/.claude-task/.boundary.log" && echo true || echo false
    else
      echo false
    fi)"

check "spaced path: pending instruction staged" \
  "$([[ -s "$T4/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

# ── Test 8: attach prompt on the first chat call, asked only once ─────────
#
# Two claims that only a real host can settle:
#
#   1. The session id used for the prompt comes from the transform hook's own
#      input. On a session's FIRST chat call no tool event and no idle event
#      has fired, so a real session id in the printed command can only have
#      come from that input — which is what stops one session's identity
#      leaking into another's.
#   2. A detached session is asked once, not on every chat call.
echo ""
echo "═══ Test 8: first-call attach prompt, asked once per session ═══"

T6=$(mktemp -d)
trap 'rm -rf "${T1:-}" "${T2:-}" "${T3:-}" "${T4:-}" "${T5:-}" "${T6:-}"' EXIT

git init -q "$T6"
install_cli "$T6"

CLI6="$T6/.claude/task-store/bin/task-store.js"
node "$CLI6" init "Attach prompt" "Task A" --root "$T6" >/dev/null
node "$CLI6" config auto-checkpoint conservative --root "$T6" >/dev/null
# Deliberately no attachment: this is the fresh-session case.

install_plugin "$T6"

# Diagnostic patch: append each injected system block to a log so the test can
# see what the model would have received. The anchor is asserted, so a refactor
# fails loudly instead of silently recording nothing.
python3 - "$T6/.opencode/plugin/task-store/injection.ts" <<'DIAGEOF'
import sys

path = sys.argv[1]
with open(path) as f:
    content = f.read()

anchor = """  const block = parts.join(SYSTEM_INJECTION_SEPARATOR);"""
if anchor not in content:
    sys.exit("diagnostic anchor not found in " + path)

# The log line must come AFTER the anchor: `block` is declared by the anchor
# statement, and a `const` reference before its declaration throws.
patched = content.replace(anchor, anchor + """
  try {
    writeFileSync(worktree + "/.claude-task/.system-inject.log", block + "\\n=====\\n", { flag: "a" });
  } catch {}""")

if patched == content:
    sys.exit("diagnostic patch did not apply to " + path)

with open(path, "w") as f:
    f.write(patched)
DIAGEOF

cd "$T6"
INJECT_LOG="$T6/.claude-task/.system-inject.log"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_prompt1.log 2>&1 || true
SID6="$(grep -oE 'ses_[A-Za-z0-9]+' /tmp/opencode_ac_prompt1.log | head -1)"

check "first-call prompt: a session id is available on the very first chat call" \
  "$([[ -n "$SID6" ]] && echo true || echo false)"

check "first-call prompt: the attach prompt is injected on the first chat call" \
  "$(if [[ -s "$INJECT_LOG" ]]; then
      grep -q 'Continue those tasks in this session?' "$INJECT_LOG" && echo true || echo false
    else
      echo false
    fi)"

check "first-call prompt: the printed command carries this session's own id" \
  "$(if [[ -s "$INJECT_LOG" && -n "$SID6" ]]; then
      # The command is shell-quoted, so match the id inside its quoting.
      grep -qF -- "--session-id '$SID6'" "$INJECT_LOG" && echo true || echo false
    else
      echo false
    fi)"

# A single `opencode run` performs more than one chat call on this build, and
# each one re-enters the transform hook. The question must appear once while the
# resume projection keeps flowing — that is the per-session prompt memory, seen
# from a real host rather than from a unit stub.
CHAT_CALLS=$(grep -c '^=====$' "$INJECT_LOG" 2>/dev/null || echo 0)
PROMPTS_IN_RUN=$(grep -c 'Continue those tasks in this session?' "$INJECT_LOG" 2>/dev/null || echo 0)
RESUME_IN_RUN=$(grep -c 'RESUME CONTEXT' "$INJECT_LOG" 2>/dev/null || echo 0)
check "prompt-once: asked once across ${CHAT_CALLS} chat call(s) in one run" \
  "$([[ "$PROMPTS_IN_RUN" == "1" ]] && echo true || echo false)"
check "prompt-once: every chat call in the run still injects the resume projection" \
  "$([[ "$RESUME_IN_RUN" == "$CHAT_CALLS" && "$RESUME_IN_RUN" -ge 1 ]] && echo true || echo false)"

# A second process re-prompts. That is the documented design — the memory is
# in-process, so there is no decline state to persist, expire, or clean up —
# and this pins it so nobody "fixes" it by writing decline state to the store.
opencode run --session "$SID6" --print-logs --log-level INFO "exit" > /tmp/opencode_ac_prompt2.log 2>&1 || true
PROMPTS_TOTAL=$(grep -c 'Continue those tasks in this session?' "$INJECT_LOG" 2>/dev/null || echo 0)
check "prompt-once: a fresh process asks again (no persisted decline state)" \
  "$([[ "$PROMPTS_TOTAL" -gt "$PROMPTS_IN_RUN" ]] && echo true || echo false)"

check "prompt-once: declining wrote nothing to the task store" \
  "$([[ ! -f "$T6/.claude-task/attachment.json" ]] && echo true || echo false)"

# ── Results ───────────────────────────────────────────────────────────────
echo ""
echo "═══ RESULTS ══════════════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
echo "  Passed: $PASS / $TOTAL"
if [[ $FAIL -eq 0 ]]; then
  echo "  ✓ All tests passed!"
  exit 0
else
  echo "  ✗ $FAIL test(s) failed"
  exit 1
fi
