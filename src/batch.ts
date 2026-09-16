/**
 * Atomic batch commit + optimistic concurrency.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * This module owns the CLI command-shape primitives that turn a JSON
 * payload into exactly one canonical state mutation:
 *
 *   - `parseBatchInput` validates an arbitrary JSON value into a
 *     strongly-typed batch plan;
 *   - `applyBatch` mutates an in-memory {@link TaskState}, with no I/O;
 *   - `commitBatch` runs the whole plan read → parse → apply → write
 *     under a single O_EXCL lock, with exactly one revision increment
 *     and one history entry;
 *   - `compareAndWriteState` is the same compare-and-write primitive
 *     exposed for callers that already hold an in-memory state and
 *     want optimistic-concurrency protection (`--expect-rev`);
 *   - {@link ConflictError} is the failure shape thrown on revision
 *     mismatch.
 *
 * Transactional guarantee: if any step fails, `state.json` is never
 * touched. History appends happen inside the writer path that
 * `writeState` already performs — keep the lock around the read,
 * compare, mutate, write sequence.
 */
import { appendHistory, readState, writeState } from './storage.js';
import { StateError, validateState } from './codec.js';
import { withStoreLock } from './lock.js';
import { nextTaskId } from './core.js';
import type { TaskState } from './types.js';

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
 * Apply a single parsed operation to a named topic within an in-memory
 * TaskState. Pure: no file I/O.
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
 * Verifies topic existence, applies all operations in order, and
 * validates the final in-memory state. Throws {@link StateError} on
 * any failure. No file I/O.
 *
 * Returns the mutated in-memory state (same reference).
 */
export function applyBatch(
  state: TaskState,
  parsed: { topic: string; operations: BatchOperationInput[] },
): TaskState {
  if (!state.topics.some(t => t.name === parsed.topic)) {
    throw new StateError(`Topic not found: ${parsed.topic}`);
  }
  for (const op of parsed.operations) {
    applyOperation(state, parsed.topic, op);
  }
  validateState(state);
  return state;
}

/**
 * Atomically commit a batch of operations in a single state.json write.
 *
 * Steps (all under one O_EXCL lock):
 *  1. Read current state
 *  2. Parse and validate the entire batch
 *  3. Enforce expectRev if provided
 *  4. Verify the named topic exists
 *  5. Apply all operations in-memory to the named topic
 *  6. Validate final in-memory state
 *  7. Write state.json: exactly one atomic write, one revision
 *     increment, touchActiveTopic=false
 *  8. Append history entry
 *
 * If steps 1–6 fail, state.json is untouched.
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

export class ConflictError extends Error {
  public readonly currentRevision: number;
  constructor(message: string, currentRevision: number) {
    super(message);
    this.name = 'ConflictError';
    this.currentRevision = currentRevision;
  }
}

/**
 * Write state only if the current on-disk revision matches
 * `expectedRevision`. Throws {@link ConflictError} if another writer
 * has updated state since this snapshot was read.
 *
 * The read-compare-write cycle runs inside an O_EXCL lock (see
 * {@link withStoreLock}), so this is a real atomic compare-and-write
 * against other CLI-driven writers, not merely a best-effort check —
 * direct library callers that bypass {@link withStoreLock} are not
 * covered.
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
