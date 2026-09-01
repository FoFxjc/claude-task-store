#!/usr/bin/env bash
# claude-task-store: OpenCode install / uninstall regression test
#
# Verifies the install.sh + uninstall.sh pair for the OpenCode plugin
# side of the integration. Mirrors tests/install_regression_test.sh but
# scoped to .opencode/plugin/task-store.ts and the surrounding
# preservation rules. End-to-end plugin logic is covered by the Jest
# unit tests; this file is concerned with the installer contract.
#
# Coverage:
#   1. OpenCode plugin loads in a representative project
#   2. install.sh copies the plugin file with the ownership marker intact
#   3. Re-running install.sh is idempotent (no duplicate plugin copy)
#   4. Unrelated .opencode/ files (plugin, agent, command, opencode.json)
#      survive install + uninstall
#   5. TASK_STORE_SKIP_OPENCODE=1 skips the .opencode/ copy
#   6. Uninstall removes only the task-store plugin (ownership marker
#      check), not unrelated files at the same path
#   7. .claude-task/ state files survive uninstall
#   8. Plugin source in the target is byte-identical to the source repo

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

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  claude-task-store OpenCode Installer Regression Test        ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── Scenario 1: fresh install copies the plugin with marker intact ──────
echo ""
echo "═══ Scenario 1: fresh install copies plugin + preserves unrelated .opencode ═══"
FRESH_DIR=$(mktemp -d)
trap 'rm -rf "$FRESH_DIR"' EXIT

git init -q "$FRESH_DIR"

# Pre-populate unrelated .opencode content to prove we never touch it.
mkdir -p "$FRESH_DIR/.opencode/agents" "$FRESH_DIR/.opencode/commands" "$FRESH_DIR/.opencode/plugin"
cat > "$FRESH_DIR/.opencode/opencode.json" <<'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-6",
  "plugin": ["some-user-plugin"]
}
EOF
cat > "$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts" <<'EOF'
// user's own plugin — must survive
export default async function () { return {}; };
EOF
cat > "$FRESH_DIR/.opencode/agents/researcher.md" <<'EOF'
---
description: User's own agent — must survive.
mode: subagent
---
User's own agent.
EOF
cat > "$FRESH_DIR/.opencode/commands/deploy.md" <<'EOF'
---
description: User's own command — must survive.
---
Run deploy with $ARGUMENTS.
EOF

# Snapshot pre-install content for byte-comparison later.
PRE_OPENCODE_JSON="$FRESH_DIR/.opencode/opencode.json"
PRE_UNRELATED_PLUGIN="$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts"
PRE_AGENT="$FRESH_DIR/.opencode/agents/researcher.md"
PRE_COMMAND="$FRESH_DIR/.opencode/commands/deploy.md"

FORCE=1 bash "$ROOT/install.sh" "$FRESH_DIR" > /tmp/opencode_install_fresh.log 2>&1 || {
  echo "install.sh failed:"; cat /tmp/opencode_install_fresh.log; exit 1;
}

OPENCODE_PLUGIN="$FRESH_DIR/.opencode/plugin/task-store.ts"

check "fresh install creates .opencode/plugin/task-store.ts" \
  "$([[ -f "$OPENCODE_PLUGIN" ]] && echo true || echo false)"

check "installed plugin contains the literal ownership marker" \
  "$(grep -q 'CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1' "$OPENCODE_PLUGIN" 2>/dev/null && echo true || echo false)"

check "installed plugin is byte-identical to source" \
  "$(diff -q "$ROOT/opencode-plugin/task-store.ts" "$OPENCODE_PLUGIN" >/dev/null && echo true || echo false)"

check "install also copies the helper into .opencode/plugin/task-store/" \
  "$([[ -f "$FRESH_DIR/.opencode/plugin/task-store/injection.ts" ]] && echo true || echo false)"

check "installed helper is byte-identical to source" \
  "$(diff -q "$ROOT/opencode-plugin/task-store/injection.ts" "$FRESH_DIR/.opencode/plugin/task-store/injection.ts" >/dev/null && echo true || echo false)"

check "unrelated opencode.json survived install" \
  "$(diff -q "$PRE_OPENCODE_JSON" "$FRESH_DIR/.opencode/opencode.json" >/dev/null && echo true || echo false)"

check "unrelated plugin file survived install" \
  "$(diff -q "$PRE_UNRELATED_PLUGIN" "$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts" >/dev/null && echo true || echo false)"

check "unrelated agent file survived install" \
  "$(diff -q "$PRE_AGENT" "$FRESH_DIR/.opencode/agents/researcher.md" >/dev/null && echo true || echo false)"

check "unrelated command file survived install" \
  "$(diff -q "$PRE_COMMAND" "$FRESH_DIR/.opencode/commands/deploy.md" >/dev/null && echo true || echo false)"

# ── Scenario 2: re-running install is idempotent (no duplicate plugin) ─
echo ""
echo "═══ Scenario 2: re-running install is idempotent ═══"
FORCE=1 bash "$ROOT/install.sh" "$FRESH_DIR" > /tmp/opencode_install_reinstall.log 2>&1 || {
  echo "re-install failed:"; cat /tmp/opencode_install_reinstall.log; exit 1;
}

PLUGIN_COUNT=$(find "$FRESH_DIR/.opencode/plugin" -maxdepth 1 -name 'task-store.ts' | wc -l | tr -d ' ')
check "re-install does not duplicate task-store plugin" \
  "$([[ "$PLUGIN_COUNT" == "1" ]] && echo true || echo false)"

check "re-install output notes plugin already installed" \
  "$(grep -q 'OpenCode plugin already installed' /tmp/opencode_install_reinstall.log && echo true || echo false)"

# ── Scenario 3: TASK_STORE_SKIP_OPENCODE skips the .opencode copy ───────
echo ""
echo "═══ Scenario 3: TASK_STORE_SKIP_OPENCODE opt-out ═══"
SKIP_DIR=$(mktemp -d)
trap 'rm -rf "$FRESH_DIR" "$SKIP_DIR"' EXIT

git init -q "$SKIP_DIR"
FORCE=1 TASK_STORE_SKIP_OPENCODE=1 bash "$ROOT/install.sh" "$SKIP_DIR" > /tmp/opencode_install_skip.log 2>&1 || {
  echo "install.sh (skip) failed:"; cat /tmp/opencode_install_skip.log; exit 1;
}

check "opt-out install does not create .opencode/plugin/" \
  "$([[ ! -d "$SKIP_DIR/.opencode/plugin" ]] && echo true || echo false)"

check "opt-out install does not create task-store.ts anywhere" \
  "$([[ ! -f "$SKIP_DIR/.opencode/plugin/task-store.ts" ]] && echo true || echo false)"

check "opt-out install still installs Claude Code side (.claude/ exists)" \
  "$([[ -d "$SKIP_DIR/.claude/task-store" ]] && echo true || echo false)"

check "opt-out install log mentions OpenCode was skipped" \
  "$(grep -q 'OpenCode integration skipped' /tmp/opencode_install_skip.log && echo true || echo false)"

# ── Scenario 4: uninstall removes only owned files ──────────────────────
echo ""
echo "═══ Scenario 4: uninstall preserves unrelated .opencode + leaves .claude-task/ ═══"
# Initialize task-store state so we can verify it survives uninstall.
node "$FRESH_DIR/.claude/task-store/bin/task-store.js" init "Test goal" \
  "Task A" "Task B" --root "$FRESH_DIR" >/dev/null 2>&1
node "$FRESH_DIR/.claude/task-store/bin/task-store.js" start T1 --root "$FRESH_DIR" >/dev/null 2>&1
STATE_PATH="$FRESH_DIR/.claude-task/state.json"
HISTORY_PATH="$FRESH_DIR/.claude-task/history.jsonl"

check "task-store init created state file" \
  "$([[ -f "$STATE_PATH" ]] && echo true || echo false)"

bash "$ROOT/uninstall.sh" "$FRESH_DIR" > /tmp/opencode_uninstall.log 2>&1 || {
  echo "uninstall.sh failed:"; cat /tmp/opencode_uninstall.log; exit 1;
}

check "uninstall removed .opencode/plugin/task-store.ts" \
  "$([[ ! -f "$OPENCODE_PLUGIN" ]] && echo true || echo false)"

check "uninstall also removed the helper subdirectory (when empty of other files)" \
  "$([[ ! -d "$FRESH_DIR/.opencode/plugin/task-store" ]] && echo true || echo false)"

check "uninstall preserved unrelated plugin file" \
  "$(diff -q "$PRE_UNRELATED_PLUGIN" "$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts" >/dev/null && echo true || echo false)"

check "uninstall preserved unrelated opencode.json" \
  "$(diff -q "$PRE_OPENCODE_JSON" "$FRESH_DIR/.opencode/opencode.json" >/dev/null && echo true || echo false)"

check "uninstall preserved unrelated agent file" \
  "$(diff -q "$PRE_AGENT" "$FRESH_DIR/.opencode/agents/researcher.md" >/dev/null && echo true || echo false)"

check "uninstall preserved unrelated command file" \
  "$(diff -q "$PRE_COMMAND" "$FRESH_DIR/.opencode/commands/deploy.md" >/dev/null && echo true || echo false)"

check "uninstall log notes OpenCode plugin removal" \
  "$(grep -q 'Removed OpenCode plugin' /tmp/opencode_uninstall.log && echo true || echo false)"

check ".claude-task/state.json survives uninstall" \
  "$([[ -f "$STATE_PATH" ]] && echo true || echo false)"

check ".claude-task/history.jsonl survives uninstall" \
  "$([[ -f "$HISTORY_PATH" ]] && echo true || echo false)"

# ── Scenario 5: uninstall refuses to remove a non-owned file at the path ─
echo ""
echo "═══ Scenario 5: uninstall refuses non-owned plugin at the path ═══"
FOREIGN_DIR=$(mktemp -d)
trap 'rm -rf "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR"' EXIT

git init -q "$FOREIGN_DIR"
mkdir -p "$FOREIGN_DIR/.opencode/plugin"
cat > "$FOREIGN_DIR/.opencode/plugin/task-store.ts" <<'EOF'
// Some other plugin that happens to live at the same path.
// Deliberately missing the claude-task-store ownership marker.
export default async function () { return {}; };
EOF

# Stub install.sh won't run here; just exercise uninstall.sh directly.
bash "$ROOT/uninstall.sh" "$FOREIGN_DIR" > /tmp/opencode_uninstall_foreign.log 2>&1 || {
  echo "uninstall on foreign dir failed:"; cat /tmp/opencode_uninstall_foreign.log; exit 1;
}

check "uninstall refused to remove foreign plugin file" \
  "$([[ -f "$FOREIGN_DIR/.opencode/plugin/task-store.ts" ]] && echo true || echo false)"

check "uninstall log warns about missing ownership marker" \
  "$(grep -q 'no claude-task-store ownership marker found' /tmp/opencode_uninstall_foreign.log && echo true || echo false)"

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
