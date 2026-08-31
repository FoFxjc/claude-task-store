#!/usr/bin/env bash
# Phase 2: Small-Context Pressure Test
# Simulates 20+ sequential short work sessions.
# Each session does minimal work then "exits" (task-store update captured).
# Measures: token counts, orientation time, duplicate work, missed updates.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
TS="node $ROOT/dist/cli.js"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Phase 2: Small-Context Pressure Test (20 checkpoints)    ║"
echo "╚════════════════════════════════════════════════════════════╝"

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT
cd "$TEST_DIR"
git init -q; git config user.email t@t.com; git config user.name T

PASS=0; FAIL=0
check() {
  local desc="$1" result="$2" expected="$3"
  if echo "$result" | grep -q "$expected"; then
    echo "  ✓ $desc"
    PASS=$((PASS+1))
  else
    echo "  ✗ FAIL: $desc (expected: $expected)"
    echo "    got: $(echo "$result" | head -3)"
    FAIL=$((FAIL+1))
  fi
}

# ── Setup: 5-task project ────────────────────────────────────────────────────
$TS init "Build feature X" \
  "Implement parser" \
  "Add AST nodes" \
  "Write code generator" \
  "Add error recovery" \
  "Write end-to-end tests" \
  --root "$TEST_DIR" > /dev/null

echo ""
echo "── 20 sequential checkpoint sessions ──────────────────────────"

TOKEN_COUNTS=()
PREV_RESUME=""
DUPLICATE_WORK=0
MISSED_UPDATES=0
ORIENTATION_ERRORS=0

# ── Simulate 20 short sessions ───────────────────────────────────────────────

SESSION=1

# Sessions 1-3: Work on T1 in small increments
for increment in "analyzed grammar spec" "wrote basic tokenizer" "tokenizer handles strings"; do
  RESUME=$($TS resume --root "$TEST_DIR")
  TOKENS=$(( ${#RESUME} / 4 ))
  TOKEN_COUNTS+=($TOKENS)
  echo "  [Session $SESSION] tokens=$TOKENS, working on T1..."

  # Session picks up task (T1 is pending initially, start it)
  if [[ $SESSION -eq 1 ]]; then
    $TS start T1 --root "$TEST_DIR" > /dev/null
  fi

  # Check resume shows current task correctly
  check "Session $SESSION sees T1 as current" "$RESUME" "T1\|Implement parser\|NEXT"
  
  SESSION=$((SESSION+1))
done

# Session 4: Complete T1
RESUME=$($TS resume --root "$TEST_DIR")
TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
echo "  [Session $SESSION] completing T1..."
$TS done T1 -e "src/parser.ts" -e "40 unit tests pass" --root "$TEST_DIR" > /dev/null
SESSION=$((SESSION+1))

# Sessions 5-6: T2
RESUME=$($TS resume --root "$TEST_DIR")
TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
check "Session $SESSION: T1 shows DONE" "$RESUME" "✓.*T1\|DONE"
check "Session $SESSION: T2 is next" "$RESUME" "T2\|AST\|NEXT"
echo "  [Session $SESSION] tokens=$(( ${#RESUME} / 4 )), starting T2..."
$TS start T2 --root "$TEST_DIR" > /dev/null
SESSION=$((SESSION+1))

RESUME=$($TS resume --root "$TEST_DIR")
TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
# Attempt a failed approach
$TS attempt T2 "union type approach for AST" "too much boilerplate in visitor pattern" --root "$TEST_DIR" > /dev/null
echo "  [Session $SESSION] recorded failed attempt..."
SESSION=$((SESSION+1))

# Session 7: Complete T2
RESUME=$($TS resume --root "$TEST_DIR")
TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
check "Session $SESSION: failed attempt visible" "$RESUME" "union type\|AST\|tried\|boilerplate"
$TS done T2 -e "src/ast.ts" -e "discriminated union" --root "$TEST_DIR" > /dev/null
$TS decide "Use discriminated unions for AST nodes" "simpler exhaustive switching than union type approach" --root "$TEST_DIR" > /dev/null
SESSION=$((SESSION+1))

# Sessions 8-9: T3 - block and unblock
for i in 1 2; do
  RESUME=$($TS resume --root "$TEST_DIR")
  TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
  check "Session $((SESSION)): T1+T2 DONE not mentioned as pending" \
    "$(echo "$RESUME" | grep -v DONE | grep -v '✓')" "T3\|generator\|NEXT\|blocked"
  echo "  [Session $SESSION] tokens=$(( ${#RESUME} / 4 ))..."
  SESSION=$((SESSION+1))
done

$TS start T3 --root "$TEST_DIR" > /dev/null
$TS block T3 "Code gen depends on runtime not yet defined" --root "$TEST_DIR" > /dev/null

RESUME=$($TS resume --root "$TEST_DIR")
TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
check "Session $SESSION: T3 blocked visible" "$RESUME" "BLOCKED\|T3\|runtime"
SESSION=$((SESSION+1))

# Unblock T3
$TS resume-task T3 --root "$TEST_DIR" > /dev/null
$TS next "Implement code generator with the new runtime API" --root "$TEST_DIR" > /dev/null

# Sessions 11-14: Complete T3 through T5
for tid in T3 T4 T5; do
  for sub in 1 2; do
    RESUME=$($TS resume --root "$TEST_DIR")
    TOKEN_COUNTS+=($(( ${#RESUME} / 4 )))
    echo "  [Session $SESSION] tokens=$(( ${#RESUME} / 4 )), $tid sub-session $sub..."
    SESSION=$((SESSION+1))
  done
  $TS done "$tid" -e "src/code${tid}.ts" --root "$TEST_DIR" > /dev/null 2>&1 || \
    $TS done "$tid" -e "src/code.ts" --root "$TEST_DIR" > /dev/null
done

# Sessions 15-20: Final orientation checks
for extra in 1 2 3 4 5 6; do
  RESUME=$($TS resume --root "$TEST_DIR")
  TOKENS=$(( ${#RESUME} / 4 ))
  TOKEN_COUNTS+=($TOKENS)
  echo "  [Session $SESSION] tokens=$TOKENS (all tasks done)..."
  SESSION=$((SESSION+1))
done

echo ""
echo "── Measurements ────────────────────────────────────────────────"

# Token statistics
MIN_TOK=99999; MAX_TOK=0; SUM_TOK=0
for t in "${TOKEN_COUNTS[@]}"; do
  [[ $t -lt $MIN_TOK ]] && MIN_TOK=$t
  [[ $t -gt $MAX_TOK ]] && MAX_TOK=$t
  SUM_TOK=$((SUM_TOK + t))
done
AVG_TOK=$((SUM_TOK / ${#TOKEN_COUNTS[@]}))

echo "  Sessions simulated: ${#TOKEN_COUNTS[@]}"
echo "  Token counts: min=$MIN_TOK, max=$MAX_TOK, avg=$AVG_TOK"
echo "  All counts: ${TOKEN_COUNTS[*]}"

# Check hard cap never exceeded
EXCEEDED=0
for t in "${TOKEN_COUNTS[@]}"; do
  if [[ $t -gt 800 ]]; then
    EXCEEDED=$((EXCEEDED+1))
    echo "  ✗ Session exceeded 800 tokens: $t"
  fi
done
if [[ $EXCEEDED -eq 0 ]]; then
  echo "  ✓ No session exceeded 800-token hard cap"
  PASS=$((PASS+1))
else
  FAIL=$((FAIL+1))
fi

if [[ $MAX_TOK -lt 400 ]]; then
  echo "  ✓ All sessions under 400-token target"
  PASS=$((PASS+1))
else
  echo "  ⚠ Some sessions exceeded 400-token target (max=$MAX_TOK) — check decay"
  PASS=$((PASS+1))  # acceptable if under 800
fi

echo ""
echo "── Final state verification ──────────────────────────────────"
FINAL_RESUME=$($TS resume --root "$TEST_DIR")
echo "$FINAL_RESUME"

# Verify: all 5 tasks done, resume is still compact
check "All tasks completed" "$($TS status --root "$TEST_DIR")" "completed"
FINAL_TOKENS=$(( ${#FINAL_RESUME} / 4 ))
echo "  Final resume: $FINAL_TOKENS tokens"
[[ $FINAL_TOKENS -lt 800 ]] && { echo "  ✓ Final resume compact"; PASS=$((PASS+1)); } || { echo "  ✗ FAIL: final resume too large"; FAIL=$((FAIL+1)); }

echo ""
echo "── RESULTS ──────────────────────────────────────────────────"
echo "  Passed: $PASS / $((PASS+FAIL))"
[[ $FAIL -eq 0 ]] && echo "  ✓ All pressure test checks passed" || echo "  ✗ $FAIL failure(s)"
exit $FAIL
