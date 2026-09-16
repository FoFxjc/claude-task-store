/**
 * Pending reconciliation instruction.
 *
 * Extracted from `src/autocheckpoint.ts` as part of #25 (structural
 * decomposition). Owns the staged-instruction flow the OpenCode
 * adapter uses as the channel-agnostic counterpart to Claude Code's
 * inline `Stop` hook:
 *
 *   - {@link stagePendingInstruction} / {@link takePendingInstruction};
 *   - the session-binding of every staged record to the session that
 *     staged it, defended in depth against takeover-window races;
 *   - the public re-exports of the underlying file-path and clear
 *     helpers so callers do not need to know about `_pending-file.ts`.
 *
 * File lifecycle (path / read / write / unconditional clear) lives in
 * `_pending-file.ts` to keep this module focused on the policy-aware
 * flow: it uses {@link shouldReconcile}, {@link markReconcileRequested},
 * and {@link RECONCILE_INSTRUCTION} to gate staging, and
 * {@link isAttached} + {@link normalizeIdentity} to bind records to a
 * session.
 */
import { findProjectRoot } from '../paths.js';
import { isAttached, normalizeIdentity } from '../attachment.js';
import {
  RECONCILE_INSTRUCTION,
  markReconcileRequested,
  shouldReconcile,
  type ReconcileDecision,
} from './policy.js';
import {
  clearPendingInstruction,
  pendingInstructionFilePath,
  readPendingInstruction,
  writePendingInstruction,
  type PendingInstructionRecord,
} from './_pending-file.js';

// Re-export the public surface that exists primarily for the on-disk
// side; the policy-aware entry points below remain in this module.
export { pendingInstructionFilePath, clearPendingInstruction };
export type { PendingInstructionRecord };

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
export function takePendingInstruction(
  projectRoot?: string,
  sessionId?: string,
): string | null {
  if (!sessionId) return null;
  const root = projectRoot ?? findProjectRoot();
  // Owner check: a displaced session must not collect, even its own record.
  if (!isAttached(sessionId, root)) return null;

  const record = readPendingInstruction(root);
  if (record && record.session_id !== normalizeIdentity(sessionId)) {
    // Staged for someone else. Leave it: the owner may still be running, and
    // the next stage overwrites it either way.
    return null;
  }

  // Record exists but doesn't pass the binding check (missing session_id /
  // instruction, parse error, etc.) — still leave no instruction behind,
  // because the record can never be delivered by anyone. Authoritative
  // cleanup of a malformed file falls within this verifier's scope.
  clearPendingInstruction(root);
  return record ? record.instruction : null;
}
