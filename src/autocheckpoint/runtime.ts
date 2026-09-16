/**
 * Auto-checkpoint runtime bookkeeping.
 *
 * Extracted from `src/autocheckpoint.ts` as part of #25 (structural
 * decomposition). Owns the ephemeral coordinated state that is *not*
 * task state (which lives in `state.json`) and is *not* user
 * configuration (which lives in `config.json`). The runtime keeps the
 * two timestamps (`dirty_since`, `last_signal_at`) and the counter
 * the policy module uses to debounce reconciliation requests.
 *
 * Writes happen through {@link atomicWriteJson} (shared with
 * `pending.ts` and `config.ts`). The clear path is exposed for both
 * `writeMode` (config) and the policy verbs to use.
 */
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { findProjectRoot, storePath } from '../paths.js';
import { RUNTIME_FILE } from './config.js';
import { atomicWriteJson } from './_write.js';

export function runtimeFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), RUNTIME_FILE);
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

export function writeRuntime(runtime: AutoCheckpointRuntime, projectRoot?: string): void {
  atomicWriteJson(runtimeFilePath(projectRoot), runtime);
}

export function clearRuntime(projectRoot?: string): void {
  const path = runtimeFilePath(projectRoot);
  try { unlinkSync(path); } catch { /* already absent */ }
}

// findProjectRoot is imported for completeness of the locator surface;
// it is used by policy/pending indirectly via the projectRoot defaults.
void findProjectRoot;
