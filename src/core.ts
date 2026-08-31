#!/usr/bin/env node
/**
 * claude-task-store: Core task state management library
 *
 * Handles all read/write operations against .claude-task/state.json and history.jsonl
 * Uses atomic writes to prevent corruption.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

const STORE_DIR = '.claude-task';
const STATE_FILE = 'state.json';
const HISTORY_FILE = 'history.jsonl';
export const SCHEMA_VERSION = '1';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Attempt {
  description: string;
  outcome: string;
  at?: string;
}

export interface Task {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'blocked' | 'done' | 'skipped';
  notes?: string | null;
  evidence?: string[];
  attempts?: Attempt[];
  started_at?: string | null;
  completed_at?: string | null;
}

export interface Decision {
  summary: string;
  rationale?: string | null;
  at?: string | null;
}

export interface Blocker {
  description: string;
  task_id?: string | null;
  since?: string | null;
}

export interface TaskState {
  version: string;
  /** Monotonically increasing integer. Incremented on every write. Used for optimistic concurrency. */
  revision: number;
  goal: string;
  status: 'active' | 'blocked' | 'completed' | 'archived';
  current_task: string | null;
  tasks: Task[];
  decisions?: Decision[];
  blockers?: Blocker[];
  next_action: string | null;
  created_at: string;
  updated_at: string;
  /** Optional agent/tool that last wrote this state. Never affects execution semantics. */
  updated_by?: string | null;
}

// ─── Store path resolution ────────────────────────────────────────────────────

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

export function storePath(projectRoot?: string): string {
  return join(projectRoot || findProjectRoot(), STORE_DIR);
}

export function stateFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), STATE_FILE);
}

export function historyFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), HISTORY_FILE);
}

// ─── Atomic write ────────────────────────────────────────────────────────────

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

// ─── State validation ─────────────────────────────────────────────────────────

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StateError';
  }
}

export function validateState(data: unknown): TaskState {
  if (typeof data !== 'object' || data === null) {
    throw new StateError('State must be a JSON object');
  }
  const s = data as Record<string, unknown>;
  if (s.version !== SCHEMA_VERSION) {
    throw new StateError(`Unknown schema version: ${s.version}`);
  }
  if (typeof s.goal !== 'string' || s.goal.trim() === '') {
    throw new StateError('State.goal must be a non-empty string');
  }
  if (!['active', 'blocked', 'completed', 'archived'].includes(s.status as string)) {
    throw new StateError(`Invalid status: ${s.status}`);
  }
  if (!Array.isArray(s.tasks)) {
    throw new StateError('State.tasks must be an array');
  }
  const ids = (s.tasks as Task[]).map(t => t.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new StateError('Duplicate task IDs found in state');
  }
  // Backfill revision for states created before it was added
  if (typeof s.revision !== 'number') {
    s.revision = 0;
  }
  return data as TaskState;
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

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

export function writeState(state: TaskState, projectRoot?: string, updatedBy?: string): void {
  const dir = storePath(projectRoot);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  state.updated_at = new Date().toISOString();
  state.revision = (state.revision ?? 0) + 1;
  if (updatedBy !== undefined) {
    state.updated_by = updatedBy || null;
  }
  const content = JSON.stringify(state, null, 2) + '\n';
  atomicWrite(stateFilePath(projectRoot), content);
  appendHistory({ event: 'state_updated', snapshot: state }, projectRoot);
}

function appendHistory(entry: Record<string, unknown>, projectRoot?: string): void {
  const path = historyFilePath(projectRoot);
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
  appendFileSync(path, line, 'utf8');
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initState(goal: string, tasks: string[], projectRoot?: string): TaskState {
  const existing = readState(projectRoot);
  if (existing && existing.status !== 'archived') {
    throw new StateError(
      'Active state already exists. Use `task-store status` to view or `task-store archive` to archive it first.'
    );
  }

  const now = new Date().toISOString();
  const state: TaskState = {
    version: SCHEMA_VERSION,
    revision: 0,
    goal,
    status: 'active',
    current_task: null,
    tasks: tasks.map((title, i) => ({
      id: `T${i + 1}`,
      title,
      status: 'pending',
      notes: null,
      evidence: [],
      attempts: [],
      started_at: null,
      completed_at: null,
    })),
    decisions: [],
    blockers: [],
    next_action: tasks.length > 0 ? `Start task T1: ${tasks[0]}` : null,
    created_at: now,
    updated_at: now,
  };

  writeState(state, projectRoot);
  appendHistory({ event: 'init', goal, taskCount: tasks.length }, projectRoot);
  return state;
}

// ─── Task operations ──────────────────────────────────────────────────────────

function getTask(state: TaskState, taskId: string): Task {
  const task = state.tasks.find(t => t.id === taskId);
  if (!task) throw new StateError(`Task ${taskId} not found`);
  return task;
}

export function startTask(taskId: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found. Run `task-store init` first.');

  const existing = state.tasks.find(t => t.status === 'in_progress' && t.id !== taskId);
  if (existing) {
    appendHistory({
      event: 'warning',
      message: `Starting ${taskId} while ${existing.id} is still in_progress`,
    }, projectRoot);
  }

  const task = getTask(state, taskId);
  task.status = 'in_progress';
  task.started_at = new Date().toISOString();
  state.current_task = taskId;
  state.status = 'active';

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function completeTask(taskId: string, evidence: string[], notes?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const task = getTask(state, taskId);
  if (!evidence || evidence.length === 0) {
    throw new StateError(
      `Evidence is required to mark ${taskId} done. Provide file paths, test output, or other proof.`
    );
  }

  task.status = 'done';
  task.evidence = evidence;
  if (notes) task.notes = notes;
  task.completed_at = new Date().toISOString();

  if (state.current_task === taskId) {
    const next = state.tasks.find(t => t.status === 'pending');
    state.current_task = next?.id ?? null;
    if (next) {
      state.next_action = `Start task ${next.id}: ${next.title}`;
    }
  }

  // Check if all tasks are done
  const allDone = state.tasks.every(t => t.status === 'done' || t.status === 'skipped');
  if (allDone) {
    state.status = 'completed';
    state.next_action = 'All tasks completed. Consider archiving with `task-store archive`.';
  }

  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'task_completed', taskId, evidence }, projectRoot);
  return state;
}

export function blockTask(taskId: string, reason: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const task = getTask(state, taskId);
  task.status = 'blocked';
  task.notes = reason;
  state.status = 'blocked';

  state.blockers = state.blockers ?? [];
  state.blockers.push({
    description: reason,
    task_id: taskId,
    since: new Date().toISOString(),
  });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function resumeTask(taskId: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const task = getTask(state, taskId);
  task.status = 'in_progress';
  state.current_task = taskId;

  // Remove resolved blocker for this task
  state.blockers = (state.blockers ?? []).filter(b => b.task_id !== taskId);
  // Unblock overall status if no blockers remain
  state.status = state.blockers.length === 0 ? 'active' : 'blocked';

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function addTask(title: string, notes?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const maxId = state.tasks.reduce((max, t) => {
    const n = parseInt(t.id.slice(1), 10);
    return n > max ? n : max;
  }, 0);

  state.tasks.push({
    id: `T${maxId + 1}`,
    title,
    status: 'pending',
    notes: notes ?? null,
    evidence: [],
    attempts: [],
    started_at: null,
    completed_at: null,
  });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function recordAttempt(taskId: string, description: string, outcome: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const task = getTask(state, taskId);
  task.attempts = task.attempts ?? [];
  task.attempts.push({ description, outcome, at: new Date().toISOString() });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function recordDecision(summary: string, rationale?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  state.decisions = state.decisions ?? [];
  state.decisions.push({ summary, rationale: rationale ?? null, at: new Date().toISOString() });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function setNextAction(nextAction: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  state.next_action = nextAction;
  writeState(state, projectRoot, updatedBy);
  return state;
}

export function archiveState(projectRoot?: string, updatedBy?: string): void {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  state.status = 'archived';
  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'archived', goal: state.goal }, projectRoot);
}

// ─── Compact resume summary ───────────────────────────────────────────────────

/**
 * Build a compact resume injection for session start.
 * Target: < 400 tokens, hard cap ~800.
 */
export function buildResumeContext(state: TaskState): string {
  const done = state.tasks.filter(t => t.status === 'done');
  const remaining = state.tasks.filter(t => t.status === 'pending');
  const inProgress = state.tasks.filter(t => t.status === 'in_progress');
  const blocked = state.tasks.filter(t => t.status === 'blocked');

  const lines: string[] = [
    '╔══════════════════════════════════════╗',
    '║  TASK STORE — RESUME CONTEXT         ║',
    '╚══════════════════════════════════════╝',
    '',
    `GOAL: ${state.goal}`,
    `STATUS: ${state.status.toUpperCase()}`,
    '',
  ];

  if (inProgress.length > 0) {
    lines.push('CURRENT:');
    for (const t of inProgress) {
      lines.push(`  ▶ [${t.id}] ${t.title}`);
      if (t.notes) lines.push(`    NOTE: ${t.notes}`);
      if (t.attempts && t.attempts.length > 0) {
        for (const a of t.attempts.slice(-2)) {  // only last 2 attempts
          lines.push(`    ✗ tried: ${a.description} → ${a.outcome}`);
        }
      }
    }
    lines.push('');
  }

  if (done.length > 0) {
    // Cap done tasks to avoid flooding context with historical work.
    // Show count summary + only last 5 completed (most recent progress).
    const MAX_DONE_DETAIL = 5;
    if (done.length <= MAX_DONE_DETAIL) {
      lines.push('DONE:');
      for (const t of done) lines.push(`  ✓ [${t.id}] ${t.title}`);
    } else {
      const recent = done.slice(-MAX_DONE_DETAIL);
      const older = done.length - MAX_DONE_DETAIL;
      lines.push(`DONE (${done.length} total, last ${MAX_DONE_DETAIL} shown):`);
      lines.push(`  ✓ [+${older} older tasks — use \`task-store status\` to see all]`);
      for (const t of recent) lines.push(`  ✓ [${t.id}] ${t.title}`);
    }
    lines.push('');
  }

  if (remaining.length > 0) {
    lines.push('REMAINING:');
    for (const t of remaining) lines.push(`  ○ [${t.id}] ${t.title}`);
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push('BLOCKED:');
    for (const t of blocked) {
      lines.push(`  ✗ [${t.id}] ${t.notes ?? t.title}`);
      if (t.attempts && t.attempts.length > 0) {
        for (const a of t.attempts.slice(-2)) {
          lines.push(`    ✗ tried: ${a.description} → ${a.outcome}`);
        }
      }
    }
    lines.push('');
  }

  if (state.decisions && state.decisions.length > 0) {
    const recent = state.decisions.slice(-3);
    lines.push('KEY DECISIONS:');
    for (const d of recent) lines.push(`  • ${d.summary}`);
    lines.push('');
  }

  lines.push(`NEXT ACTION: ${state.next_action ?? '(not set — run /task-status)'}`);
  lines.push('');
  lines.push(`Updated: ${state.updated_at.slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('─── /task-status for details | /task-history for audit ───');

  return lines.join('\n');
}

// ─── Optimistic concurrency ───────────────────────────────────────────────────

export class ConflictError extends Error {
  public readonly currentRevision: number;
  constructor(message: string, currentRevision: number) {
    super(message);
    this.name = 'ConflictError';
    this.currentRevision = currentRevision;
  }
}

/**
 * Write state only if the current on-disk revision matches expectedRevision.
 * Throws ConflictError if another agent has written since the state was read.
 *
 * Use this when concurrent agents are possible and last-writer-wins is unacceptable.
 */
export function compareAndWriteState(
  state: TaskState,
  expectedRevision: number,
  projectRoot?: string,
  updatedBy?: string,
): void {
  // Read current on-disk revision
  const current = readState(projectRoot);
  const currentRev = current?.revision ?? 0;

  if (currentRev !== expectedRevision) {
    throw new ConflictError(
      `State conflict: expected revision ${expectedRevision}, found ${currentRev}. ` +
      `Another agent has written since you read. Re-read state before retrying.`,
      currentRev,
    );
  }

  writeState(state, projectRoot, updatedBy);
}



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

  const now = Date.now();
  const warnings: StaleTaskWarning[] = [];

  for (const task of state.tasks) {
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
export function repairState(projectRoot?: string): TaskState | null {
  const histPath = historyFilePath(projectRoot);
  if (!existsSync(histPath)) return null;

  const lines = readFileSync(histPath, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { event: string; snapshot?: TaskState };
      if (entry.event === 'state_updated' && entry.snapshot) {
        const state = validateState(entry.snapshot);
        writeState(state, projectRoot);
        return state;
      }
    } catch {
      continue;
    }
  }
  return null;
}
