#!/usr/bin/env bash
# Phase 3: Cross-agent handoff test
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="node $SCRIPT_DIR/../../dist/cli.js"
PASS=0
FAIL=0

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "=== Phase 3: Cross-Agent Handoff Test ==="

# ─── Setup ────────────────────────────────────────────────────────────────────

TMPDIR_BASE=$(mktemp -d)
cleanup() { rm -rf "$TMPDIR_BASE"; }
trap cleanup EXIT

make_project() {
  local dir="$TMPDIR_BASE/$1"
  mkdir -p "$dir"
  cd "$dir" && git init -q
  echo "$dir"
}

# ─── Test 1: Claude initializes 8-task project and completes several tasks ───

echo ""
echo "EXPERIMENT 1: Claude->Codex handoff"

P1=$(make_project "exp1")
cd "$P1"

# Claude initializes
$CLI --root "$P1" init \
  "Build a URL shortener service with redirect tracking" \
  "Set up project structure and dependencies" \
  "Create database schema for URLs and clicks" \
  "Implement URL shortening logic" \
  "Implement redirect endpoint" \
  "Implement click tracking" \
  "Add rate limiting" \
  "Write integration tests" \
  "Write README and deployment docs" --by claude-code > /dev/null

# Claude completes T1, T2
$CLI --root "$P1" start T1 --by claude-code > /dev/null
$CLI --root "$P1" done T1 --by claude-code \
  -e "package.json created" -e "src/ directory created" > /dev/null

$CLI --root "$P1" start T2 --by claude-code > /dev/null
$CLI --root "$P1" done T2 --by claude-code \
  -e "db/schema.sql: urls(id,short_code,long_url,created_at) and clicks(id,url_id,ip,at)" > /dev/null

# Claude records a failed approach on T3
$CLI --root "$P1" start T3 --by claude-code > /dev/null
$CLI --root "$P1" attempt T3 \
  "nanoid with 6 chars" \
  "collision rate too high at 100k URLs — switched to 8 chars with alphabet filtering" \
  --by claude-code > /dev/null

# Claude records a decision
$CLI --root "$P1" decide \
  "Use base62 8-char codes: collision-resistant at scale, URL-safe without encoding" \
  "Tested at 1M URLs: 0 collisions vs 3% with 6-char nanoid" \
  --by claude-code > /dev/null

# Claude blocks T3 (waiting for review) and sets next action
$CLI --root "$P1" block T3 "Awaiting code review on shortening algorithm before proceeding" --by claude-code > /dev/null
$CLI --root "$P1" next "Resume T3 after review: implement final base62 shortener, then proceed to T4 redirect endpoint" --by claude-code > /dev/null

echo "  Claude wrote state at revision: $(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P1/.claude-task/state.json','utf8')).revision)")"

# ─── Verify state is model-neutral ────────────────────────────────────────────

STATE_FILE="$P1/.claude-task/state.json"
read_state_field() { node -e "const {readFileSync}=require('node:fs');const s=JSON.parse(readFileSync('$1','utf8'));console.log($2)" 2>/dev/null; }

# Check: no Claude-specific fields
CLAUDE_FIELDS=$(node -e "
const {readFileSync}=require('node:fs');
const s=JSON.parse(readFileSync('$STATE_FILE','utf8'));
const bad=['thoughts','chain_of_thought','conversation_summary','model_name','prompt','tokens'];
const found=bad.filter(k=>k in s);
console.log(found.join(','));
" 2>/dev/null || echo "check_error")

if [ -z "$CLAUDE_FIELDS" ] || [ "$CLAUDE_FIELDS" = "" ]; then
  pass "No Claude-specific fields in state.json"
else
  fail "Claude-specific fields found: $CLAUDE_FIELDS"
fi

# Check: updated_by is set but only as informational
UPDATED_BY=$(read_state_field "$STATE_FILE" "s.updated_by||''")
if [ "$UPDATED_BY" = "claude-code" ]; then
  pass "updated_by provenance recorded correctly"
else
  fail "updated_by not set (got: $UPDATED_BY)"
fi

# Check: revision is present and > 0
REVISION=$(read_state_field "$STATE_FILE" "typeof s.revision===typeof 1 && s.revision>0")
if [ "$REVISION" = "true" ]; then
  pass "revision field present and incremented"
else
  fail "revision field missing or zero"
fi

# ─── Codex resumes ────────────────────────────────────────────────────────────

RESUME=$($CLI --root "$P1" resume)

# Check: Codex can identify goal
if echo "$RESUME" | grep -q "URL shortener"; then
  pass "Goal visible in resume context"
else
  fail "Goal not found in resume context"
fi

# Check: completed work visible
if echo "$RESUME" | grep -q "T1\|T2"; then
  pass "Completed tasks visible in resume context"
else
  fail "Completed tasks not visible"
fi

# Check: failed approach visible
if echo "$RESUME" | grep -qi "nanoid\|tried"; then
  pass "Failed approach visible in resume context"
else
  fail "Failed approach not visible in resume context"
fi

# Check: blocked task visible
if echo "$RESUME" | grep -q "BLOCKED\|Awaiting"; then
  pass "Blocked task visible in resume context"
else
  fail "Blocked task not visible"
fi

# Check: next action is explicit
if echo "$RESUME" | grep -q "Resume T3\|NEXT ACTION"; then
  pass "Next action explicitly stated in resume context"
else
  fail "Next action missing from resume context"
fi

# Check: decision visible
if echo "$RESUME" | grep -qi "base62\|KEY DECISIONS"; then
  pass "Key decision visible in resume context"
else
  fail "Key decision not visible in resume context"
fi

# Measure resume token estimate
CHARS=$(echo "$RESUME" | wc -c | xargs)
TOKENS=$(( CHARS / 4 ))
echo "  Resume context: ~$TOKENS tokens ($CHARS chars)"
if [ "$TOKENS" -lt 400 ]; then
  pass "Resume context under 400-token target ($TOKENS tokens)"
else
  fail "Resume context exceeds 400 tokens ($TOKENS tokens)"
fi

# Codex continues: unblocks T3 and completes it
$CLI --root "$P1" resume-task T3 --by codex > /dev/null
$CLI --root "$P1" done T3 --by codex \
  -e "src/shortener.ts: base62 8-char implementation" \
  -e "npm test: 5/5 shortener tests pass" > /dev/null

UPDATED_BY_CODEX=$(node -e "const {readFileSync}=require('node:fs');const s=JSON.parse(readFileSync('$STATE_FILE','utf8'));console.log(s.updated_by||'')" 2>/dev/null)
if [ "$UPDATED_BY_CODEX" = "codex" ]; then
  pass "Codex updated_by provenance recorded correctly"
else
  fail "Codex updated_by not set (got: $UPDATED_BY_CODEX)"
fi

echo ""
echo "EXPERIMENT 2: Codex->Claude handoff"

P2=$(make_project "exp2")
cd "$P2"

# Codex initializes and does partial work
$CLI --root "$P2" init \
  "Add pagination to REST API endpoints" \
  "Add cursor-based pagination to GET /users" \
  "Add cursor-based pagination to GET /posts" \
  "Update API documentation" \
  "Add pagination integration tests" \
  "Update client SDK" --by codex > /dev/null

$CLI --root "$P2" start T1 --by codex > /dev/null
$CLI --root "$P2" attempt T1 \
  "offset/limit pagination" \
  "Performance degrades O(n) on large tables — decided to use cursor-based instead" \
  --by codex > /dev/null
$CLI --root "$P2" decide \
  "Use opaque cursor tokens (base64 encoded id+timestamp) not offset/limit" \
  "Offset pagination breaks on concurrent inserts and is O(n) on large tables" \
  --by codex > /dev/null
$CLI --root "$P2" done T1 --by codex \
  -e "src/pagination.ts: CursorPaginator class" \
  -e "GET /users returns {data, next_cursor, has_more}" > /dev/null
$CLI --root "$P2" start T2 --by codex > /dev/null
$CLI --root "$P2" next "Complete T2: apply CursorPaginator to GET /posts endpoint — same pattern as T1" --by codex > /dev/null

CODEX_REV=$(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P2/.claude-task/state.json','utf8')).revision)")
echo "  Codex wrote state at revision: $CODEX_REV"

# Claude resumes
RESUME2=$($CLI --root "$P2" resume)

if echo "$RESUME2" | grep -q "pagination"; then
  pass "Codex->Claude: goal context visible"
else
  fail "Codex->Claude: goal context missing"
fi

if echo "$RESUME2" | grep -qi "offset\|tried"; then
  pass "Codex->Claude: Codex's failed approach visible"
else
  fail "Codex->Claude: failed approach not visible"
fi

if echo "$RESUME2" | grep -qi "cursor\|decision\|KEY DECISIONS"; then
  pass "Codex->Claude: key decision visible"
else
  fail "Codex->Claude: key decision not visible"
fi

if echo "$RESUME2" | grep -q "T2\|CURRENT"; then
  pass "Codex->Claude: current task visible"
else
  fail "Codex->Claude: current task not visible"
fi

# Claude continues correctly
$CLI --root "$P2" done T2 --by claude-code \
  -e "src/posts-endpoint.ts: CursorPaginator applied" > /dev/null

CLAUDE_UPDATED_BY=$(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P2/.claude-task/state.json','utf8')).updated_by)")
if [ "$CLAUDE_UPDATED_BY" = "claude-code" ]; then
  pass "Claude updated_by recorded after Codex->Claude handoff"
else
  fail "Claude updated_by not set in handoff (got: $CLAUDE_UPDATED_BY)"
fi

echo ""
echo "EXPERIMENT 3: Optimistic concurrency / conflict test"

P3=$(make_project "exp3")
cd "$P3"

$CLI --root "$P3" init "Concurrency test project" "Task A" "Task B" > /dev/null
$CLI --root "$P3" start T1 --by agent-a > /dev/null

# Agent A reads revision N
REV_A=$(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P3/.claude-task/state.json','utf8')).revision)")

# Agent B writes independently (simulated by direct CLI call — last-writer-wins path)
$CLI --root "$P3" next "Agent B was here first" --by agent-b > /dev/null

REV_AFTER_B=$(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P3/.claude-task/state.json','utf8')).revision)")

# Agent A tries to write with stale revision
CONFLICT_OUTPUT=$($CLI --root "$P3" done T1 --by agent-a --expect-rev "$REV_A" -e "evidence" 2>&1 || true)
if echo "$CONFLICT_OUTPUT" | grep -qi "conflict\|revision"; then
  pass "Conflict detected: stale write rejected with --expect-rev"
else
  fail "Conflict not detected (expected rejection, got: $CONFLICT_OUTPUT)"
fi

# Agent A re-reads and retries with correct revision
$CLI --root "$P3" done T1 --by agent-a --expect-rev "$REV_AFTER_B" -e "evidence after re-read" > /dev/null
FINAL_UPDATED_BY=$(node -e "const {readFileSync}=require('node:fs');console.log(JSON.parse(readFileSync('$P3/.claude-task/state.json','utf8')).updated_by)")
if [ "$FINAL_UPDATED_BY" = "agent-a" ]; then
  pass "Agent A successfully retried after re-reading revision"
else
  fail "Agent A retry failed (got updated_by: $FINAL_UPDATED_BY)"
fi

echo ""
echo "EXPERIMENT 4: CLI interoperability audit"

P4=$(make_project "exp4")
cd "$P4"

# Verify all key cross-agent operations work without Claude Code hooks or skills
$CLI --root "$P4" init "Interoperability test" "step one" "step two" "step three" > /dev/null
$CLI --root "$P4" start T1 --by any-agent > /dev/null
$CLI --root "$P4" attempt T1 "approach X" "failed because Y" --by any-agent > /dev/null
$CLI --root "$P4" decide "Use approach Z" "Y is the better approach" --by any-agent > /dev/null
$CLI --root "$P4" done T1 --by any-agent -e "src/step1.ts" > /dev/null
$CLI --root "$P4" block T2 "needs external API key" --by any-agent > /dev/null
$CLI --root "$P4" next "Unblock T2 by adding API key to config, then resume-task T2" --by any-agent > /dev/null
RESUME4=$($CLI --root "$P4" resume)

# All key fields accessible via CLI alone
for field in "GOAL" "BLOCKED" "DONE" "NEXT ACTION"; do
  if echo "$RESUME4" | grep -q "$field"; then
    pass "CLI interop: $field visible without hooks/skills"
  else
    fail "CLI interop: $field missing from resume"
  fi
done

echo ""
echo "═══════════════════════════════════════"
echo "Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
