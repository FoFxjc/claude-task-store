#!/usr/bin/env bash
# Regression coverage for schema-v2 named topics and version-1 migration.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$ROOT/dist/cli.js")
PROJECT=$(mktemp -d "${TMPDIR:-/tmp}/task-store-topics.XXXXXX")
cleanup() { rm -rf "$PROJECT"; }
trap cleanup EXIT

PASS=0
FAIL=0
check() {
  local description="$1" condition="$2"
  if [[ "$condition" == "true" ]]; then
    echo "  ✓ $description"
    PASS=$((PASS + 1))
  else
    echo "  ✗ FAIL: $description"
    FAIL=$((FAIL + 1))
  fi
}

ts() { "${CLI[@]}" "$@" --root "$PROJECT"; }

echo "═══ multi-topic suite ═══"

git -C "$PROJECT" init -q .
ts init "Ship API" "Implement endpoint" >/dev/null
ts start T1 >/dev/null
ts attempt T1 "direct integration" "API unavailable" >/dev/null
ts decide "Use a fixture" "keeps tests deterministic" >/dev/null
ts next "Build the fixture" >/dev/null

ts topic add docs "Write the guide" "Draft guide" >/dev/null
check "topic add does not switch active topic" \
  "$(ts topic list | grep -q '^\* default' && echo true || echo false)"

ts topic use docs >/dev/null
ts start T1 >/dev/null
ts done T1 -e docs/guide.md >/dev/null

DOCS_RESUME=$(ts resume)
check "resume identifies the active topic" \
  "$(printf '%s' "$DOCS_RESUME" | grep -q '^TOPIC: docs$' && echo true || echo false)"
check "resume includes only active-topic content" \
  "$(printf '%s' "$DOCS_RESUME" | grep -q 'Write the guide' && ! printf '%s' "$DOCS_RESUME" | grep -q 'Ship API' && echo true || echo false)"

ts topic use default >/dev/null
DEFAULT_RESUME=$(ts resume)
check "switching back restores the original next action" \
  "$(printf '%s' "$DEFAULT_RESUME" | grep -q 'NEXT ACTION: Build the fixture' && echo true || echo false)"
check "switching back restores attempts and decisions" \
  "$(printf '%s' "$DEFAULT_RESUME" | grep -q 'API unavailable' && printf '%s' "$DEFAULT_RESUME" | grep -q 'Use a fixture' && echo true || echo false)"

STATE_CHECK=$(STATE="$PROJECT/.claude-task/state.json" python3 - <<'PYEOF'
import json, os
s = json.load(open(os.environ['STATE']))
default = next(t for t in s['topics'] if t['name'] == 'default')
docs = next(t for t in s['topics'] if t['name'] == 'docs')
ok = (
    s['version'] == '2'
    and s['active_topic'] == 'default'
    and default['tasks'][0]['attempts'][0]['outcome'] == 'API unavailable'
    and default['decisions'][0]['summary'] == 'Use a fixture'
    and docs['tasks'][0]['status'] == 'done'
    and docs['tasks'][0]['evidence'] == ['docs/guide.md']
)
print('true' if ok else 'false')
PYEOF
)
check "topics preserve independent tasks, attempts, decisions, and evidence" "$STATE_CHECK"

DUPLICATE=$(ts topic add docs "Duplicate" 2>&1 || true)
check "duplicate topic names are rejected" \
  "$(printf '%s' "$DUPLICATE" | grep -q 'Topic already exists' && echo true || echo false)"

# Replace the throwaway state with a representative schema-v1 checkpoint.
STATE="$PROJECT/.claude-task/state.json" python3 - <<'PYEOF'
import json, os
state = {
    'version': '1',
    'revision': 9,
    'goal': 'Legacy goal',
    'status': 'blocked',
    'current_task': 'T1',
    'tasks': [{
        'id': 'T1', 'title': 'Legacy task', 'status': 'blocked',
        'notes': 'keep this note', 'evidence': ['legacy proof'],
        'attempts': [{'description': 'old way', 'outcome': 'failed'}],
        'started_at': '2024-01-01T00:00:00.000Z', 'completed_at': None,
    }],
    'decisions': [{'summary': 'Legacy decision', 'rationale': 'keep this rationale'}],
    'blockers': [{'description': 'Legacy blocker', 'task_id': 'T1'}],
    'next_action': 'Legacy next action',
    'created_at': '2024-01-01T00:00:00.000Z',
    'updated_at': '2024-01-02T00:00:00.000Z',
    'updated_by': 'legacy-agent',
}
with open(os.environ['STATE'], 'w') as f:
    json.dump(state, f, indent=2)
    f.write('\n')
PYEOF

BEFORE=$(shasum -a 256 "$PROJECT/.claude-task/state.json" | awk '{print $1}')
LEGACY_STATUS=$(ts status)
AFTER=$(shasum -a 256 "$PROJECT/.claude-task/state.json" | awk '{print $1}')
check "version-1 state is readable as the default topic" \
  "$(printf '%s' "$LEGACY_STATUS" | grep -q '^TOPIC: default$' && printf '%s' "$LEGACY_STATUS" | grep -q 'Legacy blocker' && echo true || echo false)"
check "read-only migration does not dirty Git-trackable state" "$([[ "$BEFORE" == "$AFTER" ]] && echo true || echo false)"

ts next "Migrated next action" >/dev/null
MIGRATION_CHECK=$(STATE="$PROJECT/.claude-task/state.json" python3 - <<'PYEOF'
import json, os
s = json.load(open(os.environ['STATE']))
t = s['topics'][0]
ok = (
    s['version'] == '2' and s['revision'] == 10
    and s['active_topic'] == 'default' and s.get('updated_by') == 'legacy-agent'
    and t['goal'] == 'Legacy goal' and t['status'] == 'blocked'
    and t['current_task'] == 'T1' and t['tasks'][0]['notes'] == 'keep this note'
    and t['tasks'][0]['evidence'] == ['legacy proof']
    and t['tasks'][0]['attempts'][0]['description'] == 'old way'
    and t['decisions'][0]['summary'] == 'Legacy decision'
    and t['blockers'][0]['description'] == 'Legacy blocker'
    and t['next_action'] == 'Migrated next action'
    and t['created_at'] == '2024-01-01T00:00:00.000Z'
)
print('true' if ok else 'false')
PYEOF
)
check "first normal write persists a lossless schema-v2 migration" "$MIGRATION_CHECK"

echo ""
echo "  Passed: $PASS / $((PASS + FAIL))"
if [[ $FAIL -ne 0 ]]; then
  exit 1
fi
echo "  ✓ All tests passed!"
