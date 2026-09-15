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

import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// The canonical resume renderer in src/core.ts (buildResumeContext) now
// enforces a hard character budget (RESUME_BUDGET_CHARS) on its own output,
// including any truncation marker. Host adapters therefore no longer need
// a separate character cap: the Claude Code and OpenCode injection paths
// pass the canonical projection through verbatim. This used to live in this
// file as MAX_INJECTION_CHARS / TRUNCATION_SUFFIX / capInjection — a
// host-specific projection difference that the OpenCode adapter applied
// because nothing upstream guaranteed the bound. The cap is now redundant
// and intentionally not duplicated here. If a future regression slips
// past the canonical budget, the right fix is to tighten
// buildResumeContext, not to add a second cap in the adapter.
//
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
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      status?: unknown;
      active_topic?: unknown;
      topics?: Array<{ name?: unknown; status?: unknown }>;
    };
    if (parsed.version === "2" && typeof parsed.active_topic === "string") {
      const topic = parsed.topics?.find(candidate => candidate.name === parsed.active_topic);
      status = typeof topic?.status === "string" ? topic.status : "";
    } else {
      status = typeof parsed.status === "string" ? parsed.status : "";
    }
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

  // Pass the canonical projection through verbatim. The renderer in
  // src/core.ts already enforces the hard character budget
  // (RESUME_BUDGET_CHARS), so this adapter does not apply its own cap —
  // doing so would be a host-specific projection difference between
  // Claude Code and OpenCode for no reason.
  const text = result.stdout;

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
// Default CLI runner for `task-store auto mark-dirty`. The session id
// (mandatory for the CLI gate in src/attachment.ts) is forwarded as a
// flag; an absent session id causes the CLI to no-op the call silently,
// which is the correct failure mode for an adapter that forgot to thread
// it through.
export function defaultMarkDirty(
  cli: string,
  worktree: string,
  signal: string,
  sessionId: string,
): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "auto", "mark-dirty", signal, "--root", worktree, "--session-id", sessionId],
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

// Default CLI runner for `task-store auto check --instruction`. Same
// session-id plumbing as markDirty; the CLI's `detached` reason is the
// expected outcome for a session that never attached or that has been
// displaced, and it is handled by the caller as a no-op.
export function defaultCheckReconcile(cli: string, worktree: string, sessionId: string): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "auto", "check", "--instruction", "--root", worktree, "--session-id", sessionId],
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

// Default runner for `task-store attach status`. Used by the system-transform
// hook to decide whether this session is the recorded owner (no prompt), a
// side session that needs a takeover prompt, or a fresh session with no
// prior owner (first-time attach prompt). The output format is a single
// human-readable line — the parser below is intentionally tolerant.
export function defaultAttachStatus(cli: string, worktree: string): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "attach", "status", "--root", worktree],
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

// Default CLI runner for `task-store auto take-instruction`. Exit code is the
// decision: 0 means the instruction is on stdout (and has been deleted), 1
// means this session owns nothing to collect.
export function defaultTakeInstruction(
  cli: string,
  worktree: string,
  sessionId: string,
): CliRunResult {
  const result = spawnSync(
    "node",
    [cli, "auto", "take-instruction", "--root", worktree, "--session-id", sessionId],
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

let runMarkDirty: (cli: string, worktree: string, signal: string, sessionId: string) => CliRunResult =
  defaultMarkDirty;
let runCheckReconcile: (cli: string, worktree: string, sessionId: string) => CliRunResult =
  defaultCheckReconcile;
let runAttachStatus: (cli: string, worktree: string) => CliRunResult = defaultAttachStatus;
let runTakeInstruction: (cli: string, worktree: string, sessionId: string) => CliRunResult =
  defaultTakeInstruction;

export function _setRunCliForTests(opts: {
  markDirty?: typeof runMarkDirty;
  checkReconcile?: typeof runCheckReconcile;
  attachStatus?: typeof runAttachStatus;
  takeInstruction?: typeof runTakeInstruction;
}): void {
  if (opts.markDirty) runMarkDirty = opts.markDirty;
  if (opts.checkReconcile) runCheckReconcile = opts.checkReconcile;
  if (opts.attachStatus) runAttachStatus = opts.attachStatus;
  if (opts.takeInstruction) runTakeInstruction = opts.takeInstruction;
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
 *   - sessionId is missing (the CLI gate requires it; see src/attachment.ts)
 *
 * Failures of the CLI itself are swallowed — a checkpoint aid must never
 * break a coding session, mirroring the same failure mode as the resume
 * path above.
 */
export function markDirtyOnTool(worktree: string, tool: string, sessionId: string): void {
  if (!worktree) return;
  if (!isDirtyWorthyTool(tool)) return;
  if (!sessionId) return;
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return;
  try {
    // `tool` is intentionally used as the signal label for diagnostics,
    // but the CLI does not persist it (see markDirty in src/autocheckpoint.ts).
    runMarkDirty(cli, worktree, tool, sessionId);
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
 *     debounced, missing CLI, missing sessionId, or any error)
 *
 * The CLI itself records the request time when it returns reconcile=true,
 * opening the existing debounce window; this function does not duplicate
 * that bookkeeping.
 */
export function checkReconcileBoundary(worktree: string, sessionId: string): ReconcileDecision {
  if (!worktree) return { reconcile: false, instruction: null };
  if (!sessionId) return { reconcile: false, instruction: null };
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return { reconcile: false, instruction: null };
  let result: CliRunResult;
  try {
    result = runCheckReconcile(cli, worktree, sessionId);
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
 * time the owning session collects it via `takePendingInstruction`.
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
 * Collect the staged reconciliation instruction, if any, for `sessionId`.
 *
 * The read-and-delete is delegated to `task-store auto take-instruction`, which
 * performs it under the store lock after verifying that this session is the
 * recorded owner. Doing it in-process — as this adapter used to — left a
 * window between an `attach status` snapshot and the unlink in which a
 * takeover or a release could let a session that no longer owns the store
 * consume the instruction the new owner was staged for.
 *
 * Returns null when nothing is staged, when this session is not the owner, or
 * on any failure: the caller then injects nothing.
 */
export function takePendingInstruction(worktree: string, sessionId: string): string | null {
  if (!worktree || !sessionId) return null;
  // Nothing staged is the common case — a store stages at most one instruction
  // per debounce window. Skipping the CLI here keeps the per-chat-turn cost at
  // zero for turns that have nothing to collect. This check is only a
  // short-circuit for "there is nothing to take"; it is deliberately NOT a
  // substitute for the CLI's ownership check, which is what makes the take
  // itself atomic.
  if (!existsSync(pendingInstructionPath(worktree))) return null;
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return null;
  let result: CliRunResult;
  try {
    result = runTakeInstruction(cli, worktree, sessionId);
  } catch {
    return null;
  }
  if (result.status !== 0 || !result.stdout) return null;
  return result.stdout;
}

// ─── System-prompt composition ──────────────────────────────────────────────
//
// OpenCode's `experimental.chat.system.transform` hands the plugin an array
// of system-prompt strings. For workflow/Anthropic-shaped providers OpenCode
// concatenates them, but for OpenAI-compatible providers it maps EACH entry
// to its own `role: "system"` message. LiteLLM-backed endpoints reject any
// request whose system message is not the very first message, so appending a
// second entry made every chat call fail with:
//
//   litellm.BadRequestError: System message must be at the beginning
//
// The fix is to treat the task-store output as augmentation of the system
// context that is already there, rather than as additional system blocks:
// everything this adapter contributes is merged into `system[0]`, and a new
// element is created only when OpenCode gave us an empty array. The number of
// system message blocks is therefore never increased by this plugin.

/**
 * Separator between the existing system content and the task-store block,
 * and between the resume projection and the reconciliation instruction.
 *
 * A blank line is the smallest thing that reads as a section break in both
 * the projection's own plain-text layout and whatever prompt precedes it.
 */
export const SYSTEM_INJECTION_SEPARATOR = "\n\n";

/**
 * Merge `block` into the primary (first) system element, creating that
 * element only when the array is empty.
 *
 * Postcondition, and the whole point of this function: the array's length
 * either stays the same (when it already had an element) or becomes exactly
 * 1 (when it was empty). It never grows past 1 element's worth of new system
 * message blocks, which is what the LiteLLM constraint requires.
 *
 * Existing content is preserved byte-for-byte as the prefix; the block is
 * always appended after it.
 */
export function mergeIntoPrimarySystem(system: string[], block: string): void {
  if (!block) return;
  if (system.length > 0) {
    system[0] = system[0] + SYSTEM_INJECTION_SEPARATOR + block;
    return;
  }
  system.push(block);
}

/**
 * The project's effective auto-checkpoint mode. Mirrors the fail-closed rule in
 * src/autocheckpoint.ts:readConfig — a missing, unreadable, malformed or
 * unknown config resolves to "off", and only the literal "conservative"
 * enables the feature. Read directly rather than shelling out, so a project
 * that has opted out pays nothing per chat call.
 */
function effectiveMode(worktree: string): string {
  const configFile = join(worktree, ".claude-task", "config.json");
  if (!existsSync(configFile)) return "off";
  try {
    const parsed = JSON.parse(readFileSync(configFile, "utf8")) as { auto_checkpoint?: unknown };
    return parsed?.auto_checkpoint === "conservative" ? "conservative" : "off";
  } catch {
    return "off";
  }
}

/**
 * True when the project has task-store work worth prompting about. Requires
 * the state file to exist, parse, and be neither archived nor completed —
 * matching the Claude Code SessionStart hook, which suppresses injection for
 * both. `completed` is a valid schema status, so without that check OpenCode
 * would invite the user to continue work that is already finished.
 *
 * Deliberately narrower than buildResumeInjection(): resume has its own,
 * pre-existing archived-only rule and changing it would alter what gets
 * injected, which is out of scope here.
 */
function hasPromptableWork(worktree: string): boolean {
  const stateFile = join(worktree, ".claude-task", "state.json");
  if (!existsSync(stateFile)) return false;
  const inactive = new Set(["archived", "completed"]);
  try {
    const parsed = JSON.parse(readFileSync(stateFile, "utf8")) as {
      version?: unknown;
      status?: unknown;
      active_topic?: unknown;
      topics?: Array<{ name?: unknown; status?: unknown }>;
    };
    if (parsed.version === "2" && typeof parsed.active_topic === "string") {
      const topic = parsed.topics?.find(candidate => candidate.name === parsed.active_topic);
      return typeof topic?.status !== "string" || !inactive.has(topic.status);
    }
    return typeof parsed.status !== "string" || !inactive.has(parsed.status);
  } catch {
    return false;
  }
}

/**
 * POSIX single-quote a value so a printed command survives spaces and
 * apostrophes. The prompt tells the agent to run a command in a shell, and
 * project paths legitimately contain both.
 */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The command this session should run to claim auto-checkpoint. Built from the
 * resolved project-local CLI rather than a bare `task-store`: a global install
 * is optional, so a bare command would be command-not-found on a standard
 * install.
 *
 * `--root` is mandatory here. The agent may run the printed command from any
 * working directory, and without it the CLI falls back to findProjectRoot()
 * and attaches to whichever project happens to contain that directory — the
 * wrong store, silently.
 */
function attachCommand(worktree: string, sessionId: string, takeover: boolean): string {
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  const tail = takeover ? " --takeover --confirm" : " --yes";
  return `node ${shellQuote(cli)} attach --session-id ${shellQuote(sessionId)} `
    + `--host opencode --root ${shellQuote(worktree)}${tail}`;
}

/**
 * Build the attach prompt that should accompany the system injection when
 * this session is detached from auto-checkpoint. The prompt is a fixed
 * string when there is no current owner (first-time attach) and a
 * different string when a different session owns the record (takeover
 * required). When this session is the owner, the function returns null
 * — no prompt, the resume injection carries the context.
 *
 * Kept in this module so it lives alongside the system-prompt
 * composition and shares its style. The CLI is the source of truth for
 * ownership; this helper is just the adapter-side rendering.
 */
export function buildAttachPrompt(
  worktree: string,
  sessionId: string,
  status: string | null,
): string | null {
  if (!worktree || !sessionId || status === null) return null;
  if (status === "attached: none") {
    return [
      "[task-store] Active task-store work exists for this project.",
      "This session is detached from auto-checkpoint by design. Ask the user:",
      '"This project has active task-store work. Continue those tasks in this session?"',
      `  yes -> ${attachCommand(worktree, sessionId, false)}`,
      "  no  -> do nothing; this session stays detached",
    ].join("\n");
  }
  // Parse "attached: session_id=<X> host=<H> attached_at=<T>".
  const idMatch = status.match(/session_id=(\S+)/);
  if (idMatch && idMatch[1] === sessionId) return null; // already owner
  if (!idMatch) return null;
  return [
    `[task-store] Active task-store work is already attached to another session (${status}).`,
    "This session is detached from auto-checkpoint by design. Ask the user:",
    '"Another session is already attached to this project\'s task-store work.',
    'Continue those tasks in this session?"',
    `  yes (take over) -> ${attachCommand(worktree, sessionId, true)}`,
    "  no              -> do nothing; this session stays detached",
  ].join("\n");
}

/**
 * Read the raw `attach status` output for this project, or null when the
 * question cannot be answered (no CLI runtime, spawn failure, non-zero exit).
 * Callers must treat null as "unknown", never as "detached".
 */
export function readAttachStatus(worktree: string): string | null {
  if (!worktree) return null;
  const cli = join(worktree, ".claude", "task-store", "bin", "task-store.js");
  if (!existsSync(cli)) return null;
  try {
    const result = runAttachStatus(cli, worktree);
    if (result.status !== 0) return null;
    return result.stdout.trim();
  } catch {
    return null;
  }
}

/**
 * The whole `experimental.chat.system.transform` body, in one testable
 * function: collect the resume projection, the attach prompt for the
 * current session (when detached), and any pending reconciliation
 * instruction, then merge all three into the existing system context.
 *
 * Ordering is fixed and load-bearing:
 *
 *   existing OpenCode system content
 *     → task-store resume projection
 *       → attach prompt (only when this session is not the owner)
 *         → pending reconciliation instruction
 *
 * The pending instruction is consumed exactly once, and only by the attached
 * owner — the CLI collects it for this session only, and its own debounce is
 * what prevents a re-nag.
 *
 * Each source is guarded separately so a failure in one cannot suppress the
 * others, and the whole thing degrades to "inject nothing": a checkpoint
 * aid must never break a coding session.
 */
export function applySystemInjection(worktree: string, system: string[], sessionId: string): void {
  if (!Array.isArray(system)) return;

  let resume: string | null = null;
  try {
    resume = buildResumeInjection(worktree);
  } catch {
    // swallow — see the doc comment above
  }

  // The attachment is consulted at most once per chat call, and only when the
  // project has actually opted in and has active state. This hook fires on
  // every call, and each CLI invocation is synchronous with a 5s timeout, so
  // the work above is deliberately file reads first: an opted-out or empty
  // project spawns nothing here at all.
  let attachPrompt: string | null = null;
  try {
    if (hasPromptableWork(worktree) && effectiveMode(worktree) === "conservative") {
      attachPrompt = buildAttachPrompt(worktree, sessionId, readAttachStatus(worktree));
    }
  } catch {
    // swallow — same
  }

  // The pending file is shared by the whole project, but the instruction in it
  // belongs to whichever session owns auto-checkpoint. A detached side session
  // reaching this hook first must NOT consume it — otherwise the owner never
  // sees the instruction it was staged for, and the side session is handed a
  // reconciliation request it has no authority to act on.
  let pending: string | null = null;
  try {
    pending = takePendingInstruction(worktree, sessionId);
  } catch {
    // swallow — same
  }

  const parts: string[] = [];
  if (resume !== null && resume.length > 0) parts.push(resume);
  if (attachPrompt !== null && attachPrompt.length > 0) parts.push(attachPrompt);
  if (pending !== null && pending.length > 0) parts.push(pending);
  if (parts.length === 0) return;

  const block = parts.join(SYSTEM_INJECTION_SEPARATOR);
  mergeIntoPrimarySystem(system, block);
}
