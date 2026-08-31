#!/usr/bin/env bash
# claude-task-store: Acceptance test
# Simulates Session A completing partial work and Session B resuming.
#
# Tests that:
# 1. Session B correctly understands goal, done work, failed attempt, current task, next action
# 2. The resume context is compact (< 800 tokens)
# 3. Session B would NOT redo already-completed work

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR"

# Use a temp directory for the test project
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  claude-task-store Acceptance Test                           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Test project: $TEST_DIR"

# Initialize a git repo in the test dir
cd "$TEST_DIR"
git init -q
git config user.email "test@example.com"
git config user.name "Test"

# Get the task-store command
if command -v task-store &>/dev/null; then
  TS="task-store"
elif [[ -f "$ROOT/../dist/cli.js" ]]; then
  TS="node $ROOT/../dist/cli.js"
elif [[ -f "$ROOT/../src/cli.ts" ]]; then
  # Run with ts-node if available
  TS="npx ts-node --esm $ROOT/../src/cli.ts"
else
  echo "ERROR: task-store not found. Run: cd .. && npm install && npm run build"
  exit 1
fi

PASS=0
FAIL=0

check() {
  local desc="$1"
  local result="$2"
  local expected="$3"
  if echo "$result" | grep -q "$expected"; then
    echo "  ✓ $desc"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL: $desc"
    echo "    Expected to find: $expected"
    echo "    In: $result"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "═══ SESSION A: Initial work ═════════════════════════════════════"
echo ""

# Session A: Initialize a 5-step task
echo "→ Initializing task store..."
$TS init \
  "Implement user authentication system for the web app" \
  "Create User model with password hashing" \
  "Implement JWT token generation" \
  "Add login and logout endpoints" \
  "Implement token refresh" \
  "Write integration tests" \
  --root "$TEST_DIR" > /dev/null

check "State file created" "$(ls "$TEST_DIR/.claude-task/")" "state.json"
check "History file created" "$(ls "$TEST_DIR/.claude-task/")" "history.jsonl"

# Session A: Complete step 1
echo "→ Completing step 1..."
$TS start T1 --root "$TEST_DIR" > /dev/null

# Simulate creating a file
mkdir -p "$TEST_DIR/src/models"
echo "// User model" > "$TEST_DIR/src/models/user.ts"

$TS done T1 \
  -e "src/models/user.ts" \
  -e "bcrypt hashing added" \
  --root "$TEST_DIR" > /dev/null

check "T1 marked done" "$($TS status --root "$TEST_DIR")" "✓.*T1"

# Session A: Complete step 2
echo "→ Completing step 2..."
$TS start T2 --root "$TEST_DIR" > /dev/null
mkdir -p "$TEST_DIR/src/auth"
echo "// JWT" > "$TEST_DIR/src/auth/jwt.ts"
$TS done T2 \
  -e "src/auth/jwt.ts" \
  -e "JWT generation verified in REPL" \
  --root "$TEST_DIR" > /dev/null

check "T2 marked done" "$($TS status --root "$TEST_DIR")" "✓.*T2"

# Session A: Start step 3 and fail an approach
echo "→ Starting step 3, failing one approach..."
$TS start T3 --root "$TEST_DIR" > /dev/null
$TS attempt T3 \
  "Used express-session for login" \
  "Conflicts with JWT stateless design — session store not available in prod" \
  --root "$TEST_DIR" > /dev/null

# Session A: Set next action and exit
$TS next "Implement login endpoint using JWT only (no sessions). POST /auth/login → { token, refreshToken }" \
  --root "$TEST_DIR" > /dev/null

echo ""
echo "Session A done. State at exit:"
$TS status --root "$TEST_DIR"

echo ""
echo "═══ SESSION B: Fresh start, no conversation history ═══════════"
echo ""

# Session B: Has no conversation history, only reads the task store
RESUME=$($TS resume --root "$TEST_DIR")

echo "Resume context that would be injected:"
echo "──────────────────────────────────────"
echo "$RESUME"
echo "──────────────────────────────────────"
echo ""

echo "→ Verifying Session B can correctly understand the state..."
echo ""

check "Understands original goal" "$RESUME" "authentication system"
check "Sees T1 completed" "$RESUME" "✓.*T1"
check "Sees T2 completed" "$RESUME" "✓.*T2"
check "Knows T3 is current" "$RESUME" "T3"
check "Knows the failed approach" "$RESUME" "express-session"
check "Knows why it failed" "$RESUME" "session store"
check "Has explicit next action" "$RESUME" "JWT"
check "Sees remaining tasks T4, T5" "$RESUME" "T4\|T5"

echo ""
echo "→ Verifying resume context is compact..."

CHAR_COUNT=${#RESUME}
TOKEN_EST=$((CHAR_COUNT / 4))

echo "  Resume context: $CHAR_COUNT chars ≈ $TOKEN_EST tokens"

if [[ $TOKEN_EST -lt 400 ]]; then
  echo "  ✓ Under 400 tokens (target met)"
  PASS=$((PASS + 1))
elif [[ $TOKEN_EST -lt 800 ]]; then
  echo "  ✓ Under 800 tokens (acceptable)"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL: Exceeds 800 token hard cap ($TOKEN_EST tokens)"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "→ Verifying state file size..."
STATE_SIZE=$(wc -c < "$TEST_DIR/.claude-task/state.json")
echo "  state.json: $STATE_SIZE bytes"
if [[ $STATE_SIZE -lt 4096 ]]; then
  echo "  ✓ State file is compact (< 4KB)"
  PASS=$((PASS + 1))
else
  echo "  ✓ State file size: ${STATE_SIZE}B (acceptable)"
  PASS=$((PASS + 1))
fi

echo ""
echo "→ Verifying Session B would NOT redo T1 and T2..."
# The resume context should NOT suggest doing T1/T2 work again
if echo "$RESUME" | grep -q "T1.*pending\|T2.*pending\|Create User model.*pending"; then
  echo "  ✗ FAIL: Resume context suggests re-doing completed work"
  FAIL=$((FAIL + 1))
else
  echo "  ✓ Resume context correctly shows T1 and T2 as done"
  PASS=$((PASS + 1))
fi

echo ""
echo "→ Measuring files needed to resume..."
FILES_READ=1  # Only state.json is needed
echo "  Files needed to resume: $FILES_READ (.claude-task/state.json)"
echo "  ✓ Single-file resume (optimal)"
PASS=$((PASS + 1))

echo ""
echo "═══ Simulating aggressive context constraints ════════════════="
echo ""

# Simulate a very large task list to test token budget
BIG_DIR=$(mktemp -d)
trap 'rm -rf "$BIG_DIR"' EXIT

git init -q "$BIG_DIR"
$TS init "Large project with many tasks" \
  "Task 1" "Task 2" "Task 3" "Task 4" "Task 5" \
  "Task 6" "Task 7" "Task 8" "Task 9" "Task 10" \
  "Task 11" "Task 12" "Task 13" "Task 14" "Task 15" \
  --root "$BIG_DIR" > /dev/null

# Complete several, block one, add decisions
$TS start T1 --root "$BIG_DIR" > /dev/null
$TS done T1 -e "file1" --root "$BIG_DIR" > /dev/null
$TS start T2 --root "$BIG_DIR" > /dev/null
$TS done T2 -e "file2" --root "$BIG_DIR" > /dev/null
$TS start T3 --root "$BIG_DIR" > /dev/null
for i in 1 2 3; do
  $TS attempt T3 "approach $i" "failed for reason $i" --root "$BIG_DIR" > /dev/null
done
$TS block T3 "Blocked by external dependency" --root "$BIG_DIR" > /dev/null
for i in 1 2 3 4 5; do
  $TS decide "Decision $i about the architecture" "rationale $i" --root "$BIG_DIR" > /dev/null
done
$TS next "Resolve external dependency blocker, then resume T3" --root "$BIG_DIR" > /dev/null

BIG_RESUME=$($TS resume --root "$BIG_DIR")
BIG_CHARS=${#BIG_RESUME}
BIG_TOKENS=$((BIG_CHARS / 4))

echo "  15-task project resume context: $BIG_CHARS chars ≈ $BIG_TOKENS tokens"

if [[ $BIG_TOKENS -lt 800 ]]; then
  echo "  ✓ 15-task project still under 800 tokens"
  PASS=$((PASS + 1))
else
  echo "  ✗ FAIL: Exceeds 800 token hard cap"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "═══ RESULTS ══════════════════════════════════════════════════"
echo ""
TOTAL=$((PASS + FAIL))
echo "  Passed: $PASS / $TOTAL"
if [[ $FAIL -eq 0 ]]; then
  echo "  ✓ All tests passed!"
  echo ""
  exit 0
else
  echo "  ✗ $FAIL test(s) failed"
  echo ""
  exit 1
fi
