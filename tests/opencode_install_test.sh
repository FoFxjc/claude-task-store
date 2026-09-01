#!/usr/bin/env bash
# claude-task-store: OpenCode install / uninstall regression test
#
# Verifies the install.sh + uninstall.sh pair for the OpenCode plugin
# side of the integration. Mirrors tests/install_regression_test.sh but
# scoped to .opencode/plugin/task-store.ts and the surrounding
# preservation rules. End-to-end plugin logic is covered by the Jest
# unit tests; this file is concerned with the installer contract.
#
# This suite exercises installer/uninstaller FILESYSTEM effects only; it never
# launches `opencode`. Actual plugin loading and runtime behaviour are covered
# by tests/opencode_smoke_test.sh and tests/opencode_autockpt_smoke_test.sh,
# which run against a real opencode binary.
#
# Coverage:
#   1. install.sh places the adapter at the path OpenCode auto-discovers
#   2. install.sh copies the plugin file with the ownership marker intact
#   3. Re-running install.sh is idempotent (no duplicate plugin copy)
#   4. Unrelated .opencode/ files (plugin, agents, commands, opencode.json)
#      survive install + uninstall
#   5. TASK_STORE_SKIP_OPENCODE=1 skips the .opencode/ copy
#   6. Uninstall removes only the task-store plugin (ownership marker
#      check), not unrelated files at the same path
#   7. .claude-task/ state files survive uninstall
#   8. Plugin source in the target is byte-identical to the source repo
#   9. .gitignore covers both adapter files and the transient pending
#      reconciliation instruction, on fresh installs AND on upgrades of a
#      project that already carries the v0.1.x marker block
#  10. Upgrade semantics: a marker-owned plugin AND helper are REFRESHED on
#      reinstall (stale owned content is replaced byte-for-byte with the
#      current shipped source), while a foreign file at either owned path is
#      preserved untouched. Ownership is a whole-line marker match, so a file
#      that only mentions the marker as a substring is treated as foreign.
#  11. uninstall.sh runs to completion under `set -euo pipefail` when the
#      helper directory holds nothing but our injection.ts, and the owned
#      helper directory is removed in that case.
#  12. The helper-directory emptiness test is not fooled by a filename that
#      embeds a newline: a foreign entry named "injection.ts<LF>injection.ts"
#      is preserved. This check FAILS against the previous
#      `ls -A | grep -v '^injection\.ts$'` implementation, which read that
#      directory as empty and rm -rf'd the user's file.
#  13. The installed tree is self-consistent: every relative import in the
#      installed adapter names a file that exists at that exact path and
#      extension, and no import reaches outside node: built-ins. This pins
#      the packaging contract without needing an opencode binary.

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
# Independent store for pre-install snapshots. It lives OUTSIDE the project
# tree so nothing install.sh or uninstall.sh does can reach it.
SNAP_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR"' EXIT

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

# Snapshot pre-install CONTENT for byte-comparison later.
#
# These must be independent copies. Pointing PRE_* at the live paths would
# make every "survived install" check below a self-diff — `diff -q X X` is
# always equal, so the assertion would pass even if install.sh rewrote the
# file. Copy to $SNAP_DIR first, then diff snapshot vs. live afterwards.
cp "$FRESH_DIR/.opencode/opencode.json"                  "$SNAP_DIR/opencode.json"
cp "$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts"  "$SNAP_DIR/my-unrelated-plugin.ts"
cp "$FRESH_DIR/.opencode/agents/researcher.md"           "$SNAP_DIR/researcher.md"
cp "$FRESH_DIR/.opencode/commands/deploy.md"             "$SNAP_DIR/deploy.md"

PRE_OPENCODE_JSON="$SNAP_DIR/opencode.json"
PRE_UNRELATED_PLUGIN="$SNAP_DIR/my-unrelated-plugin.ts"
PRE_AGENT="$SNAP_DIR/researcher.md"
PRE_COMMAND="$SNAP_DIR/deploy.md"

# Guard the guard: a snapshot path must never alias the live file, or every
# preservation check silently reverts to a self-diff.
check "preservation snapshots are independent copies, not aliases of the live files" \
  "$(if [[ "$PRE_OPENCODE_JSON" != "$FRESH_DIR"/* \
        && "$PRE_UNRELATED_PLUGIN" != "$FRESH_DIR"/* \
        && "$PRE_AGENT" != "$FRESH_DIR"/* \
        && "$PRE_COMMAND" != "$FRESH_DIR"/* ]]; then echo true; else echo false; fi)"

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

check "re-install reports the owned plugin was refreshed (not skipped)" \
  "$(grep -q 'Refreshed OpenCode plugin' /tmp/opencode_install_reinstall.log && echo true || echo false)"

check "re-install reports the owned helper was refreshed (not skipped)" \
  "$(grep -q 'Refreshed OpenCode plugin helper' /tmp/opencode_install_reinstall.log && echo true || echo false)"

check "re-install leaves plugin byte-identical to source (idempotent)" \
  "$(diff -q "$ROOT/opencode-plugin/task-store.ts" "$OPENCODE_PLUGIN" >/dev/null && echo true || echo false)"

check "re-install leaves helper byte-identical to source (idempotent)" \
  "$(diff -q "$ROOT/opencode-plugin/task-store/injection.ts" "$FRESH_DIR/.opencode/plugin/task-store/injection.ts" >/dev/null && echo true || echo false)"

check "re-install preserves unrelated plugin file" \
  "$(diff -q "$PRE_UNRELATED_PLUGIN" "$FRESH_DIR/.opencode/plugin/my-unrelated-plugin.ts" >/dev/null && echo true || echo false)"

# ── Scenario 3: TASK_STORE_SKIP_OPENCODE skips the .opencode copy ───────
echo ""
echo "═══ Scenario 3: TASK_STORE_SKIP_OPENCODE opt-out ═══"
SKIP_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR"' EXIT

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

# Proves uninstall progressed past the helper-dir emptiness test rather than
# dying on it. The explicit exit-status assertion for that same code path
# lives in Scenario 7e, which captures the raw return code.
check "uninstall logged the helper removal (emptiness test did not abort)" \
  "$(grep -q 'Removed OpenCode plugin helper' /tmp/opencode_uninstall.log && echo true || echo false)"

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
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR"' EXIT

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

# ── Scenario 6: .gitignore covers every transient OpenCode artifact ──────
#
# Regression guard for the v0.2.0 install-hygiene gap: the OpenCode adapter
# ships TWO files (task-store.ts plus the sibling task-store/injection.ts)
# and the conservative auto-checkpoint path stages a third transient file
# (.claude-task/.pending-reconcile-instruction.txt). All three must be
# gitignored, on a FRESH install AND on an upgrade of a project whose
# .gitignore already carries the v0.1.x marker block — the marker check in
# install.sh short-circuits the fresh block, so the upgrade path needs its
# own backfill. Without this, `git add -A` in a user's project silently
# commits a machine-local ephemeral file.
echo ""
echo "═══ Scenario 6: .gitignore covers transient OpenCode artifacts ═══"

GI_FRESH_DIR=$(mktemp -d)
GI_UPGRADE_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR"' EXIT

git init -q "$GI_FRESH_DIR"
git init -q "$GI_UPGRADE_DIR"

# The upgrade fixture reproduces a v0.1.1-era .gitignore: the marker line is
# present, so install.sh takes the backfill branch rather than the fresh one.
cat > "$GI_UPGRADE_DIR/.gitignore" <<'GIEOF'
# claude-task-store
.claude-task/history.jsonl
.claude-task/.lock
.claude-task/auto-checkpoint.json
.claude/settings.json.bak
.claude/task-store/
GIEOF

FORCE=1 bash "$ROOT/install.sh" "$GI_FRESH_DIR" > /tmp/opencode_install_gi_fresh.log 2>&1 || {
  echo "install.sh (gitignore fresh) failed:"; cat /tmp/opencode_install_gi_fresh.log; exit 1;
}
FORCE=1 bash "$ROOT/install.sh" "$GI_UPGRADE_DIR" > /tmp/opencode_install_gi_upgrade.log 2>&1 || {
  echo "install.sh (gitignore upgrade) failed:"; cat /tmp/opencode_install_gi_upgrade.log; exit 1;
}

# `git check-ignore` is the authority here rather than grepping .gitignore:
# it answers the question that actually matters ("would git stage this?")
# and is immune to how the entry happens to be spelled.
ignored() {
  git -C "$1" check-ignore -q "$2" && echo true || echo false
}

for scenario in fresh upgrade; do
  if [[ "$scenario" == "fresh" ]]; then DIR="$GI_FRESH_DIR"; else DIR="$GI_UPGRADE_DIR"; fi

  check "$scenario install: .opencode/plugin/task-store.ts is gitignored" \
    "$(ignored "$DIR" ".opencode/plugin/task-store.ts")"

  check "$scenario install: .opencode/plugin/task-store/injection.ts is gitignored" \
    "$(ignored "$DIR" ".opencode/plugin/task-store/injection.ts")"

  check "$scenario install: .claude-task/.pending-reconcile-instruction.txt is gitignored" \
    "$(ignored "$DIR" ".claude-task/.pending-reconcile-instruction.txt")"

  check "$scenario install: .claude-task/state.json is still committable" \
    "$([[ "$(ignored "$DIR" ".claude-task/state.json")" == "false" ]] && echo true || echo false)"
done

# Re-running the installer must not append the same path twice.
FORCE=1 bash "$ROOT/install.sh" "$GI_UPGRADE_DIR" > /tmp/opencode_install_gi_reupgrade.log 2>&1 || {
  echo "install.sh (gitignore re-upgrade) failed:"; cat /tmp/opencode_install_gi_reupgrade.log; exit 1;
}

check "re-running install does not duplicate any .gitignore entry" \
  "$(if [[ -z "$(grep -v '^#' "$GI_UPGRADE_DIR/.gitignore" | grep -v '^[[:space:]]*$' | sort | uniq -d)" ]]; then echo true; else echo false; fi)"

# The upgrade branch must preserve every entry the project already had.
check "upgrade install preserves the pre-existing .gitignore entries" \
  "$(if grep -qxF '.claude-task/history.jsonl' "$GI_UPGRADE_DIR/.gitignore" \
       && grep -qxF '.claude-task/.lock' "$GI_UPGRADE_DIR/.gitignore" \
       && grep -qxF '.claude-task/auto-checkpoint.json' "$GI_UPGRADE_DIR/.gitignore" \
       && grep -qxF '.claude/task-store/' "$GI_UPGRADE_DIR/.gitignore"; then echo true; else echo false; fi)"

# ── Scenario 7: upgrade semantics for marker-owned vs foreign adapters ──
#
# Regression guard for the v0.2.0 review finding: install.sh used to treat a
# marker-present plugin as "already installed" and skip the copy, so a
# reinstall never actually upgraded the OpenCode adapter — a stale plugin
# from an older release survived indefinitely, contradicting the
# upgrade-in-place contract the .claude/task-store runtime honours.
#
# The decisive check below is deliberately NON-VACUOUS: we install, then
# clobber both adapter files with STALE but correctly marker-owned content
# carrying a sentinel string, then reinstall and require the files to be
# byte-for-byte identical to the current source (and the sentinel gone).
# Under the old skip-if-marker-present behaviour these checks fail.
echo ""
echo "═══ Scenario 7: owned adapters upgrade, foreign adapters are preserved ═══"

UPG_DIR=$(mktemp -d)
FOREIGN_PLUGIN_DIR=$(mktemp -d)
FOREIGN_HELPER_DIR=$(mktemp -d)
SUBSTR_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR" "$UPG_DIR" "$FOREIGN_PLUGIN_DIR" "$FOREIGN_HELPER_DIR" "$SUBSTR_DIR"' EXIT

MARKER='// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1'
STALE_SENTINEL='STALE_ADAPTER_FROM_AN_OLDER_RELEASE'

# ---- 7a: stale marker-owned content is replaced byte-for-byte -----------
git init -q "$UPG_DIR"
FORCE=1 bash "$ROOT/install.sh" "$UPG_DIR" > /tmp/opencode_upg_first.log 2>&1 || {
  echo "install.sh (upgrade fixture) failed:"; cat /tmp/opencode_upg_first.log; exit 1;
}

UPG_PLUGIN="$UPG_DIR/.opencode/plugin/task-store.ts"
UPG_HELPER="$UPG_DIR/.opencode/plugin/task-store/injection.ts"

# Overwrite BOTH shipped files with stale-but-owned content. These carry the
# real ownership marker on its own line, so they are unambiguously ours.
cat > "$UPG_PLUGIN" <<EOF
// claude-task-store: OpenCode plugin (stale v0.1.x copy)
$MARKER
// $STALE_SENTINEL
export default async function () { return {}; }
EOF
cat > "$UPG_HELPER" <<EOF
// claude-task-store OpenCode plugin — injection logic (stale v0.1.x copy)
$MARKER
// $STALE_SENTINEL
export function buildResumeInjection() { return ""; }
EOF

# Also drop an unrelated file into the owned helper directory to prove the
# refresh rewrites only injection.ts and never clears the directory.
cat > "$UPG_DIR/.opencode/plugin/task-store/user-notes.md" <<'EOF'
User's own notes inside the helper dir — must survive an upgrade.
EOF
UPG_NOTES="$UPG_DIR/.opencode/plugin/task-store/user-notes.md"
UPG_NOTES_BEFORE=$(cat "$UPG_NOTES")

check "fixture: stale plugin really is marker-owned before reinstall" \
  "$(grep -qxF "$MARKER" "$UPG_PLUGIN" && echo true || echo false)"

check "fixture: stale plugin differs from source before reinstall" \
  "$(diff -q "$ROOT/opencode-plugin/task-store.ts" "$UPG_PLUGIN" >/dev/null 2>&1 && echo false || echo true)"

check "fixture: stale helper differs from source before reinstall" \
  "$(diff -q "$ROOT/opencode-plugin/task-store/injection.ts" "$UPG_HELPER" >/dev/null 2>&1 && echo false || echo true)"

FORCE=1 bash "$ROOT/install.sh" "$UPG_DIR" > /tmp/opencode_upg_second.log 2>&1 || {
  echo "install.sh (upgrade reinstall) failed:"; cat /tmp/opencode_upg_second.log; exit 1;
}

check "reinstall replaces stale owned plugin byte-for-byte with current source" \
  "$(diff -q "$ROOT/opencode-plugin/task-store.ts" "$UPG_PLUGIN" >/dev/null && echo true || echo false)"

check "reinstall replaces stale owned helper byte-for-byte with current source" \
  "$(diff -q "$ROOT/opencode-plugin/task-store/injection.ts" "$UPG_HELPER" >/dev/null && echo true || echo false)"

check "stale sentinel is gone from the upgraded plugin" \
  "$(grep -q "$STALE_SENTINEL" "$UPG_PLUGIN" 2>/dev/null && echo false || echo true)"

check "stale sentinel is gone from the upgraded helper" \
  "$(grep -q "$STALE_SENTINEL" "$UPG_HELPER" 2>/dev/null && echo false || echo true)"

check "upgrade log reports the plugin was refreshed" \
  "$(grep -q 'Refreshed OpenCode plugin' /tmp/opencode_upg_second.log && echo true || echo false)"

check "upgrade log reports the helper was refreshed" \
  "$(grep -q 'Refreshed OpenCode plugin helper' /tmp/opencode_upg_second.log && echo true || echo false)"

check "unrelated file inside the owned helper dir survives the upgrade" \
  "$([[ "$(cat "$UPG_NOTES" 2>/dev/null)" == "$UPG_NOTES_BEFORE" ]] && echo true || echo false)"

# A third run must change nothing further.
cp "$UPG_PLUGIN" /tmp/opencode_upg_plugin_snapshot.ts
cp "$UPG_HELPER" /tmp/opencode_upg_helper_snapshot.ts
FORCE=1 bash "$ROOT/install.sh" "$UPG_DIR" > /tmp/opencode_upg_third.log 2>&1 || {
  echo "install.sh (third run) failed:"; cat /tmp/opencode_upg_third.log; exit 1;
}

check "third consecutive install is idempotent for the plugin" \
  "$(diff -q /tmp/opencode_upg_plugin_snapshot.ts "$UPG_PLUGIN" >/dev/null && echo true || echo false)"

check "third consecutive install is idempotent for the helper" \
  "$(diff -q /tmp/opencode_upg_helper_snapshot.ts "$UPG_HELPER" >/dev/null && echo true || echo false)"

check "repeated installs do not duplicate the task-store plugin file" \
  "$([[ "$(find "$UPG_DIR/.opencode/plugin" -maxdepth 1 -name 'task-store.ts' | wc -l | tr -d ' ')" == "1" ]] && echo true || echo false)"

# ---- 7b: a foreign plugin at the owned path is never overwritten --------
git init -q "$FOREIGN_PLUGIN_DIR"
mkdir -p "$FOREIGN_PLUGIN_DIR/.opencode/plugin"
cat > "$FOREIGN_PLUGIN_DIR/.opencode/plugin/task-store.ts" <<'EOF'
// Someone else's plugin that happens to sit at our path.
// No claude-task-store ownership marker anywhere in this file.
export default async function () { return { name: "not-ours" }; }
EOF
cat > "$FOREIGN_PLUGIN_DIR/.opencode/plugin/other.ts" <<'EOF'
// unrelated neighbour plugin — must survive
export default async function () { return {}; }
EOF
FOREIGN_PLUGIN_BEFORE=$(cat "$FOREIGN_PLUGIN_DIR/.opencode/plugin/task-store.ts")
FOREIGN_NEIGHBOUR_BEFORE=$(cat "$FOREIGN_PLUGIN_DIR/.opencode/plugin/other.ts")

FORCE=1 bash "$ROOT/install.sh" "$FOREIGN_PLUGIN_DIR" > /tmp/opencode_foreign_plugin.log 2>&1 || {
  echo "install.sh (foreign plugin) failed:"; cat /tmp/opencode_foreign_plugin.log; exit 1;
}

check "foreign plugin at the owned path is NOT overwritten by install" \
  "$([[ "$(cat "$FOREIGN_PLUGIN_DIR/.opencode/plugin/task-store.ts")" == "$FOREIGN_PLUGIN_BEFORE" ]] && echo true || echo false)"

check "install warns about the foreign plugin instead of silently skipping" \
  "$(grep -q 'no claude-task-store ownership marker found' /tmp/opencode_foreign_plugin.log && echo true || echo false)"

check "install does not create a helper dir next to a foreign plugin" \
  "$([[ ! -e "$FOREIGN_PLUGIN_DIR/.opencode/plugin/task-store/injection.ts" ]] && echo true || echo false)"

check "unrelated neighbour plugin survives the refused install" \
  "$([[ "$(cat "$FOREIGN_PLUGIN_DIR/.opencode/plugin/other.ts")" == "$FOREIGN_NEIGHBOUR_BEFORE" ]] && echo true || echo false)"

# ---- 7c: a foreign HELPER is preserved even when the plugin is ours -----
git init -q "$FOREIGN_HELPER_DIR"
FORCE=1 bash "$ROOT/install.sh" "$FOREIGN_HELPER_DIR" > /tmp/opencode_fh_first.log 2>&1 || {
  echo "install.sh (foreign helper fixture) failed:"; cat /tmp/opencode_fh_first.log; exit 1;
}
FH_HELPER="$FOREIGN_HELPER_DIR/.opencode/plugin/task-store/injection.ts"
cat > "$FH_HELPER" <<'EOF'
// Hand-rolled replacement helper with no ownership marker.
export function buildResumeInjection() { return "mine"; }
EOF
FH_HELPER_BEFORE=$(cat "$FH_HELPER")

FORCE=1 bash "$ROOT/install.sh" "$FOREIGN_HELPER_DIR" > /tmp/opencode_fh_second.log 2>&1 || {
  echo "install.sh (foreign helper reinstall) failed:"; cat /tmp/opencode_fh_second.log; exit 1;
}

check "foreign helper is NOT overwritten even when the plugin is owned" \
  "$([[ "$(cat "$FH_HELPER")" == "$FH_HELPER_BEFORE" ]] && echo true || echo false)"

check "install warns that the foreign helper was left in place" \
  "$(grep -q 'injection.ts in place' /tmp/opencode_fh_second.log && echo true || echo false)"

check "owned plugin is still refreshed alongside a foreign helper" \
  "$(diff -q "$ROOT/opencode-plugin/task-store.ts" "$FOREIGN_HELPER_DIR/.opencode/plugin/task-store.ts" >/dev/null && echo true || echo false)"

# ---- 7d: ownership is a whole-line match, not a substring match ---------
#
# A file that merely MENTIONS the marker (vendored docs, a prose reference,
# a longer identifier that contains ours) must not be claimed as ours.
git init -q "$SUBSTR_DIR"
mkdir -p "$SUBSTR_DIR/.opencode/plugin"
cat > "$SUBSTR_DIR/.opencode/plugin/task-store.ts" <<'EOF'
// Someone's plugin whose docs quote our marker inline:
// see the "CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1" marker used by claude-task-store.
// It is NOT on a line of its own, so this file is foreign.
export default async function () { return { name: "still-not-ours" }; }
EOF
SUBSTR_BEFORE=$(cat "$SUBSTR_DIR/.opencode/plugin/task-store.ts")

FORCE=1 bash "$ROOT/install.sh" "$SUBSTR_DIR" > /tmp/opencode_substr_install.log 2>&1 || {
  echo "install.sh (substring marker) failed:"; cat /tmp/opencode_substr_install.log; exit 1;
}

check "substring-only marker does NOT make a file eligible for overwrite" \
  "$([[ "$(cat "$SUBSTR_DIR/.opencode/plugin/task-store.ts")" == "$SUBSTR_BEFORE" ]] && echo true || echo false)"

bash "$ROOT/uninstall.sh" "$SUBSTR_DIR" > /tmp/opencode_substr_uninstall.log 2>&1 || {
  echo "uninstall.sh (substring marker) failed:"; cat /tmp/opencode_substr_uninstall.log; exit 1;
}

check "substring-only marker does NOT make a file eligible for removal" \
  "$([[ "$(cat "$SUBSTR_DIR/.opencode/plugin/task-store.ts")" == "$SUBSTR_BEFORE" ]] && echo true || echo false)"

# ---- 7e: uninstall still removes exactly the owned adapter --------------
bash "$ROOT/uninstall.sh" "$UPG_DIR" > /tmp/opencode_upg_uninstall.log 2>&1 || {
  echo "uninstall.sh (upgraded dir) failed:"; cat /tmp/opencode_upg_uninstall.log; exit 1;
}

check "uninstall removes the refreshed owned plugin" \
  "$([[ ! -f "$UPG_PLUGIN" ]] && echo true || echo false)"

# uninstall.sh deliberately leaves the helper directory alone when the user
# has put their own files in it — Scenario 4 covers the clean case where the
# directory holds nothing but our injection.ts and is removed wholesale.
check "uninstall keeps the user's file inside the helper dir (dir not empty)" \
  "$([[ "$(cat "$UPG_NOTES" 2>/dev/null)" == "$UPG_NOTES_BEFORE" ]] && echo true || echo false)"

# Dedicated exit-status fixture: a pristine install whose helper directory
# contains ONLY injection.ts — the exact shape flagged as a possible
# `set -euo pipefail` abort. Capture the raw exit code rather than letting
# `||` swallow it, so a regression shows up as a failing check, not a
# vanished suite.
PIPEFAIL_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR" "$UPG_DIR" "$FOREIGN_PLUGIN_DIR" "$FOREIGN_HELPER_DIR" "$SUBSTR_DIR" "$PIPEFAIL_DIR"' EXIT

git init -q "$PIPEFAIL_DIR"
FORCE=1 bash "$ROOT/install.sh" "$PIPEFAIL_DIR" > /tmp/opencode_pf_install.log 2>&1 || {
  echo "install.sh (pipefail fixture) failed:"; cat /tmp/opencode_pf_install.log; exit 1;
}

check "fixture: helper dir contains only injection.ts" \
  "$([[ "$(ls -A "$PIPEFAIL_DIR/.opencode/plugin/task-store" | tr '\n' ' ' | xargs)" == "injection.ts" ]] && echo true || echo false)"

PF_CODE=0
bash "$ROOT/uninstall.sh" "$PIPEFAIL_DIR" > /tmp/opencode_pf_uninstall.log 2>&1 || PF_CODE=$?

check "uninstall exit status is 0 when the helper dir holds only injection.ts" \
  "$([[ "$PF_CODE" == "0" ]] && echo true || echo false)"

check "uninstall fully removed the owned helper dir in that case" \
  "$([[ ! -d "$PIPEFAIL_DIR/.opencode/plugin/task-store" ]] && echo true || echo false)"

check "uninstall reached its final summary line (did not abort early)" \
  "$(grep -q 'claude-task-store removed' /tmp/opencode_pf_uninstall.log && echo true || echo false)"

# ── Scenario 8: helper-dir emptiness test vs. a newline-bearing filename ────
#
# This is the regression that DISCRIMINATES the current `find -print -quit`
# emptiness test from the `ls -A | grep -v '^injection\.ts$'` form it replaced.
#
# `ls -A` emits one LINE per directory entry, so a filename containing a
# newline is split across several lines. A foreign file literally named
#
#     injection.ts<LF>injection.ts
#
# contributes only lines that `grep -v '^injection\.ts$'` discards. The old
# pipeline therefore saw an EMPTY result for a directory that is not empty and
# ran `rm -rf` over the user's file. `find` matches `! -name` against the whole
# filename, sees the foreign entry, and keeps the directory.
#
# Run against the pre-fix uninstall.sh this scenario fails on the
# "preserves the newline-named foreign file" check.
echo ""
echo "═══ Scenario 8: newline-bearing foreign filename in the helper dir ═══"

NEWLINE_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR" "$UPG_DIR" "$FOREIGN_PLUGIN_DIR" "$FOREIGN_HELPER_DIR" "$SUBSTR_DIR" "$PIPEFAIL_DIR" "$NEWLINE_DIR"' EXIT

git init -q "$NEWLINE_DIR"
FORCE=1 bash "$ROOT/install.sh" "$NEWLINE_DIR" > /tmp/opencode_nl_install.log 2>&1 || {
  echo "install.sh (newline fixture) failed:"; cat /tmp/opencode_nl_install.log; exit 1;
}

NL_HELPER_DIR="$NEWLINE_DIR/.opencode/plugin/task-store"
# A single foreign file whose NAME embeds a newline and whose every line
# happens to read exactly "injection.ts".
NL_FOREIGN_NAME="$(printf 'injection.ts\ninjection.ts')"
printf 'user data that must survive\n' > "$NL_HELPER_DIR/$NL_FOREIGN_NAME"

check "fixture: helper dir holds our injection.ts plus one newline-named foreign file" \
  "$([[ -f "$NL_HELPER_DIR/injection.ts" && -f "$NL_HELPER_DIR/$NL_FOREIGN_NAME" ]] && echo true || echo false)"

# Demonstrate the discrimination directly: the old pipeline reports "empty".
check "pre-fix 'ls -A | grep -v' emptiness test wrongly reports this dir empty" \
  "$([[ -z "$(ls -A "$NL_HELPER_DIR" 2>/dev/null | grep -v '^injection\.ts$')" ]] && echo true || echo false)"

NL_CODE=0
bash "$ROOT/uninstall.sh" "$NEWLINE_DIR" > /tmp/opencode_nl_uninstall.log 2>&1 || NL_CODE=$?

check "uninstall exit status is 0 with a newline-named entry present" \
  "$([[ "$NL_CODE" == "0" ]] && echo true || echo false)"

check "uninstall removes the owned plugin file" \
  "$([[ ! -f "$NEWLINE_DIR/.opencode/plugin/task-store.ts" ]] && echo true || echo false)"

# THE discriminating assertion. Pre-fix: the directory (and this file) is
# rm -rf'd. Post-fix: find sees the foreign entry and the directory stays.
check "uninstall preserves the newline-named foreign file (helper dir kept)" \
  "$([[ -d "$NL_HELPER_DIR" && -f "$NL_HELPER_DIR/$NL_FOREIGN_NAME" ]] && echo true || echo false)"

check "preserved foreign file still has its original contents" \
  "$([[ "$(cat "$NL_HELPER_DIR/$NL_FOREIGN_NAME" 2>/dev/null)" == "user data that must survive" ]] && echo true || echo false)"

check "uninstall reached its final summary line with a newline-named entry" \
  "$(grep -q 'claude-task-store removed' /tmp/opencode_nl_uninstall.log && echo true || echo false)"

# ── Scenario 9: installed-tree module resolution ───────────────────────────
#
# The adapter is loaded from source by OpenCode's Bun runtime, so every
# relative import specifier in the INSTALLED plugin must name a file that
# actually exists in the INSTALLED tree, extension included. A specifier such
# as "./task-store/injection.js" resolves nowhere on disk and only loads
# because Bun happens to remap a missing .js to a sibling .ts — a property of
# one runtime, not a packaging contract. This check needs no opencode binary,
# so it guards the contract on every CI run.
echo ""
echo "═══ Scenario 9: installed tree is self-consistent (module resolution) ═══"

RESOLVE_DIR=$(mktemp -d)
trap 'rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR" "$UPG_DIR" "$FOREIGN_PLUGIN_DIR" "$FOREIGN_HELPER_DIR" "$SUBSTR_DIR" "$PIPEFAIL_DIR" "$NEWLINE_DIR" "$RESOLVE_DIR"' EXIT

git init -q "$RESOLVE_DIR"
FORCE=1 bash "$ROOT/install.sh" "$RESOLVE_DIR" > /tmp/opencode_rs_install.log 2>&1 || {
  echo "install.sh (resolution fixture) failed:"; cat /tmp/opencode_rs_install.log; exit 1;
}

RS_PLUGIN_DIR="$RESOLVE_DIR/.opencode/plugin"

# Every relative specifier in every installed adapter file must exist verbatim.
RS_MISSING=""
while IFS= read -r rs_file; do
  rs_base="$(dirname "$rs_file")"
  while IFS= read -r rs_spec; do
    [[ -z "$rs_spec" ]] && continue
    if [[ ! -f "$rs_base/$rs_spec" ]]; then
      RS_MISSING="$RS_MISSING $rs_file -> $rs_spec"
    fi
  done < <(grep -oE 'from "\.[^"]*"' "$rs_file" | sed 's/^from "//; s/"$//')
done < <(find "$RS_PLUGIN_DIR" -name '*.ts' -type f)

check "every relative import in the installed adapter resolves to a real file" \
  "$([[ -z "$RS_MISSING" ]] && echo true || echo false)"
if [[ -n "$RS_MISSING" ]]; then
  echo "      unresolved:$RS_MISSING"
fi

# Pin the specific specifier, so a silent change back to a .js path is caught
# rather than merely producing a still-resolving different layout.
check "installed plugin imports the helper by its real .ts filename" \
  "$(grep -q 'from "./task-store/injection.ts"' "$RS_PLUGIN_DIR/task-store.ts" && echo true || echo false)"

check "installed plugin contains no .js import specifier" \
  "$(grep -qE 'from "\.[^"]*\.js"' "$RS_PLUGIN_DIR/task-store.ts" && echo false || echo true)"

# Non-relative specifiers must be node: built-ins only — install.sh never
# touches the target project's package.json, so an npm import would not
# resolve inside OpenCode's loader.
check "installed adapter imports no npm packages (node: built-ins only)" \
  "$(if find "$RS_PLUGIN_DIR" -name '*.ts' -type f -exec grep -hoE 'from "[^".][^"]*"' {} + \
        | sed 's/^from "//; s/"$//' | grep -qvE '^node:'; then echo false; else echo true; fi)"

bash "$ROOT/uninstall.sh" "$FOREIGN_PLUGIN_DIR" > /tmp/opencode_fp_uninstall.log 2>&1 || {
  echo "uninstall.sh (foreign plugin) failed:"; cat /tmp/opencode_fp_uninstall.log; exit 1;
}

check "uninstall leaves the foreign plugin in place" \
  "$([[ "$(cat "$FOREIGN_PLUGIN_DIR/.opencode/plugin/task-store.ts")" == "$FOREIGN_PLUGIN_BEFORE" ]] && echo true || echo false)"

# ── Scenario 10: helper cleanup — owned file, foreign siblings, error paths ─
#
# uninstall.sh removes the helper in two independent steps: the owned
# injection.ts is removed on its own ownership marker, and the directory is
# then removed only if it is genuinely empty. `rmdir` is the primitive for the
# second step precisely because it cannot delete a non-empty directory and
# cannot mistake an error for emptiness.
echo ""
echo "═══ Scenario 10: helper cleanup (owned file / foreign siblings / errors) ═══"

HC_A_DIR=$(mktemp -d); HC_B_DIR=$(mktemp -d); HC_C_DIR=$(mktemp -d)
trap 'chmod -R u+rwX "$HC_C_DIR" 2>/dev/null; rm -rf "$SNAP_DIR" "$FRESH_DIR" "$SKIP_DIR" "$FOREIGN_DIR" "$GI_FRESH_DIR" "$GI_UPGRADE_DIR" "$UPG_DIR" "$FOREIGN_PLUGIN_DIR" "$FOREIGN_HELPER_DIR" "$SUBSTR_DIR" "$PIPEFAIL_DIR" "$NEWLINE_DIR" "$RESOLVE_DIR" "$HC_A_DIR" "$HC_B_DIR" "$HC_C_DIR"' EXIT

# ── 10a: owned helper removed even when a foreign sibling is present ───────
# Previously the owned injection.ts was left behind whenever the user had put
# anything else in the directory, because removal was gated on the whole
# directory being empty of foreign entries.
git init -q "$HC_A_DIR"
FORCE=1 bash "$ROOT/install.sh" "$HC_A_DIR" > /tmp/opencode_hca_install.log 2>&1 || {
  echo "install.sh (10a) failed:"; cat /tmp/opencode_hca_install.log; exit 1;
}
HCA_HELPER_DIR="$HC_A_DIR/.opencode/plugin/task-store"
HCA_FOREIGN="$HCA_HELPER_DIR/user-notes.md"
printf 'notes the user put next to our helper\n' > "$HCA_FOREIGN"
HCA_FOREIGN_BEFORE=$(cat "$HCA_FOREIGN")

HCA_CODE=0
bash "$ROOT/uninstall.sh" "$HC_A_DIR" > /tmp/opencode_hca_uninstall.log 2>&1 || HCA_CODE=$?

check "10a: uninstall exits 0 with a foreign sibling in the helper dir" \
  "$([[ "$HCA_CODE" == "0" ]] && echo true || echo false)"

check "10a: owned injection.ts is removed despite the foreign sibling" \
  "$([[ ! -e "$HCA_HELPER_DIR/injection.ts" ]] && echo true || echo false)"

check "10a: foreign sibling survives byte-for-byte" \
  "$([[ "$(cat "$HCA_FOREIGN" 2>/dev/null)" == "$HCA_FOREIGN_BEFORE" ]] && echo true || echo false)"

check "10a: helper dir is kept because foreign content remains" \
  "$([[ -d "$HCA_HELPER_DIR" ]] && echo true || echo false)"

check "10a: uninstall says it left the directory in place" \
  "$(grep -q 'still holds files we do not own' /tmp/opencode_hca_uninstall.log && echo true || echo false)"

# Idempotence: a second uninstall over the same tree must not fail or delete
# the user's file.
HCA_CODE2=0
bash "$ROOT/uninstall.sh" "$HC_A_DIR" > /tmp/opencode_hca_uninstall2.log 2>&1 || HCA_CODE2=$?
check "10a: repeat uninstall is idempotent (exit 0, foreign file intact)" \
  "$([[ "$HCA_CODE2" == "0" && "$(cat "$HCA_FOREIGN" 2>/dev/null)" == "$HCA_FOREIGN_BEFORE" ]] && echo true || echo false)"

# ── 10b: truly empty helper dir is removed ────────────────────────────────
git init -q "$HC_B_DIR"
FORCE=1 bash "$ROOT/install.sh" "$HC_B_DIR" > /tmp/opencode_hcb_install.log 2>&1 || {
  echo "install.sh (10b) failed:"; cat /tmp/opencode_hcb_install.log; exit 1;
}
bash "$ROOT/uninstall.sh" "$HC_B_DIR" > /tmp/opencode_hcb_uninstall.log 2>&1 || {
  echo "uninstall.sh (10b) failed:"; cat /tmp/opencode_hcb_uninstall.log; exit 1;
}
check "10b: helper dir is removed when it becomes truly empty" \
  "$([[ ! -d "$HC_B_DIR/.opencode/plugin/task-store" ]] && echo true || echo false)"

check "10b: uninstall reports removing the empty helper directory" \
  "$(grep -q 'Removed empty OpenCode helper directory' /tmp/opencode_hcb_uninstall.log && echo true || echo false)"

# ── 10c: an inspection ERROR must never be read as emptiness ──────────────
# The replaced `find`-based test answered "is anything in here?" by reading
# stdout, so a find that failed on a permission error produced empty stdout
# and was indistinguishable from an empty directory — authorising an rm -rf
# over the user's files. rmdir performs the removal instead of answering a
# question, so every failure mode is conservative.
if [[ "$EUID" -eq 0 ]]; then
  echo "  • running as root; skipping the permission-error checks (root bypasses mode bits)"
else
  # Direct comparison of the two primitives against an unreadable directory
  # that genuinely holds a user file.
  ERRP=$(mktemp -d); mkdir -p "$ERRP/helper"; echo "user data" > "$ERRP/helper/notes.md"
  chmod 000 "$ERRP/helper"

  check "10c: the replaced find-based test reports an unreadable dir as EMPTY (the bug)" \
    "$([[ -z "$(find "$ERRP/helper" -mindepth 1 -maxdepth 1 ! -name 'injection.ts' -print -quit 2>/dev/null)" ]] && echo true || echo false)"

  check "10c: rmdir refuses that same directory (error is never proof of emptiness)" \
    "$(if rmdir "$ERRP/helper" 2>/dev/null; then echo false; else echo true; fi)"

  chmod 755 "$ERRP/helper"
  check "10c: the user's file survived both probes" \
    "$([[ "$(cat "$ERRP/helper/notes.md" 2>/dev/null)" == "user data" ]] && echo true || echo false)"
  rm -rf "$ERRP"

  # End-to-end: a helper directory uninstall cannot inspect is left alone.
  git init -q "$HC_C_DIR"
  FORCE=1 bash "$ROOT/install.sh" "$HC_C_DIR" > /tmp/opencode_hcc_install.log 2>&1 || {
    echo "install.sh (10c) failed:"; cat /tmp/opencode_hcc_install.log; exit 1;
  }
  HCC_HELPER_DIR="$HC_C_DIR/.opencode/plugin/task-store"
  printf 'user file inside an unreadable dir\n' > "$HCC_HELPER_DIR/user-notes.md"
  chmod 000 "$HCC_HELPER_DIR"

  HCC_CODE=0
  bash "$ROOT/uninstall.sh" "$HC_C_DIR" > /tmp/opencode_hcc_uninstall.log 2>&1 || HCC_CODE=$?

  check "10c: uninstall exits 0 when the helper dir cannot be inspected" \
    "$([[ "$HCC_CODE" == "0" ]] && echo true || echo false)"

  check "10c: the uninspectable helper dir is NOT deleted" \
    "$([[ -d "$HCC_HELPER_DIR" ]] && echo true || echo false)"

  chmod 755 "$HCC_HELPER_DIR"
  check "10c: its contents survived (owned helper and the user's file)" \
    "$([[ -f "$HCC_HELPER_DIR/injection.ts" && "$(cat "$HCC_HELPER_DIR/user-notes.md" 2>/dev/null)" == "user file inside an unreadable dir" ]] && echo true || echo false)"

  check "10c: the owned plugin file was still removed (cleanup continued past the error)" \
    "$([[ ! -f "$HC_C_DIR/.opencode/plugin/task-store.ts" ]] && echo true || echo false)"
fi

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
