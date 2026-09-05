#!/usr/bin/env node
/**
 * claude-task-store: Core task state management library
 *
 * Handles all read/write operations against .claude-task/state.json and history.jsonl
 * Uses atomic writes to prevent corruption.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync, unlinkSync, openSync, closeSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';

const STORE_DIR = '.claude-task';
const STATE_FILE = 'state.json';
const HISTORY_FILE = 'history.jsonl';
const LOCK_FILE = '.lock';
export const SCHEMA_VERSION = '2';
export const DEFAULT_TOPIC = 'default';

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

export interface TopicState {
  name: string;
  goal: string;
  status: 'active' | 'blocked' | 'completed' | 'archived';
  current_task: string | null;
  tasks: Task[];
  decisions?: Decision[];
  blockers?: Blocker[];
  next_action: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskState {
  version: string;
  /** Monotonically increasing integer. Incremented on every write. Used for optimistic concurrency. */
  revision: number;
  active_topic: string;
  topics: TopicState[];
  updated_at: string;
  /** Optional agent/tool that last wrote this state. Never affects execution semantics. */
  updated_by?: string | null;
}

interface LegacyTaskStateV1 extends Omit<TopicState, 'name'> {
  version: '1';
  revision?: number;
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

function lockFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), LOCK_FILE);
}

// ─── Process-level locking ────────────────────────────────────────────────────

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockError';
  }
}

const LOCK_ACQUIRE_TIMEOUT_MS = 5000;
const LOCK_POLL_INTERVAL_MS = 25;
/** A lock file older than this is assumed to be left behind by a crashed process. */
const LOCK_STALE_MS = 30000;

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Acquire an exclusive O_EXCL lock file around a read-modify-write cycle and
 * run `fn` while holding it, releasing the lock afterward (even on error).
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

function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
    throw new StateError(`${label} must be a valid date-time string`);
  }
  return value;
}

function validateTopic(data: unknown, label: string): TopicState {
  if (typeof data !== 'object' || data === null) {
    throw new StateError(`${label} must be a JSON object`);
  }
  const topic = data as Record<string, unknown>;
  if (typeof topic.name !== 'string' || topic.name.trim() === '') {
    throw new StateError(`${label}.name must be a non-empty string`);
  }
  if (typeof topic.goal !== 'string' || topic.goal.trim() === '') {
    throw new StateError(`${label}.goal must be a non-empty string`);
  }
  if (!['active', 'blocked', 'completed', 'archived'].includes(topic.status as string)) {
    throw new StateError(`Invalid status: ${topic.status}`);
  }
  if (!Array.isArray(topic.tasks)) {
    throw new StateError(`${label}.tasks must be an array`);
  }
  const ids = (topic.tasks as Task[]).map(t => t.id);
  const unique = new Set(ids);
  if (unique.size !== ids.length) {
    throw new StateError(`Duplicate task IDs found in ${label}`);
  }
  validateTimestamp(topic.created_at, `${label}.created_at`);
  validateTimestamp(topic.updated_at, `${label}.updated_at`);
  return data as TopicState;
}

function migrateV1State(data: Record<string, unknown>): TaskState {
  const legacy = data as unknown as LegacyTaskStateV1;
  const topic = validateTopic({
    name: DEFAULT_TOPIC,
    goal: legacy.goal,
    status: legacy.status,
    current_task: legacy.current_task,
    tasks: legacy.tasks,
    decisions: legacy.decisions,
    blockers: legacy.blockers,
    next_action: legacy.next_action,
    created_at: legacy.created_at,
    updated_at: legacy.updated_at,
  }, `Topic ${DEFAULT_TOPIC}`);

  return {
    version: SCHEMA_VERSION,
    revision: typeof legacy.revision === 'number' ? legacy.revision : 0,
    active_topic: DEFAULT_TOPIC,
    topics: [topic],
    updated_at: topic.updated_at,
    ...(legacy.updated_by !== undefined ? { updated_by: legacy.updated_by } : {}),
  };
}

export function validateState(data: unknown): TaskState {
  if (typeof data !== 'object' || data === null) {
    throw new StateError('State must be a JSON object');
  }
  const s = data as Record<string, unknown>;
  if (s.version === '1') {
    return migrateV1State(s);
  }
  if (s.version !== SCHEMA_VERSION) {
    throw new StateError(`Unknown schema version: ${s.version}`);
  }
  if (typeof s.active_topic !== 'string' || s.active_topic.trim() === '') {
    throw new StateError('State.active_topic must be a non-empty string');
  }
  if (!Array.isArray(s.topics) || s.topics.length === 0) {
    throw new StateError('State.topics must be a non-empty array');
  }
  const topics = s.topics.map((topic, index) => validateTopic(topic, `State.topics[${index}]`));
  const names = topics.map(topic => topic.name);
  if (new Set(names).size !== names.length) {
    throw new StateError('Duplicate topic names found in state');
  }
  if (!names.includes(s.active_topic)) {
    throw new StateError(`Active topic not found: ${s.active_topic}`);
  }
  validateTimestamp(s.updated_at, 'State.updated_at');
  // Backfill revision for states created before it was added.
  if (typeof s.revision !== 'number') {
    s.revision = 0;
  }
  return data as TaskState;
}

export function getActiveTopic(state: TaskState): TopicState {
  const topic = state.topics.find(candidate => candidate.name === state.active_topic);
  if (!topic) throw new StateError(`Active topic not found: ${state.active_topic}`);
  return topic;
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

function appendHistory(entry: Record<string, unknown>, projectRoot?: string): void {
  const path = historyFilePath(projectRoot);
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
  appendFileSync(path, line, 'utf8');
}

// ─── Init ────────────────────────────────────────────────────────────────────

export function initState(goal: string, tasks: string[], projectRoot?: string, updatedBy?: string): TaskState {
  const existing = readState(projectRoot);
  if (existing && getActiveTopic(existing).status !== 'archived') {
    throw new StateError(
      'Active state already exists. Use `task-store status` to view or `task-store archive` to archive it first.'
    );
  }
  if (existing && existing.topics.length > 1) {
    throw new StateError(
      'Cannot reinitialize a multi-topic store. Use `task-store topic add` or `task-store topic use` instead.'
    );
  }

  const now = new Date().toISOString();
  const state: TaskState = {
    version: SCHEMA_VERSION,
    revision: 0,
    active_topic: DEFAULT_TOPIC,
    topics: [{
      name: DEFAULT_TOPIC,
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
    }],
    updated_at: now,
  };

  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'init', topic: DEFAULT_TOPIC, goal, taskCount: tasks.length }, projectRoot);
  return state;
}

export function addTopic(
  name: string,
  goal: string,
  tasks: string[],
  projectRoot?: string,
  updatedBy?: string,
): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found. Run `task-store init` first.');
  const normalizedName = name.trim();
  if (!normalizedName) throw new StateError('Topic name must be a non-empty string');
  if (!goal.trim()) throw new StateError('Topic goal must be a non-empty string');
  if (state.topics.some(topic => topic.name === normalizedName)) {
    throw new StateError(`Topic already exists: ${normalizedName}`);
  }

  const now = new Date().toISOString();
  state.topics.push({
    name: normalizedName,
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
  });

  writeState(state, projectRoot, updatedBy, false);
  appendHistory({ event: 'topic_added', topic: normalizedName, goal, taskCount: tasks.length }, projectRoot);
  return state;
}

export function useTopic(name: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found. Run `task-store init` first.');
  const normalizedName = name.trim();
  if (!normalizedName) throw new StateError('Topic name must be a non-empty string');
  if (!state.topics.some(topic => topic.name === normalizedName)) {
    throw new StateError(`Topic not found: ${normalizedName}`);
  }
  state.active_topic = normalizedName;
  writeState(state, projectRoot, updatedBy, false);
  appendHistory({ event: 'topic_selected', topic: normalizedName }, projectRoot);
  return state;
}

// ─── Task operations ──────────────────────────────────────────────────────────

function getTask(topic: TopicState, taskId: string): Task {
  const task = topic.tasks.find(t => t.id === taskId);
  if (!task) throw new StateError(`Task ${taskId} not found`);
  return task;
}

export function startTask(taskId: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found. Run `task-store init` first.');
  const topic = getActiveTopic(state);

  const existing = topic.tasks.find(t => t.status === 'in_progress' && t.id !== taskId);
  if (existing) {
    appendHistory({
      event: 'warning',
      topic: topic.name,
      message: `Starting ${taskId} while ${existing.id} is still in_progress`,
    }, projectRoot);
  }

  const task = getTask(topic, taskId);
  task.status = 'in_progress';
  task.started_at = new Date().toISOString();
  topic.current_task = taskId;
  topic.status = 'active';

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function completeTask(taskId: string, evidence: string[], notes?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  if (!evidence || evidence.length === 0) {
    throw new StateError(
      `Evidence is required to mark ${taskId} done. Provide file paths, test output, or other proof.`
    );
  }

  task.status = 'done';
  task.evidence = evidence;
  if (notes) task.notes = notes;
  task.completed_at = new Date().toISOString();

  if (topic.current_task === taskId) {
    const next = topic.tasks.find(t => t.status === 'pending');
    topic.current_task = next?.id ?? null;
    if (next) {
      topic.next_action = `Start task ${next.id}: ${next.title}`;
    }
  }

  // Check if all tasks are done
  const allDone = topic.tasks.every(t => t.status === 'done' || t.status === 'skipped');
  if (allDone) {
    topic.status = 'completed';
    topic.next_action = 'All tasks completed. Consider archiving with `task-store archive`.';
  }

  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'task_completed', topic: topic.name, taskId, evidence }, projectRoot);
  return state;
}

export function blockTask(taskId: string, reason: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  task.status = 'blocked';
  // Preserve any existing task notes — do not destroy prior context by
  // overwriting it with the blocker reason. The reason is always recorded
  // in topic.blockers below; task.notes is only backfilled here when there
  // isn't already a note, to keep prior display behavior for the common case.
  if (!task.notes) {
    task.notes = reason;
  }
  topic.status = 'blocked';

  topic.blockers = topic.blockers ?? [];
  topic.blockers.push({
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
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  task.status = 'in_progress';
  topic.current_task = taskId;

  // Remove resolved blocker for this task
  topic.blockers = (topic.blockers ?? []).filter(b => b.task_id !== taskId);
  // Unblock overall status if no blockers remain
  topic.status = topic.blockers.length === 0 ? 'active' : 'blocked';

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function addTask(title: string, notes?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  const maxId = topic.tasks.reduce((max, t) => {
    const n = parseInt(t.id.slice(1), 10);
    return n > max ? n : max;
  }, 0);

  topic.tasks.push({
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
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  task.attempts = task.attempts ?? [];
  task.attempts.push({ description, outcome, at: new Date().toISOString() });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function recordDecision(summary: string, rationale?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  topic.decisions = topic.decisions ?? [];
  topic.decisions.push({ summary, rationale: rationale ?? null, at: new Date().toISOString() });

  writeState(state, projectRoot, updatedBy);
  return state;
}

export function setNextAction(nextAction: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  getActiveTopic(state).next_action = nextAction;
  writeState(state, projectRoot, updatedBy);
  return state;
}

export function archiveState(projectRoot?: string, updatedBy?: string): void {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const topic = getActiveTopic(state);
  topic.status = 'archived';
  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'archived', topic: topic.name, goal: topic.goal }, projectRoot);
}

// ─── Compact resume summary ───────────────────────────────────────────────────

/**
 * Build a compact resume injection for session start.
 * Target: < 400 tokens, hard cap ~800.
 */
export function buildResumeContext(state: TaskState): string {
  const topic = getActiveTopic(state);
  const done = topic.tasks.filter(t => t.status === 'done');
  const remaining = topic.tasks.filter(t => t.status === 'pending');
  const inProgress = topic.tasks.filter(t => t.status === 'in_progress');
  const blocked = topic.tasks.filter(t => t.status === 'blocked');

  const lines: string[] = [
    '╔══════════════════════════════════════╗',
    '║  TASK STORE — RESUME CONTEXT         ║',
    '╚══════════════════════════════════════╝',
    '',
    `TOPIC: ${topic.name}`,
    `GOAL: ${topic.goal}`,
    `STATUS: ${topic.status.toUpperCase()}`,
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
      // The blocker reason lives in topic.blockers (task.notes is preserved,
      // not overwritten, when a task is blocked) — look up the most recent
      // blocker entry for this task to render the reason.
      const blocker = (topic.blockers ?? []).slice().reverse().find(b => b.task_id === t.id);
      lines.push(`  ✗ [${t.id}] ${blocker?.description ?? t.notes ?? t.title}`);
      if (t.attempts && t.attempts.length > 0) {
        for (const a of t.attempts.slice(-2)) {
          lines.push(`    ✗ tried: ${a.description} → ${a.outcome}`);
        }
      }
    }
    lines.push('');
  }

  if (topic.decisions && topic.decisions.length > 0) {
    const recent = topic.decisions.slice(-3);
    lines.push('KEY DECISIONS:');
    for (const d of recent) lines.push(`  • ${d.summary}`);
    lines.push('');
  }

  lines.push(`NEXT ACTION: ${topic.next_action ?? '(not set — run /task-status)'}`);
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
 * The read-compare-write cycle runs inside an O_EXCL lock (see
 * withStoreLock), so this is a real atomic compare-and-write against other
 * CLI-driven writers, not merely a best-effort check — see
 * docs/pre-release-remediation.md item 3 for the exact guarantee and its
 * limitation (direct library callers that bypass withStoreLock are not
 * covered).
 */
export function compareAndWriteState(
  state: TaskState,
  expectedRevision: number,
  projectRoot?: string,
  updatedBy?: string,
): void {
  withStoreLock(projectRoot, () => {
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
  });
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
