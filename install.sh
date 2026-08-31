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

  # Install globally so `task-store` is on PATH
  npm install -g . --silent 2>/dev/null || {
    echo "  ⚠  Global install failed (no sudo?). Using local bin instead."
    # Create a shim in ~/bin if it exists
    if [[ -d "$HOME/bin" ]]; then
      cat > "$HOME/bin/task-store" <<'SHIM'
#!/usr/bin/env bash
node "SCRIPT_DIR/dist/cli.js" "$@"
SHIM
      sed -i.bak "s|SCRIPT_DIR|$SCRIPT_DIR|g" "$HOME/bin/task-store"
      rm -f "$HOME/bin/task-store.bak"
      chmod +x "$HOME/bin/task-store"
      echo "  ✓ Shim installed at ~/bin/task-store"
    fi
  }
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

# Add hooks to settings.json using Python (no jq dependency required)
python3 - <<PYEOF
import json, sys

settings_file = '$SETTINGS_FILE'
with open(settings_file) as f:
    settings = json.load(f)

hooks = settings.setdefault('hooks', {})

def add_hook(event, matcher, command):
    entries = hooks.setdefault(event, [])
    # Remove any existing task-store hook for this event to avoid duplicates
    hooks[event] = [e for e in entries if not any(
        'task-store' in str(h.get('command', '')) or 'session-start.sh' in str(h.get('command',''))
        or 'pre-compact.sh' in str(h.get('command','')) or 'session-end.sh' in str(h.get('command',''))
        for h in e.get('hooks', [])
    )]
    hooks[event].append({
        'matcher': matcher,
        'hooks': [{'type': 'command', 'command': command}]
    })

add_hook('SessionStart', '', '\${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh')
add_hook('PreCompact', '', '\${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh')
add_hook('SessionEnd', '', '\${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-end.sh')

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

print('  ✓ Merged hooks into .claude/settings.json')
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
