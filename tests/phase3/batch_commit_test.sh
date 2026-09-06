#!/usr/bin/env bash
# Regression suite for GitHub issue #15: atomic batch commit
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PASS=0
FAIL=0

# Run the task-store CLI with a project root as the first positional argument.
# All remaining args are passed through in order. This makes the script safe
# for project paths containing spaces or apostrophes.
# Usage: run_cli <project-root> <subcommand> [args...]
run_cli() {
  local root="$1"; shift
  node "$ROOT/dist/cli.js" "$@" --root "$root"
}

pass() { PASS=$((PASS+1)); echo "  PASS: $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }

echo "=== GitHub issue #15: Atomic Batch Commit ==="

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

# Pass paths via sys.argv to avoid shell interpolation issues.
# Args: state_dir  (relative path, e.g. "/tmp/abc/.claude-task")
state_sha256() {
  python3 - "$1" << 'PYEOF'
import sys, hashlib
state_dir = sys.argv[1]
with open(state_dir + '/state.json', 'rb') as f:
    print(hashlib.sha256(f.read()).hexdigest())
PYEOF
}

get_rev() {
  python3 - "$1" << 'PYEOF'
import sys, json
state_dir = sys.argv[1]
with open(state_dir + '/state.json') as f:
    print(json.load(f).get('revision', 0))
PYEOF
}

get_task_status() {
  python3 - "$1" "$2" << 'PYEOF'
import sys, json
state_dir, task_id = sys.argv[1], sys.argv[2]
with open(state_dir + '/state.json') as f:
    state = json.load(f)
active = state.get('active_topic', state['topics'][0]['name'])
topic = next(t for t in state['topics'] if t['name'] == active)
for t in topic['tasks']:
    if t['id'] == task_id:
        print(t['status'])
        break
PYEOF
}

get_next_action() {
  python3 - "$1" << 'PYEOF'
import sys, json
state_dir = sys.argv[1]
with open(state_dir + '/state.json') as f:
    state = json.load(f)
active = state.get('active_topic', state['topics'][0]['name'])
topic = next(t for t in state['topics'] if t['name'] == active)
print(topic.get('next_action') or '')
PYEOF
}

get_active_topic() {
  python3 - "$1" << 'PYEOF'
import sys, json
state_dir = sys.argv[1]
with open(state_dir + '/state.json') as f:
    print(json.load(f).get('active_topic', ''))
PYEOF
}

# ─── Test 1: valid multi-operation commit ─────────────────────────────────────

echo ""
echo "TEST 1: valid multi-operation commit in one write"

P=$(make_project "t1")
run_cli "$P" init "Build a parser" "Write lexer" "Write parser" "Write tests" > /dev/null

HASH_BEFORE=$(state_sha256 "$P/.claude-task")
REV_BEFORE=$(get_rev "$P/.claude-task")

cat << 'EOF' | run_cli "$P" commit --topic default --by batch-agent

{
  "operations": [
    { "type": "start", "taskId": "T1" },
    { "type": "done", "taskId": "T1", "evidence": ["src/lexer.ts"] },
    { "type": "decide", "summary": "Use a Pratt parser", "rationale": "handles precedence naturally" },
    { "type": "next", "action": "Write the parser" }
  ]
}
EOF

HASH_AFTER=$(state_sha256 "$P/.claude-task")
REV_AFTER=$(get_rev "$P/.claude-task")

if [ "$HASH_BEFORE" != "$HASH_AFTER" ]; then
  pass "state.json bytes changed after commit"
else
  fail "state.json bytes did not change after commit"
fi

if [ "$((REV_AFTER))" -eq "$((REV_BEFORE + 1))" ]; then
  pass "revision incremented by exactly 1"
else
  fail "revision changed by $((REV_AFTER - REV_BEFORE)) (expected +1)"
fi

T1_STATUS=$(get_task_status "$P/.claude-task" "T1")
if [ "$T1_STATUS" = "done" ]; then
  pass "T1 marked done via batch"
else
  fail "T1 status is '$T1_STATUS' (expected done)"
fi

T2_STATUS=$(get_task_status "$P/.claude-task" "T2")
if [ "$T2_STATUS" = "pending" ]; then
  pass "T2 remains pending (not auto-started by done T1 in batch)"
else
  fail "T2 status is '$T2_STATUS' (expected pending)"
fi

NEXT=$(get_next_action "$P/.claude-task")
if echo "$NEXT" | grep -q 'Write the parser'; then
  pass "next action set via batch"
else
  fail "next action not set (got: $NEXT)"
fi

# ─── Test 2: inactive topic update without switching active_topic ────────────────

echo ""
echo "TEST 2: inactive topic updated without switching active_topic"

P=$(make_project "t2")
run_cli "$P" init "Main goal" "T1" > /dev/null
run_cli "$P" topic add docs "Write guide" "Draft" "Review" > /dev/null

run_cli "$P" topic use default > /dev/null


BEFORE_ACTIVE=$(python3 - "$P/.claude-task" << 'PYEOF'
import sys, json
state_dir = sys.argv[1]
with open(state_dir + '/state.json') as f:
    print(json.load(f).get('active_topic', ''))
PYEOF
)
cat << 'EOF' | run_cli "$P" commit --topic docs

{
  "operations": [
    { "type": "start", "taskId": "T1" },
    { "type": "done", "taskId": "T1", "evidence": ["docs/draft.md"] }
  ]
}
EOF
AFTER_ACTIVE=$(get_active_topic "$P/.claude-task")

if [ "$BEFORE_ACTIVE" = "$AFTER_ACTIVE" ] && [ "$BEFORE_ACTIVE" = "default" ]; then
  pass "active_topic unchanged after inactive topic update"
else
  fail "active_topic changed from '$BEFORE_ACTIVE' to '$AFTER_ACTIVE'"
fi

DOCS_T1=$(python3 - "$P/.claude-task" << 'PYEOF'
import sys, json
state_dir = sys.argv[1]
with open(state_dir + '/state.json') as f:
    state = json.load(f)
docs = next(t for t in state['topics'] if t['name'] == 'docs')
for task in docs['tasks']:
    if task['id'] == 'T1':
        print(task['status'])
        break
PYEOF
)
if [ "$DOCS_T1" = "done" ]; then
  pass "docs topic task marked done despite inactive status"
else
  fail "docs topic task not updated (status: $DOCS_T1)"
fi

# ─── Test 3: invalid middle operation triggers rollback ────────────────────────

echo ""
echo "TEST 3: invalid middle operation triggers rollback"

P=$(make_project "t3")
run_cli "$P" init "Goal" "Step 1" "Step 2" > /dev/null
HASH_BEFORE=$(state_sha256 "$P/.claude-task")

# T99 does not exist → should fail and rollback
OUTPUT=$(cat << 'EOF' | run_cli "$P" commit --topic default 2>&1 || true

{
  "operations": [
    { "type": "start", "taskId": "T1" },
    { "type": "done", "taskId": "T99", "evidence": ["e"] }
  ]
}
EOF
)

HASH_AFTER=$(state_sha256 "$P/.claude-task")

if echo "$OUTPUT" | grep -qi "T99"; then
  pass "error message mentions the failing task ID"
else
  fail "error message does not mention T99: $OUTPUT"
fi

if [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then
  pass "state.json byte-for-byte unchanged after rollback"
else
  fail "state.json bytes changed after failed batch (no rollback)"
fi

T1_AFTER=$(get_task_status "$P/.claude-task" "T1")
if [ "$T1_AFTER" = "pending" ]; then
  pass "T1 still pending after failed batch (not partially started)"
else
  fail "T1 is '$T1_AFTER' after failed batch (partial state leak)"
fi

# ─── Test 4: missing evidence triggers rollback ───────────────────────────────

echo ""
echo "TEST 4: missing evidence triggers rollback"

P=$(make_project "t4")
run_cli "$P" init "Goal" "T1" > /dev/null
HASH_BEFORE=$(state_sha256 "$P/.claude-task")

OUTPUT=$(cat << 'EOF' | run_cli "$P" commit --topic default 2>&1 || true

{
  "operations": [
    { "type": "done", "taskId": "T1", "evidence": [] }
  ]
}
EOF
)

HASH_AFTER=$(state_sha256 "$P/.claude-task")

if echo "$OUTPUT" | grep -qi "evidence"; then
  pass "error message mentions missing evidence"
else
  fail "error does not mention evidence: $OUTPUT"
fi

if [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then
  pass "state.json unchanged after missing-evidence rollback"
else
  fail "state.json changed despite missing evidence error"
fi

# ─── Test 5: revision conflict triggers rollback ──────────────────────────────

echo ""
echo "TEST 5: revision conflict triggers rollback"

P=$(make_project "t5")
run_cli "$P" init "Goal" "T1" "T2" > /dev/null

# Writer A writes first
run_cli "$P" start T1 --by writer-a > /dev/null

HASH_BEFORE=$(state_sha256 "$P/.claude-task")
REV_A=$(get_rev "$P/.claude-task")

# Writer B bumps revision
run_cli "$P" next "writer B was here" --by writer-b > /dev/null


# Writer A tries with stale revision
OUTPUT=$(cat << EOF | run_cli "$P" commit --topic default --expect-rev "$REV_A" --by writer-a 2>&1 || true

{ "operations": [{ "type": "next", "action": "stale write attempt" }] }
EOF
)

HASH_AFTER=$(state_sha256 "$P/.claude-task")

if echo "$OUTPUT" | grep -qiE "conflict|revision"; then
  pass "conflict error returned on stale --expect-rev"
else
  fail "no conflict error: $OUTPUT"
fi

if [ "$HASH_BEFORE" != "$HASH_AFTER" ]; then
  # The first write (writer A) changed the state
  : # pass (state was changed by writer A)
fi
# Writer A's stale write was rejected → state has writer-b's content
WRITER_B_CONTENT=$(get_next_action "$P/.claude-task")
if echo "$WRITER_B_CONTENT" | grep -q 'writer B'; then
  pass "state contains writer-b's write (writer-a's stale write rolled back)"
else
  fail "state does not contain writer-b's write (got: $WRITER_B_CONTENT)"
fi

# ─── Test 6: lock release ──────────────────────────────────────────────────────

echo ""
echo "TEST 6: lock is released after commit (success)"

P=$(make_project "t6")
run_cli "$P" init "Goal" "T1" > /dev/null

# First commit succeeds and releases lock
cat << 'EOF' | run_cli "$P" commit --topic default --by first > /dev/null

{ "operations": [{ "type": "start", "taskId": "T1" }] }
EOF

# Second commit immediately after should not fail with lock error
OUTPUT=$(cat << 'EOF2' | run_cli "$P" commit --topic default --by second 2>&1

{ "operations": [{ "type": "next", "action": "done" }] }
EOF2
)
EXIT=$?
if [ "$EXIT" -eq 0 ]; then
  pass "second commit succeeded without lock timeout"
elif echo "$OUTPUT" | grep -qi 'timeout\|timed out\|lock'; then
  fail "second commit failed with lock error: $OUTPUT"
else
  fail "second commit failed with unexpected error: $OUTPUT"
fi

# ─── Test 7: topic not found triggers rollback ─────────────────────────────────

echo ""
echo "TEST 7: topic not found triggers rollback"

P=$(make_project "t7")
run_cli "$P" init "Goal" "T1" > /dev/null
HASH_BEFORE=$(state_sha256 "$P/.claude-task")

OUTPUT=$(cat << 'EOF' | run_cli "$P" commit --topic nonexistent 2>&1 || true

{ "operations": [{ "type": "add", "title": "new task" }] }
EOF
)

HASH_AFTER=$(state_sha256 "$P/.claude-task")

if echo "$OUTPUT" | grep -qi "Topic not found"; then
  pass "error message mentions missing topic"
else
  fail "no topic-not-found error: $OUTPUT"
fi

if [ "$HASH_BEFORE" = "$HASH_AFTER" ]; then
  pass "state.json unchanged after missing-topic rollback"
else
  fail "state.json changed despite missing-topic error"
fi

# ─── Test 8: --topic and --expect-rev CLI flags override JSON body ─────────────

echo ""
echo "TEST 8: CLI --topic and --expect-rev flags override JSON body"

P=$(make_project "t8")
run_cli "$P" init "Goal" "T1" > /dev/null
INITIAL_REV=$(get_rev "$P/.claude-task")

# Body says topic=wrong-topic and expect_rev=999, but CLI flags override
cat << 'ENDJSON' | run_cli "$P" commit --topic default --expect-rev "$INITIAL_REV" --by override-test 2>&1

{ "topic": "wrong-topic", "expect_rev": 999, "operations": [{ "type": "start", "taskId": "T1" }] }
ENDJSON
if [ $? -eq 0 ]; then
  pass "CLI --topic and --expect-rev override JSON body values"
else
  fail "CLI flags did not override JSON body"
fi

# ─── Test 9: history contains batch_committed entry ────────────────────────────

echo ""
echo "TEST 9: history file contains batch_committed entry"

P=$(make_project "t9")
run_cli "$P" init "Goal" "T1" > /dev/null
cat << 'EOF' | run_cli "$P" commit --topic default --by hist-test > /dev/null

{ "operations": [{ "type": "add", "title": "new task" }] }
EOF

HIST_ENTRY=$(python3 - "$P/.claude-task/history.jsonl" << 'PYEOF'
import sys, json
path = sys.argv[1]
try:
    with open(path) as f:
        lines = f.read().strip().split('\n')
    for line in reversed(lines):
        if 'batch_committed' in line:
            print(json.loads(line).get('event', ''))
            break
except:
    pass
PYEOF
)
if [ "$HIST_ENTRY" = "batch_committed" ]; then
  pass "history.jsonl contains batch_committed event"
else
  fail "history.jsonl missing batch_committed entry (got: $HIST_ENTRY)"
fi

# ─── Test 10: topic required (no default fallback without --topic) ─────────────

echo ""
echo "TEST 10: --topic is required"

P=$(make_project "t10")
run_cli "$P" init "Goal" "T1" > /dev/null

OUTPUT=$(cat << 'EOF' | run_cli "$P" commit 2>&1 || true

{ "operations": [{ "type": "add", "title": "x" }] }
EOF
)

if echo "$OUTPUT" | grep -qi "topic"; then
  pass "error when --topic is missing"
else
  fail "no topic-required error: $OUTPUT"
fi

echo ""
echo "═══════════════════════════════════════"
# ─── Test 11: real concurrent writers ──────────────────────────────────────────

echo ""
echo "TEST 11: concurrent writers are serialized, both survive"

P=$(make_project "t11")
run_cli "$P" init "Goal" "T1" "T2" > /dev/null

REV_INIT=$(get_rev "$P/.claude-task")

# Launch two commit processes concurrently using a Node.js helper that spawns
# both node processes and waits for both simultaneously.
FILE_A=$(mktemp)
FILE_B=$(mktemp)
printf '{"operations":[{"type":"start","taskId":"T1"},{"type":"next","action":"writer A"}]}' > "$FILE_A"
printf '{"operations":[{"type":"start","taskId":"T2"},{"type":"next","action":"writer B"}]}' > "$FILE_B"

CONCURRENT_OUTPUT=$(node "$SCRIPT_DIR/concurrent_runner.js" "$ROOT/dist/cli.js" "$P" writer-a writer-b "$FILE_A" "$FILE_B")
rm -f "$FILE_A" "$FILE_B"

# Parse fixed-format output: EXIT_A=<code> EXIT_B=<code> PID_A=<num> PID_B=<num>
EXIT_A=$(echo "$CONCURRENT_OUTPUT" | sed -n 's/.*EXIT_A=\([0-9]*\).*/\1/p')
EXIT_B=$(echo "$CONCURRENT_OUTPUT" | sed -n 's/.*EXIT_B=\([0-9]*\).*/\1/p')
EXIT_A=${EXIT_A:-127}
EXIT_B=${EXIT_B:-127}

if [ "$EXIT_A" -eq 0 ] && [ "$EXIT_B" -eq 0 ]; then
  pass "both concurrent writers succeeded"
else
  fail "concurrent writer failed: A=$EXIT_A B=$EXIT_B"
fi

# Verify both T1 and T2 status updates survive independently
T1_S=$(get_task_status "$P/.claude-task" "T1")
T2_S=$(get_task_status "$P/.claude-task" "T2")
if [ "$T1_S" = "in_progress" ] && [ "$T2_S" = "in_progress" ]; then
  pass "both T1 and T2 marked in_progress by their respective writers"
else
  fail "task statuses after concurrent writes: T1=$T1_S T2=$T2_S"
fi

REV_FINAL=$(get_rev "$P/.claude-task")
if [ "$((REV_FINAL))" -eq "$((REV_INIT + 2))" ]; then
  pass "revision incremented twice (from $REV_INIT to $REV_FINAL)"
else
  fail "revision: expected $((REV_INIT + 2)), got $REV_FINAL"
fi

# No lock file remains
if [ ! -f "$P/.claude-task/.lock" ]; then
  pass "no lock file left behind"
else
  fail "lock file still exists after concurrent writers"
fi

# ─── Test 12: body-only expect_rev is ignored ──────────────────────────────────────

echo ""
echo "TEST 12: body-only expect_rev is ignored; CLI --expect-rev is authoritative"

P=$(make_project "t12")
run_cli "$P" init "Goal" "T1" > /dev/null

# First commit bumps the revision.
cat << 'EOF' | run_cli "$P" commit --topic default --by first > /dev/null
{ "operations": [{ "type": "start", "taskId": "T1" }] }
EOF

# The documented CLI stdin contract contains operations only. A body-level
# expect_rev must therefore be ignored when the flag is absent.
OUTPUT=$(cat << 'EOF' | run_cli "$P" commit --topic default 2>&1 || true
{ "expect_rev": 999, "operations": [{ "type": "next", "action": "done" }] }
EOF
)

if echo "$OUTPUT" | grep -q 'Committed'; then
  pass "body-only expect_rev is ignored"
else
  fail "body-only expect_rev affected the CLI commit: $OUTPUT"
fi

# Verify state was updated (next action set)
NEXT=$(get_next_action "$P/.claude-task")
if echo "$NEXT" | grep -q 'done'; then
  pass "commit succeeded without an --expect-rev flag"
else
  fail "next_action not set (commit may have failed silently)"
fi

# ─── Test 13: project path with space and apostrophe ─────────────────────────────

echo ""
echo "TEST 13: commit succeeds in project path with spaces and apostrophes"

# mktemp creates a directory whose path contains neither, so we craft one manually.
SPATH="$TMPDIR_BASE/my project's folder (phase 3)"
mkdir -p "$SPATH"
cd "$SPATH" && git init -q

run_cli "$SPATH" init "Goal" "T1" > /dev/null

cat << 'EOF' | run_cli "$SPATH" commit --topic default --by "david's-agent" > /dev/null
{ "operations": [{ "type": "start", "taskId": "T1" }] }
EOF

T1_STATUS=$(get_task_status "$SPATH/.claude-task" "T1")
if [ "$T1_STATUS" = "in_progress" ]; then
  pass "commit succeeded with space/apostrophe in project path"
else
  fail "commit failed in special-character path (status: $T1_STATUS)"
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════"

[ "$FAIL" -eq 0 ] && exit 0 || exit 1
