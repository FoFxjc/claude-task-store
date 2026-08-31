# Pre-Release Remediation

**Date:** 2026-08-31
**Version:** 0.1.0 (pre-release)
**Scope:** Findings raised after [`pre-publish-review.md`](pre-publish-review.md), and the fixes applied for them.

---

## Purpose

[`pre-publish-review.md`](pre-publish-review.md) concluded "READY WITH MINOR CAVEATS". A closer follow-up pass on the same tree found a set of defects that review had missed — most of them in code paths that only misbehave under conditions the earlier smoke tests never created: a project path containing a space, a pre-existing hook belonging to somebody else, two agents writing at once, evidence text containing a comma.

This document is the numbered index those fixes refer to. Several source comments, `README.md`, and `SECURITY.md` cite items here by number (e.g. "see `docs/pre-release-remediation.md` item 3"), so the numbering is stable and must not be renumbered.

Each item below states the defect, the concrete failure it produced, the fix, and how the fix is verified. "Verified by" names a test that fails without the fix.

---

## Status summary

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | Installer/uninstaller deleted hooks it did not own | **High** | Fixed |
| 2 | `settings.json` rewritten with no backup | Medium | Fixed |
| 3 | `--expect-rev` was a TOCTOU check; writes were not serialized | **High** | Fixed |
| 4 | Evidence strings were comma-joined and re-split, corrupting them | Medium | Fixed |
| 5 | `session-start.sh` reimplemented the resume renderer, and had drifted | Medium | Fixed |
| 6 | `--by` silently ignored on read-only commands | Low | Fixed |
| 7 | `block` destroyed pre-existing task notes | Medium | Fixed |
| 8 | Shell/Python interpolation broke on paths with spaces or quotes | **High** | Fixed |
| 9 | `SKILL.md` frontmatter invalid; "authoritative" contradicted trust hierarchy | Medium | Fixed |
| 10 | `token-estimate` undocumented and malformed in the CLI source | Low | Fixed |
| 11 | `install.sh` performed a global npm install by default | Medium | Fixed |
| 12 | CI ran only 2 of 8 test suites | Medium | Fixed |
| 13 | `package-lock.json` license drifted from `package.json` | Low | Fixed |
| 14 | New transient files (`.lock`, `settings.json.bak`) not gitignored | Low | Fixed |

All 14 are fixed in the working tree. Test status is recorded at the bottom.

---

## 1. Installer and uninstaller deleted hooks they did not own

**Severity:** High — silent destruction of unrelated user configuration.

**Defect.** Both `install.sh` and `uninstall.sh` decided which hook entries to remove from `.claude/settings.json` using a *substring* match:

```python
'task-store' in str(h.get('command', '')) or 'session-start.sh' in str(h.get('command',''))
or 'pre-compact.sh' in ... or 'session-end.sh' in ...
```

**Failure.** Any hook whose command merely *contained* one of those substrings was deleted. A user with their own `$CLAUDE_PROJECT_DIR/scripts/my-own-session-start.sh` registered on `SessionStart` lost it on install — and installing a task-store plugin is not consent to delete other plugins' hooks. The same matcher ran in `uninstall.sh`, so uninstalling deleted them too. The match was also event-blind: a command string was tested against every event's entries, not just its own.

**Fix.** Ownership is now an **exact** match against the three literal command strings this project installs, keyed by event:

```python
OWNED_COMMANDS = {
    'SessionStart': '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-start.sh',
    'PreCompact':   '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/pre-compact.sh',
    'SessionEnd':   '${CLAUDE_PROJECT_DIR}/.claude/hooks/scripts/session-end.sh',
}
```

Removal preserves the surrounding entry when it also holds hooks belonging to someone else, and drops the entry only when nothing remains. Events are deleted only when they end up empty. Re-running `install.sh` is idempotent — it removes its own entry before re-adding it, so it never duplicates.

**Verified by:** `tests/install_regression_test.sh`. The fixture deliberately includes the exact collision patterns — a `scripts/my-own-session-start.sh` path and an inline command containing the literal text `task-store` — plus an untouched `UserPromptSubmit` event, and asserts all three survive install, re-install, and uninstall.

---

## 2. `settings.json` was rewritten with no backup

**Severity:** Medium.

**Defect.** Both scripts parsed `.claude/settings.json` and re-emitted it with `json.dump(..., indent=2)`, in place, with no backup. Re-emitting normalizes formatting and drops anything that is not standard JSON. Combined with item 1, a bad match was unrecoverable.

**Fix.** Both `install.sh` and `uninstall.sh` copy the file to `.claude/settings.json.bak` before rewriting. The README documents that the backup exists and that formatting is not preserved.

**Verified by:** `tests/install_regression_test.sh` asserts `.bak` exists after both install and uninstall.

---

## 3. `--expect-rev` was a TOCTOU check, and writes were never serialized

**Severity:** High — the documented concurrency guarantee did not hold.

**Defect.** `--expect-rev` read the on-disk revision, compared it, and then let the command mutate and write. Nothing held between the read and the write, so two agents could both pass the check and both write; the second silently clobbered the first. `compareAndWriteState()` had the same shape. This is precisely the lost-update the flag exists to prevent.

**Fix, part one.** Added `withStoreLock()` in `src/core.ts`: an `O_EXCL` lock file at `.claude-task/.lock`, acquired with a bounded spin (25 ms poll, 5 s timeout), with stale-lock breaking after 30 s for locks left by a crashed process. `compareAndWriteState()` and the CLI's check-then-mutate path both run inside it, so the compare and the write cannot be interleaved.

**Fix, part two (follow-up).** The first pass wired the lock only to the `--expect-rev` path:

```ts
if (expectRev !== undefined) { withStoreLock(projectRoot, runCommand); } else { runCommand(); }
```

But `SECURITY.md` and `README.md` claimed that concurrent CLI invocations are serialized *in general*. They were not: a plain `task-store done T1 -e x` with no `--expect-rev` still did an unlocked read-modify-write. Measured directly — 12 concurrent `task-store add` invocations against one project produced **9 tasks, losing 3 writes**. The lock is now taken for every mutating command (`init`, `add`, `start`, `done`, `block`, `resume-task`, `attempt`, `decide`, `next`, `archive`, `repair`). The same 12-way test now yields 12/12. Read-only and unknown commands stay unlocked, so `task-store status` on an uninitialized project does not create `.claude-task/`.

**Fix, part three (follow-up).** Locking every mutating command exposed a leak: several commands call `process.exit()` on a validation error (`done` with no evidence, `init` with no goal), and `process.exit()` does **not** run `finally` blocks. The lock file survived, and the user's next command blocked for the full 5 s acquire timeout before failing. `withStoreLock()` now also releases via a `process.once('exit', …)` listener, removed in the `finally` on the normal path.

**The exact guarantee.** Concurrent **`task-store` CLI** invocations against the same project root are serialized; with `--expect-rev` the compare-and-write is atomic, and a stale write fails with exit code 2. This does **not** cover code that imports `src/core.ts` and calls `writeState()` or a mutation helper directly without going through `withStoreLock()` — such callers can still race. It is a single-machine advisory lock and is not safe across a network filesystem.

**Verified by:** `tests/path_safety_test.sh` scenarios 7 and 8 — stale `--expect-rev` exits 2, matching `--expect-rev` succeeds, the lock is released after both success and a validation-error exit, and 12 concurrent unflagged `add` invocations all survive with no duplicate IDs. Scenario 8 was confirmed non-vacuous by re-running it against a build with the lock disabled, which loses writes.

---

## 4. Evidence strings were comma-joined and re-split

**Severity:** Medium — silent data corruption.

**Defect.** `parseArgs` collected `-e` values by consuming every following non-`-` token, joined them with `','`, and `done` split that string back on `','`. Two things broke. Evidence containing a comma — `-e "tests pass, all 31 of them"` — was silently split into two bogus evidence entries. And because collection ran until the next `-`, a trailing positional argument could be swallowed into the evidence list.

**Fix.** Each `-e` now takes exactly one following value, kept as an opaque string; repeated `-e` flags accumulate into a `string[]` carried end-to-end with no join/split round trip. A missing value after `-e` is a clean usage error rather than a silent empty entry.

**Verified by:** `tests/path_safety_test.sh` scenario 2 asserts `-e "tests pass, all 139 of them" -e "src/core.ts"` is stored as exactly those two strings.

---

## 5. `session-start.sh` reimplemented the resume renderer, and had drifted

**Severity:** Medium.

**Defect.** The hook's Python fallback contained a second, complete implementation of `buildResumeContext()` — box-drawing header, `CURRENT`/`DONE`/`REMAINING`/`BLOCKED` sections, attempt rendering, decision list. Two renderers, one spec, and they had already diverged: the earlier hardening pass had to patch the done-task cap and blocked-task attempts into the Python copy separately to catch it up with the TypeScript. Every future change to the resume format would need the same double edit, and any missed edit produces a silently different resume context depending on whether the CLI happened to be installed — which is exactly the sort of inconsistency this project exists to prevent.

**Fix.** The hook no longer reimplements the renderer. `task-store resume` is the single canonical path. When the CLI is genuinely unavailable, the hook degrades to a deliberately minimal fallback — goal, next action, and a pointer to `task-store status` — clearly labelled as such in its output. A short fallback that is obviously partial is better than a long one that is subtly wrong.

**Verified by:** `tests/path_safety_test.sh` scenario 4 exercises both paths — CLI-present output contains the goal, and the CLI-absent fallback is valid JSON and carries its `minimal fallback` marker.

---

## 6. `--by` was silently ignored on read-only commands

**Severity:** Low.

**Defect.** `--by` records write provenance. On `status`, `resume`, `history`, `stale`, and `token-estimate` it was parsed and discarded. A user scripting `task-store status --by codex` had no way to learn the flag did nothing.

**Fix.** `--by` on a read-only command is now an explicit error naming the command. It remains accepted on all writing commands, and `init`, `add`, `archive`, and `repair` — which previously dropped it on the floor even though they write — now thread it through to `writeState()`.

**Verified by:** `tests/path_safety_test.sh` scenario 6.

---

## 7. `block` destroyed pre-existing task notes

**Severity:** Medium — unrecoverable context loss.

**Defect.** `blockTask()` did `task.notes = reason`, unconditionally overwriting whatever was there. Notes are where a task's accumulated working context lives, so blocking a task threw that away — at the exact moment the context is most valuable, since a blocked task is the one a later session most needs to understand.

**Fix.** `task.notes` is only backfilled when empty. The blocker reason is always recorded in `state.blockers`, which was already the durable home for it. `buildResumeContext()` now renders the reason for a blocked task by looking up the most recent matching `state.blockers` entry, falling back to notes then title — so the resume display is unchanged while the underlying data stops being destructive.

**Verified by:** `tests/path_safety_test.sh` scenario 3 sets a note, blocks the task, and asserts the note survives, the reason is recorded, and the reason still appears in the rendered resume context.

---

## 8. Shell and Python interpolation broke on paths with spaces or quotes

**Severity:** High — the plugin was broken for a common class of project paths.

**Defect.** Several sites interpolated shell values directly into Python source inside unquoted heredocs:

```bash
STATUS=$(python3 -c "import sys,json; d=json.load(open('$STATE_FILE')); ...")
```

For a project at `/Users/pat/my projects/app` this still parses, but for `/Users/pat's projects/app` the apostrophe terminates the Python string literal and the hook dies with a `SyntaxError`. The pattern is also an injection sink: the path is attacker-influenced text being pasted into source that is about to be executed. Separately, `TASK_STORE_CMD` was built as a *string* (`"node $PROJECT_DIR/bin/task-store.js"`) and invoked unquoted, so it word-split on any space in the path; and the `~/bin` shim was generated with a `SCRIPT_DIR` placeholder patched by `sed`, which mangles paths containing `|` or `&`.

**Fix.** Every Python inline in `session-start.sh`, `pre-compact.sh`, `install.sh`, and `uninstall.sh` now receives its values through exported environment variables read with `os.environ`, under a **quoted** (`<<'PYEOF'`) heredoc, so bash performs no expansion on the Python source at all. `TASK_STORE_CMD` is a bash **array**, invoked as `"${TASK_STORE_CMD[@]}"`. The shim is written from a heredoc that expands `$SCRIPT_DIR` once, correctly, with no `sed` post-processing, and `exec`s rather than forking.

**Verified by:** `tests/path_safety_test.sh` runs the entire surface — CLI, all three hooks, installer, uninstaller — against a project directory named `pat's $weird project`, covering the CLI path, the minimal fallback, archived state, missing state, and corrupt state.

---

## 9. `SKILL.md` frontmatter was invalid, and overclaimed authority

**Severity:** Medium.

**Defect.** Two problems in `skills/task-store/SKILL.md`. The frontmatter carried `invocation: user-or-claude`, which is not a recognized field, and omitted the required `name`. And the body asserted:

> **This context is authoritative.** Use it to resume work without re-reading transcripts.

That directly contradicts the trust hierarchy the same file documents — `repository/tests > git state > task-store > model memory` — and which Phase 2's safety test explicitly requires. Telling a model that a checkpoint file outranks the repository is how a stale `next_action` gets acted on after the code beneath it has moved.

**Fix.** Frontmatter is now `name: task-store` plus `description`. The body reads as orientation, not authority, and points back at the trust hierarchy for anything consequential.

---

## 10. `token-estimate` was undocumented and malformed

**Severity:** Low.

**Defect.** The `token-estimate` command worked but was absent from the `--help` `COMMANDS:` list, so it was undiscoverable and unmentioned in the README's command table. Its `case` arm also had the first statement collapsed onto the label line (`case 'token-estimate': {        const state = ...`), a formatting artifact that made the switch harder to read.

**Fix.** Listed in `--help`; the case arm reformatted.

---

## 11. `install.sh` performed a global npm install by default

**Severity:** Medium — surprising, undocumented mutation of the user's machine.

**Defect.** `install.sh` ran `npm install -g .` unprompted. A project-scoped installer silently modified global state outside the project, and on failure fell through to writing a shim into `~/bin` — also outside the project, also unannounced. Neither was documented. It was unnecessary as well: `session-start.sh` already resolves the CLI through `node bin/task-store.js` and `node_modules/.bin/task-store` when `task-store` is not on `PATH`.

**Fix.** Global install is opt-in via `TASK_STORE_INSTALL_GLOBAL=1`. The default path prints exactly what it is skipping and how to opt in. The README documents both. The `~/bin` shim is still only reachable from the opt-in path.

**Verified by:** `tests/path_safety_test.sh` scenario 5 asserts the default run reports skipping the global install.

---

## 12. CI ran only 2 of 8 test suites

**Severity:** Medium.

**Defect.** `.github/workflows/ci.yml` ran `npm test` and `tests/acceptance.sh` only. The five Phase 2 reliability suites and the Phase 3 handoff suite — 66 checks, the evidence base for the reliability and cross-agent claims in the README and the phase reports — never ran in CI. Regressions in them would land unnoticed.

**Fix.** CI now runs every suite: unit, acceptance, all five Phase 2 suites, Phase 3 handoff, the installer regression suite, and the path safety suite, across Node 18/20/22.

---

## 13. `package-lock.json` license drifted from `package.json`

**Severity:** Low.

**Defect.** The license change to MPL-2.0 updated `package.json` and `LICENSE` but not the root entry in `package-lock.json`, which still read `"license": "MIT"`.

**Fix.** Synced to `MPL-2.0`.

---

## Test status

All suites pass in the working tree:

| Suite | Checks | Result |
|-------|--------|--------|
| Unit (`npm test`) | 31 | Pass |
| Acceptance | 17 | Pass |
| Phase 2: pressure | 13 | Pass |
| Phase 2: decay | 8 | Pass |
| Phase 2: recovery | 15 | Pass |
| Phase 2: safety | 8 | Pass |
| Phase 2: git workflow | 8 | Pass |
| Phase 3: handoff | 22 | Pass |
| Installer regression (new) | 17 | Pass |
| Path safety (new) | 32 | Pass |
| **Total** | **171** | **Pass** |

`npm run build` succeeds with no errors.

---

## Known limitations (unchanged from the earlier review, restated)

1. **Lock scope.** `withStoreLock()` protects CLI callers on one machine. Direct library callers that bypass it, and network filesystems, are not covered (item 3).
2. **`updated_by` is unauthenticated.** Any agent can claim any identity string. Informational only.
3. **`history.jsonl` grows unbounded.** Gitignored by default; manual removal is safe.
4. **Evidence is a claim, not a proof.** `-e "tests pass"` does not run tests. The trust hierarchy in `SKILL.md` is the mitigation.
5. **Python 3 required for hooks.** The Node CLI works without it; the hooks do not.
6. **Pi interoperability untested.** Deferred in Phase 3; Pi was unavailable in the test environment.

---

## Remaining before tagging v0.1.0

Nothing in this document is outstanding. The pre-existing release steps in
[`pre-publish-review.md`](pre-publish-review.md) §"Commands to Tag and Release" still apply, with one
addition: commit the working tree, and confirm CI passes on the branch now that
it actually runs all eight suites.

---

## Addendum — item 14

## 14. New transient files were not gitignored

**Severity:** Low.

**Defect.** Items 2 and 3 introduced two files that had no gitignore coverage:
`.claude-task/.lock` (the transient `O_EXCL` write lock, which a crashed
process can leave behind for up to 30 s) and `.claude/settings.json.bak`
(written before every install/uninstall rewrite). Both would show up in
`git status` and be swept into a `git add -A`. Committing a lock file is
actively harmful — it lands in a teammate's checkout as a stale lock.

**Fix.** Both are ignored in the repository's own `.gitignore` and in the
block `install.sh` appends to a target project's `.gitignore`. `state.json`
remains committable, which is the point of the design.

**Note.** `install.sh` skips the append when its `# claude-task-store` marker
is already present, so a project installed before this fix keeps its older
block. Add the two lines by hand there, or remove the marked block and
re-run the installer.
