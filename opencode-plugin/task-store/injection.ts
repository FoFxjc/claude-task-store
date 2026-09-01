// claude-task-store OpenCode plugin — injection logic
//
// Pure helpers extracted from task-store.ts so they can be unit-tested
// without going through OpenCode's plugin loader. The plugin file
// (`task-store.ts`) only exports a single default function; exporting
// helpers from the plugin file directly causes OpenCode to try to call
// each export as a plugin, which fails validation. Keeping helpers here
// means the plugin file can stay a single default-export module.
//
// This module covers three concerns:
//
//   1. Resume injection        — `task-store resume` is invoked when a fresh
//                                session begins and the canonical projection
//                                is appended to the system prompt via
//                                `experimental.chat.system.transform`.
//
//   2. Auto-checkpoint dirty   — `tool.execute.after` calls
//                                `task-store auto mark-dirty` for any tool
//                                name that is plausibly mutating (read-only
//                                tools are excluded by a small allow-list;
//                                we never inspect command arguments).
//
//   3. Auto-checkpoint boundary — on `session.idle`, the plugin calls
//                                 `task-store auto check --instruction`. If the
//                                 CLI exits 0 (the reconciliation gates pass),
//                                 the instruction text is staged to a pending
//                                 file under `.claude-task/`. The next
//                                 `experimental.chat.system.transform`
//                                 consumes that file and injects the
//                                 instruction alongside the resume projection.
//
// The pending-file bridge is needed because OpenCode does not expose a
// direct analog of Claude Code's `Stop` hook's `additionalContext` channel
// at idle time. The instruction is therefore persisted to disk and
// delivered to the model on the next chat call — which is exactly when a
// human (or another session.idle) is going to read it anyway.
//
// CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1
// do not edit: ownership marker read by install.sh / uninstall.sh

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
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

// ─── Auto-checkpoint integration ────────────────────────────────────────────
//
// Every helper below defers to the provider-neutral core in src/autocheckpoint.ts
// through the existing `task-store` CLI. Nothing in this file inspects or
// mutates execution state directly; the core is the single source of truth
// for dirty-window bookkeeping, debounce, and the reconciliation decision.

// OpenCode 1.18.25 tool names that do NOT change repository state and
// therefore should not dirty the checkpoint. Anything outside this set
// is treated as plausibly mutating.
//
// This is a deliberately conservative small list: when in doubt, dirty.
// The provider-neutral core ignores the signal if auto-checkpoint is off,
// so a false positive only ever costs a one-line runtime marker write.
const READ_ONLY_TOOLS = new Set<string>([
  "read",
  "glob",
  "grep",
  "list",
  "webfetch",
  "websearch",
  "skill",
  "task",
  "question",
  "todowrite",
]);

export function isDirtyWorthyTool(tool: string): boolean {
  if (!tool) return false;
  return !READ_ONLY_TOOLS.has(tool);
}

// Pending reconciliation instruction file. Consumed exactly once on the
// next `experimental.chat.system.transform` after the boundary that
// staged it. Located inside `.claude-task/` so it shares the existing
// `.claude-task/.lock` and ownership story as state.json and the runtime
// bookkeeping file.
const PENDING_INSTRUCTION_FILE = ".pending-reconcile-instruction.txt";

function pendingInstructionPath(worktree: string): string {
  return join(worktree, ".claude-task", PENDING_INSTRUCTION_FILE);
}

// Default CLI runner for `task-store auto mark-dirty`.
//
// The CLI returns non-zero exit when invocation is structurally wrong;
// for `auto mark-dirty` that should never happen during normal use, but
// we still treat any non-zero as a soft failure (the auto-checkpoint
// core itself no-ops when disabled, so the CLI's exit semantics are
// "did we run the gate?" not "did we dirty something?").
export function defaultMarkDirty(
  cli: string,
  worktree: string,
  signal: string,
): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "auto", "mark-dirty", signal, "--root", worktree],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CLI_TIMEOUT_MS,
    },
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

// Default CLI runner for `task-store auto check --instruction`.
//
// Exit code is the decision:
//   0 = reconciliation warranted; instruction is on stdout
//   1 = no reconciliation (any of: disabled, no-state, clean, debounced,
//       already-requested); the CLI also prints the reason on stdout,
//       which we discard — the plugin only needs the instruction text.
export function defaultCheckReconcile(cli: string, worktree: string): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "auto", "check", "--instruction", "--root", worktree],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CLI_TIMEOUT_MS,
    },
  );
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
  };
}

let runMarkDirty: (cli: string, worktree: string, signal: string) => CliRunResult =
  defaultMarkDirty;
let runCheckReconcile: (cli: string, worktree: string) => CliRunResult =
  defaultCheckReconcile;

export function _setRunCliForTests(opts: {
  markDirty?: typeof runMarkDirty;
  checkReconcile?: typeof runCheckReconcile;
}): void {
  if (opts.markDirty) runMarkDirty = opts.markDirty;
  if (opts.checkReconcile) runCheckReconcile = opts.checkReconcile;
}

// Result of a reconciliation-boundary check.
export interface ReconcileDecision {
  reconcile: boolean;
  /** The instruction text when reconcile=true; null otherwise. */
  instruction: string | null;
}

/**
 * Fire `task-store auto mark-dirty` for a tool activity. No-op (without
 * invoking the CLI) when:
 *   - the project has no worktree path
 *   - the project-local CLI runtime is not installed
 *   - the tool name is in the read-only allow-list
 *
 * Failures of the CLI itself are swallowed — a checkpoint aid must never
 * break a coding session, mirroring the same failure mode as the resume
 * path above.
 */
export function markDirtyOnTool(worktree: string, tool: string): void {
  if (!worktree) return;
  if (!isDirtyWorthyTool(tool)) return;
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return;
  try {
    // `tool` is intentionally used as the signal label for diagnostics,
    // but the CLI does not persist it (see markDirty in src/autocheckpoint.ts).
    runMarkDirty(cli, worktree, tool);
  } catch {
    // swallow — see comment above
  }
}

/**
 * Fire `task-store auto check --instruction` at a reconciliation boundary.
 *
 * Returns:
 *   - {reconcile: true, instruction: <text>} when the CLI exits 0
 *   - {reconcile: false, instruction: null} otherwise (disabled, clean,
 *     debounced, missing CLI, or any error)
 *
 * The CLI itself records the request time when it returns reconcile=true,
 * opening the existing debounce window; this function does not duplicate
 * that bookkeeping.
 */
export function checkReconcileBoundary(worktree: string): ReconcileDecision {
  if (!worktree) return { reconcile: false, instruction: null };
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return { reconcile: false, instruction: null };
  let result: CliRunResult;
  try {
    result = runCheckReconcile(cli, worktree);
  } catch {
    return { reconcile: false, instruction: null };
  }
  if (result.status !== 0 || !result.stdout) {
    return { reconcile: false, instruction: null };
  }
  return { reconcile: true, instruction: result.stdout };
}

/**
 * Stage a reconciliation instruction for delivery on the next chat call.
 *
 * The file lives under `.claude-task/` so it shares the project's
 * ownership boundary; it is purely ephemeral and is removed the first
 * time it is read by `consumePendingReconciliation`.
 */
export function writePendingReconciliation(worktree: string, instruction: string): void {
  if (!worktree || !instruction) return;
  const dir = join(worktree, ".claude-task");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(pendingInstructionPath(worktree), instruction, "utf8");
  } catch {
    // swallow — best-effort bridge between boundary and next chat call
  }
}

/**
 * Read and delete the pending reconciliation instruction in one step.
 *
 * Returns the previously-staged text, or null if there was no pending
 * file (or it could not be read). The atomicity is best-effort: if the
 * read succeeds but the unlink fails, the instruction will simply be
 * re-delivered on the following chat call. The CLI's existing debounce
 * still prevents that from becoming a nag.
 */
export function consumePendingReconciliation(worktree: string): string | null {
  if (!worktree) return null;
  const path = pendingInstructionPath(worktree);
  if (!existsSync(path)) return null;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    unlinkSync(path);
  } catch {
    // already gone — that's fine
  }
  return content;
}
