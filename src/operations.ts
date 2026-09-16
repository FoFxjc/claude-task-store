/**
 * Task and topic state mutations.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * Each function in this module is the canonical CLI / library entry
 * point for one user-visible state transition — `initState`, `addTopic`,
 * `useTopic`, `startTask`, `completeTask`, `blockTask`, `resumeTask`,
 * `addTask`, `recordAttempt`, `recordDecision`, `setNextAction`,
 * `archiveState` — plus the internal `getTask` and `nextTaskId`
 * helpers that decide task-id uniqueness and look up tasks within a
 * topic.
 *
 * Each function follows the same shape: read in-memory state, validate
 * the preconditions, mutate, write back through {@link writeState},
 * optionally append a history event. Locking is the CLI's
 * responsibility (`./lock.ts#withStoreLock`); direct library callers
 * that skip locking are documented as bypassing concurrency
 * guarantees.
 */
import { appendHistory, readState, writeState } from './storage.js';
import { StateError, getActiveTopic } from './codec.js';
import { DEFAULT_TOPIC, SCHEMA_VERSION } from './types.js';
import type { Task, TaskState, TopicState } from './types.js';

/**
 * Resolve a task by ID within a topic, or throw.
 *
 * Used by every per-task mutation in this module.
 */
function getTask(topic: TopicState, taskId: string): Task {
  const task = topic.tasks.find(t => t.id === taskId);
  if (!task) throw new StateError(`Task ${taskId} not found`);
  return task;
}

/**
 * Allocate the next sequential task ID for a topic.
 *
 * Looks at existing IDs matching `T<number>` and returns `T<N+1>` for
 * one greater than the largest existing N. Exposed because the batch
 * apply path needs the same allocation rule; the on-disk schema and
 * all consumers agree on this single source of truth.
 */
export function nextTaskId(tasks: Task[]): string {
  let maxId = 0n;
  for (const task of tasks) {
    const match = /^T([0-9]+)$/.exec(task.id);
    if (!match) continue;
    const value = BigInt(match[1]);
    if (value > maxId) maxId = value;
  }
  return `T${maxId + 1n}`;
}

/**
 * Initialise a fresh single-topic task store.
 *
 * Rejects re-initialisation when a non-archived or multi-topic store
 * already exists. Seeds the canonical `default` topic with the supplied
 * goal and the supplied task titles.
 */
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

/**
 * Add a new topic to an existing store.
 *
 * Validates the goal is non-empty and the topic name is unique among
 * existing topics. The new topic is created in the `active` status
 * without switching the active selection.
 */
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

/**
 * Switch the active topic.
 *
 * Emits a `topic_selected` history event. Does not change the active
 * topic's `updated_at`.
 */
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

/**
 * Mark a task as in-progress.
 *
 * Records the start timestamp, sets the topic current task, and
 * surfaces the topic. Emits a non-fatal warning history event when
 * another task is already in progress.
 */
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

/**
 * Mark a task as done with required evidence.
 *
 * Records evidence, sets completion timestamp, advances topic.current_task
 * to the next pending task, and transitions the topic to `completed` when
 * no remaining tasks are open.
 */
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

  const allDone = topic.tasks.every(t => t.status === 'done' || t.status === 'skipped');
  if (allDone) {
    topic.status = 'completed';
    topic.next_action = 'All tasks completed. Consider archiving with `task-store archive`.';
  }

  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'task_completed', topic: topic.name, taskId, evidence }, projectRoot);
  return state;
}

/**
 * Mark a task as blocked.
 *
 * Preserves any existing task notes; the reason is recorded in
 * `topic.blockers` so the renderer can surface it without losing prior
 * task context.
 */
export function blockTask(taskId: string, reason: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  task.status = 'blocked';
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

/**
 * Mark a previously blocked task as in-progress.
 *
 * Clears this task's blocker entry. Sets the topic back to `active`
 * when no other blockers remain; stays `blocked` when they do.
 */
export function resumeTask(taskId: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  const task = getTask(topic, taskId);
  task.status = 'in_progress';
  topic.current_task = taskId;

  topic.blockers = (topic.blockers ?? []).filter(b => b.task_id !== taskId);
  topic.status = topic.blockers.length === 0 ? 'active' : 'blocked';

  writeState(state, projectRoot, updatedBy);
  return state;
}

/**
 * Add a new task to the active topic, with the next sequential task ID.
 */
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

/**
 * Append an attempt record to a task's history without changing its status.
 */
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

/**
 * Record a key decision against the active topic.
 */
export function recordDecision(summary: string, rationale?: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');
  const topic = getActiveTopic(state);

  topic.decisions = topic.decisions ?? [];
  topic.decisions.push({ summary, rationale: rationale ?? null, at: new Date().toISOString() });

  writeState(state, projectRoot, updatedBy);
  return state;
}

/**
 * Overwrite the active topic's `next_action` text.
 */
export function setNextAction(nextAction: string, projectRoot?: string, updatedBy?: string): TaskState {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  getActiveTopic(state).next_action = nextAction;
  writeState(state, projectRoot, updatedBy);
  return state;
}

/**
 * Mark the active topic as archived.
 *
 * Archived topics remain in `state.topics` but are excluded from active
 * decisions. The store is then eligible for re-initialisation.
 */
export function archiveState(projectRoot?: string, updatedBy?: string): void {
  const state = readState(projectRoot);
  if (!state) throw new StateError('No state found.');

  const topic = getActiveTopic(state);
  topic.status = 'archived';
  writeState(state, projectRoot, updatedBy);
  appendHistory({ event: 'archived', topic: topic.name, goal: topic.goal }, projectRoot);
}
