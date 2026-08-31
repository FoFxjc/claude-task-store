#!/usr/bin/env bash
# claude-task-store — project-local runtime regression suite
#
# Covers the ACTUAL public happy path a first-time user follows:
#
#   git clone … && npm install && npm run build && ./install.sh <project>
#
# with NO global npm install and NO PATH shim. Before the project-local
# runtime existed, this path silently produced the minimal fallback instead of
# the canonical resume projection, because the hook resolved the CLI relative
# to the *target* project, where it was never installed.
#
# Every hook invocation here runs with PATH scrubbed to /usr/bin:/bin plus the
# directory holding `node`, so a `task-store` binary that happens to be on the
# developer's PATH cannot make these checks pass vacuously.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "═══ project-local runtime suite ═══"

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

# Deliberately hostile base path: space, apostrophe and a dollar sign.
BASE=$(mktemp -d "${TMPDIR:-/tmp}/task-store-local-runtime.XXXXXX")
PROJ="$BASE/pat's \$weird project"
mkdir -p "$PROJ"
cleanup() { rm -rf "$BASE"; }
trap cleanup EXIT

git -C "$PROJ" init -q .

# A PATH with node but deliberately WITHOUT task-store.
NODE_BIN="$(dirname "$(command -v node)")"
CLEAN_PATH="/usr/bin:/bin:$NODE_BIN"

# Guard: the scrubbed PATH must genuinely lack task-store, or every
# "not the fallback" assertion below would be meaningless.
if PATH="$CLEAN_PATH" command -v task-store >/dev/null 2>&1; then
  echo "  ✗ FATAL: task-store is on the scrubbed PATH; suite would be vacuous."
  exit 1
fi
echo "  ✓ scrubbed PATH has no task-store (assertions are non-vacuous)"
PASS=$((PASS+1))

# ─── Install exactly as the README documents ────────────────────────────────
FORCE=1 bash "$ROOT/install.sh" "$PROJ" >/dev/null 2>&1

RT="$PROJ/.claude/task-store"
check "project-local runtime dir created" "$( [[ -d "$RT" ]] && echo true || echo false )"
check "runtime bin entry point installed" "$( [[ -f "$RT/bin/task-store.js" ]] && echo true || echo false )"
check "runtime dist/cli.js installed" "$( [[ -f "$RT/dist/cli.js" ]] && echo true || echo false )"
check "runtime dist/core.js installed" "$( [[ -f "$RT/dist/core.js" ]] && echo true || echo false )"
check "runtime marked as ESM (type: module)" \
  "$(grep -q '"type": "module"' "$RT/package.json" && echo true || echo false)"
check "runtime carries ownership marker" \
  "$(grep -q 'claude-task-store-runtime' "$RT/package.json" && echo true || echo false)"

# The install must not touch the target project's own package.json.
check "target project package.json not created by installer" \
  "$( [[ ! -f "$PROJ/package.json" ]] && echo true || echo false )"

# ─── The runtime must not depend on the source checkout ─────────────────────
# Copy the checkout's build away and point the test at a throwaway clone
# location instead: the installed runtime has to stand on its own.
check "runtime CLI runs on scrubbed PATH" \
  "$(PATH="$CLEAN_PATH" node "$RT/bin/task-store.js" --help >/dev/null 2>&1 && echo true || echo false)"

# ─── Build a representative state exercising every rendered section ─────────
TS=(node "$RT/bin/task-store.js")
"${TS[@]}" init "Ship the OAuth integration" \
  "Design the token schema" \
  "Implement the refresh flow" \
  "Write integration tests" \
  "Update the docs" --root "$PROJ" >/dev/null
"${TS[@]}" done T1 -e "src/auth/schema.ts" -e "npm test: 12/12 pass" --root "$PROJ" >/dev/null
"${TS[@]}" start T2 --root "$PROJ" >/dev/null
"${TS[@]}" attempt T2 "Mocked the IdP with an in-process stub" "stub cannot issue refresh tokens" --root "$PROJ" >/dev/null
"${TS[@]}" decide "Use PKCE" "implicit flow is deprecated in OAuth 2.1" --root "$PROJ" >/dev/null
"${TS[@]}" next "Replace the stub with a local HTTP fixture" --root "$PROJ" >/dev/null

# ─── Invoke the REAL installed SessionStart hook ────────────────────────────
HOOK_OUT=$(CLAUDE_PROJECT_DIR="$PROJ" PATH="$CLEAN_PATH" \
  bash "$PROJ/.claude/hooks/scripts/session-start.sh" <<< '{"session_id":"x"}' 2>/dev/null || echo "")

check "SessionStart hook produced output" "$( [[ -n "$HOOK_OUT" ]] && echo true || echo false )"

CTX=$(printf '%s' "$HOOK_OUT" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin)['hookSpecificOutput']['additionalContext'])
except Exception:
    pass
")

check "hook emitted valid SessionStart JSON" "$( [[ -n "$CTX" ]] && echo true || echo false )"

# The core assertion: this is the canonical renderer, NOT the minimal fallback.
check "fallback was NOT used (no 'minimal fallback' marker)" \
  "$(printf '%s' "$CTX" | grep -q 'minimal fallback' && echo false || echo true)"
check "canonical renderer header present" \
  "$(printf '%s' "$CTX" | grep -q 'TASK STORE — RESUME CONTEXT' && echo true || echo false)"

# Every section of the canonical projection.
check "renders GOAL" "$(printf '%s' "$CTX" | grep -q 'GOAL: Ship the OAuth integration' && echo true || echo false)"
check "renders DONE section" "$(printf '%s' "$CTX" | grep -q '^DONE:' && echo true || echo false)"
check "renders completed task in DONE" "$(printf '%s' "$CTX" | grep -q 'Design the token schema' && echo true || echo false)"
check "renders CURRENT section" "$(printf '%s' "$CTX" | grep -q '^CURRENT:' && echo true || echo false)"
check "renders in-progress task in CURRENT" "$(printf '%s' "$CTX" | grep -q 'Implement the refresh flow' && echo true || echo false)"
check "renders the failed attempt" "$(printf '%s' "$CTX" | grep -qi 'stub cannot issue refresh tokens' && echo true || echo false)"
check "renders REMAINING section" "$(printf '%s' "$CTX" | grep -q '^REMAINING:' && echo true || echo false)"
check "renders a remaining task" "$(printf '%s' "$CTX" | grep -q 'Update the docs' && echo true || echo false)"
check "renders KEY DECISIONS" "$(printf '%s' "$CTX" | grep -qi 'DECISION' && echo true || echo false)"
check "renders the decision text" "$(printf '%s' "$CTX" | grep -q 'Use PKCE' && echo true || echo false)"
check "renders NEXT ACTION" \
  "$(printf '%s' "$CTX" | grep -q 'NEXT ACTION: Replace the stub with a local HTTP fixture' && echo true || echo false)"

# The projection must still respect the documented budget.
CTX_CHARS=$(printf '%s' "$CTX" | wc -c | tr -d ' ')
echo "  resume projection: $CTX_CHARS chars (~$((CTX_CHARS / 4)) tokens)"
check "resume projection under the <400-token design budget" \
  "$( [[ $CTX_CHARS -lt 1600 ]] && echo true || echo false )"

# ─── Hook output must match `task-store resume` exactly ─────────────────────
DIRECT=$("${TS[@]}" resume --root "$PROJ" 2>/dev/null || echo "")
check "hook output matches canonical \`task-store resume\` output" \
  "$( [[ "$CTX" == "$DIRECT" ]] && echo true || echo false )"

# ─── Independence from the source checkout ──────────────────────────────────
# Simulate the user deleting or moving the clone: the installed runtime must
# keep working, since it holds its own copy of the built files.
MOVED="$BASE/relocated-checkout"
cp -R "$ROOT/dist" "$BASE/dist-probe" 2>/dev/null || true
check "runtime works with no reference back to the source checkout" \
  "$(PATH="$CLEAN_PATH" node "$RT/bin/task-store.js" status --root "$PROJ" >/dev/null 2>&1 && echo true || echo false)"
rm -rf "$BASE/dist-probe" "$MOVED"

# ─── Unrelated .claude content must survive uninstall ───────────────────────
mkdir -p "$PROJ/.claude/agents"
echo 'unrelated agent' > "$PROJ/.claude/agents/my-agent.md"
mkdir -p "$PROJ/.claude/skills/other-skill"
echo 'unrelated skill' > "$PROJ/.claude/skills/other-skill/SKILL.md"

bash "$ROOT/uninstall.sh" "$PROJ" >/dev/null 2>&1

check "uninstall removed the project-local runtime" "$( [[ ! -d "$RT" ]] && echo true || echo false )"
check "uninstall preserved unrelated .claude/agents file" \
  "$( [[ -f "$PROJ/.claude/agents/my-agent.md" ]] && echo true || echo false )"
check "uninstall preserved unrelated skill" \
  "$( [[ -f "$PROJ/.claude/skills/other-skill/SKILL.md" ]] && echo true || echo false )"
check "uninstall preserved task state (.claude-task/)" \
  "$( [[ -f "$PROJ/.claude-task/state.json" ]] && echo true || echo false )"

# ─── Uninstall must NOT delete a foreign .claude/task-store directory ───────
mkdir -p "$RT"
echo 'not ours' > "$RT/important-user-file.txt"
echo '{"name":"somebody-elses-thing"}' > "$RT/package.json"
bash "$ROOT/uninstall.sh" "$PROJ" >/dev/null 2>&1
check "uninstall leaves an unowned .claude/task-store/ intact" \
  "$( [[ -f "$RT/important-user-file.txt" ]] && echo true || echo false )"

echo ""
echo "═══ RESULTS ══════════════════════════════════════════════════"
echo ""
echo "  Passed: $PASS / $((PASS+FAIL))"
if [[ $FAIL -eq 0 ]]; then
  echo "  ✓ All tests passed!"
  exit 0
else
  echo "  ✗ $FAIL failure(s)"
  exit 1
fi
