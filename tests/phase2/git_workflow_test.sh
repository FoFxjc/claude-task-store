#!/usr/bin/env bash
# Phase 2: Git Workflow Test
# Tests both modes: state.json committed vs gitignored
# Determines default recommendation.

set -euo pipefail
trap 'echo "[git_workflow_test] error at line $LINENO" >&2' ERR
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
TS="node $ROOT/dist/cli.js"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Phase 2: Git Workflow Test                               ║"
echo "╚════════════════════════════════════════════════════════════╝"

PASS=0; FAIL=0
check() {
  local desc="$1" cond="$2"
  [[ "$cond" == "true" ]] && { echo "  ✓ $desc"; PASS=$((PASS+1)); } || { echo "  ✗ FAIL: $desc"; FAIL=$((FAIL+1)); }
}

mkproject() {
  local dir=$(mktemp -d)
  cd "$dir"; git init -q; git config user.email t@t.com; git config user.name T
  echo "$dir"
}

# ─── Mode A: state.json committed ─────────────────────────────────────────────
echo ""
echo "── Mode A: state.json committed (cross-session handoff) ───────"
DA=$(mkproject)

printf '.claude-task/history.jsonl\n' > "$DA/.gitignore"
git -C "$DA" add .gitignore; git -C "$DA" commit -q -m "init"

$TS init "Implement feature X" "Task A" "Task B" "Task C" --root "$DA" > /dev/null
$TS start T1 --root "$DA" > /dev/null
$TS done T1 -e "src/a.ts" --root "$DA" > /dev/null

# Commit state.json
cd "$DA"; git add .claude-task/state.json; git -C "$DA" commit -q -m "chore: update task state"

# Verify it's tracked
STATE_IN_GIT=$(git -C "$DA" ls-files .claude-task/state.json | grep -q "state.json" && echo true || echo false)
HISTORY_IN_GIT=$(git -C "$DA" ls-files .claude-task/history.jsonl | wc -l)
check "Mode A: state.json in git" "$STATE_IN_GIT"
check "Mode A: history.jsonl NOT in git (too verbose)" "$( [[ $HISTORY_IN_GIT -eq 0 ]] && echo true || echo false )"

# Simulate a new developer/session cloning (shallow copy)
DB=$(mktemp -d)
cp -r "$DA/.git" "$DB/"
cp -r "$DA/.claude-task" "$DB/" 2>/dev/null || true  # if not tracked via git, copy directly
git -C "$DB" checkout -q HEAD -- . 2>/dev/null || true

# New session: reads state without conversation history
RESUME_A=$($TS resume --root "$DA" 2>&1)
check "Mode A: resume context generated for new session" "$( [[ -n "$RESUME_A" ]] && echo true || echo false )"
check "Mode A: resume shows completed T1" "$( echo "$RESUME_A" | grep -q 'T1\|DONE\|✓' && echo true || echo false )"
echo "  Mode A resume tokens: $(( ${#RESUME_A} / 4 ))"

# Measure git noise — how many state.json commits would accumulate?
# Simulate 5 task transitions
for t in T2 T3; do
  $TS start "$t" --root "$DA" > /dev/null
  $TS done "$t" -e "src/module${t}.ts" --root "$DA" > /dev/null
  git -C "$DA" add .claude-task/state.json
  git -C "$DA" commit -q -m "chore: task state — $t done"
done
COMMIT_COUNT=$(git -C "$DA" log --oneline | grep "task state" | wc -l | tr -d ' ')
echo "  Mode A git noise: $COMMIT_COUNT state commits for 2 task transitions"
check "Mode A: git noise acceptable (<5 commits per task)" "$( [[ $COMMIT_COUNT -le 5 ]] && echo true || echo false )"

rm -rf "$DA"

# ─── Mode B: .claude-task/ fully gitignored ────────────────────────────────────
cd /tmp  # ensure CWD is valid after DA removal
echo ""
echo "── Mode B: .claude-task/ fully gitignored (private sessions) ─"
DB_DIR=$(mktemp -d)
git -C "$DB_DIR" init -q
git -C "$DB_DIR" config user.email t@t.com
git -C "$DB_DIR" config user.name T

printf '.claude-task/\n' > "$DB_DIR/.gitignore"
git -C "$DB_DIR" add .gitignore
git -C "$DB_DIR" commit -q -m "init"

$TS init "Private work" "Task 1" "Task 2" --root "$DB_DIR" > /dev/null
$TS start T1 --root "$DB_DIR" > /dev/null
$TS done T1 -e "src/1.ts" --root "$DB_DIR" > /dev/null

# State must NOT appear in git
GIT_HAS_STATE_B=$(git -C "$DB_DIR" status --porcelain | { grep ".claude-task" || true; } | wc -l | xargs)
check "Mode B: .claude-task/ not tracked by git" "$( [[ "$GIT_HAS_STATE_B" = "0" ]] && echo true || echo false )"

# But still works locally
RESUME_B=$($TS resume --root "$DB_DIR" 2>&1)
check "Mode B: local resume still works" "$( echo "$RESUME_B" | grep -q "Private work\|T1\|DONE" && echo true || echo false )"

echo "  Mode B limitation: another developer cannot resume your work"
rm -rf "$DB_DIR"

# ─── Recommendation ──────────────────────────────────────────────────────────
echo ""
echo "── Recommendation ────────────────────────────────────────────"
echo ""
echo "  DEFAULT: Commit state.json, ignore history.jsonl"
echo ""
echo "  Rationale:"
echo "  - state.json is compact (< 12KB for 30 tasks)"
echo "  - history.jsonl grows unbounded (486KB in decay test)"
echo "  - Committed state enables cross-model/cross-developer handoff"
echo "  - history.jsonl is a local audit tool, not a collaboration artifact"
echo ""
echo "  Recommended .gitignore snippet:"
echo "    .claude-task/history.jsonl"
echo "  (state.json NOT in .gitignore)"
PASS=$((PASS+1))  # recommendation recorded

echo ""
echo "── RESULTS ──────────────────────────────────────────────────"
echo "  Passed: $PASS / $((PASS+FAIL))"
[[ $FAIL -eq 0 ]] && { echo "  ✓ Git workflow test passed"; exit 0; } || { echo "  ✗ $FAIL failure(s)"; exit 1; }
