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
    echo "     Not needed: the built runtime is copied into the target project at"
    echo "     .claude/task-store/, and the hooks run it from there."
    echo "     Install globally only if you also want \`task-store\` on your PATH"
    echo "     for manual use: TASK_STORE_INSTALL_GLOBAL=1 ./install.sh"
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
# Auto-checkpoint hooks. These are installed unconditionally but are inert
# unless the project opts in — each one bails out in bash, before spawning
# anything, when .claude-task/config.json is absent or not set to
# conservative. Installing them up front means enabling the feature is a
# single `task-store config auto-checkpoint conservative` with no reinstall.
cp "$SCRIPT_DIR/hooks/scripts/post-tool-use.sh" "$CLAUDE_DIR/hooks/scripts/post-tool-use.sh"
cp "$SCRIPT_DIR/hooks/scripts/stop.sh" "$CLAUDE_DIR/hooks/scripts/stop.sh"
chmod +x "$CLAUDE_DIR/hooks/scripts/"*.sh
echo "  ✓ Installed hooks: session-start, pre-compact, session-end, post-tool-use, stop"

# ── Project-local CLI runtime ───────────────────────────────────────────────
# The hooks need to run the canonical TypeScript resume renderer
# (buildResumeContext in src/core.ts, exposed as `task-store resume`). Copying
# the already-built runtime into the target project makes the install
# self-contained: no global npm install, no PATH shim, no dependency added to
# the target's package.json, and no requirement that this source checkout
# still exist afterwards.
#
# The CLI has no runtime dependencies (package.json declares devDependencies
# only), so the built .js files plus the bin entry point are the whole runtime.
RUNTIME_DIR="$CLAUDE_DIR/task-store"

if [[ ! -f "$SCRIPT_DIR/dist/cli.js" ]] || [[ ! -f "$SCRIPT_DIR/dist/core.js" ]]; then
  echo "  ✗ Build output missing at $SCRIPT_DIR/dist/."
  echo "    Run 'npm install && npm run build' in the claude-task-store checkout first."
  exit 1
fi

# Replace any previous runtime wholesale so an upgrade cannot leave stale
# files behind. Only this task-store-owned directory is ever touched.
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/bin" "$RUNTIME_DIR/dist"
cp "$SCRIPT_DIR"/dist/*.js "$RUNTIME_DIR/dist/"
cp "$SCRIPT_DIR/bin/task-store.js" "$RUNTIME_DIR/bin/task-store.js"
chmod +x "$RUNTIME_DIR/bin/task-store.js"

# This package.json marks the runtime as ESM. It is REQUIRED, not cosmetic:
# Node resolves module type from the nearest package.json, so without it the
# target project's own package.json (or absence of one) decides. On Node 18 a
# .js file resolved as CommonJS fails outright on dist/cli.js's static
# imports; on newer Node it only survives via a reparse heuristic that also
# prints a warning to stderr. This file is scoped to .claude/task-store/ and
# does NOT touch the target project's own package.json. Its name/version also
# serve as the ownership marker uninstall.sh checks before removing anything.
# The version is read from the source package.json rather than hardcoded, so
# it cannot drift as the project is released.
export RUNTIME_DIR SCRIPT_DIR
python3 <<'RUNTIME_PKG'
import json, os

script_dir = os.environ['SCRIPT_DIR']
runtime_dir = os.environ['RUNTIME_DIR']

with open(os.path.join(script_dir, 'package.json')) as f:
    version = json.load(f).get('version', '0.0.0')

with open(os.path.join(runtime_dir, 'package.json'), 'w') as f:
    json.dump({
        'name': 'claude-task-store-runtime',
        'version': version,
        'private': True,
        'type': 'module',
    }, f, indent=2)
    f.write('\n')
RUNTIME_PKG

echo "  ✓ Installed project-local CLI runtime: .claude/task-store/"

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
    # Auto-checkpoint (inert unless the project opts in to conservative mode).
    'PostToolUse': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/post-tool-use.sh',
    'Stop': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/stop.sh',
}

# PostToolUse is the only event we scope with a matcher. The list is the set
# of tools that can change repository or execution state; read-only tools
# (Read, Grep, Glob, WebFetch, ...) are deliberately excluded so that merely
# looking at the codebase never marks the checkpoint stale.
MATCHERS = {
    'PostToolUse': 'Write|Edit|MultiEdit|NotebookEdit|Bash',
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

for event in ('SessionStart', 'PreCompact', 'SessionEnd', 'PostToolUse', 'Stop'):
    add_hook(event, MATCHERS.get(event, ''), OWNED_COMMANDS[event])

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
  # Backfill entries added after the marker block was first written. Without
  # this, upgrading a v0.1.0 project would leave the auto-checkpoint runtime
  # marker showing up as an untracked file forever, because the marker check
  # above short-circuits the whole block.
  if ! grep -q '.claude-task/auto-checkpoint.json' "$GITIGNORE"; then
    cat >> "$GITIGNORE" <<'EOF'
# auto-checkpoint runtime marker (ephemeral dirty/debounce bookkeeping)
.claude-task/auto-checkpoint.json
EOF
    echo "  ✓ Added .claude-task/auto-checkpoint.json to .gitignore"
  fi
else
  echo "" >> "$GITIGNORE"
  cat >> "$GITIGNORE" <<'EOF'
# claude-task-store
# state.json is committable (enables cross-session handoff)
# history.jsonl is verbose — commit it only if you want a full audit trail
.claude-task/history.jsonl
# .lock is a transient O_EXCL write lock; a crashed process can leave one behind
.claude-task/.lock
# auto-checkpoint.json is ephemeral dirty/debounce bookkeeping for the optional
# auto-checkpoint mode — machine-local, never meaningful to another checkout
.claude-task/auto-checkpoint.json
# settings.json.bak is written by install.sh/uninstall.sh before each rewrite
.claude/settings.json.bak
# .claude/task-store/ is build output copied in by install.sh; re-created by
# re-running the installer, so it does not belong in version control
.claude/task-store/
# .opencode/plugin/task-store.ts is the auto-discovered OpenCode plugin;
# like the Claude Code runtime above, it is re-created by the installer.
.opencode/plugin/task-store.ts
EOF
  echo "  ✓ Updated .gitignore (history.jsonl ignored, state.json committable)"
fi

# ── 4. OpenCode integration (thin adapter) ──────────────────────────────────
#
# OpenCode (>= 1.x) auto-discovers any *.ts or *.js file under
# `.opencode/plugin/`. We copy the canonical task-store plugin there; it
# loads the project-local CLI runtime already installed in section 2, so
# no duplicate code, no extra build step, no change to the target project's
# package.json.
#
# The existing Claude-compatible SKILL.md at `.claude/skills/task-store/`
# is also auto-discovered by OpenCode as an "external skill" — we do NOT
# create a duplicate `.opencode/skills/task-store/SKILL.md`. The plugin
# below handles fresh-session resume injection.
#
# If the user explicitly opted out of OpenCode integration, skip this.
# Anything else under `.opencode/` (their own agents, commands, MCP
# servers, plugin configs) is never touched.

if [[ "${TASK_STORE_SKIP_OPENCODE:-0}" == "1" ]]; then
  echo ""
  echo "  • OpenCode integration skipped (TASK_STORE_SKIP_OPENCODE=1)"
elif [[ ! -f "$SCRIPT_DIR/opencode-plugin/task-store.ts" ]]; then
  echo ""
  echo "  • OpenCode plugin source missing at $SCRIPT_DIR/opencode-plugin/"
  echo "    (older claude-task-store checkout). Skipping OpenCode integration."
else
  echo ""
  echo "→ Setting up OpenCode plugin in: $PROJECT_ROOT"

  OPENCODE_PLUGIN_DIR="$PROJECT_ROOT/.opencode/plugin"
  OPENCODE_PLUGIN_FILE="$OPENCODE_PLUGIN_DIR/task-store.ts"
  OPENCODE_PLUGIN_HELPER_DIR="$OPENCODE_PLUGIN_DIR/task-store"
  OPENCODE_PLUGIN_HELPER_FILE="$OPENCODE_PLUGIN_HELPER_DIR/injection.ts"

  mkdir -p "$OPENCODE_PLUGIN_DIR"

  # Only write if the file does not already carry the ownership marker, so
  # we never overwrite a user's manual edits and we never overwrite a
  # claude-task-store install we did ourselves — re-running the installer
  # upgrades in place, which is the same contract as the Claude Code side.
  if [[ -f "$OPENCODE_PLUGIN_FILE" ]] \
      && grep -q 'CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1' "$OPENCODE_PLUGIN_FILE"; then
    echo "  ✓ OpenCode plugin already installed (ownership marker present)"
  else
    cp "$SCRIPT_DIR/opencode-plugin/task-store.ts" "$OPENCODE_PLUGIN_FILE"
    # The plugin imports the helper from a sibling subdirectory. OpenCode
    # does NOT auto-discover .ts files in subdirectories of .opencode/plugin/
    # (verified empirically: see tests/opencode_install_test.sh and the
    # opencode discovery rules in customize-opencode), so placing
    # `injection.ts` under `task-store/` keeps it out of OpenCode's
    # plugin loader while remaining importable from `task-store.ts`.
    mkdir -p "$OPENCODE_PLUGIN_HELPER_DIR"
    cp "$SCRIPT_DIR/opencode-plugin/task-store/injection.ts" "$OPENCODE_PLUGIN_HELPER_FILE"
    echo "  ✓ Installed OpenCode plugin: .opencode/plugin/task-store.ts"
    echo "    (auto-discovered on next OpenCode launch; no opencode.json change)"
  fi

  # Note: we intentionally do NOT touch opencode.json, .opencode/agent/,
  # .opencode/command/, .opencode/skills/, or any other .opencode/* file.
  # The existing .claude/skills/task-store/SKILL.md is already auto-loaded
  # by OpenCode as an "external skill", so no skill duplication is needed.
fi

# ── 5. Done ──────────────────────────────────────────────────────────────────

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
echo "  2. Start Claude Code OR OpenCode in this project — state will be"
echo "     injected automatically at session start."
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
echo "  5. To opt out of OpenCode integration on future installs:"
echo "     TASK_STORE_SKIP_OPENCODE=1 ./install.sh /path/to/project"
echo ""
echo "  See README.md for full documentation."
