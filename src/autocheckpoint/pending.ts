/**
 * Pending reconciliation instruction.
 *
 * Extracted from `src/autocheckpoint.ts` as part of #25 (structural
 * decomposition). Owns the staged-instruction flow the OpenCode
 * adapter uses as the channel-agnostic counterpart to Claude Code's
 * inline `Stop` hook:
 *
 *   - the file path {@link pendingInstructionFilePath};
 *   - the staging-and-record-keeping pair
 *     {@link stagePendingInstruction} / {@link takePendingInstruction};
 *   - the binding of every staged record to the session that staged
 *     it, defended in depth against takeover-window races.
 *
 * Both halves live here, in the provider-neutral core, rather than in
 * the adapter. The decision (gates) lives in `policy.ts`; this module
 * owns only the file lifecycle around it.
 */
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { findProjectRoot, storePath } from '../paths.js';
import { isAttached, normalizeIdentity } from '../attachment.js';
import {
  RECONCILE_INSTRUCTION,
  markReconcileRequested,
  shouldReconcile,
  type ReconcileDecision,
} from './policy.js';
import { atomicWriteJson } from './_write.js';

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
export function clearPendingInstruction(projectRoot?: string): void {
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
