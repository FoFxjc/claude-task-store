/**
 * Stale-task detection + state recovery.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * Owns two read-only-or-restoring primitives that intentionally do
 * not decide what to do — only surface what the repository sees:
 *
 *   - {@link detectStaleTasks} reads the active topic, finds tasks
 *     that have been `in_progress` for more than {@link STALE_TASK_HOURS}
 *     (default 48 h), and returns non-fatal {@link StaleTaskWarning}
 *     records. It never modifies state. The agent or operator decides
 *     whether to follow up.
 *
 *   - {@link repairState} scans `history.jsonl` from the latest entry
 *     backwards for the most recent `state_updated` snapshot that
 *     validates through {@link validateState}, then writes it back to
 *     `state.json`. This is the recovery path the CLI recommends after
 *     `state.json` becomes corrupt or missing. It writes only when the
 *     rebuild produces a validated {@link TaskState}.
 *
 * Both are deliberately conservative: nothing about task completion,
 * blockers, decisions, or `next_action` is inferred from repository
 * activity — only the file's own history is consulted.
 */
import { existsSync, readFileSync } from 'fs';
import { historyFilePath } from './paths.js';
import { getActiveTopic, validateState } from './codec.js';
import { readState, writeState } from './storage.js';
import type { TaskState } from './types.js';

/** Stale threshold: tasks `in_progress` for more than this many hours trigger a warning. */
export const STALE_TASK_HOURS = 48;

export interface StaleTaskWarning {
  taskId: string;
  title: string;
  startedAt: string;
  hoursElapsed: number;
}

/**
 * Detect tasks that have been in_progress for an abnormally long time.
 * Returns warnings, does NOT modify state — the model decides what to do.
 */
export function detectStaleTasks(projectRoot?: string): StaleTaskWarning[] {
  const state = readState(projectRoot);
  if (!state) return [];
  const topic = getActiveTopic(state);

  const now = Date.now();
  const warnings: StaleTaskWarning[] = [];

  for (const task of topic.tasks) {
    if (task.status === 'in_progress' && task.started_at) {
      const startMs = new Date(task.started_at).getTime();
      const hoursElapsed = (now - startMs) / (1000 * 60 * 60);
      if (hoursElapsed > STALE_TASK_HOURS) {
        warnings.push({
          taskId: task.id,
          title: task.title,
          startedAt: task.started_at,
          hoursElapsed: Math.round(hoursElapsed),
        });
      }
    }
  }

  return warnings;
}

/**
 * Attempt to recover the last valid state from `history.jsonl`.
 *
 * Walks the most recent entries first, looking for the latest
 * `state_updated` snapshot that passes {@link validateState}. When
 * found, the recovered state is written back through
 * {@link writeState} (one atomic rename, one revision increment).
 *
 * Returns the recovered state, or `null` when no usable snapshot
 * exists in history.
 */
export function repairState(projectRoot?: string, updatedBy?: string): TaskState | null {
  const histPath = historyFilePath(projectRoot);
  if (!existsSync(histPath)) return null;

  const lines = readFileSync(histPath, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { event: string; snapshot?: TaskState };
      if (entry.event === 'state_updated' && entry.snapshot) {
        const state = validateState(entry.snapshot);
        writeState(state, projectRoot, updatedBy);
        return state;
      }
    } catch {
      continue;
    }
  }
  return null;
}
