/**
 * Low-level pending-instruction file lifecycle.
 *
 * Private to the `autocheckpoint/` folder. Owns only the file path, the
 * raw write/read helpers, and the unconditional clear used by
 * {@link config.writeMode} when the user turns auto-checkpoint off.
 *
 * This module deliberately does NOT import policy or config. Splitting
 * those concerns keeps the high-level `pending.ts` (which calls into
 * the policy verbs) load-free of `config.ts`, breaking the previous
 * `config → pending → policy → config` cycle at the module-load
 * level. The function-call cycle, if any, is the consumer's
 * responsibility.
 */
import { readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { storePath } from '../paths.js';
import { normalizeIdentity } from '../attachment.js';
import { atomicWriteJson } from './_write.js';

const PENDING_INSTRUCTION_FILE = '.pending-reconcile-instruction.txt';

/**
 * On-disk shape of the staged instruction record. Both writers and
 * readers in this folder import the same interface so the file is the
 * single source of truth for the wire format.
 */
export interface PendingInstructionRecord {
  /** The session that staged the record. Used by ownership checks. */
  session_id: string;
  /** The exact instruction text that was staged. The plugin returns it verbatim. */
  instruction: string;
  /** ISO timestamp the record was written. Used for diagnostics, not policy. */
  staged_at: string;
}

/** Absolute path to the staged instruction file. */
export function pendingInstructionFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), PENDING_INSTRUCTION_FILE);
}

/**
 * Remove any staged reconciliation instruction.
 *
 * This is administrative cleanup for disabling auto-checkpoint, not a
 * session-scoped consume operation. Missing is fine; every other
 * filesystem failure surfaces so `off` cannot claim the runtime was
 * cleared while a dead pending record remains on disk.
 *
 * No identity check here — `takePendingInstruction` does that itself.
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
 *
 * Session id is normalized here so every read back from the file
 * compares against `normalizeIdentity(sessionId)` instead of the raw
 * id the caller passed in.
 */
export function writePendingInstruction(
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

/**
 * Read the raw record off disk, or null when the file is missing,
 * unreadable, unparseable, or does not match the shape.
 *
 * No ownership check — the caller (typically `takePendingInstruction`)
 * is responsible for binding the record back to a specific session.
 */
export function readPendingInstruction(
  projectRoot?: string,
): PendingInstructionRecord | null {
  const path = pendingInstructionFilePath(projectRoot);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PendingInstructionRecord>;
    if (
      typeof parsed?.session_id === 'string' &&
      typeof parsed.instruction === 'string' &&
      parsed.instruction.length > 0
    ) {
      return {
        session_id: parsed.session_id,
        instruction: parsed.instruction,
        staged_at: typeof parsed.staged_at === 'string' ? parsed.staged_at : '',
      };
    }
    return null;
  } catch {
    return null;
  }
}
