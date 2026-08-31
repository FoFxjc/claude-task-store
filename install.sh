#!/usr/bin/env bash
# claude-task-store installer
# Installs the task-store CLI and sets up Claude Code plugin files for a project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "╔══════════════════════════════════════════╗"
echo "║  claude-task-store installer             ║"
echo "╚══════════════════════════════════════════╝"
echo ""

# ── 1. Build / install the CLI ──────────────────────────────────────────────

echo "→ Installing task-store CLI..."

if command -v npm &>/dev/null; then
  cd "$SCRIPT_DIR"
  npm install --silent
  npm run build --silent
  echo "  ✓ Built TypeScript"

  # Global install is opt-in: it silently altered the user's global npm
  # environment by default, which was surprising and undocumented (see
  # docs/pre-release-remediation.md item 11). The CLI does not need to be on
  # PATH for hooks to work — session-start.sh already falls back to
  # `node bin/task-store.js` / node_modules/.bin/task-store when `task-store`
  # isn't found on PATH.
  if [[ "${TASK_STORE_INSTALL_GLOBAL:-0}" == "1" ]]; then
    npm install -g . --silent 2>/dev/null || {
      echo "  ⚠  Global install failed (no sudo?). Using local bin instead."
      # Create a shim in ~/bin if it exists. Uses an unquoted heredoc so
      # $SCRIPT_DIR is expanded once, safely, even if it contains spaces or
      # apostrophes (e.g. "/tmp/pat's project") — no sed post-processing
      # step is needed, which previously could break on such paths.
      if [[ -d "$HOME/bin" ]]; then
        cat > "$HOME/bin/task-store" <<SHIM
#!/usr/bin/env bash
exec node "$SCRIPT_DIR/dist/cli.js" "\$@"
SHIM
        chmod +x "$HOME/bin/task-store"
        echo "  ✓ Shim installed at ~/bin/task-store"
      fi
    }
  else
    echo "  ℹ  Skipping global npm install (opt-in only)."
    echo "     The CLI works via bin/task-store.js and hook fallback detection without it."
    echo "     To put \`task-store\` on PATH globally, run:"
    echo "       TASK_STORE_INSTALL_GLOBAL=1 ./install.sh"
    echo "     or manually: npm install -g ."
  fi
else
  echo "  ⚠  npm not found. Falling back to Python-only mode."
  echo "     The Python fallback in hooks will be used instead of the CLI."
fi

# ── 2. Set up project .claude/ directory ────────────────────────────────────

PROJECT_ROOT="${1:-$(pwd)}"
CLAUDE_DIR="$PROJECT_ROOT/.claude"

echo ""
echo "→ Setting up Claude Code plugin in: $PROJECT_ROOT"

# Check if this is a project directory (has .git or we're told to proceed)
if [[ ! -d "$PROJECT_ROOT/.git" ]] && [[ "${FORCE:-}" != "1" ]]; then
  echo "  ⚠  No .git directory found at $PROJECT_ROOT"
  read -r -p "  Install anyway? [y/N] " confirm
  if [[ "${confirm:-N}" != "y" ]] && [[ "${confirm:-N}" != "Y" ]]; then
    echo "  Aborted."
    exit 1
  fi
fi

mkdir -p "$CLAUDE_DIR/hooks/scripts"
mkdir -p "$CLAUDE_DIR/skills/task-store"

# Copy skill
cp "$SCRIPT_DIR/skills/task-store/SKILL.md" "$CLAUDE_DIR/skills/task-store/SKILL.md"
echo "  ✓ Installed skill: .claude/skills/task-store/SKILL.md"

# Copy hook scripts
cp "$SCRIPT_DIR/hooks/scripts/session-start.sh" "$CLAUDE_DIR/hooks/scripts/session-start.sh"
cp "$SCRIPT_DIR/hooks/scripts/pre-compact.sh" "$CLAUDE_DIR/hooks/scripts/pre-compact.sh"
cp "$SCRIPT_DIR/hooks/scripts/session-end.sh" "$CLAUDE_DIR/hooks/scripts/session-end.sh"
chmod +x "$CLAUDE_DIR/hooks/scripts/"*.sh
echo "  ✓ Installed hooks: session-start, pre-compact, session-end"

# Merge hooks into .claude/settings.json
SETTINGS_FILE="$CLAUDE_DIR/settings.json"

if [[ ! -f "$SETTINGS_FILE" ]]; then
  cat > "$SETTINGS_FILE" <<'EOF'
{
  "hooks": {}
}
EOF
fi

# Back up settings.json before rewriting it. JSON is parsed and re-emitted
# below, so comments (not valid in JSON anyway) and original formatting are
# not preserved — the backup is the recovery path if that matters to you.
cp "$SETTINGS_FILE" "$SETTINGS_FILE.bak"
echo "  ✓ Backed up existing settings to $(basename "$SETTINGS_FILE").bak"

# Add hooks to settings.json using Python (no jq dependency required).
# STATE/paths are passed via environment variables, never interpolated into
# the Python source, so this is safe for project paths containing spaces,
# apostrophes, or other shell metacharacters.
export SETTINGS_FILE
python3 <<'PYEOF'
import json, os

settings_file = os.environ['SETTINGS_FILE']
with open(settings_file) as f:
    settings = json.load(f)

hooks = settings.setdefault('hooks', {})

# Ownership is determined by an EXACT match against the literal command
# string claude-task-store installs — never a substring match. This is
# critical: a substring match (e.g. matching any command containing
# "session-start.sh") would silently delete unrelated hooks that a user or
# another plugin registered for the same event, such as
# scripts/my-own-session-start.sh. Only these exact strings are ever removed.
OWNED_COMMANDS = {
    'SessionStart': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh',
    'PreCompact': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh',
    'SessionEnd': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-end.sh',
}

def is_owned(event, command):
    return command == OWNED_COMMANDS.get(event)

def remove_owned(event):
    entries = hooks.get(event, [])
    kept = []
    for entry in entries:
        inner = entry.get('hooks', [])
        kept_inner = [h for h in inner if not is_owned(event, str(h.get('command', '')))]
        if kept_inner:
            # Preserve the entry (and any unrelated hooks inside it) if
            # anything is left after removing only our own hook(s).
            new_entry = dict(entry)
            new_entry['hooks'] = kept_inner
            kept.append(new_entry)
        # else: this entry consisted solely of our own hook — drop it.
    if kept:
        hooks[event] = kept
    elif event in hooks:
        del hooks[event]

def add_hook(event, matcher, command):
    remove_owned(event)
    entries = hooks.setdefault(event, [])
    entries.append({
        'matcher': matcher,
        'hooks': [{'type': 'command', 'command': command}]
    })

add_hook('SessionStart', '', OWNED_COMMANDS['SessionStart'])
add_hook('PreCompact', '', OWNED_COMMANDS['PreCompact'])
add_hook('SessionEnd', '', OWNED_COMMANDS['SessionEnd'])

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('  ✓ Merged hooks into .claude/settings.json (unrelated hooks preserved)')
PYEOF

# ── 3. Add .gitignore entries ────────────────────────────────────────────────

GITIGNORE="$PROJECT_ROOT/.gitignore"
GITIGNORE_MARKER="# claude-task-store"

if [[ -f "$GITIGNORE" ]] && grep -q "$GITIGNORE_MARKER" "$GITIGNORE"; then
  echo "  ✓ .gitignore already has task-store entries"
else
  echo "" >> "$GITIGNORE"
  cat >> "$GITIGNORE" <<'EOF'
# claude-task-store
# state.json is committable (enables cross-session handoff)
# history.jsonl is verbose — commit it only if you want a full audit trail
.claude-task/history.jsonl
# .lock is a transient O_EXCL write lock; a crashed process can leave one behind
.claude-task/.lock
# settings.json.bak is written by install.sh/uninstall.sh before each rewrite
.claude/settings.json.bak
EOF
  echo "  ✓ Updated .gitignore (history.jsonl ignored, state.json committable)"
fi

# ── 4. Done ──────────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════╗"
echo "║  Installation complete!                  ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "NEXT STEPS:"
echo ""
echo "  1. Initialize a task store for your project:"
echo "     task-store init \"Your goal here\" \"Task 1\" \"Task 2\" ..."
echo ""
echo "  2. Start Claude Code — state will be injected automatically at session start."
echo ""
echo "  3. Use these commands during development:"
echo "     task-store status           # show current state"
echo "     task-store start T1         # begin task T1"
echo "     task-store done T1 -e file  # complete with evidence"
echo "     task-store block T2 reason  # mark blocked"
echo "     task-store next \"action\"   # set next action before ending session"
echo ""
echo "  4. To enable cross-session handoff via git:"
echo "     git add .claude-task/state.json"
echo ""
echo "  See README.md for full documentation."
