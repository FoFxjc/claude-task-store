/**
 * Path resolution for the on-disk task store.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition). The
 * helpers here only deal with filesystem locations: they do not validate or
 * mutate state. The store directory is created lazily by writers and the
 * lock primitive when needed.
 */
import { existsSync } from 'fs';
import { join, resolve } from 'path';

/** Directory containing `state.json` and history, relative to the project root. */
export const STORE_DIR = '.claude-task';

const STATE_FILE = 'state.json';
const HISTORY_FILE = 'history.jsonl';
const LOCK_FILE = '.lock';

/**
 * Resolve the repository root that owns this task store.
 *
 * Walks up from `startDir` (defaults to cwd) until it finds either a `.git`
 * directory or an existing `.claude-task/` directory. If no marker is
 * found, returns the starting directory so writers can create the store
 * lazily.
 */
export function findProjectRoot(startDir?: string): string {
  let dir = resolve(startDir || process.cwd());
  while (true) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, STORE_DIR))) {
      return dir;
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return resolve(startDir || process.cwd());
    dir = parent;
  }
}

/** Absolute path to the store directory. Creates nothing on disk. */
export function storePath(projectRoot?: string): string {
  return join(projectRoot || findProjectRoot(), STORE_DIR);
}

export function stateFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), STATE_FILE);
}

export function historyFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), HISTORY_FILE);
}

export function lockFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), LOCK_FILE);
}
