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
The state files are read by Claude Code hooks and injected into the AI context. A malicious actor with write access to `.claude-task/state.json` could inject arbitrary text into Claude's context window, potentially influencing Claude's behavior (prompt injection).

**Mitigation**: The hook scripts read and inject the state file as-is. Do not commit state files from untrusted sources without reviewing them. Treat `.claude-task/state.json` with the same trust level as other project configuration files.

### Hook script execution
The hook scripts (`session-start.sh`, `pre-compact.sh`, `session-end.sh`) are shell scripts executed by Claude Code. These scripts:
- Read the state file
- Optionally run `task-store` CLI
- Print JSON output to stdout

**Mitigation**: Review hook scripts before installing. The scripts in this repository do not make network requests, do not execute arbitrary code from state files, and do not send data to external services.

### Atomic writes
State writes use a write-to-temp-then-rename pattern to prevent corruption from interrupted writes. The temp file is always in the same directory as the target file.

## Recommendations

1. **Review state files before committing** them to a shared repository, especially if collaborating with others.

2. **Do not store secrets in task notes or evidence.** Task notes are injected into the AI context. Never write API keys, passwords, or tokens in task descriptions.

3. **The `history.jsonl` file contains your full task history.** Consider whether to commit it. It's gitignored by default. If you commit it, treat it like any other project file.

4. **Local filesystem only.** This plugin makes no network requests. All state is local.

5. **Multi-user environments.** If multiple developers share a project and commit `state.json`, concurrent modifications from separate sessions may conflict. Use git merge workflows to resolve. The last writer wins on atomic write; there is no distributed lock.

## Reporting Vulnerabilities

Open a GitHub issue with the label `security`. For sensitive issues, describe the vulnerability without including exploit details in the public issue — we will coordinate a fix before full disclosure.

## Supported Versions

This project follows [Semantic Versioning](https://semver.org/). Security fixes are applied to the latest major version.
