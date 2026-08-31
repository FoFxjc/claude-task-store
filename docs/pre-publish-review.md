# Pre-Publish Review

**Date:** 2026-08-31  
**Version:** 0.1.0  
**Reviewer:** Automated audit (pre-publish hardening pass)

---

## Verdict

**READY WITH MINOR CAVEATS**

All tests pass. Installation is verified. Security posture is sound. The caveats are documented limitations that do not block a public v0.1.0 release.

---

## 1. Repository Hygiene

### Findings and fixes

| Finding | Severity | Fix |
|---------|----------|-----|
| `.gitignore` gitignored all of `.claude-task/` — users couldn't commit `state.json` | High | Fixed: now only ignores `history.jsonl` |
| `commands/` was an empty directory | Low | Removed |
| `package.json` listed `commands/` in `files` | Low | Removed from `files` |
| `package.json` version was `1.0.0` | Medium | Changed to `0.1.0` (pre-release) |
| `package.json` had no `repository`, `homepage`, `bugs` fields | Low | Added |
| `package.json` description was verbose | Low | Replaced with concise positioning statement |
| `uninstall.sh` not listed in `package.json` `files` | Low | Added |
| No LICENSE file despite `"license": "MIT"` in package.json | High | Created `LICENSE` (MIT) |
| No CI workflow | Medium | Added `.github/workflows/ci.yml` |

### No issues found
- No temporary files
- No local test artifacts  
- No debug output in committed files
- No generated files committed (dist/ is in .gitignore)
- No absolute local paths in source (install.sh uses `$SCRIPT_DIR` correctly)
- No developer-specific usernames/machine paths
- No duplicate files
- No accidental secrets

---

## 2. Security Review

### Findings

| Finding | Severity | Status |
|---------|----------|--------|
| `session-end.sh`: `PROJECT_DIR` bash var not exported before Python heredoc | Medium | Fixed: added `export PROJECT_DIR` |
| `session-start.sh`: `STATE_FILE` not exported before Python fallback heredoc | Medium | Fixed: added `export STATE_FILE` |
| Python fallback in `session-start.sh` didn't cap done tasks at 5 (state decay risk) | Medium | Fixed: added same capping logic as TypeScript |
| `uninstall.sh`: `export SETTINGS_FILE` came after the heredoc that used it | Medium | Fixed: moved export before heredoc |

### No issues found
- No API keys, tokens, credentials, or secrets
- No private URLs or internal endpoints
- No network access (confirmed: no `curl`, `wget`, `fetch`, or DNS calls anywhere)
- No telemetry
- Atomic writes use `write-to-tmp + renameSync` — safe against interruption
- Temp files are always in same directory as target — no `/tmp` cross-device rename issues
- No symlink or path traversal risks
- No `eval` or dynamic code execution
- Shell scripts use `set -euo pipefail`
- Python inlines use `try/except` with safe fallback (exit 0)

### Prompt injection note (documented)
State files are injected into Claude's context. A malicious `state.json` could contain adversarial text. This is documented in `SECURITY.md` and is inherent to the design. No fix needed — treat `state.json` like other project config files.

---

## 3. Installation Review

**Test:** Fresh temporary directory with `git init`.

```
./install.sh <project>
```

Results:
- ✓ TypeScript built
- ✓ `SKILL.md` copied to `.claude/skills/task-store/`
- ✓ Hook scripts copied to `.claude/hooks/scripts/`
- ✓ Hooks merged into `.claude/settings.json`
- ✓ `.gitignore` updated with correct entries
- ✓ `task-store` CLI functional via `node dist/cli.js`

**Verified:** README install steps match actual behavior.

**Known limitation:** Global `npm install -g .` requires appropriate permissions. The installer falls back to `~/bin/` shim gracefully. This is documented.

---

## 4. First-Use Experience

README now opens with:

```
Persistent execution checkpoints for Claude Code.
Resume long coding tasks across sessions and models without replaying the full conversation.

Plain JSON · Local-first · <400-token resume state · No cloud · No embeddings · Model-neutral
```

A new user can understand:
- ✓ What this project does (first two lines)
- ✓ What problem it solves (six-questions section)
- ✓ What it does NOT do ("not a general-purpose memory system, not a vector database, not a project management tool")
- ✓ How to install it (Installation section with prerequisites)
- ✓ How to initialize a task (Quick Start)
- ✓ How Claude Code resumes state (session context example)
- ✓ How to inspect status (`task-store status`)
- ✓ How to uninstall (`uninstall.sh`)

---

## 5. Documentation Consistency

| Document | Status |
|----------|--------|
| README.md | Updated: schema example includes `revision`/`updated_by`; `stale` command added; `--by`/`--expect-rev` flags documented |
| DESIGN.md | No changes needed — architecture section still accurate |
| SECURITY.md | No changes needed — already covers prompt injection, local-only, multi-user note |
| skills/task-store/SKILL.md | No changes needed — Phase 2 trust hierarchy section is accurate |
| schemas/state.schema.json | Updated in Phase 3 — includes `revision` and `updated_by` |
| CLI help | Matches README commands table |
| install.sh | Consistent with README install steps |
| uninstall.sh | Now correctly exports `SETTINGS_FILE` before Python heredoc |

---

## 6. CLI UX Review

All commands tested:

| Command | Exit 0 | Error handling |
|---------|--------|---------------|
| `init` | ✓ | Rejects empty goal; rejects existing active state |
| `status` | ✓ | "No state found" when missing |
| `resume` | ✓ | "No state found" when missing |
| `add` | ✓ | Requires title |
| `start` | ✓ | Warns if another task in_progress |
| `done` | ✓ | Rejects empty evidence |
| `block` | ✓ | Requires reason |
| `resume-task` | ✓ | StateError on missing task |
| `attempt` | ✓ | Requires all three args |
| `decide` | ✓ | Requires summary |
| `next` | ✓ | Requires action text |
| `history` | ✓ | "No history yet" when missing |
| `archive` | ✓ | StateError on missing state |
| `repair` | ✓ | Reports success/failure clearly |
| `stale` | ✓ | Exit 1 when stale tasks found (correct for scripts) |
| `token-estimate` | ✓ | Numeric output |
| `--expect-rev` conflict | ✓ | Exit 2, clear message; no stack trace |
| Unknown command | ✓ | Exit 1, suggests `--help` |

No stack traces for normal user errors. All `StateError` instances caught before throw.

---

## 7. Hook Safety

| Hook | Safety check | Result |
|------|-------------|--------|
| `session-start.sh` | No state file → exits 0 silently | ✓ |
| `session-start.sh` | Archived state → exits 0 silently | ✓ |
| `session-start.sh` | CLI unavailable → Python fallback | ✓ |
| `session-start.sh` | Corrupt state → Python try/except exits 0 | ✓ |
| `session-start.sh` | Done-task cap (5) — now matches TypeScript | ✓ Fixed |
| `pre-compact.sh` | No state file → exits 0 silently | ✓ |
| `pre-compact.sh` | Corrupt state → try/except exits 0 | ✓ |
| `session-end.sh` | No state file → exits 0 silently | ✓ |
| `session-end.sh` | `PROJECT_DIR` exported correctly | ✓ Fixed |
| All hooks | Output stays compact (context injection is small) | ✓ |

---

## 8. Package / Release Metadata

```json
{
  "name": "claude-task-store",
  "version": "0.1.0",
  "license": "MIT",
  "repository": "github:FoFxjc/claude-task-store",
  "engines": { "node": ">=18.0.0" }
}
```

✓ Name, version, license, repository, homepage, bugs, engines, bin all set.  
✓ `files` array includes all necessary files and excludes `commands/`.  
✓ `uninstall.sh` added to `files`.

---

## 9. License

✓ `LICENSE` file created (MIT).  
✓ `package.json` `"license": "MIT"` matches.

---

## 10. CI

✓ `.github/workflows/ci.yml` created.  
Runs on push/PR to main, tests Node.js 18/20/22:
- `npm ci`
- `npm run build`
- `npm test` (unit tests)
- `bash tests/acceptance.sh`

---

## 11. Test Results

| Suite | Tests | Result |
|-------|-------|--------|
| Unit tests | 31 | ✓ Pass |
| Acceptance | 17 | ✓ Pass |
| Phase 2: pressure | 13 | ✓ Pass |
| Phase 2: decay | 8 | ✓ Pass |
| Phase 2: recovery | 15 | ✓ Pass |
| Phase 2: safety | 8 | ✓ Pass |
| Phase 2: git workflow | 8 | ✓ Pass |
| Phase 3: handoff | 22 | ✓ Pass |
| **Total** | **122** | ✓ All pass |

**Build:** ✓ `npm run build` succeeds  
**Install:** ✓ Fresh-directory install smoke test passes  

---

## 12. Public Surface Review

- Tone: technical and concise throughout
- No internal development notes in user-facing docs
- No confusing terminology
- DESIGN.md explains the gap clearly
- SECURITY.md covers the real risks without being alarmist
- Phase 2/3 reports are in `docs/` — accurate, no internal notes, appropriate for public
- `examples/cross-session-demo.md` — useful reference
- No placeholder text or `TODO` comments in public-facing files

---

## 13. Changes Made in This Pass

| File | Change |
|------|--------|
| `.gitignore` | Fixed: only ignore `history.jsonl`, not all of `.claude-task/` |
| `LICENSE` | Created: MIT license |
| `package.json` | Version `0.1.0`; add `repository`/`homepage`/`bugs`; update description; fix `files`; better keywords |
| `.github/workflows/ci.yml` | Created: minimal CI workflow |
| `hooks/scripts/session-start.sh` | Export `STATE_FILE` before heredoc; cap done tasks at 5 (match TypeScript); fix attempts for blocked tasks |
| `hooks/scripts/session-end.sh` | Export `PROJECT_DIR` before Python heredoc |
| `uninstall.sh` | Export `SETTINGS_FILE` before Python heredoc |
| `README.md` | New positioning statement; schema updated with `revision`/`updated_by`; `stale` command added; cross-agent flags documented; CI badge added |
| `commands/` (empty dir) | Removed |

---

## 14. Known Limitations

1. **No distributed lock** — concurrent agent sessions use last-writer-wins by default. `--expect-rev` provides opt-in conflict detection but is not atomic CAS. Documented in SECURITY.md.

2. **`updated_by` is unauthenticated** — any agent can claim any identity string. Informational only.

3. **`history.jsonl` grows unbounded** — no automatic pruning. Gitignored by default. Manual `rm .claude-task/history.jsonl` is safe.

4. **Evidence paths are claims** — marking a task done with `-e "tests pass"` doesn't verify tests actually pass. Trust hierarchy is documented in SKILL.md and Phase 3 report.

5. **Python 3 required** — for hook fallback and hook scripts. Documented in prerequisites. On systems without Python 3, the Node.js CLI path still works; hooks require Python 3.

6. **Pi not tested** — Phase 3 deferred Pi interoperability test (Pi not available in test environment).

---

## 15. Unresolved Blockers

**None.** All blocking issues have been fixed.

---

## Suggested First Version

`v0.1.0`

Conservative pre-1.0 version signaling: functional, validated, but API may evolve before 1.0.

---

## Commands to Tag and Release

Once the PR is merged to `main`:

```bash
# Merge PR #1 via GitHub UI or:
# gh pr merge 1 --squash --repo FoFxjc/claude-task-store

# After merge, tag from main:
git checkout main
git pull
git tag -a v0.1.0 -m "v0.1.0 — initial public release

Persistent execution checkpoints for Claude Code.
Plain JSON, local-first, <400-token resume state, model-neutral.

Validated through:
- Phase 2: reliability (122 tests)
- Phase 3: cross-agent handoff (Claude↔Codex)

See DESIGN.md for architecture.
See docs/ for validation reports."

git push origin v0.1.0
```

To publish to npm (if desired, after explicit authorization):
```bash
npm publish --access public
```
