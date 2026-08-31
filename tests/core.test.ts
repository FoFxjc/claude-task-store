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
    expect(state.tasks.map(t => t.id)).toEqual(['T1', 'T2', 'T3']);
  });

  it('sets all tasks to pending initially', () => {
    const state = initState('Goal', ['T A', 'T B'], root);
    expect(state.tasks.every(t => t.status === 'pending')).toBe(true);
  });

  it('sets next_action to start first task', () => {
    const state = initState('Goal', ['First task'], root);
    expect(state.next_action).toContain('T1');
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
    expect(state.tasks[0].status).toBe('in_progress');
    expect(state.current_task).toBe('T1');
  });

  it('requires evidence to complete', () => {
    startTask('T1', root);
    expect(() => completeTask('T1', [], undefined, root)).toThrow(StateError);
  });

  it('marks task done with evidence', () => {
    startTask('T1', root);
    const state = completeTask('T1', ['src/foo.ts', 'tests pass'], undefined, root);
    expect(state.tasks[0].status).toBe('done');
    expect(state.tasks[0].evidence).toContain('src/foo.ts');
  });

  it('auto-advances current_task to next pending', () => {
    startTask('T1', root);
    const state = completeTask('T1', ['evidence'], undefined, root);
    expect(state.current_task).toBe('T2');
  });

  it('sets status to completed when all tasks done', () => {
    startTask('T1', root);
    completeTask('T1', ['e1'], undefined, root);
    startTask('T2', root);
    const state = completeTask('T2', ['e2'], undefined, root);
    expect(state.status).toBe('completed');
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
    expect(state.tasks[0].status).toBe('blocked');
    expect(state.status).toBe('blocked');
    expect(state.blockers?.length).toBeGreaterThan(0);
  });

  it('records blocker reason', () => {
    blockTask('T1', 'API is broken', root);
    const state = readState(root)!;
    expect(state.blockers?.[0].description).toBe('API is broken');
  });

  it('can resume a blocked task', () => {
    blockTask('T1', 'reason', root);
    const state = resumeTask('T1', root);
    expect(state.tasks[0].status).toBe('in_progress');
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
    const newTask = state.tasks[state.tasks.length - 1];
    expect(newTask.id).toBe('T3');
    expect(newTask.title).toBe('New task');
  });

  it('does not create duplicate IDs after add', () => {
    addTask('T3', undefined, root);
    const state = addTask('T4', undefined, root);
    const ids = state.tasks.map(t => t.id);
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
    expect(state.tasks[0].attempts).toHaveLength(1);
    expect(state.tasks[0].attempts?.[0].description).toBe('used inline mock');
    expect(state.tasks[0].attempts?.[0].outcome).toBe('too slow');
  });

  it('accumulates multiple attempts', () => {
    recordAttempt('T1', 'approach A', 'failed', root);
    recordAttempt('T1', 'approach B', 'also failed', root);
    const state = readState(root)!;
    expect(state.tasks[0].attempts).toHaveLength(2);
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
    const t2 = state.tasks.find(t => t.id === 'T2')!;
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
    expect(recovered?.goal).toBe('Goal');
  });
});
