/**
 * Atomic store read/write and history append.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * Storage owns the disk-side contract for `state.json` and `history.jsonl`:
 *
 *   - Read: decode the on-disk file through the codec and return a
 *     canonical v2 {@link TaskState}, or null if the file does not exist.
 *     Storage itself never mutates on read; v1 files are read-only and
 *     stay byte-for-byte unmodified until a normal write rewrites them
 *     as v2.
 *   - Write: stamp the canonical timestamps, bump revision exactly once,
 *     optionally touch the active topic's `updated_at`, persist via an
 *     atomic rename, and append a `state_updated` entry to history.
 *
 * Storage is intentionally lock-free. Locking is the caller's
 * responsibility; the CLI wraps every mutating command in
 * `withStoreLock`, and direct library callers that skip this protection
 * are documented as bypassing concurrency guarantees.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { historyFilePath, stateFilePath, storePath } from './paths.js';
import { getActiveTopic, StateError, validateState } from './codec.js';
import type { TaskState } from './types.js';

function atomicWrite(filePath: string, content: string): void {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '') || '.';
  const tmp = join(dir, `.tmp_${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(tmp, content, 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

/**
 * Read the canonical state.
 *
 * Returns null when `state.json` does not exist. Throws
 * {@link StateError} on read failure, malformed JSON, or a parse that
 * fails codec validation. A v1 on-disk file is migrated in memory to
 * the canonical v2 representation; the file on disk is not modified by
 * this call.
 */
export function readState(projectRoot?: string): TaskState | null {
  const path = stateFilePath(projectRoot);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    throw new StateError(`Failed to read state file: ${(err as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError('State file contains invalid JSON. Run `task-store repair` to recover from history.');
  }

  return validateState(parsed);
}

/**
 * Persist the canonical state.
 *
 * Stamps `updated_at`, optionally refreshes `updated_at` on the active
 * topic, bumps `revision` exactly once, applies `updated_by` if
 * provided, then atomically renames a temp file into place and records
 * a `state_updated` history event. The caller is expected to hold the
 * store lock when this races with other writers; see
 * `./lock.ts#withStoreLock`.
 */
export function writeState(
  state: TaskState,
  projectRoot?: string,
  updatedBy?: string,
  touchActiveTopic = true,
): void {
  const dir = storePath(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const now = new Date().toISOString();
  state.updated_at = now;
  if (touchActiveTopic) getActiveTopic(state).updated_at = now;
  state.revision = (state.revision ?? 0) + 1;
  if (updatedBy !== undefined) {
    state.updated_by = updatedBy || null;
  }
  const content = JSON.stringify(state, null, 2) + '\n';
  atomicWrite(stateFilePath(projectRoot), content);
  appendHistory({ event: 'state_updated', snapshot: state }, projectRoot);
}

/**
 * Append a single JSONL record to history. A timestamp is added under
 * `at`. The storage layer does not interpret the record's `event`
 * discriminator; callers shape their own entries.
 */
export function appendHistory(entry: Record<string, unknown>, projectRoot?: string): void {
  const path = historyFilePath(projectRoot);
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
  appendFileSync(path, line, 'utf8');
}
