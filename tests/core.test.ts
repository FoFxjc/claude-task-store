/**
 * Tests for claude-task-store core library
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  initState,
  readState,
  startTask,
  completeTask,
  blockTask,
  resumeTask,
  addTask,
  recordAttempt,
  recordDecision,
  setNextAction,
  archiveState,
  buildResumeContext,
  repairState,
  stateFilePath,
  historyFilePath,
  StateError,
  validateState,
  getActiveTopic,
  addTopic,
  useTopic,
} from '../src/core.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `task-store-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('initState', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('creates state.json and history.jsonl', () => {
    initState('Build feature X', ['Task A', 'Task B'], root);
    expect(existsSync(stateFilePath(root))).toBe(true);
    expect(existsSync(historyFilePath(root))).toBe(true);
  });

  it('creates tasks with sequential IDs', () => {
    const state = initState('Goal', ['T A', 'T B', 'T C'], root);
    expect(getActiveTopic(state).tasks.map(t => t.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('sets all tasks to pending initially', () => {
    const state = initState('Goal', ['T A', 'T B'], root);
    expect(getActiveTopic(state).tasks.every(t => t.status === 'pending')).toBe(true);
  });

  it('sets next_action to start first task', () => {
    const state = initState('Goal', ['First task'], root);
    expect(getActiveTopic(state).next_action).toContain('T1');
  });

  it('throws if active state already exists', () => {
    initState('Goal', ['T1'], root);
    expect(() => initState('Goal 2', ['T2'], root)).toThrow(StateError);
  });

  it('allows re-init after archive', () => {
    initState('Goal', ['T1'], root);
    archiveState(root);
    expect(() => initState('Goal 2', ['T2'], root)).not.toThrow();
  });
});

describe('startTask / completeTask', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Goal', ['T A', 'T B'], root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('marks task in_progress and sets current_task', () => {
    const state = startTask('T1', root);
    expect(getActiveTopic(state).tasks[0].status).toBe('in_progress');
    expect(getActiveTopic(state).current_task).toBe('T1');
  });

  it('requires evidence to complete', () => {
    startTask('T1', root);
    expect(() => completeTask('T1', [], undefined, root)).toThrow(StateError);
  });

  it('marks task done with evidence', () => {
    startTask('T1', root);
    const state = completeTask('T1', ['src/foo.ts', 'tests pass'], undefined, root);
    expect(getActiveTopic(state).tasks[0].status).toBe('done');
    expect(getActiveTopic(state).tasks[0].evidence).toContain('src/foo.ts');
  });

  it('auto-advances current_task to next pending', () => {
    startTask('T1', root);
    const state = completeTask('T1', ['evidence'], undefined, root);
    expect(getActiveTopic(state).current_task).toBe('T2');
  });

  it('sets status to completed when all tasks done', () => {
    startTask('T1', root);
    completeTask('T1', ['e1'], undefined, root);
    startTask('T2', root);
    const state = completeTask('T2', ['e2'], undefined, root);
    expect(getActiveTopic(state).status).toBe('completed');
  });

  it('throws for unknown task ID', () => {
    expect(() => startTask('T99', root)).toThrow(StateError);
  });
});

describe('blockTask / resumeTask', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Goal', ['T A'], root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('marks task and overall state blocked', () => {
    const state = blockTask('T1', 'External API down', root);
    expect(getActiveTopic(state).tasks[0].status).toBe('blocked');
    expect(getActiveTopic(state).status).toBe('blocked');
    expect(getActiveTopic(state).blockers?.length).toBeGreaterThan(0);
  });

  it('records blocker reason', () => {
    blockTask('T1', 'API is broken', root);
    const state = readState(root)!;
    expect(getActiveTopic(state).blockers?.[0].description).toBe('API is broken');
  });

  it('can resume a blocked task', () => {
    blockTask('T1', 'reason', root);
    const state = resumeTask('T1', root);
    expect(getActiveTopic(state).tasks[0].status).toBe('in_progress');
  });
});

describe('addTask', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Goal', ['T A', 'T B'], root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('assigns next sequential ID', () => {
    const state = addTask('New task', undefined, root);
    const topic = getActiveTopic(state);
    const newTask = topic.tasks[topic.tasks.length - 1];
    expect(newTask.id).toBe('T3');
    expect(newTask.title).toBe('New task');
  });

  it('does not create duplicate IDs after add', () => {
    addTask('T3', undefined, root);
    const state = addTask('T4', undefined, root);
    const ids = getActiveTopic(state).tasks.map(t => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('recordAttempt', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Goal', ['T A'], root);
    startTask('T1', root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('appends attempt to task', () => {
    const state = recordAttempt('T1', 'used inline mock', 'too slow', root);
    expect(getActiveTopic(state).tasks[0].attempts).toHaveLength(1);
    expect(getActiveTopic(state).tasks[0].attempts?.[0].description).toBe('used inline mock');
    expect(getActiveTopic(state).tasks[0].attempts?.[0].outcome).toBe('too slow');
  });

  it('accumulates multiple attempts', () => {
    recordAttempt('T1', 'approach A', 'failed', root);
    recordAttempt('T1', 'approach B', 'also failed', root);
    const state = readState(root)!;
    expect(getActiveTopic(state).tasks[0].attempts).toHaveLength(2);
  });
});

describe('topics', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Ship API', ['Implement endpoint'], root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('adds a topic without changing the active topic', () => {
    const state = addTopic('docs', 'Write the guide', ['Draft', 'Review'], root);
    expect(state.active_topic).toBe('default');
    expect(state.topics.map(topic => topic.name)).toEqual(['default', 'docs']);
    expect(state.topics[1].tasks.map(task => task.id)).toEqual(['T1', 'T2']);
  });

  it('rejects duplicate topic names', () => {
    addTopic('docs', 'Write the guide', [], root);
    expect(() => addTopic('docs', 'Another goal', [], root)).toThrow(StateError);
  });

  it('normalizes topic names before storing, matching, and duplicate checks', () => {
    const added = addTopic('  docs  ', 'Write the guide', [], root);
    expect(added.topics[1].name).toBe('docs');
    expect(() => addTopic('docs', 'Another goal', [], root)).toThrow('Topic already exists: docs');

    expect(useTopic('  docs  ', root).active_topic).toBe('docs');
    expect(() => useTopic('   ', root)).toThrow('Topic name must be a non-empty string');
  });

  it('switches topics while preserving independent execution checkpoints', () => {
    startTask('T1', root);
    recordAttempt('T1', 'direct integration', 'API unavailable', root);
    recordDecision('Keep retry logic local', 'Avoid a new dependency', root);
    setNextAction('Add a deterministic fixture', root);

    addTopic('docs', 'Write the guide', ['Draft guide'], root);
    useTopic('docs', root);
    startTask('T1', root);
    completeTask('T1', ['docs/guide.md'], undefined, root);

    const switchedBack = useTopic('default', root);
    const original = getActiveTopic(switchedBack);
    expect(original.current_task).toBe('T1');
    expect(original.tasks[0].attempts?.[0]).toMatchObject({
      description: 'direct integration',
      outcome: 'API unavailable',
    });
    expect(original.decisions?.[0].summary).toBe('Keep retry logic local');
    expect(original.next_action).toBe('Add a deterministic fixture');

    const docs = switchedBack.topics.find(topic => topic.name === 'docs')!;
    expect(docs.status).toBe('completed');
    expect(docs.tasks[0].evidence).toEqual(['docs/guide.md']);
  });

  it('renders only the active topic in resume context', () => {
    addTopic('docs', 'Write secret docs', ['Private draft'], root);
    const defaultResume = buildResumeContext(readState(root)!);
    expect(defaultResume).toContain('TOPIC: default');
    expect(defaultResume).toContain('Ship API');
    expect(defaultResume).not.toContain('Write secret docs');

    useTopic('docs', root);
    const docsResume = buildResumeContext(readState(root)!);
    expect(docsResume).toContain('TOPIC: docs');
    expect(docsResume).toContain('Write secret docs');
    expect(docsResume).not.toContain('Ship API');
  });
});

describe('buildResumeContext', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir();
    initState('Build the authentication system', ['Write models', 'Add routes', 'Write tests'], root);
    startTask('T1', root);
    completeTask('T1', ['src/models/user.ts'], undefined, root);
    startTask('T2', root);
    recordAttempt('T2', 'JWT with redis', 'session store too complex', root);
    blockTask('T2', 'JWT secret rotation policy unclear', root);
    setNextAction('Clarify JWT rotation with team, then implement', root);
    recordDecision('Use JWT over sessions', 'stateless is simpler', root);
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('includes goal', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    expect(ctx).toContain('Build the authentication system');
  });

  it('marks done tasks correctly', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    expect(ctx).toContain('✓');
    expect(ctx).toContain('Write models');
  });

  it('includes failed attempt for blocked tasks', () => {
    const state = readState(root)!;
    const t2 = getActiveTopic(state).tasks.find(t => t.id === 'T2')!;
    expect(t2.attempts).toHaveLength(1);
    expect(t2.attempts?.[0].description).toBe('JWT with redis');
    const ctx = buildResumeContext(state);
    expect(ctx).toContain('JWT secret rotation');
  });

  it('shows attempts in CURRENT section for in_progress tasks', () => {
    const testRoot = makeTmpDir();
    try {
      initState('Goal', ['Task A', 'Task B'], testRoot);
      startTask('T1', testRoot);
      recordAttempt('T1', 'redis approach', 'too slow latency', testRoot);
      const state = readState(testRoot)!;
      const ctx = buildResumeContext(state);
      expect(ctx).toContain('redis approach');
      expect(ctx).toContain('too slow latency');
    } finally {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it('includes next action', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    expect(ctx).toContain('Clarify JWT rotation');
  });

  it('includes key decision', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    expect(ctx).toContain('Use JWT over sessions');
  });

  it('stays under 800 tokens (3200 chars)', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    // 800 tokens * 4 chars/token = 3200 chars
    expect(ctx.length).toBeLessThan(3200);
  });

  it('normally stays under 400 tokens (1600 chars) for typical task counts', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    // 3 tasks, typical notes — should be well under 400 tokens
    expect(ctx.length).toBeLessThan(1600);
  });
});

describe('validateState', () => {
  it('rejects unknown schema version', () => {
    expect(() => validateState({ version: '99', goal: 'x', status: 'active', tasks: [], updated_at: '' }))
      .toThrow(StateError);
  });

  it('rejects empty goal', () => {
    expect(() => validateState({ version: '1', goal: '', status: 'active', tasks: [], updated_at: '' }))
      .toThrow(StateError);
  });

  it('rejects duplicate task IDs', () => {
    expect(() => validateState({
      version: '1', goal: 'x', status: 'active', tasks: [
        { id: 'T1', title: 'a', status: 'pending' },
        { id: 'T1', title: 'b', status: 'pending' },
      ], updated_at: '',
    })).toThrow(StateError);
  });

  it('migrates version 1 state into a default topic without losing checkpoint data', () => {
    const legacy = {
      version: '1',
      revision: 7,
      goal: 'Legacy goal',
      status: 'blocked',
      current_task: 'T1',
      tasks: [{
        id: 'T1', title: 'Legacy task', status: 'blocked', notes: 'keep me',
        evidence: ['proof'], attempts: [{ description: 'old way', outcome: 'failed' }],
        started_at: '2024-01-01T00:00:00.000Z', completed_at: null,
      }],
      decisions: [{ summary: 'Legacy decision', rationale: 'Legacy rationale' }],
      blockers: [{ description: 'Legacy blocker', task_id: 'T1' }],
      next_action: 'Legacy next action',
      created_at: '2024-01-01T00:00:00.000Z',
      updated_at: '2024-01-02T00:00:00.000Z',
      updated_by: 'legacy-agent',
    };

    const migrated = validateState(legacy);
    expect(migrated).toMatchObject({
      version: '2', revision: 7, active_topic: 'default',
      updated_at: legacy.updated_at, updated_by: 'legacy-agent',
    });
    expect(getActiveTopic(migrated)).toMatchObject({
      name: 'default', goal: legacy.goal, status: legacy.status,
      current_task: legacy.current_task, tasks: legacy.tasks,
      decisions: legacy.decisions, blockers: legacy.blockers,
      next_action: legacy.next_action, created_at: legacy.created_at,
      updated_at: legacy.updated_at,
    });
  });

  it('migrates schema-valid version 1 state when optional checkpoint fields are absent', () => {
    const updatedAt = '2024-01-02T00:00:00.000Z';
    const migrated = validateState({
      version: '1', goal: 'Minimal legacy goal', status: 'active', tasks: [], updated_at: updatedAt,
    });
    expect(getActiveTopic(migrated)).toMatchObject({
      current_task: null, decisions: [], blockers: [], next_action: null,
      created_at: updatedAt, updated_at: updatedAt,
    });
  });

  it('rejects malformed task entries with StateError instead of leaking TypeError', () => {
    const validationRoot = makeTmpDir();
    try {
      const state = initState('Goal', ['Task'], validationRoot);
      const malformed = {
        ...state,
        topics: [{ ...state.topics[0], tasks: [null] }],
      };
      expect(() => validateState(malformed)).toThrow(StateError);
      expect(() => validateState(malformed)).toThrow('State.topics[0].tasks[0] must be a JSON object');
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
  });

  it('rejects invalid current_task and next_action types', () => {
    const validationRoot = makeTmpDir();
    try {
      const state = initState('Goal', [], validationRoot);
      expect(() => validateState({
        ...state, topics: [{ ...state.topics[0], current_task: 1 }],
      })).toThrow('State.topics[0].current_task must be a string or null');
      expect(() => validateState({
        ...state, topics: [{ ...state.topics[0], next_action: {} }],
      })).toThrow('State.topics[0].next_action must be a string or null');
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
  });

  it('rejects version 1 state with a missing or invalid updated_at', () => {
    const legacy = {
      version: '1', goal: 'Legacy goal', status: 'active', current_task: null,
      tasks: [], decisions: [], blockers: [], next_action: null,
      created_at: '2024-01-01T00:00:00.000Z',
    };
    expect(() => validateState(legacy)).toThrow('Topic default.updated_at must be a valid date-time string');
    expect(() => validateState({ ...legacy, updated_at: 'not-a-date' }))
      .toThrow('Topic default.updated_at must be a valid date-time string');
  });

  it('rejects version 2 state with a missing or invalid root updated_at', () => {
    const validationRoot = makeTmpDir();
    try {
      const state = initState('Goal', [], validationRoot);
      const { updated_at: _updatedAt, ...missingTimestamp } = state;
      expect(() => validateState(missingTimestamp)).toThrow('State.updated_at must be a valid date-time string');
      expect(() => validateState({ ...state, updated_at: 'not-a-date' }))
        .toThrow('State.updated_at must be a valid date-time string');
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
  });

  it('rejects a missing active topic and duplicate topic names', () => {
    const validationRoot = makeTmpDir();
    try {
      const state = initState('Goal', [], validationRoot);
      const missing = { ...state, active_topic: 'missing' };
      expect(() => validateState(missing)).toThrow('Active topic not found');
      const duplicate = { ...state, topics: [...state.topics, { ...state.topics[0] }] };
      expect(() => validateState(duplicate)).toThrow('Duplicate topic names');
    } finally {
      rmSync(validationRoot, { recursive: true, force: true });
    }
  });
});

describe('repairState', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('recovers from corrupt state.json using history', () => {
    initState('Goal', ['T A'], root);
    // Corrupt the state file
    writeFileSync(stateFilePath(root), '{invalid json!!!', 'utf8');

    const recovered = repairState(root);
    expect(recovered).not.toBeNull();
    expect(recovered && getActiveTopic(recovered).goal).toBe('Goal');
  });
});
