// claude-task-store OpenCode plugin — injection logic
//
// Pure helpers extracted from task-store.ts so they can be unit-tested
// without going through OpenCode's plugin loader. The plugin file
// (`task-store.ts`) only exports a single default function; exporting
// helpers from the plugin file directly causes OpenCode to try to call
// each export as a plugin, which fails validation. Keeping helpers here
// means the plugin file can stay a single default-export module.
//
// This module is responsible for the resume projection. The
// auto-checkpoint wiring lives in a separate sibling (`./autockpt.ts`)
// to keep the two concerns individually testable.
//
// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1
// do not edit: ownership marker read by install.sh / uninstall.sh

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// 400-token design ceiling × ~4 chars/token. Matches src/core.ts's hard cap;
// truncating is the only safe fallback if the canonical renderer ever
// regresses past it.
export const MAX_INJECTION_CHARS = 1600;

// CLI invocation timeout. The resume renderer is a synchronous read of a
// small JSON file followed by string assembly — milliseconds in practice.
// 5s leaves headroom for cold-start on a slow filesystem while still
// returning fast enough that a hung process can't stall chat.
export const CLI_TIMEOUT_MS = 5000;

export interface CacheEntry {
  // Composite key: worktree + state mtime + state size. Auto-invalidates on
  // any state write because writeState() bumps the file's mtime.
  key: string;
  // null = intentionally skipped (no state, archived, missing CLI, etc).
  // Returning null is cached so repeated calls with the same state file do
  // not re-run the CLI on every chat message of a long session.
  text: string | null;
}

// Result of an attempted CLI invocation. Status mirrors child_process
// semantics (null means "killed by signal"). stdout/stderr are passed
// through verbatim; the caller decides how to interpret them.
export interface CliRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Default CLI runner. Spawns the project-local `task-store` CLI via Node.
//
// IMPORTANT: when this plugin runs inside OpenCode (>=1.x), the plugin
// executes inside a Bun runtime whose `process.execPath` points at the
// OpenCode binary itself, not at a Node interpreter. We deliberately
// invoke `node` (resolved via the user's PATH) instead so the CLI spawns
// correctly under both OpenCode's bundled Bun runtime and a plain Node
// runtime. This is fine because the project-local CLI is itself a plain
// Node ESM script with no Bun-specific APIs.
//
// Factored out so unit tests can inject a stub without mocking
// node:child_process (which is awkward under ts-jest's ESM transform).
export function defaultRunResumeCli(cli: string, worktree: string): CliRunResult {
  const result = spawnSync("node", [cli, "resume", "--root", worktree], {
    encoding: "utf8",
    // Mute the child so its stdout cannot leak into OpenCode's own TUI
    // output. The child uses stderr for warnings; we don't surface those
    // because the resume path is read-only.
    stdio: ["ignore", "pipe", "ignore"],
    timeout: CLI_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

let cache: CacheEntry | null = null;
let runResumeCli: (cli: string, worktree: string) => CliRunResult = defaultRunResumeCli;

// Test seam: lets tests inject a fake CLI runner. Production callers never
// touch this. Renamed with a leading underscore to flag it as internal,
// even though the export is necessary for the test seam to work.
export function _setRunResumeCliForTests(
  runner: (cli: string, worktree: string) => CliRunResult,
): void {
  runResumeCli = runner;
}

export function _resetCacheForTests(): void {
  cache = null;
}

export function buildResumeInjection(worktree: string): string | null {
  if (!worktree) return null;

  const stateFile = join(worktree, ".claude-task", "state.json");
  if (!existsSync(stateFile)) {
    // No state — the canonical no-injection case. Don't pollute the cache
    // for projects that simply have no task store.
    return null;
  }

  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(stateFile);
  } catch {
    return null;
  }

  const key = `${worktree}|${st.mtimeMs}|${st.size}`;
  if (cache && cache.key === key) return cache.text;

  // Status check mirrors session-start.sh: don't inject archived state.
  // We read the file directly rather than shelling out twice.
  let status: string;
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as { status?: unknown };
    status = typeof parsed.status === "string" ? parsed.status : "";
  } catch {
    // Corrupt state file. Fail safe: inject nothing rather than
    // a half-parsed blob.
    cache = { key, text: null };
    return null;
  }
  if (status === "archived") {
    cache = { key, text: null };
    return null;
  }

  // The project-local CLI runtime installed by install.sh. Resolution
  // order matches session-start.sh: prefer the project-local copy, since
  // that is what makes `./install.sh /path/to/project` self-contained.
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) {
    // Plugin is installed but the CLI runtime isn't — likely a partial
    // install. Fail safe: no injection.
    cache = { key, text: null };
    return null;
  }

  const result = runResumeCli(cli, worktree);
  if (result.status !== 0 || !result.stdout) {
    cache = { key, text: null };
    return null;
  }

  let text = result.stdout;
  if (text.length > MAX_INJECTION_CHARS) {
    // Defensive cap. The canonical renderer is bounded; this only fires
    // if that invariant is broken. Truncate rather than blow the system
    // prompt budget.
    text = text.slice(0, MAX_INJECTION_CHARS) + "\n[…truncated, run `task-store status`]";
  }

  cache = { key, text };
  return text;
}
