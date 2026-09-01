#!/usr/bin/env bash
# claude-task-store uninstaller

set -euo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
CLAUDE_DIR="$PROJECT_ROOT/.claude"
OPENCODE_DIR="$PROJECT_ROOT/.opencode"

echo "→ Removing claude-task-store from: $PROJECT_ROOT"

# Remove skill
rm -f "$CLAUDE_DIR/skills/task-store/SKILL.md"
rmdir "$CLAUDE_DIR/skills/task-store" 2>/dev/null || true

# Remove hook scripts
rm -f "$CLAUDE_DIR/hooks/scripts/session-start.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/pre-compact.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/session-end.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/post-tool-use.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/stop.sh"

# Remove the project-local CLI runtime installed by install.sh — but only
# after confirming the directory is actually ours. Ownership is proven by the
# marker package.json install.sh writes; without that check this would be an
# unguarded `rm -rf` against a path the user could have repurposed. Nothing
# else under .claude/ is touched.
RUNTIME_DIR="$CLAUDE_DIR/task-store"
if [[ -d "$RUNTIME_DIR" ]]; then
  RUNTIME_MARKER="$RUNTIME_DIR/package.json"
  RUNTIME_OWNED=no
  if [[ -f "$RUNTIME_MARKER" ]]; then
    export RUNTIME_MARKER
    RUNTIME_OWNED=$(python3 <<'PYEOF'
import json, os

try:
    with open(os.environ['RUNTIME_MARKER']) as f:
        owned = json.load(f).get('name') == 'claude-task-store-runtime'
except Exception:
    owned = False
print('yes' if owned else 'no')
PYEOF
) || RUNTIME_OWNED=no
  fi

  if [[ "$RUNTIME_OWNED" == "yes" ]]; then
    rm -rf "$RUNTIME_DIR"
    echo "  ✓ Removed project-local CLI runtime: .claude/task-store/"
  else
    echo "  ⚠  Left $RUNTIME_DIR in place — no claude-task-store-runtime marker found."
    echo "     Remove it by hand if you meant to."
  fi
fi

# Remove task-store hooks from settings.json
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [[ -f "$SETTINGS_FILE" ]]; then
  # Back up before rewriting. JSON is parsed and re-emitted below, so
  # comments (not valid in JSON anyway) and original formatting are not
  # preserved — the backup is the recovery path if that matters to you.
  cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
  echo "  ✓ Backed up settings to $(basename "$SETTINGS_FILE").bak"

  export SETTINGS_FILE
  python3 <<'PYEOF'
import json, os

settings_file = os.environ['SETTINGS_FILE']
with open(settings_file) as f:
    settings = json.load(f)

hooks = settings.get('hooks', {})

# Ownership is determined by an EXACT match against the literal command
# string claude-task-store installs — never a substring match. A substring
# match (e.g. matching any command containing "session-start.sh") would
# silently delete unrelated hooks a user or another plugin registered for
# the same event, such as scripts/my-own-session-start.sh. Only these exact
# strings are ever removed; everything else in settings.json is untouched.
OWNED_COMMANDS = {
    'SessionStart': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh',
    'PreCompact': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh',
    'SessionEnd': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-end.sh',
    'PostToolUse': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/post-tool-use.sh',
    'Stop': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/stop.sh',
}

def is_owned(event, command):
    return command == OWNED_COMMANDS.get(event)

for event in list(hooks.keys()):
    entries = hooks.get(event, [])
    kept = []
    for entry in entries:
        inner = entry.get('hooks', [])
        kept_inner = [h for h in inner if not is_owned(event, str(h.get('command', '')))]
        if kept_inner:
            new_entry = dict(entry)
            new_entry['hooks'] = kept_inner
            kept.append(new_entry)
    if kept:
        hooks[event] = kept
    else:
        hooks.pop(event, None)

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
print('  ✓ Removed task-store hooks from .claude/settings.json (unrelated hooks preserved)')
PYEOF
fi

# Remove the OpenCode plugin — but only the file we own. The plugin file
# carries a literal ownership marker comment that install.sh writes; we
# grep for it before removing. This means we never delete a user's
# unrelated plugin at the same path, and we never touch anything else
# under .opencode/ (their own plugins, agents, commands, MCP servers,
# skills, and opencode.json all stay put).
#
# The marker is matched as a WHOLE LINE (grep -qxF), not as a substring, so
# this agrees exactly with the ownership test install.sh uses before it will
# refresh a file. A file that merely mentions the identifier in prose is
# foreign to both scripts.
OPENCODE_MARKER='// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1'
OPENCODE_PLUGIN_FILE="$OPENCODE_DIR/plugin/task-store.ts"
if [[ -f "$OPENCODE_PLUGIN_FILE" ]]; then
  if grep -qxF "$OPENCODE_MARKER" "$OPENCODE_PLUGIN_FILE"; then
    rm -f "$OPENCODE_PLUGIN_FILE"
    echo "  ✓ Removed OpenCode plugin: .opencode/plugin/task-store.ts"
    # Helper cleanup, in two independent steps.
    #
    # The helper file is ownership-marked in its own right, so step 1 does not
    # depend on what else lives in the directory: a user who dropped their own
    # notes next to our helper still gets our helper removed. Step 2 then
    # disposes of the directory only if nothing is left in it.
    OPENCODE_HELPER_DIR="$OPENCODE_DIR/plugin/task-store"
    OPENCODE_HELPER_FILE="$OPENCODE_HELPER_DIR/injection.ts"
    if [[ -d "$OPENCODE_HELPER_DIR" ]]; then

      # ── Step 1: remove the owned helper file ──────────────────────────
      # Same whole-line marker test as everywhere else. A foreign file at the
      # owned path is left exactly as-is.
      if [[ -f "$OPENCODE_HELPER_FILE" ]]; then
        if grep -qxF "$OPENCODE_MARKER" "$OPENCODE_HELPER_FILE"; then
          rm -f "$OPENCODE_HELPER_FILE"
          echo "  ✓ Removed OpenCode plugin helper: .opencode/plugin/task-store/injection.ts"
        else
          echo "  ⚠  Left $OPENCODE_HELPER_FILE in place — no claude-task-store ownership marker found."
          echo "     Remove it by hand if you meant to."
        fi
      fi

      # ── Step 2: remove the directory only if it is genuinely empty ─────
      # `rmdir` is the whole safety argument here, and it replaces the earlier
      # `find`-based emptiness test:
      #
      #   * It is never destructive to content. The kernel refuses to remove a
      #     directory that still has entries (ENOTEMPTY), so a user's files
      #     cannot be lost the way an `rm -rf` guarded by a separate emptiness
      #     test can lose them if that test is wrong.
      #
      #   * An error cannot be mistaken for emptiness. The `find` form asked a
      #     question ("is anything in here?") and read the answer from stdout,
      #     so a find that failed on a permission or I/O error produced empty
      #     stdout and was indistinguishable from a genuinely empty directory —
      #     which then authorised an `rm -rf`. `rmdir` does not answer a
      #     question, it performs the removal, and any failure — non-empty,
      #     permission denied, I/O error, a race with another writer — leaves
      #     the directory in place. Failure is always conservative.
      #
      #   * It reads no filenames, so filenames cannot fool it. Unusual names
      #     (spaces, apostrophes, embedded newlines, dotfiles) are irrelevant.
      #
      # The command sits in an `if` condition, where bash suppresses errexit,
      # so a non-empty directory is an expected outcome rather than an abort.
      # No `set +e` is needed anywhere.
      if rmdir "$OPENCODE_HELPER_DIR" 2>/dev/null; then
        echo "  ✓ Removed empty OpenCode helper directory: .opencode/plugin/task-store/"
      else
        echo "  • Left .opencode/plugin/task-store/ in place — it still holds files we do not own."
      fi
    fi
  else
    echo "  ⚠  Left $OPENCODE_PLUGIN_FILE in place — no claude-task-store ownership marker found."
    echo "     Remove it by hand if you meant to."
  fi
fi

echo "  ✓ claude-task-store removed"
echo ""
echo "Note: .claude-task/ state files were NOT removed."
echo "      This includes config.json (your auto-checkpoint setting) and"
echo "      auto-checkpoint.json (ephemeral dirty/debounce bookkeeping)."
echo "To remove them: rm -rf .claude-task/"
