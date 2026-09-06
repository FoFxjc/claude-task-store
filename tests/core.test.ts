/**
 * Tests for claude-task-store core library
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  initState,
  readState,
  writeState,
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
  fitResumeToBudget,
  RESUME_BUDGET_CHARS,
  RESUME_TRUNCATION_SUFFIX,
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
    // 800 tokens * 4 chars/token = 3200 chars — the documented hard cap.
    // The renderer now enforces a tighter 400-token cap (RESUME_BUDGET_CHARS),
    // so this assertion is strictly weaker than the budget and merely
    // documents the documented hard cap.
    expect(ctx.length).toBeLessThan(3200);
  });

  it('stays within the hard 400-token budget (RESUME_BUDGET_CHARS) for typical input', () => {
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    // 3 tasks, typical notes — should fit comfortably under the budget.
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    // And not be truncated either, since typical input is well under budget.
    expect(ctx).not.toContain('…truncated');
  });

  it('enforces the hard budget deterministically on the small fixture', () => {
    // Pin the exact length of the small fixture so a future change to the
    // renderer is forced to think about whether the new shape is also small
    // enough to keep the typical-input experience untruncated.
    const state = readState(root)!;
    const ctx = buildResumeContext(state);
    // The exact value is not asserted (it would couple the test to the
    // renderer's exact line counts); we only assert the postcondition.
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
  });
});

// ─── GitHub issue #14: hard character budget in the canonical resume renderer
//
// Prior to the fix, buildResumeContext had soft per-section caps (e.g. last
// 5 done tasks, last 2 attempts) but no hard character budget, so a state
// with many long tasks, huge notes, or dozens of pending entries could blow
// past the documented <400-token target. The OpenCode adapter applied a
// separate 1600-char cap as a backstop, but that was a host-specific
// projection — Claude Code did not get the same cap.
//
// These tests cover the fix from a renderer's-eye view: the budget is
// enforced in the canonical renderer (so both hosts get identical output),
// priority order is preserved, lower-priority sections are collapsed to
// counts, truncation happens at line boundaries, and critical fields stay
// visible.

// GitHub issue #14: hard character budget in the canonical resume renderer.
// Priority order, per-line bounds, explicit omission markers, no mid-line
// truncation, and a global omission marker whenever anything is dropped,
// collapsed, soft-capped, or field-bounded.

describe('buildResumeContext — hard character budget (issue #14)', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('exports RESUME_BUDGET_CHARS = 1600 (the documented <400-token target)', () => {
    expect(RESUME_BUDGET_CHARS).toBe(1600);
  });

  it('exports a suffix that mentions `task-store status`', () => {
    expect(RESUME_TRUNCATION_SUFFIX).toContain('…truncated');
    expect(RESUME_TRUNCATION_SUFFIX).toContain('task-store status');
  });

  it('priority order: header → CURRENT → NEXT ACTION → BLOCKED → DONE → REMAINING → DECISIONS → footer', () => {
    initState('Ship the parser', ['Lexer', 'Parser', 'Tests', 'Deploy'], root);
    startTask('T1', root);
    recordAttempt('T1', 'use regex', 'too slow', root);
    completeTask('T1', ['src/lexer.ts'], undefined, root);
    startTask('T2', root);
    recordAttempt('T2', 'in-memory', 'no nested expr', root);
    startTask('T3', root);
    recordAttempt('T3', 'external', 'unavailable in CI', root);
    blockTask('T3', 'grammar format unclear', root);
    setNextAction('clarify grammar with team', root);
    recordDecision('use PEG', 'top-down is easier to read', root);

    const ctx = buildResumeContext(readState(root)!);
    const at = (needle: string) => ctx.indexOf(needle);
    expect(at('TOPIC:')).toBeGreaterThanOrEqual(0);
    expect(at('CURRENT:')).toBeGreaterThan(at('TOPIC:'));
    expect(at('NEXT ACTION:')).toBeGreaterThan(at('CURRENT:'));
    expect(at('BLOCKED:')).toBeGreaterThan(at('NEXT ACTION:'));
    expect(at('DONE:')).toBeGreaterThan(at('BLOCKED:'));
    expect(at('REMAINING:')).toBeGreaterThan(at('DONE:'));
    expect(at('KEY DECISIONS:')).toBeGreaterThan(at('REMAINING:'));
    expect(at('─── /task-status')).toBeGreaterThan(at('KEY DECISIONS:'));
  });

  it('NEXT ACTION survives even when DONE / REMAINING / DECISIONS are dropped to keep the budget', () => {
    const titles = Array.from({ length: 400 }, (_, i) => `Task ${i + 1} with a description that has a moderate amount of detail`);
    initState('Mega', titles, root);
    for (let i = 1; i <= 200; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, [`src/m${i}.ts`], undefined, root);
    }
    setNextAction('NEXT ACTION MUST SURVIVE', root);
    for (let i = 0; i < 30; i++) recordDecision(`Decision ${i + 1}`, `r${i + 1}`, root);

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    expect(ctx).toContain('NEXT ACTION MUST SURVIVE');
  });

  it('TOPIC is bounded for adversarial topic names (1000 chars) — header labels still visible', () => {
    initState('G', ['T1'], root);
    // Override the topic name with a 1000-char adversarial string.
    const state = readState(root)!;
    state.topics[0].name = 'X'.repeat(1000);
    state.active_topic = state.topics[0].name; // active_topic must still resolve
    writeState(state, root);

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    // TOPIC, GOAL, and STATUS labels are all still present.
    expect(ctx).toContain('TOPIC:');
    expect(ctx).toContain('GOAL:');
    expect(ctx).toContain('STATUS:');
    // The TOPIC line itself is bounded (no raw 1000-char prefix).
    const topicLine = ctx.split('\n').find(l => l.startsWith('TOPIC:'))!;
    expect(topicLine.length).toBeLessThanOrEqual(60);
  });

  it('huge CURRENT note + huge BLOCKED reason + huge NEXT ACTION all keep their labels and task IDs', () => {
    const note = 'n'.repeat(5000);
    const blocker = 'b'.repeat(5000);
    const next = 'a'.repeat(5000);
    const goal = 'G'.repeat(1000);
    initState(goal, ['In progress', 'Blocked', 'Pending'], root);
    startTask('T1', root);
    const s = readState(root)!;
    getActiveTopic(s).tasks[0].notes = note;
    writeState(s, root);
    startTask('T2', root);
    blockTask('T2', blocker, root);
    setNextAction(next, root);

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    expect(ctx).toContain('TOPIC:');
    expect(ctx).toContain('GOAL:');
    expect(ctx).toContain('CURRENT:');
    expect(ctx).toContain('[T1]');
    expect(ctx).toContain('BLOCKED:');
    expect(ctx).toContain('[T2]');
    expect(ctx).toContain('NEXT ACTION:');
    // No line is a raw prefix cut.
    for (const line of ctx.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(260);
    }
  });

  it('every emitted line is either bounded or a complete omission marker — no raw prefix cuts', () => {
    const longTitle = (i: number) => `Step ${i + 1}: implement sub-feature ${i + 1} with comprehensive validation, including schema migration, backwards compatibility, performance regression checks, and exhaustive end-to-end tests across all supported environments and platforms, plus documentation, accessibility, internationalisation, observability, and graceful degradation under failure modes`;
    const titles = Array.from({ length: 130 }, (_, i) =>
      i < 50 ? longTitle(i) : `Pending task ${i + 1} with a moderate description and details`,
    );
    initState('Bulk', titles, root);
    for (let i = 1; i <= 50; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, [`src/step${i}.ts`], undefined, root);
    }
    setNextAction('Move on', root);
    for (let i = 0; i < 30; i++) {
      recordDecision(`Decision ${i + 1} about the design with extensive rationale text covering every aspect of the trade-off in detail and explaining the long-term consequences of this choice for the project as a whole and the team`, `r${i + 1}`, root);
    }

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    for (const line of ctx.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(260);
    }
  });

  it('DONE soft-cap emits a `+N older` indicator when not all done tasks fit in detail', () => {
    const titles = Array.from({ length: 20 }, (_, i) => `Task ${i + 1}`);
    initState('Goal', titles, root);
    for (let i = 1; i <= 20; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, ['e'], undefined, root);
    }
    const ctx = buildResumeContext(readState(root)!);
    // 20 done, only last 5 in detail, so +15 older.
    expect(ctx).toMatch(/\+15 older/);
  });

  it('KEY DECISIONS soft-cap emits a `+N earlier` indicator when not all decisions fit in detail', () => {
    initState('Goal', ['T1'], root);
    for (let i = 0; i < 20; i++) recordDecision(`Decision ${i + 1}`, 'r', root);
    const ctx = buildResumeContext(readState(root)!);
    // 20 decisions, only last 3 in detail, so +17 earlier.
    expect(ctx).toMatch(/\+17 earlier/);
  });

  it('attempts soft-cap emits a `+N earlier attempts` indicator when more than the last 2 exist', () => {
    initState('Goal', ['T1'], root);
    startTask('T1', root);
    for (let i = 0; i < 5; i++) recordAttempt('T1', `attempt ${i + 1}`, 'failed', root);
    const ctx = buildResumeContext(readState(root)!);
    // 5 attempts, only last 2 in detail, so +3 earlier attempts.
    expect(ctx).toMatch(/\+3 earlier attempts/);
  });

  it('soft-capped sections trigger the global omission marker', () => {
    // 20 decisions: only last 3 in detail, +17 earlier. The soft cap
    // is internal to the section, so the section's `lines` form still
    // fits in the budget — the global marker fires because of the
    // soft-cap, even though no full/collapsed/dropped transition
    // happened.
    initState('Goal', ['T1'], root);
    for (let i = 0; i < 20; i++) recordDecision(`D${i + 1}`, 'r', root);
    const ctx = buildResumeContext(readState(root)!);
    expect(ctx).toMatch(/\+17 earlier/);
    expect(ctx).toContain('details omitted');
  });

  it('field-bounded content triggers the global omission marker', () => {
    initState('A goal that is far too long for the budget and must be bounded to MAX_GOAL_CHARS at construction time so the resulting line is a short bounded summary rather than a 1000-char raw prefix cut, with extensive additional detail to push it well past the maximum allowed goal length of 200 characters', ['T1'], root);
    const ctx = buildResumeContext(readState(root)!);
    // Field was bounded (goal exceeded MAX_GOAL_CHARS), so the global
    // marker is appended.
    expect(ctx).toContain('details omitted');
  });

  it('global omission marker is present when a low-priority section is dropped', () => {
    // Construct a state where critical content consumes most of the
    // effective budget, leaving no room for a low-priority section
    // even in its omitted-line form. With 3 in_progress tasks each
    // carrying a 200-char note (bounded to 160) and 3 blocked tasks
    // each carrying a 200-char reason (also bounded to 160), the
    // critical content alone is over 1 200 chars. After the header,
    // NEXT ACTION, and footer are added, the remaining effective
    // budget cannot fit even REMAINING's omitted-line form, so
    // REMAINING is dropped and the global omission marker is added.
    const titles = Array.from({ length: 13 }, (_, i) => `Task ${i + 1} with a moderate description`);
    initState('G', titles, root);
    for (let i = 1; i <= 3; i++) {
      startTask(`T${i}`, root);
      const s = readState(root)!;
      getActiveTopic(s).tasks[i - 1].notes = 'n'.repeat(200);
      writeState(s, root);
    }
    for (let i = 4; i <= 6; i++) {
      startTask(`T${i}`, root);
      blockTask(`T${i}`, 'b'.repeat(200), root);
    }
    for (let i = 7; i <= 11; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, ['e'], undefined, root);
    }
    setNextAction('next', root);

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    // The global marker is present, even when a section is dropped.
    expect(ctx).toContain('details omitted');
  });

  it('a dropped section is replaced by the global omission marker (no silent drops)', () => {
    // Same scenario as above, but verify that REMAINING specifically
    // is missing from the output (it was dropped, not collapsed).
    const titles = Array.from({ length: 13 }, (_, i) => `Task ${i + 1} with a moderate description`);
    initState('G', titles, root);
    for (let i = 1; i <= 3; i++) {
      startTask(`T${i}`, root);
      const s = readState(root)!;
      getActiveTopic(s).tasks[i - 1].notes = 'n'.repeat(200);
      writeState(s, root);
    }
    for (let i = 4; i <= 6; i++) {
      startTask(`T${i}`, root);
      blockTask(`T${i}`, 'b'.repeat(200), root);
    }
    for (let i = 7; i <= 11; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, ['e'], undefined, root);
    }
    setNextAction('next', root);

    const ctx = buildResumeContext(readState(root)!);
    // REMAINING was dropped (it would not fit even in its omitted
    // form, given the budget pressure from CURRENT + BLOCKED).
    expect(ctx).not.toMatch(/^REMAINING:/m);
    expect(ctx).not.toMatch(/REMAINING: \d+ pending/m);
    // The global marker is the only indicator that REMAINING existed.
    expect(ctx).toContain('details omitted');
  });

  it('buildResumeContext is pure: no module-level state leaks between calls', () => {
    // Verify that re-entrant or back-to-back calls do not contaminate
    // each other. A large state triggers field-bounded content and a
    // global marker. A subsequent call on a small state must not
    // carry over the field-bounded flag or omission state.
    initState('Goal', ['T1', 'T2'], root);
    startTask('T1', root);
    let s = readState(root)!;
    getActiveTopic(s).tasks[0].notes = 'n'.repeat(200); // triggers field bound
    writeState(s, root);
    const ctx1 = buildResumeContext(readState(root)!);
    expect(ctx1).toContain('NOTE:');
    expect(ctx1).toContain('details omitted');

    rmSync(join(root, '.claude-task'), { recursive: true, force: true });
    initState('Small', ['X'], root);
    const ctx2 = buildResumeContext(readState(root)!);
    expect(ctx2).not.toContain('details omitted');
    expect(ctx2).toContain('TOPIC: default');
    expect(ctx2).toContain('GOAL: Small');
  });

  it('collapsed DONE points at `task-store status` and preserves the count', () => {
    const longTitle = (i: number) => `Step ${i + 1}: implement sub-feature ${i + 1} with comprehensive validation, including schema migration, backwards compatibility, performance regression checks, and exhaustive end-to-end tests across all supported environments and platforms, plus documentation, accessibility, internationalisation, observability, and graceful degradation under failure modes`;
    const titles = Array.from({ length: 50 }, (_, i) => longTitle(i));
    const inProgressTitles = Array.from({ length: 5 }, (_, i) => `In-progress task ${i + 1} with a moderate description and a note`);
    initState('Bulk', [...inProgressTitles, ...titles], root);
    for (let i = 1; i <= 5; i++) {
      startTask(`T${i}`, root);
      const state = readState(root)!;
      getActiveTopic(state).tasks[i - 1].notes = 'n'.repeat(200);
      writeState(state, root);
    }
    for (let i = 6; i <= 55; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, [`src/step${i}.ts`], undefined, root);
    }
    setNextAction('Move on to the next phase of the work', root);
    const ctx = buildResumeContext(readState(root)!);
    expect(ctx).toMatch(/DONE: 50 completed — use `task-store status` for full details/);
  });

  it('collapsed REMAINING preserves the count', () => {
    const titles = Array.from({ length: 80 }, (_, i) => `Pending task number ${i + 1} with a moderately descriptive title that explains the work to be done in a reasonable amount of detail so the budget is exceeded for sure`);
    initState('Backlog', titles, root);
    setNextAction('Pick up the next open item', root);
    const ctx = buildResumeContext(readState(root)!);
    expect(ctx).toMatch(/REMAINING: 80 pending/);
  });

  it('collapsed KEY DECISIONS preserves the count', () => {
    const inProgressTitles = Array.from({ length: 5 }, (_, i) => `In-progress task ${i + 1} with a moderate description`);
    initState('Big arch', inProgressTitles, root);
    for (let i = 1; i <= 5; i++) {
      startTask(`T${i}`, root);
      const state = readState(root)!;
      getActiveTopic(state).tasks[i - 1].notes = 'n'.repeat(200);
      writeState(state, root);
    }
    for (let i = 0; i < 30; i++) {
      const summary = `Decision ${i + 1}: pick option ${i + 1} for the design with extensive rationale text covering every aspect of the trade-off in detail and explaining the long-term consequences of this choice for the project as a whole and the team and the customer and the future maintainers and the security review board and the on-call rotation and the deprecation policy owners and the long-term roadmap and the migration window and the customer support burden during the transition and the documentation effort and the training cost for new team members joining the project mid-stream during the planned migration window`;
      recordDecision(summary, `r${i + 1}`, root);
    }
    setNextAction('Move on', root);
    const ctx = buildResumeContext(readState(root)!);
    expect(ctx).toMatch(/KEY DECISIONS: 30 recorded/);
  });

  it('omitted sections still surface an explicit marker, never silent drops', () => {
    const titles = Array.from({ length: 300 }, (_, i) => `Task ${i + 1} with a description that has a moderate amount of detail`);
    initState('Mega', titles, root);
    for (let i = 1; i <= 100; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, [`src/m${i}.ts`], undefined, root);
    }
    for (let i = 0; i < 30; i++) recordDecision(`Decision ${i + 1}`, `r${i + 1}`, root);
    setNextAction('Move on', root);

    const ctx = buildResumeContext(readState(root)!);
    expect(ctx).toContain('DONE');
    expect(ctx).toContain('REMAINING');
    expect(ctx).toContain('KEY DECISIONS');
    expect(ctx).toContain('task-store status');
  });

  it('CURRENT count summary preserves task IDs (identity, not just count)', () => {
    const titles = Array.from({ length: 20 }, (_, i) => `In-progress task ${i + 1} with a moderate description`);
    initState('Many in progress', titles, root);
    for (let i = 1; i <= 20; i++) {
      startTask(`T${i}`, root);
      const state = readState(root)!;
      getActiveTopic(state).tasks[i - 1].notes = 'n'.repeat(500);
      writeState(state, root);
    }
    setNextAction('Pick up the next one', root);
    const ctx = buildResumeContext(readState(root)!);
    const m = ctx.match(/CURRENT: 20 in-progress \(([^)]+)\)/);
    expect(m).not.toBeNull();
    const ids = m![1].split(',').map(s => s.trim()).sort();
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `T${i + 1}`).sort());
  });

  it('the COMPLETE result (including any suffix) is within the budget', () => {
    const titles = Array.from({ length: 500 }, (_, i) => `Task ${i + 1} with a description`);
    initState('Massive', titles, root);
    for (let i = 1; i <= 200; i++) {
      startTask(`T${i}`, root);
      completeTask(`T${i}`, [`src/m${i}.ts`], undefined, root);
    }
    setNextAction('next', root);
    for (let i = 0; i < 50; i++) recordDecision(`Decision ${i + 1}`, `r${i + 1}`, root);
    const ctx = buildResumeContext(readState(root)!);
    expect(ctx.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
  });

  it('does not load a model-specific tokenizer dependency', () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    const all = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ];
    const tokenizerLike = all.filter(d =>
      /tokeniz|tiktoken|gpt-?tokenizer|hf-tokenizer|@huggingface\/tokenizers/i.test(d),
    );
    expect(tokenizerLike).toEqual([]);
  });
});

describe('fitResumeToBudget', () => {
  it('returns input at or below RESUME_BUDGET_CHARS unchanged', () => {
    expect(fitResumeToBudget('hello')).toBe('hello');
    expect(fitResumeToBudget('x'.repeat(RESUME_BUDGET_CHARS)).length).toBe(RESUME_BUDGET_CHARS);
  });

  it('postcondition: result.length <= RESUME_BUDGET_CHARS for any oversized input', () => {
    for (const size of [RESUME_BUDGET_CHARS + 1, RESUME_BUDGET_CHARS * 2, RESUME_BUDGET_CHARS * 10]) {
      const text = 'A'.repeat(size);
      const result = fitResumeToBudget(text);
      expect(result.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    }
  });

  it('truncates at the last complete line that fits, never mid-line', () => {
    const line1 = 'a'.repeat(50);
    const line2 = 'b'.repeat(50);
    const line3 = 'c'.repeat(RESUME_BUDGET_CHARS);
    const text = `${line1}\n${line2}\n${line3}`;
    const result = fitResumeToBudget(text);
    expect(result.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
    expect(result.endsWith(RESUME_TRUNCATION_SUFFIX)).toBe(true);
    const head = result.slice(0, result.length - RESUME_TRUNCATION_SUFFIX.length);
    expect(head.endsWith(line2) || head.endsWith(line1)).toBe(true);
    expect(result).not.toContain('cccc');
  });

  it('when no complete line fits, returns the suffix alone (no partial rendered line)', () => {
    const text = 'X'.repeat(RESUME_BUDGET_CHARS + 100);
    const result = fitResumeToBudget(text);
    expect(result).toBe(RESUME_TRUNCATION_SUFFIX);
    expect(result.length).toBeLessThanOrEqual(RESUME_BUDGET_CHARS);
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
