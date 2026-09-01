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
#       - session.idle boundary fires checkReconcileBoundary
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

# ── Test 1: auto_checkpoint = off ──────────────────────────────────────────
echo ""
echo "═══ Test 1: auto_checkpoint = off (default behavior) ═══"

T1=$(mktemp -d)
trap 'rm -rf "${T1:-}" "${T2:-}" "${T3:-}" "${T4:-}" "${T5:-}"' EXIT

git init -q "$T1"
install_cli "$T1"

CLI1="$T1/.claude/task-store/bin/task-store.js"
node "$CLI1" init "Build the auth system" "Write models" --root "$T1" >/dev/null
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
node "$CLI3" auto mark-dirty --root "$T3" >/dev/null

# Pre-flight: confirm the runtime is dirty.
PRE_FLIGHT=$(node "$CLI3" auto status --root "$T3" | grep -E '^dirty_since:' || true)
check "pre-flight: runtime is dirty after mark-dirty" \
  "$([[ -n "$PRE_FLIGHT" && "$PRE_FLIGHT" != *"dirty_since: (clean)"* ]] && echo true || echo false)"

# Install plugin with a diagnostic patch.
install_plugin "$T3"

python3 - "$T3/.opencode/plugin/task-store.ts" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'writePendingReconciliation(worktree, decision.instruction);',
    '''writePendingReconciliation(worktree, decision.instruction);
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(worktree + "/.claude-task/.boundary.log", "BOUNDARY HIT instruction-staged\\n");
    } catch {}'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$T3"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_dirty.log 2>&1 || true

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
      const ok = s.tasks.every(t => t.status !== "done") && s.tasks.every(t => t.status === "pending" || t.status === "in_progress");
      console.log(ok ? "true" : "false");
    ' "$T3/.claude-task/state.json" | grep -q true && echo true || echo false)"

check "conservative+dirty: auto-checkpoint runtime recorded a reconciliation request (debounce opened)" \
  "$(node "$CLI3" auto status --root "$T3" | grep -E '^last_reconcile_request_at:' | grep -qv 'never' && echo true || echo false)"

# ── Test 4: debounce suppresses repeated reconciliation requests ───────────
echo ""
echo "═══ Test 4: debounce suppresses repeated reconciliation requests ═══"

# Already in the dirty+requested state from Test 3. Re-marking dirty
# without elapsed debounce time should NOT reopen reconciliation; the
# next `auto check` returns no-reconcile. This is the gate-2 contract
# from src/autocheckpoint.ts:shouldReconcile.
node "$CLI3" auto mark-dirty --root "$T3" >/dev/null
check_RC=0
node "$CLI3" auto check --root "$T3" >/dev/null 2>&1 || check_RC=$?
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
# model directly.
python3 - "$T5/.opencode/plugin/task-store.ts" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'output.system.push(resume);',
    '''const fs = await import("node:fs");
    fs.writeFileSync(worktree + "/.claude-task/.system-resume.txt", resume);
    output.system.push(resume);'''
)
with open(plugin_path, "w") as f:
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
trap 'rm -rf "${T1}" "${T2}" "${T3}" "${T5}" "${T4}"' EXIT

git init -q "$T4"
install_cli "$T4"

CLI4="$T4/.claude/task-store/bin/task-store.js"
node "$CLI4" init "Spaced goal" "Task A" --root "$T4" >/dev/null
node "$CLI4" config auto-checkpoint conservative --root "$T4" >/dev/null
node "$CLI4" auto mark-dirty --root "$T4" >/dev/null

install_plugin "$T4"

python3 - "$T4/.opencode/plugin/task-store.ts" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'writePendingReconciliation(worktree, decision.instruction);',
    '''writePendingReconciliation(worktree, decision.instruction);
    try {
      const fs = await import("node:fs");
      fs.appendFileSync(worktree + "/.claude-task/.boundary.log", "BOUNDARY HIT\\n");
    } catch {}'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$T4"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_ac_spaced.log 2>&1 || true

check "spaced path: boundary hook fired" \
  "$(if [[ -f "$T4/.claude-task/.boundary.log" ]]; then
      grep -q 'BOUNDARY HIT' "$T4/.claude-task/.boundary.log" && echo true || echo false
    else
      echo false
    fi)"

check "spaced path: pending instruction staged" \
  "$([[ -s "$T4/.claude-task/.pending-reconcile-instruction.txt" ]] && echo true || echo false)"

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
