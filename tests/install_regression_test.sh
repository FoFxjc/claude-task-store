#!/usr/bin/env bash
# claude-task-store: Installer/uninstaller regression test
#
# Regression coverage for docs/pre-release-remediation.md item 1:
# install.sh / uninstall.sh must never delete hooks they do not own, must
# only remove their own hook entries by exact command match, and must back
# up .claude/settings.json before rewriting it.

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

has_command() {
  # has_command <settings-file> <event> <exact-command>
  python3 - "$1" "$2" "$3" <<'PYEOF'
import json, sys
settings_file, event, cmd = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(settings_file) as f:
        settings = json.load(f)
except Exception:
    sys.exit(1)
for entry in settings.get('hooks', {}).get(event, []):
    for h in entry.get('hooks', []):
        if h.get('command') == cmd:
            sys.exit(0)
sys.exit(1)
PYEOF
}

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  claude-task-store Installer Regression Test                 ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ── Scenario 1: project with unrelated pre-existing hooks ──────────────────
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

echo ""
echo "═══ Scenario 1: unrelated hooks must survive install + uninstall ═══"
echo "Test project: $TEST_DIR"

git init -q "$TEST_DIR"
mkdir -p "$TEST_DIR/.claude" "$TEST_DIR/scripts"
echo 'echo my custom hook' > "$TEST_DIR/scripts/my-own-session-start.sh"
chmod +x "$TEST_DIR/scripts/my-own-session-start.sh"

# Pre-populate settings.json with unrelated hooks for the SAME events
# claude-task-store uses, including one whose path contains the substring
# "session-start.sh" (the exact bug pattern called out in the review) and
# one that is a plain inline command containing the substring "task-store".
cat > "$TEST_DIR/.claude/settings.json" <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/my-own-session-start.sh" }
        ]
      }
    ],
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "echo loading my-task-store-notes" }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "$CLAUDE_PROJECT_DIR/scripts/unrelated-prompt-hook.sh" }
        ]
      }
    ]
  }
}
EOF
cp "$TEST_DIR/.claude/settings.json" "$TEST_DIR/.claude/settings.json.orig"

FORCE=1 bash "$ROOT/install.sh" "$TEST_DIR" > /tmp/install_regression_install.log 2>&1 || {
  echo "install.sh failed:"; cat /tmp/install_regression_install.log; exit 1;
}

SETTINGS="$TEST_DIR/.claude/settings.json"

check "settings.json.bak created by install" \
  "$([[ -f "$SETTINGS.bak" ]] && echo true || echo false)"

check "unrelated SessionStart hook (path substring collision) survives install" \
  "$(has_command "$SETTINGS" SessionStart '$CLAUDE_PROJECT_DIR/scripts/my-own-session-start.sh' && echo true || echo false)"

check "unrelated PreCompact hook (contains 'task-store' substring) survives install" \
  "$(has_command "$SETTINGS" PreCompact 'echo loading my-task-store-notes' && echo true || echo false)"

check "unrelated UserPromptSubmit hook (untouched event) survives install" \
  "$(has_command "$SETTINGS" UserPromptSubmit '$CLAUDE_PROJECT_DIR/scripts/unrelated-prompt-hook.sh' && echo true || echo false)"

check "task-store SessionStart hook was installed" \
  "$(has_command "$SETTINGS" SessionStart '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh' && echo true || echo false)"

check "task-store PreCompact hook was installed" \
  "$(has_command "$SETTINGS" PreCompact '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh' && echo true || echo false)"

check "task-store SessionEnd hook was installed" \
  "$(has_command "$SETTINGS" SessionEnd '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-end.sh' && echo true || echo false)"

# Re-run install.sh: must not duplicate the task-store SessionStart entry.
FORCE=1 bash "$ROOT/install.sh" "$TEST_DIR" > /tmp/install_regression_reinstall.log 2>&1 || {
  echo "second install.sh failed:"; cat /tmp/install_regression_reinstall.log; exit 1;
}
OWNED_COUNT=$(python3 - "$SETTINGS" <<'PYEOF'
import json, sys
with open(sys.argv[1]) as f:
    settings = json.load(f)
count = 0
for entry in settings.get('hooks', {}).get('SessionStart', []):
    for h in entry.get('hooks', []):
        if h.get('command') == '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh':
            count += 1
print(count)
PYEOF
)
check "re-install does not duplicate task-store's own SessionStart hook" \
  "$([[ "$OWNED_COUNT" == "1" ]] && echo true || echo false)"

check "unrelated SessionStart hook still present after re-install" \
  "$(has_command "$SETTINGS" SessionStart '$CLAUDE_PROJECT_DIR/scripts/my-own-session-start.sh' && echo true || echo false)"

# Uninstall: unrelated hooks must survive; task-store hooks must be gone.
bash "$ROOT/uninstall.sh" "$TEST_DIR" > /tmp/install_regression_uninstall.log 2>&1 || {
  echo "uninstall.sh failed:"; cat /tmp/install_regression_uninstall.log; exit 1;
}

check "settings.json.bak created by uninstall" \
  "$([[ -f "$SETTINGS.bak" ]] && echo true || echo false)"

check "unrelated SessionStart hook survives uninstall" \
  "$(has_command "$SETTINGS" SessionStart '$CLAUDE_PROJECT_DIR/scripts/my-own-session-start.sh' && echo true || echo false)"

check "unrelated PreCompact hook survives uninstall" \
  "$(has_command "$SETTINGS" PreCompact 'echo loading my-task-store-notes' && echo true || echo false)"

check "unrelated UserPromptSubmit hook survives uninstall" \
  "$(has_command "$SETTINGS" UserPromptSubmit '$CLAUDE_PROJECT_DIR/scripts/unrelated-prompt-hook.sh' && echo true || echo false)"

check "task-store SessionStart hook removed by uninstall" \
  "$(has_command "$SETTINGS" SessionStart '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh' && echo false || echo true)"

check "task-store PreCompact hook removed by uninstall" \
  "$(has_command "$SETTINGS" PreCompact '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh' && echo false || echo true)"

# ── Scenario 2: fresh project, no pre-existing settings.json ───────────────
echo ""
echo "═══ Scenario 2: fresh project (no pre-existing settings.json) ═══"
FRESH_DIR=$(mktemp -d)
trap 'rm -rf "$FRESH_DIR"' EXIT
git init -q "$FRESH_DIR"

FORCE=1 bash "$ROOT/install.sh" "$FRESH_DIR" > /tmp/install_regression_fresh.log 2>&1 || {
  echo "install.sh (fresh) failed:"; cat /tmp/install_regression_fresh.log; exit 1;
}
check "fresh install creates settings.json with task-store hooks" \
  "$(has_command "$FRESH_DIR/.claude/settings.json" SessionStart '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh' && echo true || echo false)"

bash "$ROOT/uninstall.sh" "$FRESH_DIR" > /tmp/install_regression_fresh_uninstall.log 2>&1 || {
  echo "uninstall.sh (fresh) failed:"; cat /tmp/install_regression_fresh_uninstall.log; exit 1;
}
check "fresh project uninstall removes task-store hooks cleanly" \
  "$(has_command "$FRESH_DIR/.claude/settings.json" SessionStart '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh' && echo false || echo true)"

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
