# Installing claude-task-store as a coding agent

Instructions for a shell-capable coding agent (Claude Code, OpenCode, Codex, or
similar) asked to install claude-task-store into a repository. Follow them in
order.

## Goal

Install claude-task-store into the current repository without changing the
target project's package manager, application dependencies, or unrelated agent
configuration.

## Preconditions

> **Do not broadly inspect the target repository unless installation validation fails.**

Start with the minimum observation set defined in this guide. Expand inspection
only when the documented installation or verification steps fail or reveal a
specific ambiguity.

Before modifying anything:

- Identify the repository root.
  ```bash
  git rev-parse --show-toplevel
  ```
- Confirm Node.js >= 18.
  ```bash
  node --version
  ```
- Confirm `python3` is available (the installer uses it to merge JSON).
  ```bash
  python3 --version
  ```
- Inspect what already exists, and record it before the install so you can
  compare afterwards:
  ```bash
  cat .claude/settings.json 2>/dev/null
  cat .gitignore 2>/dev/null
  ls -la .opencode/ 2>/dev/null
  ```
- Preserve unrelated user configuration. Existing hooks, agents, commands, MCP
  servers, skills, plugins, and ignore rules belong to the user, not to this
  install.

If a precondition fails, stop and report it. Do not work around a missing
runtime by editing the target project.

## Installation

Clone claude-task-store outside the target repository, or into a temporary
directory. Build it there, then point the installer at the target repository.

```bash
git clone https://github.com/FoFxjc/claude-task-store.git /tmp/claude-task-store
cd /tmp/claude-task-store
npm install
npm run build
./install.sh /absolute/path/to/target/repository
```

Explicitly:

- Do not run task-store's `npm install` inside the target repository.
- Do not add task-store to the target project's `package.json`.
- Do not rewrite unrelated project dependencies.

The installer copies the built runtime into the target repository, so the clone
can be deleted afterwards.

Optional flags, only when the user asks:

- `TASK_STORE_SKIP_OPENCODE=1 ./install.sh <target>` — skip OpenCode integration.
- `TASK_STORE_INSTALL_GLOBAL=1 ./install.sh <target>` — also install the CLI on
  `PATH`. Not required; hooks and the OpenCode plugin never use `PATH`.

## Expected installer surfaces

The installer may add or update these task-store-owned surfaces in the target
repository:

- `.claude/task-store/` — the project-local CLI runtime
- `.claude/skills/task-store/` — the skill
- task-store hook scripts under `.claude/hooks/scripts/`
- task-store entries in `.claude/settings.json` (a backup is written to
  `.claude/settings.json.bak` before each rewrite)
- `.opencode/plugin/task-store.ts` — the OpenCode adapter
- `.opencode/plugin/task-store/` — the adapter's sibling helper module
- task-store-related `.gitignore` entries

Unrelated Claude Code and OpenCode configuration must survive the install. If
anything outside the list above changed, treat it as a defect and report it
instead of continuing.

## Verification

Run from the target repository root.

```bash
test -f .claude/task-store/bin/task-store.js
node .claude/task-store/bin/task-store.js --help
```

For Claude Code:

- Confirm task-store hook entries exist in `.claude/settings.json`. The
  installer registers five, one per event:
  ```bash
  grep -nE 'hooks/scripts/(session-start|pre-compact|session-end|post-tool-use|stop)\.sh' .claude/settings.json
  ```
- Confirm unrelated hooks remain — compare against the pre-install copy you took
  in Preconditions.

For OpenCode:

- Confirm `.opencode/plugin/task-store.ts` exists.
- Confirm `.opencode/plugin/task-store/injection.ts` exists.
- Do not add or rewrite `opencode.json`. The plugin is auto-discovered; no
  `opencode.json` change is required.

```bash
test -f .opencode/plugin/task-store.ts
test -f .opencode/plugin/task-store/injection.ts
```

## Task initialization

Do not invent a project goal or task list.

If the user supplied a goal and tasks, initialize explicitly:

```bash
node .claude/task-store/bin/task-store.js init "<goal>" "<task 1>" "<task 2>"
```

Otherwise ask before running `task-store init`.

Never infer:

- file changed -> task done
- tests passed -> task done
- commit exists -> milestone done

Completion requires an explicit `task-store done` with evidence.

## Auto-checkpoint

Default off. Leave it off.

Only enable when the user explicitly requests it:

```bash
node .claude/task-store/bin/task-store.js config auto-checkpoint conservative
```

Auto-checkpoint is interruption insurance and stale-state detection: it reduces
recovery cost when a session ends before the checkpoint was updated by hand. It
is not automatic task management. It never writes task state on its own; it
emits an instruction at a safe boundary and the agent decides.

## Trust hierarchy

```
repository / tests
  >
git state
  >
task-store
  >
model memory
```

Consequential claims must be verified against repository reality. A checkpoint
entry is a hint about what happened, not evidence that it is still true.

## Completion report

After installation, report:

1. Target repository path
2. Files and directories added or updated
3. Claude Code integration status
4. OpenCode integration status
5. Auto-checkpoint mode
6. Validation commands run, and their results
7. Unrelated user configuration preserved
8. Whether task state was initialized

## Safety boundaries

Do not:

- Commit unless the user asked
- Push unless the user asked
- Delete unrelated `.claude` or `.opencode` content
- Overwrite `opencode.json`
- Modify `package.json` for task-store
- Enable auto-checkpoint without an explicit request
- Invent task state
