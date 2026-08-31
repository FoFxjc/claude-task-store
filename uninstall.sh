#!/usr/bin/env bash
# claude-task-store uninstaller

set -euo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
CLAUDE_DIR="$PROJECT_ROOT/.claude"

echo "→ Removing claude-task-store from: $PROJECT_ROOT"

# Remove skill
rm -f "$CLAUDE_DIR/skills/task-store/SKILL.md"
rmdir "$CLAUDE_DIR/skills/task-store" 2>/dev/null || true

# Remove hook scripts
rm -f "$CLAUDE_DIR/hooks/scripts/session-start.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/pre-compact.sh"
rm -f "$CLAUDE_DIR/hooks/scripts/session-end.sh"

# Remove task-store hooks from settings.json
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
if [[ -f "$SETTINGS_FILE" ]]; then
  export SETTINGS_FILE
  python3 - <<'PYEOF'
import json, os

settings_file = os.environ.get('SETTINGS_FILE', '.claude/settings.json')
with open(settings_file) as f:
    settings = json.load(f)

hooks = settings.get('hooks', {})
for event in list(hooks.keys()):
    hooks[event] = [
        e for e in hooks[event]
        if not any(
            'session-start.sh' in str(h.get('command',''))
            or 'pre-compact.sh' in str(h.get('command',''))
            or 'session-end.sh' in str(h.get('command',''))
            for h in e.get('hooks', [])
        )
    ]
    if not hooks[event]:
        del hooks[event]

with open(settings_file, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
print('  ✓ Removed task-store hooks from .claude/settings.json')
PYEOF
fi

echo "  ✓ claude-task-store removed"
echo ""
echo "Note: .claude-task/ state files were NOT removed."
echo "To remove them: rm -rf .claude-task/"
