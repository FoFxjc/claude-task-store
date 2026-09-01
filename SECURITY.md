# Security Policy

## Overview

`claude-task-store` stores execution state in plain JSON files in your project directory. This document describes the security model and known considerations.

## Data Storage

### What is stored
- `state.json`: Task titles, goal description, notes, evidence file paths, failure summaries, decisions, and next actions. This is entirely content you write.
- `history.jsonl`: An append-only log of state transitions. Contains the same data as `state.json` plus timestamps.

### What is NOT stored
- Conversation transcripts
- Code file contents
- API keys or secrets
- Authentication credentials
- User data from your application

## Threat Model

### State file injection
The state files are read by both integrations and injected into the agent's context: the Claude Code `SessionStart` hook injects them as `additionalContext`, and the OpenCode plugin pushes the same projection into the system prompt via `experimental.chat.system.transform`. A malicious actor with write access to `.claude-task/state.json` could inject arbitrary text into that context window, potentially influencing the agent's behavior (prompt injection).

**Injected task-store content is untrusted project-local input.** Both hosts render the same bytes from the same file, so **OpenCode system-context injection carries exactly the same prompt-injection trust considerations as the Claude Code hooks** — neither is more or less trusted than the other.

**Mitigation**: Both adapters read and inject the state file as-is; neither interprets, executes, or evaluates its contents. Do not commit state files from untrusted sources without reviewing them. Treat `.claude-task/state.json` with the same trust level as other project configuration files. The trust hierarchy the tool documents and re-states in its own reconciliation instruction is the behavioral mitigation: **repository/tests > git state > task-store > model memory**. The task store records what happened; it is never authoritative over what the repository and its tests actually show.

### Executable surface installed into your project
`install.sh` places executable code in two places. Nothing else in your project is modified — in particular, your `package.json` and lockfile are never touched.

**Claude Code — shell hooks in `.claude/hooks/scripts/`**, registered in `.claude/settings.json`:
- `session-start.sh` (`SessionStart`) — injects the resume projection
- `pre-compact.sh` (`PreCompact`) — writes a history marker before compaction
- `session-end.sh` (`SessionEnd`) — session-boundary bookkeeping
- `post-tool-use.sh` (`PostToolUse`) — auto-checkpoint dirty marking; inert unless the project opts in
- `stop.sh` (`Stop`) — auto-checkpoint reconciliation boundary; inert unless the project opts in

Each script reads the state file, optionally runs the `task-store` CLI, and prints JSON to stdout.

**OpenCode — an auto-discovered plugin at `.opencode/plugin/task-store.ts`**, plus the helper module it imports at `.opencode/plugin/task-store/injection.ts`. OpenCode loads and executes both inside its own runtime. The plugin registers four hooks (`experimental.chat.system.transform`, `event`, `tool.execute.after`, `experimental.session.compacting`), holds no task-state logic of its own, and reaches the store only by spawning the same project-local `task-store` CLI the Claude Code hooks use.

**Mitigation**: Review both surfaces before installing; the full source of each ships with the install and is byte-identical to this repository. Neither the hook scripts nor the OpenCode adapter makes network requests, sends telemetry, executes arbitrary code from state files, or transmits data to external services — **the OpenCode adapter introduces no network access or telemetry of any kind**. Both use only Node/OS built-ins and add no npm dependency to your project. `uninstall.sh` removes these files only after confirming a claude-task-store ownership marker, so a foreign file at the same path is left in place.

### Atomic writes
State writes use a write-to-temp-then-rename pattern to prevent corruption from interrupted writes. The temp file is always in the same directory as the target file. Separately, `task-store` CLI invocations serialize their full read-modify-write cycle behind an O_EXCL lock file (`.claude-task/.lock`) so that two concurrent CLI invocations cannot interleave a read and a write — see the "Multi-user environments" recommendation below for the exact scope of this guarantee.

## Recommendations

1. **Review state files before committing** them to a shared repository, especially if collaborating with others.

2. **Do not store secrets in task notes or evidence.** Task notes are injected into the AI context. Never write API keys, passwords, or tokens in task descriptions.

3. **The `history.jsonl` file contains your full task history.** Consider whether to commit it. It's gitignored by default. If you commit it, treat it like any other project file.

4. **Local filesystem only.** Neither the Claude Code hooks nor the OpenCode plugin makes network requests or emits telemetry. All state is local.

5. **Multi-user environments.** By default, concurrent writes from separate `task-store` CLI invocations are serialized (not merely last-writer-wins) by an O_EXCL lock file (`.claude-task/.lock`) held around each command's full read-modify-write cycle. Passing `--expect-rev <N>` additionally makes the write fail with a conflict error if another writer's revision has moved since you last read state — this check is performed inside the same lock, so it is atomic, not a best-effort/TOCTOU-prone check. This protects concurrent **task-store CLI** invocations. It does **not** protect code that imports `src/core.ts` directly and calls `writeState()`/mutation functions without going through `withStoreLock()` — such callers can still race. See [`docs/pre-release-remediation.md`](docs/pre-release-remediation.md) item 3 for the exact guarantee and limitation.

## Reporting Vulnerabilities

Open a GitHub issue with the label `security`. For sensitive issues, describe the vulnerability without including exploit details in the public issue — we will coordinate a fix before full disclosure.

## Supported Versions

This project follows [Semantic Versioning](https://semver.org/). Security fixes are applied to the latest major version.
