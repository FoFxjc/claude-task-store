#!/usr/bin/env bash
# claude-task-store: Path safety regression test
#
# Regression coverage for docs/pre-release-remediation.md items 4, 7 and 8.
#
# Item 8 (path safety) is the main subject: every hook script and installer
# path must work when the project directory contains spaces, apostrophes and
# other shell metacharacters. The historical failure mode was interpolating
# "$STATE_FILE" directly into Python source text inside an unquoted heredoc,
# which turns a path like /tmp/pat's project into a Python syntax error (or,
# worse, injectable code). Every such site now exports an environment
# variable and reads it with os.environ, under a quoted 'PYEOF' delimiter.
#
# Items 4 and 7 are covered here too because both are most visible through
# the same round trip: evidence strings containing commas must survive, and
# blocking a task must not destroy pre-existing task notes.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PASS=0
FAIL=0

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

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  claude-task-store Path Safety Test                          ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# Build once so dist/cli.js is current.
(cd "$ROOT" && npm run build --silent >/dev/null 2>&1) || {
  echo "  ✗ FAIL: npm run build failed"
  exit 1
}

BASE=$(mktemp -d)
trap 'rm -rf "$BASE"' EXIT

# The hostile path: a space, an apostrophe, and a dollar sign.
PROJ="$BASE/pat's \$weird project"
mkdir -p "$PROJ"
git init -q "$PROJ"

CLI=("node" "$ROOT/dist/cli.js")

echo ""
echo "═══ Scenario 1: CLI against a path with spaces/apostrophes ═══"
echo "Test project: $PROJ"

"${CLI[@]}" init "Ship the release" "First task" "Second task" --root "$PROJ" >/dev/null 2>&1
check "init succeeds with spaces/apostrophes/\$ in --root" \
  "$([[ -f "$PROJ/.claude-task/state.json" ]] && echo true || echo false)"

check "state.json is valid JSON" \
  "$(python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$PROJ/.claude-task/state.json" >/dev/null 2>&1 && echo true || echo false)"

"${CLI[@]}" start T1 --root "$PROJ" >/dev/null 2>&1
check "start succeeds on hostile path" \
  "$("${CLI[@]}" status --root "$PROJ" 2>/dev/null | grep -q "T1" && echo true || echo false)"

# ── Item 4: evidence containing commas must survive verbatim ──────────────
echo ""
echo "═══ Scenario 2: evidence with commas (item 4) ═══"
"${CLI[@]}" done T1 -e "tests pass, all 139 of them" -e "src/core.ts" --root "$PROJ" >/dev/null 2>&1

EVIDENCE_OK=$(python3 - "$PROJ/.claude-task/state.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
topic = next(t for t in state['topics'] if t['name'] == state['active_topic'])
t1 = next(t for t in topic['tasks'] if t['id'] == 'T1')
ev = t1.get('evidence') or []
print('true' if ev == ['tests pass, all 139 of them', 'src/core.ts'] else 'false')
PYEOF
)
check "comma-containing evidence stored as one unsplit string" "$EVIDENCE_OK"

# ── Item 7: blocking a task must preserve pre-existing notes ──────────────
echo ""
echo "═══ Scenario 3: block preserves task notes (item 7) ═══"
"${CLI[@]}" start T2 --root "$PROJ" >/dev/null 2>&1
python3 - "$PROJ/.claude-task/state.json" <<'PYEOF'
import json, sys
path = sys.argv[1]
with open(path) as f:
    state = json.load(f)
topic = next(t for t in state['topics'] if t['name'] == state['active_topic'])
for t in topic['tasks']:
    if t['id'] == 'T2':
        t['notes'] = 'PRIOR CONTEXT worth keeping'
with open(path, 'w') as f:
    json.dump(state, f, indent=2)
PYEOF

"${CLI[@]}" block T2 "upstream API returns 500" --root "$PROJ" >/dev/null 2>&1

NOTES_OK=$(python3 - "$PROJ/.claude-task/state.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
topic = next(t for t in state['topics'] if t['name'] == state['active_topic'])
t2 = next(t for t in topic['tasks'] if t['id'] == 'T2')
blockers = [b for b in topic.get('blockers', []) if b.get('task_id') == 'T2']
kept = t2.get('notes') == 'PRIOR CONTEXT worth keeping'
recorded = any('upstream API returns 500' in b.get('description', '') for b in blockers)
print('true' if kept and recorded else 'false')
PYEOF
)
check "pre-existing task notes survive block; reason recorded in blockers" "$NOTES_OK"

RESUME_OUT=$("${CLI[@]}" resume --root "$PROJ" 2>/dev/null || echo "")
check "resume context renders blocker reason for blocked task" \
  "$(echo "$RESUME_OUT" | grep -q "upstream API returns 500" && echo true || echo false)"

# ── Item 8: hooks on a hostile path ───────────────────────────────────────
echo ""
echo "═══ Scenario 4: hooks on a hostile path (item 8) ═══"

# 4a. session-start.sh with the CLI available on PATH.
SHIMDIR="$BASE/shim"
mkdir -p "$SHIMDIR"
cat > "$SHIMDIR/task-store" <<SHIM
#!/usr/bin/env bash
exec node "$ROOT/dist/cli.js" "\$@"
SHIM
chmod +x "$SHIMDIR/task-store"

HOOK_OUT=$(CLAUDE_PROJECT_DIR="$PROJ" PATH="$SHIMDIR:$PATH" \
  bash "$ROOT/hooks/scripts/session-start.sh" <<< '{"session_id":"x"}' 2>/dev/null || echo "")

check "session-start.sh (CLI path) emits output on hostile path" \
  "$([[ -n "$HOOK_OUT" ]] && echo true || echo false)"

HOOK_JSON_OK=$(printf '%s' "$HOOK_OUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    out = d['hookSpecificOutput']
    ok = out['hookEventName'] == 'SessionStart' and 'Ship the release' in out['additionalContext']
    print('true' if ok else 'false')
except Exception:
    print('false')
" 2>/dev/null || echo "false")
check "session-start.sh (CLI path) emits valid JSON containing the goal" "$HOOK_JSON_OK"

# 4b. session-start.sh minimal fallback: no task-store on PATH, no local bin.
FALLBACK_OUT=$(CLAUDE_PROJECT_DIR="$PROJ" PATH="/usr/bin:/bin" \
  bash "$ROOT/hooks/scripts/session-start.sh" <<< '{"session_id":"x"}' 2>/dev/null || echo "")

FALLBACK_OK=$(printf '%s' "$FALLBACK_OUT" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    ctx = d['hookSpecificOutput']['additionalContext']
    ok = 'Ship the release' in ctx and 'minimal fallback' in ctx
    print('true' if ok else 'false')
except Exception:
    print('false')
" 2>/dev/null || echo "false")
check "session-start.sh minimal fallback emits valid JSON on hostile path" "$FALLBACK_OK"

# 4c. Archived state must suppress injection entirely.
"${CLI[@]}" archive --root "$PROJ" >/dev/null 2>&1
ARCHIVED_OUT=$(CLAUDE_PROJECT_DIR="$PROJ" PATH="$SHIMDIR:$PATH" \
  bash "$ROOT/hooks/scripts/session-start.sh" <<< '{"session_id":"x"}' 2>/dev/null || echo "")
check "session-start.sh injects nothing for archived state" \
  "$([[ -z "$ARCHIVED_OUT" ]] && echo true || echo false)"

# Restore a live state for the remaining hook tests.
rm -rf "$PROJ/.claude-task"
"${CLI[@]}" init "Second run goal" "Only task" --root "$PROJ" >/dev/null 2>&1

# 4d. pre-compact.sh must append a well-formed checkpoint on a hostile path.
CLAUDE_PROJECT_DIR="$PROJ" bash "$ROOT/hooks/scripts/pre-compact.sh" \
  <<< '{"trigger":"manual"}' >/dev/null 2>&1
check "pre-compact.sh exits 0 on hostile path" "$([[ $? -eq 0 ]] && echo true || echo false)"

CHECKPOINT_OK=$(python3 - "$PROJ/.claude-task/history.jsonl" <<'PYEOF'
import json, sys, os
path = sys.argv[1]
if not os.path.exists(path):
    print('false'); raise SystemExit(0)
found = False
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        entry = json.loads(line)
        if entry.get('event') == 'pre_compact_checkpoint' and entry.get('trigger') == 'manual':
            found = True
print('true' if found else 'false')
PYEOF
)
check "pre-compact.sh appends valid checkpoint with parsed trigger" "$CHECKPOINT_OK"

# 4e. session-end.sh must exit 0 cleanly on a hostile path.
CLAUDE_PROJECT_DIR="$PROJ" bash "$ROOT/hooks/scripts/session-end.sh" \
  <<< '{"session_id":"x"}' >/dev/null 2>&1
check "session-end.sh exits 0 on hostile path" "$([[ $? -eq 0 ]] && echo true || echo false)"

# 4f. Hooks must stay silent (exit 0, no output) when there is no state file.
NOSTATE="$BASE/no state here"
mkdir -p "$NOSTATE"
for hook in session-start pre-compact session-end; do
  OUT=$(CLAUDE_PROJECT_DIR="$NOSTATE" bash "$ROOT/hooks/scripts/$hook.sh" <<< '{}' 2>/dev/null || echo "HOOKFAIL")
  check "$hook.sh is silent and succeeds with no state file" \
    "$([[ -z "$OUT" ]] && echo true || echo false)"
done

# 4g. Corrupt state must not crash any hook.
echo 'not json at all {{{' > "$PROJ/.claude-task/state.json"
for hook in session-start pre-compact session-end; do
  if CLAUDE_PROJECT_DIR="$PROJ" bash "$ROOT/hooks/scripts/$hook.sh" <<< '{}' >/dev/null 2>&1; then
    check "$hook.sh survives corrupt state.json" "true"
  else
    check "$hook.sh survives corrupt state.json" "false"
  fi
done

# ── Installer on a hostile path ───────────────────────────────────────────
echo ""
echo "═══ Scenario 5: installer/uninstaller on a hostile path ═══"
rm -rf "$PROJ/.claude-task"

FORCE=1 bash "$ROOT/install.sh" "$PROJ" >/dev/null 2>&1
check "install.sh succeeds on hostile path" \
  "$([[ -f "$PROJ/.claude/settings.json" ]] && echo true || echo false)"

check "install.sh writes valid settings.json on hostile path" \
  "$(python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$PROJ/.claude/settings.json" >/dev/null 2>&1 && echo true || echo false)"

# Capture to a variable first: piping install.sh straight into `grep -q` makes
# grep exit on first match, SIGPIPE-ing install.sh, which `pipefail` would then
# report as a failure of the thing we are trying to assert succeeded.
REINSTALL_LOG=$(FORCE=1 bash "$ROOT/install.sh" "$PROJ" 2>&1 || true)
check "install.sh does not perform a global npm install by default (item 11)" \
  "$(printf '%s' "$REINSTALL_LOG" | grep -q "Skipping global npm install" && echo true || echo false)"

bash "$ROOT/uninstall.sh" "$PROJ" >/dev/null 2>&1
check "uninstall.sh succeeds on hostile path" \
  "$(python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$PROJ/.claude/settings.json" >/dev/null 2>&1 && echo true || echo false)"

# ── Item 6: --by rejected on read-only commands ───────────────────────────
echo ""
echo "═══ Scenario 6: --by on read-only commands (item 6) ═══"
rm -rf "$PROJ/.claude-task"
"${CLI[@]}" init "Flag goal" "T" --root "$PROJ" >/dev/null 2>&1

if "${CLI[@]}" status --by codex --root "$PROJ" >/dev/null 2>&1; then
  check "--by rejected on read-only \`status\`" "false"
else
  check "--by rejected on read-only \`status\`" "true"
fi

if "${CLI[@]}" add "another task" --by codex --root "$PROJ" >/dev/null 2>&1; then
  check "--by accepted on writing \`add\`" "true"
else
  check "--by accepted on writing \`add\`" "false"
fi

# ── Item 3: --expect-rev conflict is detected and exits 2 ─────────────────
echo ""
echo "═══ Scenario 7: --expect-rev conflict handling (item 3) ═══"
CUR_REV=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    print(json.load(f).get('revision', 0))
" "$PROJ/.claude-task/state.json")

set +e
"${CLI[@]}" next "stale write" --expect-rev 999 --root "$PROJ" >/dev/null 2>&1
STALE_RC=$?
set -e
check "stale --expect-rev write exits 2" "$([[ $STALE_RC -eq 2 ]] && echo true || echo false)"

set +e
"${CLI[@]}" next "fresh write" --expect-rev "$CUR_REV" --root "$PROJ" >/dev/null 2>&1
FRESH_RC=$?
set -e
check "matching --expect-rev write succeeds" "$([[ $FRESH_RC -eq 0 ]] && echo true || echo false)"

check "lock file is released after a locked command" \
  "$([[ ! -f "$PROJ/.claude-task/.lock" ]] && echo true || echo false)"

# A mutating command that fails validation exits via process.exit(), which
# does NOT run `finally` blocks. The lock must still be released, or the very
# next command blocks for the whole acquire timeout.
set +e
"${CLI[@]}" done T1 --root "$PROJ" >/dev/null 2>&1
set -e
check "lock released even when a mutating command exits on a validation error" \
  "$([[ ! -f "$PROJ/.claude-task/.lock" ]] && echo true || echo false)"

# ── Item 3: concurrent unlocked writers must not lose updates ─────────────
echo ""
echo "═══ Scenario 8: concurrent writers are serialized (item 3) ═══"
rm -rf "$PROJ/.claude-task"
"${CLI[@]}" init "Concurrency goal" --root "$PROJ" >/dev/null 2>&1

# Fire N concurrent `add` commands with NO --expect-rev. Each one is a
# read-modify-write of the task list. If mutating commands did not hold the
# store lock, these would interleave and silently lose tasks.
N=12
for i in $(seq 1 $N); do
  "${CLI[@]}" add "concurrent task $i" --root "$PROJ" >/dev/null 2>&1 &
done
wait

TASK_COUNT=$(python3 - "$PROJ/.claude-task/state.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
    topic = next(t for t in state['topics'] if t['name'] == state['active_topic'])
    print(len(topic['tasks']))
PYEOF
)
check "all $N concurrent \`add\` writes survive (got $TASK_COUNT)" \
  "$([[ "$TASK_COUNT" == "$N" ]] && echo true || echo false)"

DUPE_IDS=$(python3 - "$PROJ/.claude-task/state.json" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
    topic = next(t for t in state['topics'] if t['name'] == state['active_topic'])
    ids = [t['id'] for t in topic['tasks']]
print('true' if len(ids) == len(set(ids)) else 'false')
PYEOF
)
check "concurrent writes produce no duplicate task IDs" "$DUPE_IDS"

check "no lock file left behind after concurrent writes" \
  "$([[ ! -f "$PROJ/.claude-task/.lock" ]] && echo true || echo false)"

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
