#!/usr/bin/env bash
# claude-task-store: OpenCode plugin end-to-end smoke test
#
# Verifies the integration works in a real OpenCode session by:
#   1. Running opencode in a temp project with the production plugin installed
#   2. Patching the installed plugin to record the exact content it pushed to
#      the system prompt (writing to a project-local file). This is a
#      diagnostic capture added by the test, not by the production plugin.
#   3. Verifying the recorded push:
#        - is non-empty
#        - matches what `task-store resume --root <project>` prints (canonical)
#        - is below the 400-token design ceiling (1600 chars)
#
# The plugin itself is verified at the unit-test level for status checks,
# caching, and graceful degradation. This smoke test is end-to-end: it
# proves a real OpenCode session loads the plugin, the plugin's system
# transform hook fires, and the plugin pushes the canonical resume
# projection into the system prompt.
#
# This test does NOT require a working model API. OpenCode fires the
# experimental.chat.system.transform hook before the model call, so the
# plugin's push is observable even when the model call itself fails.
# The point is to prove the adapter is wired correctly: a fresh OpenCode
# session receives the canonical task-store resume projection in its
# system prompt without any prior conversation history.

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

if ! command -v opencode >/dev/null 2>&1; then
  echo "opencode not found in PATH; skipping OpenCode smoke test."
  exit 77
fi

OPENCODE_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
echo "OpenCode version: $OPENCODE_VERSION"

# ── Test 1: representative project ──────────────────────────────────────
echo ""
echo "═══ Smoke test 1: representative project with full state ═══"

TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "${TEST_DIR2:-}"' EXIT

git init -q "$TEST_DIR"

# Install the project-local CLI runtime, exactly as install.sh would.
mkdir -p "$TEST_DIR/.claude/task-store/dist" "$TEST_DIR/.claude/task-store/bin"
cp "$ROOT/dist/"*.js "$TEST_DIR/.claude/task-store/dist/"
cp "$ROOT/bin/task-store.js" "$TEST_DIR/.claude/task-store/bin/"
cat > "$TEST_DIR/.claude/task-store/package.json" <<EOF
{
  "name": "claude-task-store-runtime",
  "version": "$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")",
  "private": true,
  "type": "module"
}
EOF

# Initialize state with multiple task statuses so the resume projection
# exercises every section of buildResumeContext() in src/core.ts.
CLI="$TEST_DIR/.claude/task-store/bin/task-store.js"
node "$CLI" init "Build the authentication system" \
  "Write data models" "Implement callback route" "Token validation" \
  "Integration tests" "Update documentation" \
  --root "$TEST_DIR" >/dev/null
node "$CLI" start T1 --root "$TEST_DIR" >/dev/null
node "$CLI" done T1 -e "src/models/user.ts" -e "schema migration applied" --root "$TEST_DIR" >/dev/null
node "$CLI" start T2 --root "$TEST_DIR" >/dev/null
node "$CLI" attempt T2 "mock fetch" "does not support streaming responses" --root "$TEST_DIR" >/dev/null
node "$CLI" decide "Use PKCE flow" "implicit flow deprecated in OAuth 2.1" --root "$TEST_DIR" >/dev/null
node "$CLI" block T2 "Need local HTTP fixture before streaming test works" --root "$TEST_DIR" >/dev/null
node "$CLI" next "Replace mock with local HTTP fixture, then complete streaming test" --root "$TEST_DIR" >/dev/null

# Snapshot the canonical projection the plugin MUST reproduce.
EXPECTED_RESUME="$(node "$CLI" resume --root "$TEST_DIR")"

check "fixture state initialized (.claude-task/state.json exists)" \
  "$([[ -f "$TEST_DIR/.claude-task/state.json" ]] && echo true || echo false)"

check "canonical resume projection is below the 400-token design ceiling (1600 chars)" \
  "$([[ "${#EXPECTED_RESUME}" -lt 1600 ]] && echo true || echo false)"

# ── Install the production plugin (with a diagnostic capture) ──────────
mkdir -p "$TEST_DIR/.opencode/plugin/task-store"
cp "$ROOT/opencode-plugin/task-store.ts" "$TEST_DIR/.opencode/plugin/task-store.ts"
cp "$ROOT/opencode-plugin/task-store/injection.ts" "$TEST_DIR/.opencode/plugin/task-store/injection.ts"

# Add a one-line file-write right after the push, so we can inspect
# exactly what the plugin pushed. This is purely a test diagnostic and
# does not change the production plugin source.
DIAG_PATH="$TEST_DIR/.opencode/plugin/task-store.ts"
python3 - "$DIAG_PATH" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'output.system.push(resume);',
    '''const fs = await import("node:fs");
    try { fs.writeFileSync(worktree + "/.claude-task/.smoke-pushed.txt", resume); } catch {}
    output.system.push(resume);'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

# ── Run OpenCode ────────────────────────────────────────────────────────
cd "$TEST_DIR"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_smoke.log 2>&1 || true

PUSHED="$TEST_DIR/.claude-task/.smoke-pushed.txt"

# ── Verify the plugin ran and pushed the right content ─────────────────
check "plugin's system.transform hook fired in a fresh OpenCode session" \
  "$([[ -s "$PUSHED" ]] && echo true || echo false)"

check "injected projection matches the canonical \`task-store resume\` output" \
  "$(if [[ -s "$PUSHED" ]]; then
      if [[ "$(cat "$PUSHED")" == "$EXPECTED_RESUME" ]]; then echo true; else echo false; fi
    else
      echo false
    fi)"

check "injected projection is below the 400-token design ceiling (1600 chars)" \
  "$(if [[ -s "$PUSHED" ]]; then
      if [[ "$(wc -c < "$PUSHED")" -lt 1600 ]]; then echo true; else echo false; fi
    else
      echo false
    fi)"

check "injected projection contains the GOAL" \
  "$(grep -q 'GOAL: Build the authentication system' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "injected projection contains the DONE section" \
  "$(grep -q '^DONE:' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "injected projection contains the BLOCKED task with reason" \
  "$(grep -q 'BLOCKED' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "injected projection contains the failed attempt" \
  "$(grep -q 'mock fetch' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "injected projection contains the key decision" \
  "$(grep -q 'PKCE' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "injected projection contains the NEXT ACTION" \
  "$(grep -q 'NEXT ACTION' "$PUSHED" 2>/dev/null && echo true || echo false)"

check "OpenCode plugin loaded (no \`failed to load plugin\` error in log)" \
  "$(if grep -q 'failed to load plugin' /tmp/opencode_smoke.log; then echo false; else echo true; fi)"

check "OpenCode plugin path was loaded by OpenCode (no \`paths[0]\` schema error)" \
  "$(if grep -q 'paths\[0\]' /tmp/opencode_smoke.log; then echo false; else echo true; fi)"

# ── Test 2: paths with spaces and apostrophes ──────────────────────────
echo ""
echo "═══ Smoke test 2: paths with spaces and apostrophes ═══"

# Use mktemp with a template so the directory name contains spaces and
# apostrophes from the start.
TEST_DIR2_TEMPLATE="/tmp/pat's odd proj-XXXXXXXX"
TEST_DIR2="$(mktemp -d "$TEST_DIR2_TEMPLATE")"
trap 'rm -rf "$TEST_DIR" "$TEST_DIR2"' EXIT

git init -q "$TEST_DIR2"
mkdir -p "$TEST_DIR2/.claude/task-store/dist" "$TEST_DIR2/.claude/task-store/bin"
cp "$ROOT/dist/"*.js "$TEST_DIR2/.claude/task-store/dist/"
cp "$ROOT/bin/task-store.js" "$TEST_DIR2/.claude/task-store/bin/"
cat > "$TEST_DIR2/.claude/task-store/package.json" <<EOF
{
  "name": "claude-task-store-runtime",
  "version": "$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")",
  "private": true,
  "type": "module"
}
EOF
node "$TEST_DIR2/.claude/task-store/bin/task-store.js" init "Spaced goal" "T1" --root "$TEST_DIR2" >/dev/null

mkdir -p "$TEST_DIR2/.opencode/plugin/task-store"
cp "$ROOT/opencode-plugin/task-store.ts" "$TEST_DIR2/.opencode/plugin/task-store.ts"
cp "$ROOT/opencode-plugin/task-store/injection.ts" "$TEST_DIR2/.opencode/plugin/task-store/injection.ts"
DIAG2="$TEST_DIR2/.opencode/plugin/task-store.ts"
python3 - "$DIAG2" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'output.system.push(resume);',
    '''const fs = await import("node:fs");
    try { fs.writeFileSync(worktree + "/.claude-task/.smoke-pushed.txt", resume); } catch {}
    output.system.push(resume);'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$TEST_DIR2"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_smoke_spaced.log 2>&1 || true

PUSHED2="$TEST_DIR2/.claude-task/.smoke-pushed.txt"

check "plugin handles project paths containing spaces and apostrophes" \
  "$(if [[ -s "$PUSHED2" ]] && grep -q 'GOAL: Spaced goal' "$PUSHED2"; then echo true; else echo false; fi)"

# ── Test 3: no state → no injection ─────────────────────────────────────
echo ""
echo "═══ Smoke test 3: no .claude-task/state.json → no injection ═══"

TEST_DIR3=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$TEST_DIR2" "$TEST_DIR3"' EXIT

git init -q "$TEST_DIR3"
mkdir -p "$TEST_DIR3/.claude/task-store/dist" "$TEST_DIR3/.claude/task-store/bin"
cp "$ROOT/dist/"*.js "$TEST_DIR3/.claude/task-store/dist/"
cp "$ROOT/bin/task-store.js" "$TEST_DIR3/.claude/task-store/bin/"
cat > "$TEST_DIR3/.claude/task-store/package.json" <<EOF
{
  "name": "claude-task-store-runtime",
  "version": "$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")",
  "private": true,
  "type": "module"
}
EOF

mkdir -p "$TEST_DIR3/.opencode/plugin/task-store"
cp "$ROOT/opencode-plugin/task-store.ts" "$TEST_DIR3/.opencode/plugin/task-store.ts"
cp "$ROOT/opencode-plugin/task-store/injection.ts" "$TEST_DIR3/.opencode/plugin/task-store/injection.ts"
DIAG3="$TEST_DIR3/.opencode/plugin/task-store.ts"
python3 - "$DIAG3" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'output.system.push(resume);',
    '''const fs = await import("node:fs");
    try { fs.writeFileSync(worktree + "/.claude-task/.smoke-pushed.txt", resume); } catch {}
    output.system.push(resume);'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$TEST_DIR3"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_smoke_empty.log 2>&1 || true

PUSHED3="$TEST_DIR3/.claude-task/.smoke-pushed.txt"

check "no .claude-task/state.json → no resume push" \
  "$(if [[ ! -f "$PUSHED3" ]]; then echo true; else echo false; fi)"

# ── Test 4: archived state → no injection ──────────────────────────────
echo ""
echo "═══ Smoke test 4: archived state → no injection ═══"

TEST_DIR4=$(mktemp -d)
trap 'rm -rf "$TEST_DIR" "$TEST_DIR2" "$TEST_DIR3" "$TEST_DIR4"' EXIT

git init -q "$TEST_DIR4"
mkdir -p "$TEST_DIR4/.claude/task-store/dist" "$TEST_DIR4/.claude/task-store/bin"
cp "$ROOT/dist/"*.js "$TEST_DIR4/.claude/task-store/dist/"
cp "$ROOT/bin/task-store.js" "$TEST_DIR4/.claude/task-store/bin/"
cat > "$TEST_DIR4/.claude/task-store/package.json" <<EOF
{
  "name": "claude-task-store-runtime",
  "version": "$(node -e 'console.log(require(process.argv[1]).version)' "$ROOT/package.json")",
  "private": true,
  "type": "module"
}
EOF

CLI4="$TEST_DIR4/.claude/task-store/bin/task-store.js"
node "$CLI4" init "Old goal" "T1" --root "$TEST_DIR4" >/dev/null
node "$CLI4" archive --root "$TEST_DIR4" >/dev/null

mkdir -p "$TEST_DIR4/.opencode/plugin/task-store"
cp "$ROOT/opencode-plugin/task-store.ts" "$TEST_DIR4/.opencode/plugin/task-store.ts"
cp "$ROOT/opencode-plugin/task-store/injection.ts" "$TEST_DIR4/.opencode/plugin/task-store/injection.ts"
DIAG4="$TEST_DIR4/.opencode/plugin/task-store.ts"
python3 - "$DIAG4" <<'PYEOF'
import sys
plugin_path = sys.argv[1]
with open(plugin_path) as f:
    content = f.read()
patched = content.replace(
    'output.system.push(resume);',
    '''const fs = await import("node:fs");
    try { fs.writeFileSync(worktree + "/.claude-task/.smoke-pushed.txt", resume); } catch {}
    output.system.push(resume);'''
)
with open(plugin_path, "w") as f:
    f.write(patched)
PYEOF

cd "$TEST_DIR4"
opencode run --print-logs --log-level INFO "exit" > /tmp/opencode_smoke_archived.log 2>&1 || true

PUSHED4="$TEST_DIR4/.claude-task/.smoke-pushed.txt"

check "archived state → no resume push" \
  "$(if [[ ! -f "$PUSHED4" ]]; then echo true; else echo false; fi)"

# ── Results ─────────────────────────────────────────────────────────────
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
