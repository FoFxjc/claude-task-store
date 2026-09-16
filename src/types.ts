/**
 * Canonical task-store state schema types.
 *
 * Extracted from `core.ts` as part of #25 (structural decomposition).
 * These types are the single source of truth for the in-memory state
 * shape. They do not depend on filesystem, lock, or codec internals.
 */

/** Current on-disk schema version. Persisted in `state.json` and re-emitted on first write. */
export const SCHEMA_VERSION = '2';

/** Name of the implicit topic created when a v1 state is migrated to v2. */
export const DEFAULT_TOPIC = 'default';

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

/**
 * Schema-v1 on-disk shape. The legacy state had no `version`-aware wrapper
 * beyond a top-level `version: '1'` and a single implicit topic. The codec
 * recognises this shape through `migrateV1State` and rewrites it to a
 * canonical {@link TaskState} on the first normal write, never on read.
 */
export interface LegacyTaskStateV1 extends Omit<TopicState, 'name'> {
  version: '1';
  revision?: number;
  updated_by?: string | null;
}
