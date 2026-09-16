/**
 * Process-level store lock.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition). This
 * module is the single home for the O_EXCL lock file that serializes
 * concurrent `task-store` CLI invocations against the same project root.
 *
 * Callers always go through `withStoreLock`; direct callers of `writeState`
 * or the mutation helpers bypass this protection. That limitation is
 * documented at the call site.
 */
import {
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  statSync,
  unlinkSync,
} from 'fs';
import { lockFilePath, storePath } from './paths.js';

/** Maximum total time `withStoreLock` will wait before throwing `LockError`. */
export const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 25;
/** A lock file older than this is assumed to be left behind by a crashed process. */
export const LOCK_STALE_MS = 30000;

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Acquire an exclusive O_EXCL lock file around a read-modify-write cycle
 * and run `fn` while holding it, releasing the lock afterward (even on
 * error).
 *
 * This provides real (not merely best-effort) process-level conflict
 * protection for concurrent `task-store` CLI invocations against the same
 * project root: only one process can hold the lock at a time, so a
 * read-compare-write sequence (e.g. `--expect-rev`) cannot be interleaved
 * with another writer's read-compare-write sequence.
 *
 * Limitation: this protects callers that go through this function (the CLI
 * always does). Code that imports core.ts directly and calls writeState()
 * without going through withStoreLock() bypasses this protection.
 */
export function withStoreLock<T>(projectRoot: string | undefined, fn: () => T): T {
  const dir = storePath(projectRoot);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockPath = lockFilePath(projectRoot);
  const start = Date.now();

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;

      // Break stale locks left behind by a crashed process.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock file disappeared between our check and stat(); retry immediately.
        continue;
      }

      if (Date.now() - start > LOCK_ACQUIRE_TIMEOUT_MS) {
        throw new LockError(
          `Timed out waiting for task-store lock at ${lockPath}. ` +
          `Another task-store process may be writing. If no process is running, ` +
          `it is safe to remove the stale lock file manually.`
        );
      }
      sleepSync(LOCK_POLL_INTERVAL_MS);
    }
  }

  // `fn` may call process.exit() directly — several CLI commands do that on
  // a validation error (e.g. `done` with no evidence). process.exit() does
  // NOT run `finally` blocks, so a `finally`-only release would leak the
  // lock file and make the user's very next command block for the full
  // acquire timeout before failing. An 'exit' listener does run on an
  // explicit process.exit(), so release through both paths.
  const releaseOnExit = (): void => {
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  };
  process.once('exit', releaseOnExit);

  try {
    return fn();
  } finally {
    process.removeListener('exit', releaseOnExit);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}
