#!/usr/bin/env node
/**
 * claude-task-store: Core task state management library
 *
 * Handles all read/write operations against .claude-task/state.json and history.jsonl
 * Uses atomic writes to prevent corruption.
 */

import { readFileSync, existsSync } from 'fs';
import { historyFilePath } from './paths.js';
import { withStoreLock } from './lock.js';
import { getActiveTopic, StateError, validateState } from './codec.js';
import { readState, writeState, appendHistory } from './storage.js';
import type {
  Decision, Task, TaskState, TopicState,
} from './types.js';
import { DEFAULT_TOPIC, SCHEMA_VERSION } from './types.js';

export { SCHEMA_VERSION, DEFAULT_TOPIC } from './types.js';
/** Stale threshold: tasks in_progress for more than this many hours trigger a warning. */
const STALE_TASK_HOURS = 48;

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
 * Attempt to recover the last valid state from history.jsonl
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
