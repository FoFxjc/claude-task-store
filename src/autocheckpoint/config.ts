/**
 * Auto-checkpoint configuration.
 *
 * Extracted from `src/autocheckpoint.ts` as part of #25 (structural
 * decomposition). Owns the user-facing config file:
 *
 *   - the {@link AutoCheckpointMode} enum,
 *   - the {@link AutoCheckpointConfig} record,
 *   - the file path {@link configFilePath},
 *   - the safe-default readers {@link readConfig} / {@link isEnabled}
 *     / {@link debounceSeconds},
 *   - the {@link writeMode} writer that owns switching on / off.
 *
 * The runtime file lives in `runtime.ts`; the policy / freshness
 * verbs in `policy.ts`; the staged instruction file in `pending.ts`.
 * They are coordinated through this module's exported surface.
 *
 * The module-load cycle between config, pending, and policy
 * (`config.writeMode` calls `pending.clearPendingInstruction`, which
 * via `policy.shouldReconcile` reads back `config.isEnabled`) is
 * fine under ESM live bindings — the cycle is only used at
 * function-call time, never at module-initialisation time.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { findProjectRoot, storePath } from '../paths.js';
import { clearAttachment } from '../attachment.js';
import { clearRuntime } from './runtime.js';
import { clearPendingInstruction } from './pending.js';
import { atomicWriteJson } from './_write.js';

const CONFIG_FILE = 'config.json';
export const RUNTIME_FILE = 'auto-checkpoint.json';

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

export function configFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), CONFIG_FILE);
}

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

export function isEnabled(projectRoot?: string): boolean {
  return readConfig(projectRoot).auto_checkpoint === 'conservative';
}

export function debounceSeconds(projectRoot?: string): number {
  const config = readConfig(projectRoot);
  return config.auto_checkpoint_debounce_seconds ?? DEFAULT_DEBOUNCE_SECONDS;
}

/**
 * Persist the mode, preserving any unrelated keys already in config.json so
 * that this never becomes a destructive rewrite of a file the user owns.
 *
 * Switching modes flushes the runtime, the attachment, and any pending
 * instruction so a stale dirty window or staged reconciliation cannot
 * outlive an explicit opt-in or opt-out.
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

  // Turning the feature off and back on should start from a clean slate
  // rather than immediately firing a reconciliation for work that predates
  // the change.
  clearRuntime(projectRoot);

  if (mode === 'off') {
    // The attachment is the intent boundary for auto-checkpoint, so with
    // the mode off there is nothing left for it to gate. Leaving the record
    // makes the next session to enable the mode meet an owner that no
    // longer exists — and, because the mode is off, the session-end hook
    // deliberately skips its release, so nothing else would ever clear it.
    clearAttachment(projectRoot);
    // A staged reconciliation belongs to the auto-checkpoint flow just as
    // much as the dirty runtime and attachment do. Leaving it behind after
    // an explicit opt-out creates dead ephemeral state and makes the next
    // chat call pay collection overhead for a feature that is off.
    clearPendingInstruction(projectRoot);
  }

  return readConfig(projectRoot);
}

// Touch findProjectRoot to keep its import live for testing consumers
// that swap the locator in tests.
void findProjectRoot;
