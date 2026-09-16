/**
 * Auto-checkpoint policy verbs + freshness.
 *
 * Extracted from `src/autocheckpoint.ts` as part of #25 (structural
 * decomposition). Owns the three reconciliation verbs the adapters
 * call:
 *
 *   - `markDirty`              — tool-activity adapter signal
 *   - `shouldReconcile`        — boundary check before asking the agent
 *   - `markReconcileRequested` — record a delivered instruction
 *   - `markReconciled`         — explicitly close the dirty window
 *
 * And the {@link Freshness} derived view + the constant
 * {@link RECONCILE_INSTRUCTION} text. Together they read the runtime
 * marker, compare it against `state.updated_at`, and gate every
 * instruction emission behind the three independent gates documented
 * in each verb's docstring.
 *
 * Auto-checkpoint never imports `writeState`, never mutates a Task,
 * and never infers completion. The only task-state function referenced
 * is `readState`, and it is read only to compare timestamps.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { findProjectRoot, storePath } from '../paths.js';
import { isAttached } from '../attachment.js';
import { readState } from '../storage.js';
import { getActiveTopic } from '../codec.js';
import { debounceSeconds, isEnabled } from './config.js';
import { readRuntime, type AutoCheckpointRuntime } from './runtime.js';

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
import { writeRuntime } from './runtime.js';

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
