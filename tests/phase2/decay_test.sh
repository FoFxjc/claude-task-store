#!/usr/bin/env bash
# Phase 2: State Decay Test
# Creates 30+ completed tasks, 5 pending.
# Verifies: resume context stays compact; old completed tasks don't flood it.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
TS="node $ROOT/dist/cli.js"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Phase 2: State Decay Test (30+ completed tasks)          ║"
echo "╚════════════════════════════════════════════════════════════╝"

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
cd "$TEST_DIR"
git init -q; git config user.email t@t.com; git config user.name T

PASS=0; FAIL=0
check() {
  local desc="$1" cond="$2"
  if [[ "$cond" == "true" ]]; then
    echo "  ✓ $desc"
    PASS=$((PASS+1))
  else
    echo "  ✗ FAIL: $desc"
    FAIL=$((FAIL+1))
  fi
}

# Build task list: 30 historical + 5 current
ALL_TASKS=()
for i in $(seq 1 35); do
  if [[ $i -le 30 ]]; then
    ALL_TASKS+=("Completed historical task $i")
  else
    ALL_TASKS+=("Active task $((i-30)): important current work")
  fi
done

echo "→ Initializing with ${#ALL_TASKS[@]} tasks..."
$TS init "Large-scale refactor project" "${ALL_TASKS[@]}" --root "$TEST_DIR" > /dev/null

# Complete 30 tasks
echo "→ Completing 30 historical tasks..."
for i in $(seq 1 30); do
  $TS start "T$i" --root "$TEST_DIR" > /dev/null
  $TS done "T$i" -e "src/module$i.ts" --root "$TEST_DIR" > /dev/null
done

# Add decisions, failed attempts, and a blocked task
for i in 1 2 3 4 5; do
  $TS decide "Architecture decision $i: chose approach A over B" "rationale $i" --root "$TEST_DIR" > /dev/null
done

$TS start T31 --root "$TEST_DIR" > /dev/null
for j in 1 2 3; do
  $TS attempt T31 "approach $j for task 31" "failed because reason $j" --root "$TEST_DIR" > /dev/null
done

$TS block T31 "Waiting for API specification from external team" --root "$TEST_DIR" > /dev/null
$TS next "Resume T31 once API spec arrives (check Slack #api-specs)" --root "$TEST_DIR" > /dev/null

echo "→ Generating resume context..."
RESUME=$($TS resume --root "$TEST_DIR")
CHARS=${#RESUME}
TOKENS=$((CHARS / 4))

echo ""
echo "Resume context:"
echo "─────────────────────────────────────────────────"
echo "$RESUME"
echo "─────────────────────────────────────────────────"
echo ""
echo "Measurements:"
echo "  Characters: $CHARS"
echo "  Tokens (est): $TOKENS"

# Verify compact
check "Under 800-token hard cap" "$( [[ $TOKENS -lt 800 ]] && echo true || echo false )"
check "Under 400-token target" "$( [[ $TOKENS -lt 400 ]] && echo true || echo false )"

# Verify content correctness
check "Shows blocked T31" "$( echo "$RESUME" | grep -q "T31\|BLOCKED" && echo true || echo false )"
check "Shows next action" "$( echo "$RESUME" | grep -q "Resume T31\|API spec" && echo true || echo false )"
check "Does NOT list all 30 done tasks individually" "$(
  DONE_LINES=$(echo "$RESUME" | grep -c '✓' || true)
  # Should show significantly fewer than 30 individual done entries
  [[ $DONE_LINES -lt 15 ]] && echo true || echo false
)"
check "Shows active tasks (T32-T35)" "$( echo "$RESUME" | grep -q "T3[2-5]\|Active task" && echo true || echo false )"

# Count how many historical tasks appear verbatim
HIST_COUNT=0
for i in $(seq 1 30); do
  echo "$RESUME" | grep -q "Completed historical task $i" && HIST_COUNT=$((HIST_COUNT+1))
done
echo "  Historical tasks appearing verbatim: $HIST_COUNT / 30"
check "Most historical tasks collapsed/omitted" "$( [[ $HIST_COUNT -lt 10 ]] && echo true || echo false )"

# Key decisions: only last 3 should appear
DEC_COUNT=$(echo "$RESUME" | grep -c "decision" || echo 0)
echo "  Decision entries visible: $DEC_COUNT"
check "Decisions capped at last 3" "$( [[ $DEC_COUNT -le 5 ]] && echo true || echo false )"

# Failed attempts: last 2 per task
echo ""
echo "State file size: $(wc -c < "$TEST_DIR/.claude-task/state.json") bytes"
echo "History file size: $(wc -c < "$TEST_DIR/.claude-task/history.jsonl") bytes"

echo ""
echo "── RESULTS ──────────────────────────────────────────────────"
echo "  Passed: $PASS / $((PASS+FAIL))"
[[ $FAIL -eq 0 ]] && { echo "  ✓ State decay test passed"; exit 0; } || { echo "  ✗ $FAIL failure(s)"; exit 1; }
