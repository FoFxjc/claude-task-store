/**
 * claude-task-store: optional auto-checkpoint mode (provider-neutral core)
 *
 * PURPOSE
 * -------
 * v0.1.0 covers lifecycle boundaries (SessionStart / PreCompact / SessionEnd)
 * but not mid-session drift: the agent can edit code, run tests and finish
 * milestones without ever calling the task-store CLI, so `.claude-task/state.json`
 * silently falls behind repository reality.
 *
 * This module implements the smallest thing that fixes that:
 *
 *     tool activity  ->  markDirty()          (cheap, no task mutation)
 *     boundary       ->  shouldReconcile()    (debounced, freshness-aware)
 *     agent          ->  existing task-store CLI does the actual write
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * It never imports writeState, never mutates a Task, and never infers
 * completion. `file changed -> task done`, `tests passed -> task done` and
 * `commit exists -> milestone complete` are all forbidden by design, not by
 * convention: the only task-state function referenced here is readState(),
 * and it is read exclusively to compare timestamps. Checkpoint mutation
 * remains the exclusive job of the existing CLI verbs (start/done/attempt/
 * block/decide/next) driven by an explicit agent decision.
 *
 * The trust hierarchy is unchanged and is restated in the instruction text
 * this module emits:
 *
 *     repository/tests  >  git state  >  task-store  >  model memory
 *
 * PROVIDER NEUTRALITY
 * -------------------
 * Nothing here knows about "PostToolUse", "Stop", "PreCompact" or any other
 * Claude Code event name. Adapters (the Claude Code hook scripts, the
 * OpenCode plugin) map their own lifecycle events onto the three verbs
 * below. That is the whole extension surface — there is no event framework,
 * no registry, and no dispatch table.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { readState, storePath, findProjectRoot, getActiveTopic } from './core.js';
import { isAttached, clearAttachment, normalizeIdentity } from './attachment.js';

const CONFIG_FILE = 'config.json';
const RUNTIME_FILE = 'auto-checkpoint.json';

/**
 * Supported modes. `aggressive` is intentionally NOT implemented in v0.1.x —
 * an unknown value degrades to 'off' rather than erroring, so a config written
 * by a future version can never break an older install.
 */
export type AutoCheckpointMode = 'off' | 'conservative';

// Missing or invalid configuration must remain off for legacy stores. New
// stores use a separate, explicit default that the CLI persists during init.
export const DEFAULT_MODE: AutoCheckpointMode = 'off';
export const NEW_STORE_MODE: AutoCheckpointMode = 'conservative';

/**
 * Minimum seconds between two reconciliation requests. A reconciliation is
 * also gated on new work having arrived since the last request (see
 * shouldReconcile), so this interval only governs how often the agent can be
 * asked during *continuous* activity.
 *
 * 120s is chosen over a shorter window because the primary boundary (the Stop
 * event) fires at the end of every assistant response: a 60s window would
 * interrupt a rapid back-and-forth roughly every other turn, which is exactly
 * the nagging this feature is supposed to avoid.
 */
export const DEFAULT_DEBOUNCE_SECONDS = 120;

export interface AutoCheckpointConfig {
  auto_checkpoint: AutoCheckpointMode;
  /** Optional override for DEFAULT_DEBOUNCE_SECONDS. */
  auto_checkpoint_debounce_seconds?: number;
}

/**
 * Runtime bookkeeping. This is ephemeral coordination metadata, NOT task
 * state and NOT user configuration — which is why it lives in its own file
 * rather than in state.json (whose schema is a published contract) or
 * config.json (which the user owns and may commit).
 */
export interface AutoCheckpointRuntime {
  /** ISO timestamp of the first dirty signal of the current dirty window; null when clean. */
  dirty_since: string | null;
  /** ISO timestamp of the most recent dirty signal; null when clean. */
  last_signal_at: string | null;
  /** Count of dirty signals in the current window. Reporting only — never a threshold. */
  signal_count: number;
  /** ISO timestamp of the last time an adapter was told to ask for reconciliation. */
  last_reconcile_request_at: string | null;
  /** ISO timestamp of the last completed reconciliation. */
  last_reconcile_at: string | null;
}

const EMPTY_RUNTIME: AutoCheckpointRuntime = {
  dirty_since: null,
  last_signal_at: null,
  signal_count: 0,
  last_reconcile_request_at: null,
  last_reconcile_at: null,
};

// ─── Paths ────────────────────────────────────────────────────────────────────

export function configFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), CONFIG_FILE);
}

export function runtimeFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), RUNTIME_FILE);
}

// ─── Atomic write (mirrors core.ts) ──────────────────────────────────────────

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '') || '.';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp_${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Read the auto-checkpoint config. A missing, unreadable, malformed or
 * unknown-valued config always resolves to the default ('off').
 *
 * Failing closed is the whole safety story for existing users: no config file
 * exists in a v0.1.0 project, so every v0.1.0 project keeps v0.1.0 behavior
 * with zero migration and zero writes.
 */
export function readConfig(projectRoot?: string): AutoCheckpointConfig {
  const path = configFilePath(projectRoot);
  if (!existsSync(path)) return { auto_checkpoint: DEFAULT_MODE };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    // A corrupt config must not break a coding session, and must never
    // silently turn the feature ON. Degrade to the safe default.
    return { auto_checkpoint: DEFAULT_MODE };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { auto_checkpoint: DEFAULT_MODE };
  }

  const raw = parsed as Record<string, unknown>;
  const mode = raw.auto_checkpoint;
  const config: AutoCheckpointConfig = {
    auto_checkpoint: mode === 'conservative' ? 'conservative' : DEFAULT_MODE,
  };

  const debounce = raw.auto_checkpoint_debounce_seconds;
  if (typeof debounce === 'number' && Number.isFinite(debounce) && debounce >= 0) {
    config.auto_checkpoint_debounce_seconds = debounce;
  }

  return config;
}

/**
 * Persist the mode, preserving any unrelated keys already in config.json so
 * that this never becomes a destructive rewrite of a file the user owns.
 */
export function writeMode(mode: AutoCheckpointMode, projectRoot?: string): AutoCheckpointConfig {
  const path = configFilePath(projectRoot);

  let existing: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable config gets replaced rather than blocking the user from
      // configuring the tool. The file is small and tool-owned.
    }
  }

  existing.auto_checkpoint = mode;
  atomicWriteJson(path, existing);

  // Switching modes must not leave a stale dirty window behind: turning the
  // feature off and back on should start from a clean slate rather than
  // immediately firing a reconciliation for work that predates the change.
  clearRuntime(projectRoot);

  // Switching OFF must not leave a stale *owner* behind either. The
  // attachment is the intent boundary for auto-checkpoint, so with the mode
  // off there is nothing left for it to gate. Leaving the record makes the
  // next session to enable the mode meet an owner that no longer exists —
  // and, because the mode is off, the session-end hook deliberately skips its
  // release, so nothing else would ever clear it. The user is forced through
  // a takeover confirmation for a session that ended long ago.
  if (mode === 'off') {
    clearAttachment(projectRoot);
    // A staged OpenCode reconciliation belongs to the auto-checkpoint flow
    // just as much as the dirty runtime and attachment do. Leaving it behind
    // after an explicit opt-out creates dead ephemeral state and makes the
    // next chat call pay collection overhead for a feature that is off.
    clearPendingInstruction(projectRoot);
  }

  return readConfig(projectRoot);
}

export function isEnabled(projectRoot?: string): boolean {
  return readConfig(projectRoot).auto_checkpoint === 'conservative';
}

export function debounceSeconds(projectRoot?: string): number {
  const config = readConfig(projectRoot);
  return config.auto_checkpoint_debounce_seconds ?? DEFAULT_DEBOUNCE_SECONDS;
}

// ─── Runtime marker ───────────────────────────────────────────────────────────

export function readRuntime(projectRoot?: string): AutoCheckpointRuntime {
  const path = runtimeFilePath(projectRoot);
  if (!existsSync(path)) return { ...EMPTY_RUNTIME };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<AutoCheckpointRuntime>;
    return {
      dirty_since: typeof parsed.dirty_since === 'string' ? parsed.dirty_since : null,
      last_signal_at: typeof parsed.last_signal_at === 'string' ? parsed.last_signal_at : null,
      signal_count: typeof parsed.signal_count === 'number' ? parsed.signal_count : 0,
      last_reconcile_request_at:
        typeof parsed.last_reconcile_request_at === 'string' ? parsed.last_reconcile_request_at : null,
      last_reconcile_at: typeof parsed.last_reconcile_at === 'string' ? parsed.last_reconcile_at : null,
    };
  } catch {
    return { ...EMPTY_RUNTIME };
  }
}

function writeRuntime(runtime: AutoCheckpointRuntime, projectRoot?: string): void {
  atomicWriteJson(runtimeFilePath(projectRoot), runtime);
}

function clearRuntime(projectRoot?: string): void {
  const path = runtimeFilePath(projectRoot);
  try { unlinkSync(path); } catch { /* already absent */ }
}

// ─── Verb 1: markDirty ────────────────────────────────────────────────────────

/**
 * Record that repository/execution state may have changed.
 *
 * This is the ONLY thing a tool-activity adapter is allowed to do. It records
 * two timestamps and a counter; it does not read tasks, does not decide
 * anything, and above all does not write task state.
 *
 * No-ops entirely when the mode is 'off', so a project that never opts in
 * never gets a single extra file write. No-ops also when the calling session
 * is not the recorded owner of the auto-checkpoint flow: the intent
 * boundary lives in attachment.ts, and a side session must not push dirty
 * signals into a checkpoint it has no authority over.
 */
export function markDirty(
  projectRoot?: string,
  signal?: string,
  sessionId?: string,
): AutoCheckpointRuntime | null {
  if (!isEnabled(projectRoot)) return null;

  const root = projectRoot ?? findProjectRoot();
  // Only track drift for a project that actually has a task store. Marking a
  // store that does not exist would create .claude-task/ as a side effect of
  // an unrelated tool call.
  if (!existsSync(join(storePath(root), 'state.json'))) return null;

  // Intent boundary. Without a sessionId (or when this session is not the
  // current owner) we cannot prove the call came from a session that opted
  // into the task-store execution. A missing or wrong id is treated the
  // same as "this session is detached" — silently no-op, so a misconfigured
  // adapter or a fresh side session never escalates.
  if (!sessionId || !isAttached(sessionId, root)) return null;

  const now = new Date().toISOString();
  const runtime = readRuntime(root);

  runtime.dirty_since = runtime.dirty_since ?? now;
  runtime.last_signal_at = now;
  runtime.signal_count += 1;
  // `signal` is accepted for adapter ergonomics and intentionally not
  // persisted: storing tool names or arguments would edge toward the
  // conversation-transcript storage this feature is scoped out of.
  void signal;

  writeRuntime(runtime, root);
  return runtime;
}

// ─── Freshness ────────────────────────────────────────────────────────────────

export interface Freshness {
  /** True when work was signalled and the checkpoint has not been written since. */
  stale: boolean;
  /** ISO timestamp of the first unreconciled signal, when stale. */
  since: string | null;
  /** Number of unreconciled signals. */
  signals: number;
}

/**
 * Cheap staleness check: has the task store been written since the most
 * recent dirty signal?
 *
 * This deliberately compares two timestamps we already have — state.updated_at
 * (bumped by every CLI write) against last_signal_at. There is no repository
 * scan, no diffing, and no Git dependency, so it works in a project with no
 * VCS at all. It is a hint, never a claim of certainty: it can only tell you
 * that the checkpoint has not been touched since work happened.
 *
 * Note the useful side effect: because *any* CLI write bumps updated_at, an
 * agent reconciling through the normal verbs clears staleness for free. No
 * explicit "I am done reconciling" call is required for correctness.
 */
export function freshness(projectRoot?: string): Freshness {
  const runtime = readRuntime(projectRoot);
  if (!runtime.last_signal_at) {
    return { stale: false, since: null, signals: 0 };
  }

  let updatedAt: number | null = null;
  try {
    const state = readState(projectRoot);
    updatedAt = state ? new Date(state.updated_at).getTime() : null;
  } catch {
    // A corrupt/unreadable state file is a different problem with its own
    // recovery path (`task-store repair`). Don't report it as staleness.
    return { stale: false, since: null, signals: 0 };
  }

  if (updatedAt === null) return { stale: false, since: null, signals: 0 };

  const signalAt = new Date(runtime.last_signal_at).getTime();
  if (!Number.isFinite(signalAt) || !Number.isFinite(updatedAt)) {
    return { stale: false, since: null, signals: 0 };
  }

  if (updatedAt >= signalAt) {
    return { stale: false, since: null, signals: 0 };
  }

  return { stale: true, since: runtime.dirty_since, signals: runtime.signal_count };
}

// ─── Verb 2: shouldReconcile ──────────────────────────────────────────────────

export interface ReconcileDecision {
  reconcile: boolean;
  /** Machine-readable reason, useful for tests and `task-store auto status`. */
  reason:
    | 'disabled'
    | 'no-state'
    | 'clean'
    | 'debounced'
    | 'already-requested'
    | 'detached'
    | 'inactive-state'
    | 'stale';
  freshness: Freshness;
}

/**
 * Decide whether this boundary should ask the agent to reconcile.
 *
 * Three independent gates must all open:
 *
 *   0. ATTACHMENT — this session is the recorded owner of the auto-checkpoint
 *                   flow. Without this, a fresh session in a project with
 *                   active task-store state would push reconciliation
 *                   instructions it has no authority to act on.
 *   1. NEW WORK   — at least one dirty signal has arrived since the previous
 *                   request. Without this, a single unanswered request would
 *                   re-fire forever on an idle session.
 *   2. DEBOUNCE   — at least `debounceSeconds` have elapsed since the previous
 *                   request. Without this, back-to-back turns during active
 *                   work would each carry a reconciliation nag.
 *
 * Pure function of persisted state — it starts no timer and spawns no process.
 * `now` is injectable so tests can exercise the debounce without sleeping.
 */
export function shouldReconcile(
  projectRoot?: string,
  now: Date = new Date(),
  sessionId?: string,
): ReconcileDecision {
  const clean: Freshness = { stale: false, since: null, signals: 0 };

  if (!isEnabled(projectRoot)) {
    return { reconcile: false, reason: 'disabled', freshness: clean };
  }

  const root = projectRoot ?? findProjectRoot();
  if (!existsSync(join(storePath(root), 'state.json'))) {
    return { reconcile: false, reason: 'no-state', freshness: clean };
  }

  // An archived or completed checkpoint has no work left to reconcile. Asking
  // for one would deliver an instruction the agent cannot act on, and since
  // `auto check` also records the request, it would burn the debounce window
  // on nothing. This mirrors the suppression the SessionStart hook and the
  // OpenCode adapter already apply to injection, and the guard on
  // `auto take-instruction`.
  let activeStatus: string | null;
  try {
    const state = readState(root);
    activeStatus = state ? getActiveTopic(state).status : null;
  } catch {
    // A corrupt state file has its own recovery path (`task-store repair`).
    // Do not ask an agent to reconcile a checkpoint we cannot read.
    return { reconcile: false, reason: 'clean', freshness: clean };
  }
  if (activeStatus === 'archived' || activeStatus === 'completed') {
    return { reconcile: false, reason: 'inactive-state', freshness: clean };
  }

  // Intent boundary, mirrored from markDirty. The 'detached' reason is
  // treated like 'clean' / 'debounced' by every adapter — a no-op — but
  // is distinct in status output so an operator can tell the gate fired.
  if (!sessionId || !isAttached(sessionId, root)) {
    return { reconcile: false, reason: 'detached', freshness: clean };
  }

  const fresh = freshness(root);
  if (!fresh.stale) {
    return { reconcile: false, reason: 'clean', freshness: fresh };
  }

  const runtime = readRuntime(root);
  const lastRequest = runtime.last_reconcile_request_at;

  if (lastRequest) {
    const lastRequestMs = new Date(lastRequest).getTime();
    const lastSignalMs = new Date(runtime.last_signal_at ?? 0).getTime();

    // Gate 1: nothing new has happened since we last asked.
    if (Number.isFinite(lastRequestMs) && lastSignalMs <= lastRequestMs) {
      return { reconcile: false, reason: 'already-requested', freshness: fresh };
    }

    // Gate 2: we asked too recently.
    const elapsedSeconds = (now.getTime() - lastRequestMs) / 1000;
    if (Number.isFinite(lastRequestMs) && elapsedSeconds < debounceSeconds(root)) {
      return { reconcile: false, reason: 'debounced', freshness: fresh };
    }
  }

  return { reconcile: true, reason: 'stale', freshness: fresh };
}

// ─── Verb 3: markReconciled ───────────────────────────────────────────────────

/**
 * Why a runtime-writing verb did or did not apply. Returned rather than
 * thrown so an adapter can stay silent while the CLI can explain itself to an
 * agent — "nothing happened" with no reason is the failure mode this exists
 * to avoid.
 */
export type ReconcileRecordOutcome = 'applied' | 'disabled' | 'no-state' | 'detached';

/**
 * Record that a reconciliation instruction was delivered to the agent.
 * Opens the debounce window; does NOT clear the dirty flag, because the agent
 * may ignore the request and the checkpoint would still be stale.
 *
 * Ownership: the same intent boundary as markDirty / shouldReconcile. The
 * runtime is shared project state, so a session that does not own the
 * attachment must not open the debounce window on the owner's behalf — that
 * would silence the owner's next genuine request for a full debounce period,
 * which is strictly worse than the detached session doing nothing.
 */
export function markReconcileRequested(
  projectRoot?: string,
  now: Date = new Date(),
  sessionId?: string,
): ReconcileRecordOutcome {
  const root = projectRoot ?? findProjectRoot();
  if (!isEnabled(root)) return 'disabled';
  if (!existsSync(join(storePath(root), 'state.json'))) return 'no-state';
  if (!sessionId || !isAttached(sessionId, root)) return 'detached';
  const runtime = readRuntime(root);
  runtime.last_reconcile_request_at = now.toISOString();
  writeRuntime(runtime, root);
  return 'applied';
}

/**
 * Record that reconciliation actually happened, clearing the dirty window.
 *
 * Calling this is optional: staleness is derived from state.updated_at, so an
 * agent that reconciles via the normal CLI verbs is already reported fresh.
 * It exists so an adapter can explicitly close the loop.
 *
 * Ownership is enforced here, in the provider-neutral core, and not only in
 * the CLI: this is the one verb that *clears* the shared dirty window, so a
 * session that does not own the attachment calling it would silently discard
 * the owner's pending work signal — the owner would then be told its
 * checkpoint is clean when it is not. markDirty and shouldReconcile already
 * gate on the same record; this closes the third verb of the set.
 */
export function markReconciled(
  projectRoot?: string,
  now: Date = new Date(),
  sessionId?: string,
): ReconcileRecordOutcome {
  const root = projectRoot ?? findProjectRoot();
  if (!isEnabled(root)) return 'disabled';
  if (!existsSync(join(storePath(root), 'state.json'))) return 'no-state';
  if (!sessionId || !isAttached(sessionId, root)) return 'detached';
  const runtime = readRuntime(root);
  runtime.dirty_since = null;
  runtime.last_signal_at = null;
  runtime.signal_count = 0;
  runtime.last_reconcile_at = now.toISOString();
  writeRuntime(runtime, root);
  return 'applied';
}

// ─── The instruction ──────────────────────────────────────────────────────────

/**
 * The entire behavioral payload of this feature.
 *
 * Kept deliberately short: it is injected at a boundary the user did not ask
 * for, so it must cost near-nothing in context and must not read as a new
 * workflow. It restates the trust hierarchy, forbids unevidenced completion,
 * and points at the existing CLI rather than describing a new one.
 */
export const RECONCILE_INSTRUCTION = [
  '[task-store] The checkpoint may be stale: files or commands changed repository state',
  'since it was last written. Reconcile it with repository/test reality now.',
  '',
  'Authority order: repository/tests > git state > task-store > model memory.',
  'The task store records what happened; it does not decide what is true.',
  '',
  'Rules:',
  '- Update only execution state that is clearly supported by evidence you can point to.',
  '- Do NOT mark a task done without evidence. A file edit or a passing test is evidence',
  '  that work happened, not proof that a task is complete — that is your explicit call.',
  '- Do NOT invent decisions, blockers, or a next action. Leave next_action alone unless',
  '  you actually know the next step.',
  '- If nothing material changed, do nothing and say so in one line.',
  '',
  'Use the existing CLI: task-store start|done|attempt|block|decide|next',
].join('\n');

// ─── Pending reconciliation instruction ──────────────────────────────────────
//
// The OpenCode adapter cannot deliver a reconciliation instruction at its
// boundary the way Claude Code's `Stop` hook can, so the instruction is staged
// to a file and collected on the next chat call.
//
// Both halves live here, in the provider-neutral core, rather than in the
// adapter. The reason is a race that cannot be fixed from the adapter: the
// adapter used to (1) ask the CLI whether reconciliation was warranted, then
// (2) write the file itself. Between those two steps the CLI's lock is gone,
// so a takeover or a release landing in the gap let a session that had just
// lost ownership stage an instruction anyway — and, symmetrically, the old
// owner could still collect a file the new owner had staged. Staging is now a
// single core operation performed by the CLI under the store lock, so the
// ownership check and the write are one step (see `auto stage-instruction`).
//
// The staged record is also bound to the session that staged it, so a
// collected instruction can never be one that was produced for a different
// session's view of the store. That is defence in depth: the ownership check
// already refuses a displaced session, and the binding additionally refuses a
// record staged before a takeover from being delivered after it.

const PENDING_INSTRUCTION_FILE = '.pending-reconcile-instruction.txt';

interface PendingInstructionRecord {
  session_id: string;
  instruction: string;
  staged_at: string;
}

export function pendingInstructionFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), PENDING_INSTRUCTION_FILE);
}

/**
 * Remove any staged reconciliation instruction.
 *
 * This is administrative cleanup for disabling auto-checkpoint, not a
 * session-scoped consume operation. Missing is fine; every other filesystem
 * failure surfaces so `off` cannot claim the runtime was cleared while a
 * dead pending record remains on disk.
 */
function clearPendingInstruction(projectRoot?: string): void {
  const path = pendingInstructionFilePath(projectRoot);
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/**
 * Write the staged record. Caller holds the store lock and has already
 * established that `sessionId` owns the attachment.
 */
function writePendingInstruction(
  root: string,
  sessionId: string,
  instruction: string,
  now: Date,
): void {
  const record: PendingInstructionRecord = {
    session_id: normalizeIdentity(sessionId),
    instruction,
    staged_at: now.toISOString(),
  };
  atomicWriteJson(pendingInstructionFilePath(root), record);
}

export interface StageDecision {
  reconcile: boolean;
  /** Same vocabulary as ReconcileDecision.reason, so adapters handle one set. */
  reason: ReconcileDecision['reason'];
  /** The instruction text that was staged when reconcile=true; null otherwise. */
  instruction: string | null;
}

/**
 * Decide whether this boundary should ask for reconciliation, and stage the
 * instruction for the next chat call in the same step.
 *
 * This is the OpenCode analogue of Claude Code's `Stop` hook, which delivers
 * inline: the decision and the opening of the debounce window must be
 * indivisible with the staging, or a displaced session can act on a decision
 * that is no longer its to make. Called by the CLI under the store lock.
 */
export function stagePendingInstruction(
  projectRoot?: string,
  now: Date = new Date(),
  sessionId?: string,
): StageDecision {
  const root = projectRoot ?? findProjectRoot();
  if (!sessionId) {
    return { reconcile: false, reason: 'detached', instruction: null };
  }
  const decision = shouldReconcile(root, now, sessionId);
  if (!decision.reconcile) {
    return { reconcile: false, reason: decision.reason, instruction: null };
  }
  const recorded = markReconcileRequested(root, now, sessionId);
  if (recorded !== 'applied') {
    // Defence in depth for non-CLI callers: the CLI serializes mode/ownership
    // changes with this operation, but the provider-neutral core should still
    // refuse to stage if the preconditions changed between decision and write.
    return { reconcile: false, reason: recorded, instruction: null };
  }
  writePendingInstruction(root, sessionId, RECONCILE_INSTRUCTION, now);
  return { reconcile: true, reason: decision.reason, instruction: RECONCILE_INSTRUCTION };
}

/**
 * Read and delete the staged instruction in one step.
 *
 * Ownership is enforced here rather than left to the caller, so that every
 * path — CLI or library — answers the same two questions before anything is
 * deleted:
 *
 *   1. Is the calling session the current owner? Without this, a session that
 *      was taken over or that released could still collect an instruction,
 *      because its own staged record is genuinely bound to it.
 *   2. Was this record staged by the calling session? Without this, a new
 *      owner would be handed an instruction produced for the *previous*
 *      owner's view of the store.
 *
 * Callers should still hold the store lock so the check and the delete stay
 * indivisible against a takeover landing in between. Returns null when nothing
 * is ours to collect, and leaves a record that belongs to someone else alone.
 */
export function takePendingInstruction(projectRoot?: string, sessionId?: string): string | null {
  if (!sessionId) return null;
  const root = projectRoot ?? findProjectRoot();
  // Owner check: a displaced session must not collect, even its own record.
  if (!isAttached(sessionId, root)) return null;
  const path = pendingInstructionFilePath(root);

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  let record: PendingInstructionRecord | null = null;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingInstructionRecord>;
    if (
      typeof parsed?.session_id === 'string' &&
      typeof parsed.instruction === 'string' &&
      parsed.instruction.length > 0
    ) {
      record = {
        session_id: parsed.session_id,
        instruction: parsed.instruction,
        staged_at: typeof parsed.staged_at === 'string' ? parsed.staged_at : '',
      };
    }
  } catch {
    // Not our format at all — a file left by a pre-binding version. Fall
    // through to the removal below; it can never be delivered by anyone.
  }

  if (record && record.session_id !== normalizeIdentity(sessionId)) {
    // Staged for someone else. Leave it: the owner may still be running, and
    // the next stage overwrites it either way.
    return null;
  }

  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return record ? record.instruction : null;
}
