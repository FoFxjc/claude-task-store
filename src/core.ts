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

// ─── Batch commit types ────────────────────────────────────────────────────────

/** Input shape for a single operation in a commit batch. */
export type BatchOperationInput =
  | { type: 'add';       title: string; notes?: string }
  | { type: 'start';     taskId: string }
  | { type: 'done';      taskId: string; evidence: string[]; notes?: string }
  | { type: 'attempt';   taskId: string; description: string; outcome: string }
  | { type: 'block';     taskId: string; reason: string }
  | { type: 'resume';    taskId: string }
  | { type: 'decide';    summary: string; rationale?: string }
  | { type: 'next';      action: string };

/** Raw JSON input for the commit command. */
export interface BatchInput {
  operations: BatchOperationInput[];
  topic: string;
  expect_rev?: number;
}

/** Result of a successful commit. */
export interface BatchResult {
  revision: number;
  operationsApplied: number;
  topic: string;
}

/**
 * Parse a batch input from an unknown value.
 * Throws StateError on malformed input.
 * Does NOT read or write any files.
 */
export function parseBatchInput(raw: unknown): { topic: string; expectRev: number | undefined; operations: BatchOperationInput[] } {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new StateError('Batch input must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.topic !== 'string' || obj.topic.trim() === '') {
    throw new StateError('topic must be a non-empty string');
  }
  const topic = obj.topic.trim();

  const expectRev = obj.expect_rev === undefined || obj.expect_rev === null
    ? undefined
    : typeof obj.expect_rev === 'number' && Number.isFinite(obj.expect_rev) && Number.isInteger(obj.expect_rev)
      ? (obj.expect_rev < 0
          ? (() => { throw new StateError('expect_rev must be a non-negative integer'); })()
          : obj.expect_rev)
      : (() => { throw new StateError('expect_rev must be a non-negative integer'); })();

  if (!Array.isArray(obj.operations)) {
    throw new StateError('operations must be an array');
  }
  if (obj.operations.length === 0) {
    throw new StateError('operations array must not be empty');
  }

  const operations: BatchOperationInput[] = [];
  for (let i = 0; i < obj.operations.length; i++) {
    const op = obj.operations[i];
    if (op === null || op === undefined || typeof op !== 'object' || Array.isArray(op)) {
      throw new StateError(`operations[${i}] must be a JSON object`);
    }
    const o = op as Record<string, unknown>;
    const type = typeof o.type === 'string' ? o.type : (() => { throw new StateError(`operations[${i}].type must be a string`); })();

    switch (type) {
      case 'add': {
        if (typeof o.title !== 'string' || o.title.trim() === '') {
          throw new StateError(`operations[${i}].title must be a non-empty string`);
        }
        if (o.notes !== undefined && o.notes !== null && typeof o.notes !== 'string') {
          throw new StateError(`operations[${i}].notes must be a string or omitted`);
        }
        operations.push({ type: 'add', title: o.title.trim(), notes: o.notes as string | undefined });
        break;
      }
      case 'start': {
        if (typeof o.taskId !== 'string' || !/^T[0-9]+$/i.test(o.taskId)) {
          throw new StateError(`operations[${i}].taskId must match T<number>`);
        }
        operations.push({ type: 'start', taskId: (o.taskId as string).toUpperCase() });
        break;
      }
      case 'done': {
        if (typeof o.taskId !== 'string' || !/^T[0-9]+$/i.test(o.taskId)) {
          throw new StateError(`operations[${i}].taskId must match T<number>`);
        }
        if (!Array.isArray(o.evidence) || o.evidence.length === 0) {
          throw new StateError(`operations[${i}].evidence must be a non-empty array`);
        }
        for (const ev of o.evidence) {
          if (typeof ev !== 'string') {
            throw new StateError(`operations[${i}].evidence must contain only strings`);
          }
        }
        if (o.notes !== undefined && o.notes !== null && typeof o.notes !== 'string') {
          throw new StateError(`operations[${i}].notes must be a string or omitted`);
        }
        operations.push({ type: 'done', taskId: (o.taskId as string).toUpperCase(), evidence: o.evidence as string[], notes: o.notes as string | undefined });
        break;
      }
      case 'attempt': {
        if (typeof o.taskId !== 'string' || !/^T[0-9]+$/i.test(o.taskId)) {
          throw new StateError(`operations[${i}].taskId must match T<number>`);
        }
        if (typeof o.description !== 'string' || o.description.trim() === '') {
          throw new StateError(`operations[${i}].description must be a non-empty string`);
        }
        if (typeof o.outcome !== 'string' || o.outcome.trim() === '') {
          throw new StateError(`operations[${i}].outcome must be a non-empty string`);
        }
        operations.push({ type: 'attempt', taskId: (o.taskId as string).toUpperCase(), description: o.description.trim(), outcome: o.outcome.trim() });
        break;
      }
      case 'block': {
        if (typeof o.taskId !== 'string' || !/^T[0-9]+$/i.test(o.taskId)) {
          throw new StateError(`operations[${i}].taskId must match T<number>`);
        }
        if (typeof o.reason !== 'string' || o.reason.trim() === '') {
          throw new StateError(`operations[${i}].reason must be a non-empty string`);
        }
        operations.push({ type: 'block', taskId: (o.taskId as string).toUpperCase(), reason: o.reason.trim() });
        break;
      }
      case 'resume': {
        if (typeof o.taskId !== 'string' || !/^T[0-9]+$/i.test(o.taskId)) {
          throw new StateError(`operations[${i}].taskId must match T<number>`);
        }
        operations.push({ type: 'resume', taskId: (o.taskId as string).toUpperCase() });
        break;
      }
      case 'decide': {
        if (typeof o.summary !== 'string' || o.summary.trim() === '') {
          throw new StateError(`operations[${i}].summary must be a non-empty string`);
        }
        if (o.rationale !== undefined && o.rationale !== null && typeof o.rationale !== 'string') {
          throw new StateError(`operations[${i}].rationale must be a string or omitted`);
        }
        operations.push({ type: 'decide', summary: o.summary.trim(), rationale: typeof o.rationale === 'string' ? o.rationale.trim() : undefined });
        break;
      }
      case 'next': {
        if (typeof o.action !== 'string' || o.action.trim() === '') {
          throw new StateError(`operations[${i}].action must be a non-empty string`);
        }
        operations.push({ type: 'next', action: o.action.trim() });
        break;
      }
      default:
        throw new StateError(`operations[${i}].type must be one of: add, start, done, attempt, block, resume, decide, next`);
    }
  }

  return { topic, expectRev, operations };
}

/**
 * Apply a single parsed operation to a named topic within an in-memory TaskState copy.
 * Returns the updated state (same reference, mutated in-place).
 * This is a pure function of state + topicName + operation — no file I/O.
 */
function applyOperation(state: TaskState, topicName: string, op: BatchOperationInput): void {
  const topic = state.topics.find(t => t.name === topicName);
  if (!topic) throw new StateError(`Topic not found: ${topicName}`);

  switch (op.type) {
    case 'add': {
      topic.tasks.push({
        id: nextTaskId(topic.tasks),
        title: op.title,
        status: 'pending',
        notes: op.notes ?? null,
        evidence: [],
        attempts: [],
        started_at: null,
        completed_at: null,
      });
      break;
    }
    case 'start': {
      const task = topic.tasks.find(t => t.id === op.taskId);
      if (!task) throw new StateError(`Task ${op.taskId} not found`);
      task.status = 'in_progress';
      task.started_at = new Date().toISOString();
      topic.current_task = op.taskId;
      topic.status = 'active';
      break;
    }
    case 'done': {
      const task = topic.tasks.find(t => t.id === op.taskId);
      if (!task) throw new StateError(`Task ${op.taskId} not found`);
      task.status = 'done';
      task.evidence = op.evidence;
      if (op.notes) task.notes = op.notes;
      task.completed_at = new Date().toISOString();
      if (topic.current_task === op.taskId) {
        const next = topic.tasks.find(t => t.status === 'pending');
        topic.current_task = next?.id ?? null;
        if (next) topic.next_action = `Start task ${next.id}: ${next.title}`;
      }
      const allDone = topic.tasks.every(t => t.status === 'done' || t.status === 'skipped');
      if (allDone) {
        topic.status = 'completed';
        topic.next_action = 'All tasks completed. Consider archiving with `task-store archive`.';
      }
      break;
    }
    case 'attempt': {
      const task = topic.tasks.find(t => t.id === op.taskId);
      if (!task) throw new StateError(`Task ${op.taskId} not found`);
      task.attempts = task.attempts ?? [];
      task.attempts.push({ description: op.description, outcome: op.outcome, at: new Date().toISOString() });
      break;
    }
    case 'block': {
      const task = topic.tasks.find(t => t.id === op.taskId);
      if (!task) throw new StateError(`Task ${op.taskId} not found`);
      task.status = 'blocked';
      if (!task.notes) task.notes = op.reason;
      topic.status = 'blocked';
      topic.blockers = topic.blockers ?? [];
      topic.blockers.push({ description: op.reason, task_id: op.taskId, since: new Date().toISOString() });
      break;
    }
    case 'resume': {
      const task = topic.tasks.find(t => t.id === op.taskId);
      if (!task) throw new StateError(`Task ${op.taskId} not found`);
      task.status = 'in_progress';
      topic.current_task = op.taskId;
      topic.blockers = (topic.blockers ?? []).filter(b => b.task_id !== op.taskId);
      topic.status = topic.blockers.length === 0 ? 'active' : 'blocked';
      break;
    }
    case 'decide': {
      topic.decisions = topic.decisions ?? [];
      topic.decisions.push({ summary: op.summary, rationale: op.rationale ?? null, at: new Date().toISOString() });
      break;
    }
    case 'next': {
      topic.next_action = op.action;
      break;
    }
  }
}

/**
 * Apply a complete batch of operations to an in-memory state copy.
 * Parses, validates topic existence, applies all operations, and validates the
 * final state. Throws StateError on any failure. No file I/O.
 *
 * Returns the mutated in-memory state (same reference).
 */
export function applyBatch(
  state: TaskState,
  parsed: { topic: string; operations: BatchOperationInput[] },
): TaskState {
  // Verify topic exists.
  if (!state.topics.some(t => t.name === parsed.topic)) {
    throw new StateError(`Topic not found: ${parsed.topic}`);
  }
  // Apply operations in order, in-place, to a working copy.
  for (const op of parsed.operations) {
    applyOperation(state, parsed.topic, op);
  }
  // Validate the final in-memory state so a corrupted intermediate step
  // cannot produce an invalid file write.
  validateState(state);
  return state;
}

/**
 * Atomically commit a batch of operations in a single state.json write.
 *
 * Steps (all under one O_EXCL lock):
 * 1. Read current state
 * 2. Parse and validate the entire batch
 * 3. Enforce expectRev if provided
 * 4. Verify the named topic exists
 * 5. Apply all operations in-memory to the named topic (no active_topic switch)
 * 6. Validate final in-memory state
 * 7. Write state.json: exactly one atomic write, one revision increment,
 *    touchActiveTopic=false (no implicit active-topic timestamp update)
 * 8. Append history entry
 *
 * If steps 1–6 fail, state.json is untouched. History is outside the transaction.
 *
 * Atomicity covers only the canonical state update, not cross-file transactions.
 */
export function commitBatch(
  rawInput: unknown,
  projectRoot?: string,
  updatedBy?: string,
): BatchResult {
  return withStoreLock(projectRoot, () => {
    // 1. Read current state
    const state = readState(projectRoot);
    if (!state) throw new StateError('No state found. Run `task-store init` first.');

    // 2. Parse (validates JSON structure, operation types, required fields)
    const parsed = parseBatchInput(rawInput);

    // 3. Enforce expectRev
    if (parsed.expectRev !== undefined) {
      const currentRev = state.revision ?? 0;
      if (currentRev !== parsed.expectRev) {
        throw new ConflictError(
          `Revision conflict. Expected rev ${parsed.expectRev}, found rev ${currentRev}. ` +
          `Re-read state with \`task-store status\` before retrying.`,
          currentRev,
        );
      }
    }

    // 4. Verify topic exists
    if (!state.topics.some(t => t.name === parsed.topic)) {
      throw new StateError(`Topic not found: ${parsed.topic}`);
    }

    // 5. Apply all operations in-memory to the named topic (no active_topic switch)
    applyBatch(state, parsed);

    // 6. Stamp timestamps and updated_by — writeState will increment revision
    const now = new Date().toISOString();
    state.updated_at = now;
    state.topics.find(t => t.name === parsed.topic)!.updated_at = now;
    if (updatedBy !== undefined) state.updated_by = updatedBy || null;

    // 7. Exactly one atomic state write
    writeState(state, projectRoot, undefined, false);
    appendHistory({ event: 'batch_committed', topic: parsed.topic, operations: parsed.operations.map(o => o.type), by: updatedBy }, projectRoot);

    return { revision: state.revision ?? 0, operationsApplied: parsed.operations.length, topic: parsed.topic };
  });
}


function validateTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || Number.isNaN(Date.parse(value))) {
    throw new StateError(`${label} must be a valid date-time string`);
  }
  return value;
}

function validateNullableString(value: unknown, label: string): void {
  if (value !== null && typeof value !== 'string') {
    throw new StateError(`${label} must be a string or null`);
  }
}

function validateTask(data: unknown, label: string): Task {
  if (typeof data !== 'object' || data === null) {
    throw new StateError(`${label} must be a JSON object`);
  }
  const task = data as Record<string, unknown>;
  if (typeof task.id !== 'string' || !/^T[0-9]+$/.test(task.id)) {
    throw new StateError(`${label}.id must match T<number>`);
  }
  if (typeof task.title !== 'string') {
    throw new StateError(`${label}.title must be a string`);
  }
  if (!['pending', 'in_progress', 'blocked', 'done', 'skipped'].includes(task.status as string)) {
    throw new StateError(`Invalid task status in ${label}: ${task.status}`);
  }
  return data as Task;
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
  validateNullableString(topic.current_task, `${label}.current_task`);
  validateNullableString(topic.next_action, `${label}.next_action`);
  const tasks = topic.tasks.map((task, index) => validateTask(task, `${label}.tasks[${index}]`));
  const ids = tasks.map(task => task.id);
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
    current_task: legacy.current_task ?? null,
    tasks: legacy.tasks,
    decisions: legacy.decisions ?? [],
    blockers: legacy.blockers ?? [],
    next_action: legacy.next_action ?? null,
    created_at: legacy.created_at ?? legacy.updated_at,
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

function nextTaskId(tasks: Task[]): string {
  let maxId = 0n;
  for (const task of tasks) {
    const match = /^T([0-9]+)$/.exec(task.id);
    if (!match) continue;
    const value = BigInt(match[1]);
    if (value > maxId) maxId = value;
  }
  return `T${maxId + 1n}`;
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

  topic.tasks.push({
    id: nextTaskId(topic.tasks),
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

/** Hard character budget for the resume projection. The COMPLETE returned
 * string — including any global omission marker or truncation marker —
 * never exceeds this value. */
export const RESUME_BUDGET_CHARS = 1600;

/** Marker appended when the renderer had to truncate. */
export const RESUME_TRUNCATION_SUFFIX = "\n[…truncated, run `task-store status` for full details]";

// Global omission marker. Appended after a blank separator line when any
// section was collapsed, soft-capped, field-bounded, or dropped. The
// blank line is produced by `out.push('')` in the assembly, not by the
// marker itself. A reserved slice of the budget guarantees this line
// always fits.
const GLOBAL_OMISSION_MARKER = '[…details omitted, run `task-store status` for full details]';

// appendLines-style separation produces a blank line, so reserve two
// newlines as well as the marker itself.
const GLOBAL_RESERVED = GLOBAL_OMISSION_MARKER.length + 2;

const STATUS_POINT = "use \`task-store status\` for full details";

// Per-line bounds. Every emitted line is pre-truncated during assembly,
// so `fitResumeToBudget` only ever drops whole lines, never mid-line slices.
const MAX_TOPIC_CHARS = 50;
const MAX_GOAL_CHARS = 200;
const MAX_NEXT_ACTION_CHARS = 200;
const MAX_TITLE_CHARS = 80;
const MAX_NOTE_CHARS = 160;
const MAX_BLOCKER_CHARS = 160;
const MAX_DECISION_CHARS = 150;
const MAX_ATTEMPT_FIELD_CHARS = 100;
const SOFT_MAX_DONE = 5;
const SOFT_MAX_DECISIONS = 3;
const SOFT_MAX_ATTEMPTS = 2;

// Per-call stats object. Passed through every buildResumeContext call so
// the function is safe for concurrent / re-entrant use (no module-level
// mutable state that could bleed between concurrent calls).
interface RenderStats {
  fieldBounded: boolean;
}

function bound(s: string, max: number, stats: RenderStats): string {
  if (s.length <= max) return s;
  stats.fieldBounded = true;
  return s.slice(0, max - 1) + '…';
}

/** Enforce `result.length <= budget`. If the text already fits the budget
 * it is returned unchanged. Otherwise, the suffix is appended
 * at a complete-line boundary: find the last newline in the budget-allowable
 * prefix, truncate there, and append the suffix. If even the suffix alone
 * exceeds the budget (e.g. the budget was tightened below the suffix length),
 * the suffix is clamped to the budget and returned as-is.
 *
 * Postcondition: `result.length <= budget` always holds.
 * No partial line is ever emitted.
 */
export function fitResumeToBudget(text: string, budget = RESUME_BUDGET_CHARS): string {
  const safeBudget = Math.max(0, budget);
  if (text.length <= safeBudget) return text;
  // Clamp the suffix to the budget so maxPrefix is never negative.
  const safeSuffix = RESUME_TRUNCATION_SUFFIX.slice(0, safeBudget);
  const maxPrefix = safeBudget - safeSuffix.length;
  const lastNewline = text.slice(0, maxPrefix).lastIndexOf('\n');
  if (lastNewline > 0) {
    return text.slice(0, lastNewline) + safeSuffix;
  }
  return safeSuffix;
}

/**
 * Build a compact resume injection for session start.
 *
 * Output order, top to bottom. Priority is top-down so a budget-driven
 * tail-trim cannot remove a higher-priority field:
 *
 *   1. Header        — TOPIC, GOAL, STATUS (always shown, bounded per line)
 *   2. CURRENT       — in-progress task + last attempts (always shown)
 *   3. NEXT ACTION   — always shown, bounded
 *   4. BLOCKED       — with reason + last attempts (always shown)
 *   5. DONE          — optional, count summary if too long
 *   6. REMAINING     — optional, count summary if too long
 *   7. KEY DECISIONS — optional, count summary if too long
 *   8. Footer        — timestamp + hint (always shown)
 *
 * Every section that is not rendered in full is replaced with a one-line
 * marker naming the section, identifying the omitted content (count, and
 * task IDs for CURRENT/BLOCKED), and pointing at `task-store status`.
 * No omission is ever silent.
 *
 * Soft-capped sections (DONE/KEY DECISIONS with more items than the
 * soft cap) emit a `+N older — use \`task-store status\`` indicator
 * inside the section so the reader knows older items are present.
 * Attempts past the last 2 emit a `+N earlier attempts` line.
 *
 * Rendering uses a two-pass approach:
 *   • Pass 1 renders at full budget (1 600 chars) with no marker
 *     reservation. If no omission occurs, the result is returned
 *     immediately (no space is wasted on a marker that was not needed).
 *   • If any content is collapsed, soft-capped, field-bounded, or
 *     dropped, Pass 2 re-renders with an effective budget that reserves
 *     space for the global omission marker, and appends the marker.
 *
 * Token counts are approximate (no model-specific tokenizer). The
 * postcondition `result.length <= RESUME_BUDGET_CHARS` holds for the
 * COMPLETE returned string. This function is pure and safe for
 * concurrent / re-entrant calls (no module-level mutable state).
 */
export function buildResumeContext(state: TaskState): string {
  // Pure stats object — no module-level mutable state, so concurrent or
  // re-entrant calls cannot bleed into each other.
  const stats: RenderStats = { fieldBounded: false };

  const topic = getActiveTopic(state);
  const inProgress = topic.tasks.filter(t => t.status === 'in_progress');
  const blocked = topic.tasks.filter(t => t.status === 'blocked');
  const done = topic.tasks.filter(t => t.status === 'done');
  const remaining = topic.tasks.filter(t => t.status === 'pending');
  const decisions = topic.decisions ?? [];

  // Each section's lines are pre-bounded. Assembly picks the largest
  // form that fits; any non-full section gets an explicit marker.
  const sections: Section[] = [
    { label: 'header', lines: renderHeader(topic, stats) },
    { label: 'CURRENT', lines: renderCurrent(inProgress, stats),
      count: countWithIds('CURRENT', 'in-progress', inProgress) },
    { label: 'NEXT ACTION', lines: renderNextAction(topic, stats) },
    { label: 'BLOCKED', lines: renderBlocked(topic, blocked, stats),
      count: countWithIds('BLOCKED', 'blocked', blocked) },
    { label: 'DONE', lines: renderDone(done, stats),
      count: countOnly('DONE', 'completed', done.length) },
    { label: 'REMAINING', lines: renderRemaining(remaining, stats),
      count: countOnly('REMAINING', 'pending', remaining.length) },
    { label: 'KEY DECISIONS', lines: renderDecisions(decisions, stats),
      count: countOnly('KEY DECISIONS', 'recorded', decisions.length) },
    { label: 'footer', lines: renderFooter(state) },
  ];

  // ── Pass 1: full budget, no marker reservation ────────────────────────
  const out1: string[] = [];
  let droppedCount = 0;
  let collapsedCount = 0;
  let softCappedCount = 0;
  for (const section of sections) {
    const r = appendSection(out1, section, RESUME_BUDGET_CHARS);
    if (r.dropped) droppedCount++;
    if (r.collapsed) collapsedCount++;
    if (r.softCapped) softCappedCount++;
  }

  const anyOmission = stats.fieldBounded || droppedCount > 0 || collapsedCount > 0 || softCappedCount > 0;
  if (!anyOmission) {
    // No omission occurred. The complete pre-bounded render is within
    // 1 600 chars. Return it directly — no marker space was wasted.
    // Wrap in fitResumeToBudget as a last-resort hard bound; it returns
    // text unchanged when length <= budget so this is a zero-cost safety net.
    return fitResumeToBudget(out1.join('\n'));
  }

  // ── Pass 2: omission was needed — re-render with marker budget ───────
  // Sections may be dropped at a tighter effective budget. The `stats`
  // flags are deterministic (bound() is pure) so the result is consistent.
  const out2: string[] = [];
  droppedCount = 0;
  collapsedCount = 0;
  softCappedCount = 0;
  const effectiveBudget = RESUME_BUDGET_CHARS - GLOBAL_RESERVED;
  for (const section of sections) {
    const r = appendSection(out2, section, effectiveBudget);
    if (r.dropped) droppedCount++;
    if (r.collapsed) collapsedCount++;
    if (r.softCapped) softCappedCount++;
  }
  out2.push('');
  out2.push(GLOBAL_OMISSION_MARKER);
  // Wrap in fitResumeToBudget as a last-resort hard bound, even though
  // accounting guarantees the result is within budget.
  return fitResumeToBudget(out2.join('\n'));
}

interface Section {
  label: string;
  lines: string[];
  count?: string;
  omitted?: string;
}

interface AppendResult {
  dropped: boolean;
  collapsed: boolean;
  /** True if the section's rendering already includes a soft-cap indicator
   * (e.g. `+N older` for DONE). Tracked separately from `dropped` and
   * `collapsed` because it fires the global marker even when the full
   * form fits in the budget. */
  softCapped: boolean;
}

function appendSection(out: string[], section: Section, effectiveBudget: number): AppendResult {
  const omitted = `${section.label}: omitted — ${STATUS_POINT}`;
  const softCapped = section.lines.some(l => /^\s*\+\d+ (older|earlier)/.test(l));

  if (section.lines.length === 0) {
    return { dropped: false, collapsed: false, softCapped: false };
  }
  if (sectionFits(out, section.lines, effectiveBudget)) {
    appendLines(out, section.lines);
    return { dropped: false, collapsed: false, softCapped };
  }
  if (section.count && sectionFits(out, [section.count], effectiveBudget)) {
    appendLines(out, [section.count]);
    return { dropped: false, collapsed: true, softCapped: false };
  }
  if (sectionFits(out, [omitted], effectiveBudget)) {
    appendLines(out, [omitted]);
    return { dropped: false, collapsed: true, softCapped: false };
  }
  // Even the omitted line does not fit. The section is dropped.
  // The global omission marker is added at the end of the build.
  return { dropped: true, collapsed: false, softCapped: false };
}

// appendLines inserts an empty element, which renders as a blank line and
// therefore costs two newline characters between non-empty sections.
function sectionFits(out: string[], lines: string[], effectiveBudget: number): boolean {
  return joinLength(out) + joinLength(lines) + (out.length > 0 ? 2 : 0) <= effectiveBudget;
}

function appendLines(out: string[], lines: string[]): void {
  if (out.length > 0) out.push('');
  out.push(...lines);
}

function joinLength(lines: string[]): number {
  if (lines.length === 0) return 0;
  let n = 0;
  for (const l of lines) n += l.length;
  return n + (lines.length - 1);
}

function countOnly(label: string, kind: string, n: number): string {
  return `${label}: ${n} ${kind} — ${STATUS_POINT}`;
}

function countWithIds(label: string, kind: string, tasks: Task[]): string {
  return `${label}: ${tasks.length} ${kind} (${tasks.map(t => t.id).join(', ')}) — ${STATUS_POINT}`;
}

// ─── Section renderers. Each returns pre-bounded lines. ───────────────────

function renderHeader(topic: TopicState, stats: RenderStats): string[] {
  return [
    '╔══════════════════════════════════════╗',
    '║  TASK STORE — RESUME CONTEXT         ║',
    '╚══════════════════════════════════════╝',
    `TOPIC: ${bound(topic.name, MAX_TOPIC_CHARS, stats)}`,
    `GOAL: ${bound(topic.goal, MAX_GOAL_CHARS, stats)}`,
    `STATUS: ${topic.status.toUpperCase()}`,
  ];
}

function renderCurrent(inProgress: Task[], stats: RenderStats): string[] {
  if (inProgress.length === 0) return [];
  const lines = ['CURRENT:'];
  for (const t of inProgress) {
    lines.push(`  ▶ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
    if (t.notes) lines.push(`    NOTE: ${bound(t.notes, MAX_NOTE_CHARS, stats)}`);
    if (t.attempts && t.attempts.length > 0) {
      const recent = t.attempts.slice(-SOFT_MAX_ATTEMPTS);
      const earlier = t.attempts.length - SOFT_MAX_ATTEMPTS;
      if (earlier > 0) lines.push(`    +${earlier} earlier attempts`);
      for (const a of recent) {
        lines.push(`    ✗ tried: ${bound(a.description, MAX_ATTEMPT_FIELD_CHARS, stats)} → ${bound(a.outcome, MAX_ATTEMPT_FIELD_CHARS, stats)}`);
      }
    }
  }
  return lines;
}

function renderBlocked(topic: TopicState, blocked: Task[], stats: RenderStats): string[] {
  if (blocked.length === 0) return [];
  const lines = ['BLOCKED:'];
  for (const t of blocked) {
    // The blocker reason lives in topic.blockers (task.notes is preserved,
    // not overwritten, when a task is blocked) — look up the most recent
    // blocker entry for this task to render the reason.  Only include a
    // reason when one was explicitly recorded; do not echo the task title
    // as a self-referential "title: title" fallback.
    const blocker = (topic.blockers ?? []).slice().reverse().find(b => b.task_id === t.id);
    const explicitReason = blocker?.description ?? t.notes;
    if (explicitReason) {
      lines.push(`  ✗ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}: ${bound(explicitReason, MAX_BLOCKER_CHARS, stats)}`);
    } else {
      lines.push(`  ✗ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
    }
    if (t.attempts && t.attempts.length > 0) {
      const recent = t.attempts.slice(-SOFT_MAX_ATTEMPTS);
      const earlier = t.attempts.length - SOFT_MAX_ATTEMPTS;
      if (earlier > 0) lines.push(`    +${earlier} earlier attempts`);
      for (const a of recent) {
        lines.push(`    ✗ tried: ${bound(a.description, MAX_ATTEMPT_FIELD_CHARS, stats)} → ${bound(a.outcome, MAX_ATTEMPT_FIELD_CHARS, stats)}`);
      }
    }
  }
  return lines;
}

function renderNextAction(topic: TopicState, stats: RenderStats): string[] {
  return [`NEXT ACTION: ${bound(topic.next_action ?? '(not set — run /task-status)', MAX_NEXT_ACTION_CHARS, stats)}`];
}

function renderDone(done: Task[], stats: RenderStats): string[] {
  if (done.length === 0) return [];
  const recent = done.slice(-SOFT_MAX_DONE);
  const older = done.length - SOFT_MAX_DONE;
  const lines: string[] = ['DONE:'];
  if (older > 0) lines.push(`  +${older} older — use \`task-store status\` to see all`);
  for (const t of recent) {
    lines.push(`  ✓ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
  }
  return lines;
}

function renderRemaining(remaining: Task[], stats: RenderStats): string[] {
  if (remaining.length === 0) return [];
  return ['REMAINING:', ...remaining.map(t => `  ○ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`)];
}

function renderDecisions(decisions: Decision[], stats: RenderStats): string[] {
  if (decisions.length === 0) return [];
  const recent = decisions.slice(-SOFT_MAX_DECISIONS);
  const older = decisions.length - SOFT_MAX_DECISIONS;
  const lines: string[] = ['KEY DECISIONS:'];
  if (older > 0) lines.push(`  +${older} earlier — use \`task-store status\` to see all`);
  for (const d of recent) {
    lines.push(`  • ${bound(d.summary, MAX_DECISION_CHARS, stats)}`);
  }
  return lines;
}

function renderFooter(state: TaskState): string[] {
  return [
    `Updated: ${state.updated_at.slice(0, 16).replace('T', ' ')} UTC`,
    '─── /task-status for details | /task-history for audit ───',
  ];
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
