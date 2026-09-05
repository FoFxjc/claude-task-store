/**
 * Tests for the provider-neutral auto-checkpoint core.
 *
 * These cover the decision logic in isolation — no hooks, no Claude Code, no
 * OpenCode. Everything an adapter can do goes through markDirty /
 * shouldReconcile / markReconciled, so if those three behave, every adapter
 * behaves.
 *
 * `shouldReconcile` takes an injectable `now`, which is what lets the debounce
 * be tested exactly rather than by sleeping.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import { initState, readState, completeTask, setNextAction } from '../src/core.js';
import {
  readConfig,
  writeMode,
  isEnabled,
  markDirty,
  shouldReconcile,
  markReconcileRequested,
  markReconciled,
  freshness,
  readRuntime,
  configFilePath,
  runtimeFilePath,
  debounceSeconds,
  DEFAULT_MODE,
  NEW_STORE_MODE,
  DEFAULT_DEBOUNCE_SECONDS,
  RECONCILE_INSTRUCTION,
} from '../src/autocheckpoint.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `task-store-autockpt-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A project with a task store and one in-progress task. */
function seed(root: string): void {
  initState('Ship the parser', ['Write lexer', 'Write parser'], root);
  setNextAction('Implement expression parsing', root);
}

function laterBy(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

describe('configuration', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('defaults to off with no config file present', () => {
    expect(existsSync(configFilePath(root))).toBe(false);
    expect(readConfig(root).auto_checkpoint).toBe('off');
    expect(DEFAULT_MODE).toBe('off');
    expect(isEnabled(root)).toBe(false);
  });

  it('keeps the new-store default separate from the legacy fallback', () => {
    expect(DEFAULT_MODE).toBe('off');
    expect(NEW_STORE_MODE).toBe('conservative');
  });

  it('enables and disables conservative mode', () => {
    expect(writeMode('conservative', root).auto_checkpoint).toBe('conservative');
    expect(isEnabled(root)).toBe(true);
    expect(writeMode('off', root).auto_checkpoint).toBe('off');
    expect(isEnabled(root)).toBe(false);
  });

  it('keeps configuration out of state.json', () => {
    writeMode('conservative', root);
    const raw = readFileSync(join(root, '.claude-task', 'state.json'), 'utf8');
    expect(raw).not.toContain('auto_checkpoint');
  });

  it('preserves unrelated keys already in config.json', () => {
    writeFileSync(configFilePath(root), JSON.stringify({ some_other_tool: { a: 1 } }));
    writeMode('conservative', root);
    const cfg = JSON.parse(readFileSync(configFilePath(root), 'utf8'));
    expect(cfg.some_other_tool).toEqual({ a: 1 });
    expect(cfg.auto_checkpoint).toBe('conservative');
  });

  it('fails closed on a corrupt config rather than enabling the feature', () => {
    writeFileSync(configFilePath(root), '{ this is not json');
    expect(readConfig(root).auto_checkpoint).toBe('off');
    expect(isEnabled(root)).toBe(false);
  });

  it('treats an unknown mode (e.g. a future "aggressive") as off', () => {
    writeFileSync(configFilePath(root), JSON.stringify({ auto_checkpoint: 'aggressive' }));
    expect(readConfig(root).auto_checkpoint).toBe('off');
  });

  it('uses the default debounce unless overridden', () => {
    expect(debounceSeconds(root)).toBe(DEFAULT_DEBOUNCE_SECONDS);
    writeFileSync(configFilePath(root), JSON.stringify({
      auto_checkpoint: 'conservative',
      auto_checkpoint_debounce_seconds: 30,
    }));
    expect(debounceSeconds(root)).toBe(30);
  });
});

describe('markDirty', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is a complete no-op while disabled', () => {
    expect(markDirty(root, 'Edit')).toBeNull();
    expect(existsSync(runtimeFilePath(root))).toBe(false);
  });

  it('records signals once enabled', () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit');
    markDirty(root, 'Bash');
    const runtime = readRuntime(root);
    expect(runtime.signal_count).toBe(2);
    expect(runtime.dirty_since).not.toBeNull();
    expect(runtime.last_signal_at).not.toBeNull();
  });

  it('keeps dirty_since anchored to the first signal of the window', async () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit');
    const first = readRuntime(root).dirty_since;
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    expect(readRuntime(root).dirty_since).toBe(first);
  });

  it('never mutates task state', () => {
    writeMode('conservative', root);
    const before = readState(root)!;
    for (let i = 0; i < 10; i++) markDirty(root, 'Edit');
    const after = readState(root)!;
    expect(after.revision).toBe(before.revision);
    expect(after.tasks.map(t => t.status)).toEqual(before.tasks.map(t => t.status));
    expect(after.next_action).toBe(before.next_action);
    expect(after.updated_at).toBe(before.updated_at);
  });

  it('does not create a task store as a side effect', () => {
    const empty = makeTmpDir();
    try {
      mkdirSync(join(empty, '.claude-task'), { recursive: true });
      writeMode('conservative', empty);
      expect(markDirty(empty, 'Edit')).toBeNull();
      expect(existsSync(runtimeFilePath(empty))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('does not persist tool names or arguments', () => {
    writeMode('conservative', root);
    markDirty(root, 'Bash: curl https://secrets.example/token');
    const raw = readFileSync(runtimeFilePath(root), 'utf8');
    expect(raw).not.toContain('secrets.example');
    expect(raw).not.toContain('Bash');
  });

  it('switching modes clears any stale dirty window', () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit');
    expect(existsSync(runtimeFilePath(root))).toBe(true);
    writeMode('off', root);
    expect(existsSync(runtimeFilePath(root))).toBe(false);
    writeMode('conservative', root);
    expect(shouldReconcile(root).reconcile).toBe(false);
  });
});

describe('freshness', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); writeMode('conservative', root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('reports clean before any activity', () => {
    expect(freshness(root).stale).toBe(false);
  });

  it('reports stale after activity with no checkpoint write', async () => {
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    const f = freshness(root);
    expect(f.stale).toBe(true);
    expect(f.signals).toBe(1);
  });

  it('clears when the agent writes through the normal CLI verbs', async () => {
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    expect(freshness(root).stale).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    // Any ordinary checkpoint write counts — no explicit "I reconciled" call.
    setNextAction('Implement the parser', root);
    expect(freshness(root).stale).toBe(false);
  });

  it('does not require git', () => {
    expect(existsSync(join(root, '.git'))).toBe(false);
    markDirty(root, 'Edit');
    expect(() => freshness(root)).not.toThrow();
  });
});

describe('shouldReconcile', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('never fires while disabled, however much activity happens', () => {
    for (let i = 0; i < 20; i++) markDirty(root, 'Edit');
    const d = shouldReconcile(root);
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('disabled');
  });

  it('does not fire on a clean store', () => {
    writeMode('conservative', root);
    expect(shouldReconcile(root).reason).toBe('clean');
  });

  it('fires once when the store is dirty', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    const d = shouldReconcile(root);
    expect(d.reconcile).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('does not fire again with no new work (gate 1)', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    markReconcileRequested(root);
    // Even far past the debounce window, nothing new has happened.
    const d = shouldReconcile(root, laterBy(86400));
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('already-requested');
  });

  it('does not fire again within the debounce window despite new work (gate 2)', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    markReconcileRequested(root);
    // Strictly after the request: timestamps are millisecond-resolution and a
    // signal landing in the same millisecond as the request is deliberately
    // NOT counted as new work (ties resolve toward asking less often).
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    const d = shouldReconcile(root, laterBy(DEFAULT_DEBOUNCE_SECONDS - 1));
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('debounced');
  });

  it('fires again once BOTH new work and the debounce window are satisfied', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    markReconcileRequested(root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    const d = shouldReconcile(root, laterBy(DEFAULT_DEBOUNCE_SECONDS + 1));
    expect(d.reconcile).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('a burst of activity yields exactly one request', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    let fired = 0;
    for (let i = 0; i < 50; i++) {
      markDirty(root, 'Edit');
      // Simulate a boundary after every single tool call.
      if (shouldReconcile(root).reconcile) {
        fired++;
        markReconcileRequested(root);
      }
    }
    expect(fired).toBe(1);
  });

  it('treats a signal in the same millisecond as the request as not-new', () => {
    writeMode('conservative', root);
    // Constructed on disk rather than raced against the wall clock: the two
    // timestamps must be exactly equal, which back-to-back calls only
    // achieve by luck. Ties resolve toward asking less often.
    const updatedAt = new Date(readState(root)!.updated_at).getTime();
    const tie = new Date(updatedAt + 1000).toISOString();
    writeFileSync(runtimeFilePath(root), JSON.stringify({
      dirty_since: tie,
      last_signal_at: tie,
      signal_count: 1,
      last_reconcile_request_at: tie,
      last_reconcile_at: null,
    }));
    expect(freshness(root).stale).toBe(true);
    expect(shouldReconcile(root, laterBy(86400)).reason).toBe('already-requested');
  });

  it('does not fire when the project has no task store', () => {
    const empty = makeTmpDir();
    try {
      mkdirSync(join(empty, '.claude-task'), { recursive: true });
      writeMode('conservative', empty);
      expect(shouldReconcile(empty).reason).toBe('no-state');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('is pure: asking does not change the answer', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    const a = shouldReconcile(root);
    const b = shouldReconcile(root);
    const c = shouldReconcile(root);
    expect([a.reconcile, b.reconcile, c.reconcile]).toEqual([true, true, true]);
  });
});

describe('markReconciled', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); writeMode('conservative', root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clears the dirty window and records the time', async () => {
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit');
    markReconciled(root);
    const runtime = readRuntime(root);
    expect(runtime.dirty_since).toBeNull();
    expect(runtime.signal_count).toBe(0);
    expect(runtime.last_reconcile_at).not.toBeNull();
    expect(shouldReconcile(root).reason).toBe('clean');
  });

  it('does not complete tasks or set next_action', async () => {
    await new Promise(r => setTimeout(r, 5));
    const before = readState(root)!;
    markDirty(root, 'Edit');
    markReconcileRequested(root);
    markReconciled(root);
    const after = readState(root)!;
    expect(after.tasks.every(t => t.status !== 'done')).toBe(true);
    expect(after.next_action).toBe(before.next_action);
    expect(after.revision).toBe(before.revision);
  });
});

describe('reconciliation instruction', () => {
  it('restates the trust hierarchy verbatim', () => {
    expect(RECONCILE_INSTRUCTION).toContain(
      'repository/tests > git state > task-store > model memory',
    );
  });

  it('forbids unevidenced completion and invented next actions', () => {
    expect(RECONCILE_INSTRUCTION).toMatch(/not mark a task done without evidence/i);
    expect(RECONCILE_INSTRUCTION).toMatch(/not invent decisions, blockers, or a next action/i);
  });

  it('routes the agent to the existing CLI rather than a new API', () => {
    expect(RECONCILE_INSTRUCTION).toContain('task-store start|done|attempt|block|decide|next');
  });

  it('stays small enough to inject at a boundary', () => {
    expect(RECONCILE_INSTRUCTION.length).toBeLessThan(1200);
  });
});

describe('evidence flag robustness', () => {
  // Regression for a defect observed in a live Claude Code session: the agent
  // wrote `task-store done T1 --evidence "..."`, the unknown flag fell through
  // to the positional-args branch, and the literal string "--evidence" was
  // recorded as the first piece of evidence. Auto-checkpoint makes this more
  // likely to be hit, because reconciliation drives the agent to the CLI more
  // often.
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('does not record the flag name itself as evidence', async () => {
    const { execFileSync } = await import('child_process');
    execFileSync(process.execPath, [
      new URL('../dist/cli.js', import.meta.url).pathname,
      'done', 'T1', '--evidence', 'src/lexer.ts: implemented', '--root', root,
    ]);
    const task = readState(root)!.tasks.find(t => t.id === 'T1')!;
    expect(task.status).toBe('done');
    expect(task.evidence).toEqual(['src/lexer.ts: implemented']);
    expect(task.evidence).not.toContain('--evidence');
  });
});

describe('no automatic completion inference', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); writeMode('conservative', root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a passing test signal never completes a task', () => {
    markDirty(root, 'Bash');   // e.g. `npm test` exiting 0
    markDirty(root, 'Bash');
    expect(readState(root)!.tasks.every(t => t.status !== 'done')).toBe(true);
  });

  it('completion still requires explicit evidence through the CLI', () => {
    markDirty(root, 'Edit');
    expect(() => completeTask('T1', [], undefined, root)).toThrow(/Evidence is required/);
    completeTask('T1', ['src/lexer.ts'], undefined, root);
    expect(readState(root)!.tasks.find(t => t.id === 'T1')!.status).toBe('done');
  });

  it('the module exposes no way to mutate a task', () => {
    // Guard against a future refactor quietly adding one.
    const api = Object.keys(
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      { markDirty, shouldReconcile, markReconciled, markReconcileRequested,
        freshness, readConfig, writeMode, isEnabled, readRuntime },
    );
    expect(api.some(n => /task|done|complete|start|block/i.test(n))).toBe(false);
  });
});
