#!/usr/bin/env bash
# Phase 2: Source-of-Truth Safety Tests
# Trust hierarchy: repository/tests > git state > task-store > model memory
#
# Tests scenarios where state.json incorrectly claims:
# - a task is complete
# - a test passed
# - a file was modified
#
# These are NEGATIVE tests: the task store MUST NOT be used as authoritative 
# project truth without verification.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/../.."
TS="node $ROOT/dist/cli.js"

echo "╔════════════════════════════════════════════════════════════╗"
echo "║  Phase 2: Source-of-Truth Safety Tests                    ║"
echo "╚════════════════════════════════════════════════════════════╝"
echo ""
echo "Testing trust hierarchy: repo/tests > git > task-store > model memory"

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

mkproject() {
  local dir=$(mktemp -d)
  cd "$dir"; git init -q; git config user.email t@t.com; git config user.name T
  echo "$dir"
}

# ─── Test 1: State claims done, but file doesn't exist ───────────────────────
echo ""
echo "── Test 1: State claims T1 done, but evidence file missing ───"
D=$(mkproject)
$TS init "Goal" "Create src/auth.ts" --root "$D" > /dev/null
$TS start T1 --root "$D" > /dev/null
$TS done T1 -e "src/auth.ts" -e "tests pass" --root "$D" > /dev/null

# The file was never actually created
# Simulate a model reading state and verifying
STATE_SAYS_DONE=$($TS status --root "$D" 2>&1 | grep -c "done" || echo 0)
FILE_EXISTS=$([[ -f "$D/src/auth.ts" ]] && echo true || echo false)
RESUME=$($TS resume --root "$D" 2>&1)

echo "  task-store says T1: done"
echo "  src/auth.ts exists: $FILE_EXISTS"
echo ""
echo "  ANALYSIS: The task store records evidence paths but does NOT verify"
echo "  they exist. The evidence string 'src/auth.ts' is a hint, not a proof."
echo "  A model resuming work SHOULD verify evidence exists before trusting done status."
echo ""
echo "  Resume context shows:"
echo "  $(echo "$RESUME" | grep -A2 "DONE\|✓")"
echo ""

# The resume context includes the done task — but a responsible model should verify
# This is a BEHAVIORAL requirement, not a state validation requirement
check "State records done status (raw claim)" "$( [[ $STATE_SAYS_DONE -gt 0 ]] && echo true || echo false )"
check "Evidence path is preserved in state" "$( $TS status --root "$D" | grep -q 'src/auth.ts' && echo true || echo false )"
check "File does NOT exist (mismatch detectable)" "$( [[ "$FILE_EXISTS" == "false" ]] && echo true || echo false )"

echo "  → SAFETY FINDING: task-store does not auto-verify evidence paths."
echo "    Models MUST treat done evidence as hints, not authoritative proof."
echo "    Rule added to SKILL.md: 'Verify evidence exists before trusting done status.'"
rm -rf "$D"

# ─── Test 2: State claims test passed, but tests actually fail ───────────────
echo ""
echo "── Test 2: State claims 'tests pass' but tests fail ──────────"
D=$(mkproject)
mkdir -p "$D/src"
cat > "$D/src/add.ts" << 'EOF'
export function add(a: number, b: number): number {
  return a - b;  // BUG: subtract instead of add
}
EOF

$TS init "Fix add function" "Fix arithmetic bug in add()" --root "$D" > /dev/null
$TS start T1 --root "$D" > /dev/null
# Falsely claim done
$TS done T1 -e "src/add.ts" -e "npm test: PASS 5/5" --root "$D" > /dev/null

# Actual test (simulated)
ACTUAL_RESULT=$(node -e "
const {add} = require('./src/add.js');
" 2>&1 || echo "test unavailable")

echo "  task-store claims: 'npm test: PASS 5/5'"
echo "  src/add.ts actual behavior: add(1,2) returns $(node -e "
const code = require('fs').readFileSync('$D/src/add.ts','utf8');
// Quick logic check
console.log(code.includes('a - b') ? '1 (wrong!)' : '3 (correct)');
" 2>/dev/null || echo 'unknown')"

echo ""
echo "  KEY INSIGHT: The task store records WHAT the model CLAIMED as evidence,"
echo "  not verified truth. The resume context says '✓ T1 done' — but the"
echo "  actual test result must be re-verified before trusting completion."
echo ""
check "State preserves false evidence claim (for audit)" \
  "$( $TS status --root "$D" | grep -q 'npm test' && echo true || echo false )"
echo "  → A resuming model seeing '✓ T1 done, evidence: npm test: PASS' should"
echo "    run tests itself if the work is consequential."
rm -rf "$D"

# ─── Test 3: Trust hierarchy documented in SKILL.md ─────────────────────────
echo ""
echo "── Test 3: Trust hierarchy in SKILL.md ───────────────────────"
SKILL_FILE="$ROOT/skills/task-store/SKILL.md"

check "SKILL.md exists" "$( [[ -f "$SKILL_FILE" ]] && echo true || echo false )"

# The trust hierarchy is a BEHAVIORAL guarantee enforced only by what SKILL.md
# tells the model, so assert on its actual content. This check previously
# incremented PASS unconditionally, which meant the hierarchy could silently
# regress out of SKILL.md while this suite still reported 8/8.
HAS_SECTION=$(grep -qi "^## Trust Hierarchy" "$SKILL_FILE" && echo true || echo false)
HAS_NOT_AUTHORITATIVE=$(grep -qi "NOT authoritative" "$SKILL_FILE" && echo true || echo false)
HAS_ORDER=$(grep -qi "Repository state" "$SKILL_FILE" && grep -qi "Model memory" "$SKILL_FILE" && echo true || echo false)
HAS_VERIFY=$(grep -qi "Run the tests yourself\|verify" "$SKILL_FILE" && echo true || echo false)

# Absolutist phrasing contradicts the hierarchy in the same file; a model told
# to "trust it" outright will not verify a stale done claim.
NO_ABSOLUTIST=$(grep -qiE "The task store IS the state\. Trust it\.|Trust the NEXT ACTION field completely|This context is authoritative" "$SKILL_FILE" && echo false || echo true)

echo "  section=$HAS_SECTION not-authoritative=$HAS_NOT_AUTHORITATIVE order=$HAS_ORDER verify=$HAS_VERIFY no-absolutist=$NO_ABSOLUTIST"

check "SKILL.md documents the trust hierarchy and does not overclaim authority" \
  "$( [[ "$HAS_SECTION" == "true" && "$HAS_NOT_AUTHORITATIVE" == "true" && "$HAS_ORDER" == "true" && "$HAS_VERIFY" == "true" && "$NO_ABSOLUTIST" == "true" ]] && echo true || echo false )"

# ─── Test 4: Git state vs task state ─────────────────────────────────────────
echo ""
echo "── Test 4: Git state divergence detection ────────────────────"
D=$(mkproject)
mkdir -p "$D/src"

$TS init "Build feature" "Create auth module" "Write tests" --root "$D" > /dev/null
$TS start T1 --root "$D" > /dev/null

# Actually create the file and commit it
echo "export const auth = () => {};" > "$D/src/auth.ts"
cd "$D"; git add src/auth.ts; git commit -q -m "add auth module"

$TS done T1 -e "src/auth.ts" -e "git: commit abc123" --root "$D" > /dev/null

# Now: git state and task-store agree. This is the happy path.
GIT_HAS_FILE=$(git -C "$D" show HEAD:src/auth.ts > /dev/null 2>&1 && echo true || echo false)
STORE_SAYS_DONE=$($TS status --root "$D" | grep -q "T1.*done\|done.*T1" && echo true || echo false)

check "Happy path: git and store agree" "$( [[ "$GIT_HAS_FILE" == "true" && "$STORE_SAYS_DONE" == "true" ]] && echo true || echo false )"

# Simulate divergence: file deleted from git (revert), but store says done
git -C "$D" rm -q src/auth.ts; git -C "$D" commit -q -m "revert: remove auth module"
GIT_HAS_FILE_NOW=$(git -C "$D" show HEAD:src/auth.ts > /dev/null 2>&1 && echo true || echo false)
STORE_STILL_DONE=$($TS status --root "$D" | grep -q "done" && echo true || echo false)

echo "  After git revert: file in git=$GIT_HAS_FILE_NOW, store says done=$STORE_STILL_DONE"
echo "  → SAFETY: task-store does not auto-detect git divergence."
echo "    Model responsibility: always verify git state for consequential tasks."
check "Store does not auto-update on git changes (documented limitation)" \
  "$( [[ "$STORE_STILL_DONE" == "true" && "$GIT_HAS_FILE_NOW" == "false" ]] && echo true || echo false )"

rm -rf "$D"

echo ""
echo "── RESULTS ──────────────────────────────────────────────────"
echo "  Passed: $PASS / $((PASS+FAIL))"
echo ""
echo "  SAFETY FINDINGS:"
echo "  1. Evidence paths in state.json are claims, not verified proofs"
echo "  2. Done status does not reflect actual test results"
echo "  3. Git divergence is not auto-detected"
echo "  4. Trust hierarchy enforcement is a BEHAVIORAL requirement, not"
echo "     a technical one — it must be documented in SKILL.md"
echo ""
echo "  SKILL.md is asserted above to document the hierarchy explicitly and to"
echo "  carry 'verify before trust' guidance for consequential tasks."
[[ $FAIL -eq 0 ]] && { echo "  ✓ All safety tests passed"; exit 0; } || { echo "  ✗ $FAIL failure(s)"; exit 1; }
