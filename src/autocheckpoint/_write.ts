/**
 * Shared atomic JSON write helper for the auto-checkpoint sub-modules.
 *
 * Mirrors the `atomicWrite` shape used by `src/storage.ts`. Kept inside
 * the `autocheckpoint/` folder rather than promoted to a public helper
 * because auto-checkpoint is the only consumer besides storage itself;
 * each domain owns its own atomic-write so the rename / unlink contract
 * is colocated with the read/write code that depends on it.
 */
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export function atomicWriteJson(filePath: string, value: unknown): void {
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
