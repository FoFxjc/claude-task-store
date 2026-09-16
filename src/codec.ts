/**
 * State codec: validation and the schema-v1 read-only migration boundary.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * The codec owns the on-disk → in-memory translation contract:
 *
 *   - Supported on-disk readers: schema v1 and v2.
 *   - Canonical in-memory representation: the v2 {@link TaskState}.
 *   - Read-only access to v1 must not rewrite or dirty `state.json`.
 *   - The first normal mutation persists the v2 schema (writer's job; not
 *     this codec's job; see the migration section in DESIGN.md).
 *   - Semantic fields are preserved across migration.
 *   - Unknown future schema versions fail closed.
 *
 * This module is pure: it does not read or write files. Callers (storage,
 * repair) decide when to invoke `validateState` and how to handle the
 * returned canonical state.
 */
import {
  DEFAULT_TOPIC,
  SCHEMA_VERSION,
  type LegacyTaskStateV1,
  type Task,
  type TaskState,
  type TopicState,
} from './types.js';

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

/**
 * Validate an arbitrary value as a canonical {@link TaskState}.
 *
 * Recognises schema v1 read-only and migrates it in memory to a canonical
 * v2 representation. The migration is in-memory only: persistence is the
 * writer's responsibility, and v1 must remain byte-for-byte unmodified
 * after a read-only command (see {@link tests/multi_topic_test.sh}).
 *
 * Throws {@link StateError} on malformed input or unknown future schemas.
 */
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

/**
 * Resolve the active topic from a validated state.
 *
 * Throws {@link StateError} when `state.active_topic` does not name a topic
 * in `state.topics`. Callers are expected to pass a state that already
 * passed through {@link validateState}; the invariant is the same one
 * encoded there.
 */
export function getActiveTopic(state: TaskState): TopicState {
  const topic = state.topics.find(candidate => candidate.name === state.active_topic);
  if (!topic) throw new StateError(`Active topic not found: ${state.active_topic}`);
  return topic;
}
