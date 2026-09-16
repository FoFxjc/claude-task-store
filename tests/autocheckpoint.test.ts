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

import { initState, completeTask, setNextAction } from '../src/operations.js';
import { readState } from '../src/storage.js';
import { getActiveTopic } from '../src/codec.js';
import {
  isAttached as _isAttached,
  attach,
  release,
  clearAttachment,
  normalizeIdentity,
  readAttachment,
} from '../src/attachment.js';
import {
  readConfig, writeMode, isEnabled,
  configFilePath, debounceSeconds, DEFAULT_MODE, NEW_STORE_MODE,
  DEFAULT_DEBOUNCE_SECONDS,
} from '../src/autocheckpoint/config.js';
import { readRuntime, runtimeFilePath } from '../src/autocheckpoint/runtime.js';
import {
  markDirty, shouldReconcile, markReconcileRequested, markReconciled,
  freshness, RECONCILE_INSTRUCTION,
} from '../src/autocheckpoint/policy.js';
import {
  stagePendingInstruction, takePendingInstruction, pendingInstructionFilePath,
} from '../src/autocheckpoint/pending.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `task-store-autockpt-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A project with a task store and one in-progress task, no attachment
 *  yet. The session-attachment gate tests build on top of this and call
 *  `attachTestSession()` themselves; the rest of the suite relies on
 *  `seed()` calling it on their behalf so the existing test bodies
 *  keep working without threading sessionId through every call. */
function storeSeed(root: string): void {
  initState('Ship the parser', ['Write lexer', 'Write parser'], root);
  setNextAction('Implement expression parsing', root);
}

const TEST_SESSION_ID = 'test-session';
function attachTestSession(root: string): void {
  attach({ sessionId: TEST_SESSION_ID, host: 'claude-code' }, root);
}
function seed(root: string): void {
  storeSeed(root);
  attachTestSession(root);
}
function isAttachedOther(sessionId: string, root: string): boolean {
  return _isAttached(sessionId, root);
}
function laterBy(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

describe('configuration', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('switching the mode off clears the attachment, leaving no dead owner', () => {
    // The scenario from the review: a session attaches, the user runs
    // `config auto-checkpoint off`, the session later ends, and conservative
    // mode is enabled again. The session-end hook releases only when the mode
    // it observes is conservative, so nothing else clears the record — the
    // next session would meet an owner that ended long ago and be pushed
    // through a takeover confirmation for no reason.
    expect(readAttachment(root)?.session_id).toBe(TEST_SESSION_ID);

    // Pending delivery is ephemeral auto-checkpoint state too. A request
    // staged just before opt-out must not survive an explicit `off` and make
    // later chat turns pay collection cost for a disabled feature.
    writeFileSync(
      pendingInstructionFilePath(root),
      JSON.stringify({
        session_id: TEST_SESSION_ID,
        instruction: RECONCILE_INSTRUCTION,
        staged_at: new Date().toISOString(),
      }),
    );
    expect(existsSync(pendingInstructionFilePath(root))).toBe(true);

    writeMode('off', root);
    expect(readAttachment(root)).toBeNull();
    expect(existsSync(pendingInstructionFilePath(root))).toBe(false);

    writeMode('conservative', root);
    // No owner at all now, so a fresh session gets the first-time prompt.
    expect(_isAttached(TEST_SESSION_ID, root)).toBe(false);
  });

  it('switching the mode on does not disturb the current owner', () => {
    writeMode('conservative', root);
    expect(readAttachment(root)?.session_id).toBe(TEST_SESSION_ID);
  });

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
    expect(markDirty(root, 'Edit', TEST_SESSION_ID)).toBeNull();
    expect(existsSync(runtimeFilePath(root))).toBe(false);
  });

  it('records signals once enabled', () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit', TEST_SESSION_ID);
    markDirty(root, 'Bash', TEST_SESSION_ID);
    const runtime = readRuntime(root);
    expect(runtime.signal_count).toBe(2);
    expect(runtime.dirty_since).not.toBeNull();
    expect(runtime.last_signal_at).not.toBeNull();
  });

  it('keeps dirty_since anchored to the first signal of the window', async () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const first = readRuntime(root).dirty_since;
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(readRuntime(root).dirty_since).toBe(first);
  });

  it('never mutates task state', () => {
    writeMode('conservative', root);
    const before = readState(root)!;
    for (let i = 0; i < 10; i++) markDirty(root, 'Edit', TEST_SESSION_ID);
    const after = readState(root)!;
    expect(after.revision).toBe(before.revision);
    expect(getActiveTopic(after).tasks.map(t => t.status)).toEqual(getActiveTopic(before).tasks.map(t => t.status));
    expect(getActiveTopic(after).next_action).toBe(getActiveTopic(before).next_action);
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
    markDirty(root, 'Bash: curl https://secrets.example/token', TEST_SESSION_ID);
    const raw = readFileSync(runtimeFilePath(root), 'utf8');
    expect(raw).not.toContain('secrets.example');
    expect(raw).not.toContain('Bash');
  });

  it('switching modes clears any stale dirty window', () => {
    writeMode('conservative', root);
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(existsSync(runtimeFilePath(root))).toBe(true);
    writeMode('off', root);
    expect(existsSync(runtimeFilePath(root))).toBe(false);
    writeMode('conservative', root);
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reconcile).toBe(false);
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
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const f = freshness(root);
    expect(f.stale).toBe(true);
    expect(f.signals).toBe(1);
  });

  it('clears when the agent writes through the normal CLI verbs', async () => {
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(freshness(root).stale).toBe(true);
    await new Promise(r => setTimeout(r, 5));
    // Any ordinary checkpoint write counts — no explicit "I reconciled" call.
    setNextAction('Implement the parser', root);
    expect(freshness(root).stale).toBe(false);
  });

  it('does not require git', () => {
    expect(existsSync(join(root, '.git'))).toBe(false);
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(() => freshness(root)).not.toThrow();
  });
});

describe('shouldReconcile', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('never fires while disabled, however much activity happens', () => {
    for (let i = 0; i < 20; i++) markDirty(root, 'Edit', TEST_SESSION_ID);
    const d = shouldReconcile(root, new Date(), TEST_SESSION_ID);
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('disabled');
  });

  it('does not fire on a clean store', () => {
    writeMode('conservative', root);
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reason).toBe('clean');
  });

  it('fires once when the store is dirty', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const d = shouldReconcile(root, new Date(), TEST_SESSION_ID);
    expect(d.reconcile).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('does not fire again with no new work (gate 1)', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    markReconcileRequested(root, new Date(), TEST_SESSION_ID);
    // Even far past the debounce window, nothing new has happened.
    const d = shouldReconcile(root, laterBy(86400), TEST_SESSION_ID);
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('already-requested');
  });

  it('does not fire again within the debounce window despite new work (gate 2)', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    markReconcileRequested(root, new Date(), TEST_SESSION_ID);
    // Strictly after the request: timestamps are millisecond-resolution and a
    // signal landing in the same millisecond as the request is deliberately
    // NOT counted as new work (ties resolve toward asking less often).
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const d = shouldReconcile(root, laterBy(DEFAULT_DEBOUNCE_SECONDS - 1), TEST_SESSION_ID);
    expect(d.reconcile).toBe(false);
    expect(d.reason).toBe('debounced');
  });

  it('fires again once BOTH new work and the debounce window are satisfied', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    markReconcileRequested(root, new Date(), TEST_SESSION_ID);
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const d = shouldReconcile(root, laterBy(DEFAULT_DEBOUNCE_SECONDS + 1), TEST_SESSION_ID);
    expect(d.reconcile).toBe(true);
    expect(d.reason).toBe('stale');
  });

  it('a burst of activity yields exactly one request', async () => {
    writeMode('conservative', root);
    await new Promise(r => setTimeout(r, 5));
    let fired = 0;
    for (let i = 0; i < 50; i++) {
      markDirty(root, 'Edit', TEST_SESSION_ID);
      // Simulate a boundary after every single tool call.
      if (shouldReconcile(root, new Date(), TEST_SESSION_ID).reconcile) {
        fired++;
        markReconcileRequested(root, new Date(), TEST_SESSION_ID);
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
    expect(shouldReconcile(root, laterBy(86400), TEST_SESSION_ID).reason).toBe('already-requested');
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
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const a = shouldReconcile(root, new Date(), TEST_SESSION_ID);
    const b = shouldReconcile(root, new Date(), TEST_SESSION_ID);
    const c = shouldReconcile(root, new Date(), TEST_SESSION_ID);
    expect([a.reconcile, b.reconcile, c.reconcile]).toEqual([true, true, true]);
  });
});

describe('markReconciled', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seed(root); writeMode('conservative', root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clears the dirty window and records the time', async () => {
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(markReconciled(root, new Date(), TEST_SESSION_ID)).toBe('applied');
    const runtime = readRuntime(root);
    expect(runtime.dirty_since).toBeNull();
    expect(runtime.signal_count).toBe(0);
    expect(runtime.last_reconcile_at).not.toBeNull();
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reason).toBe('clean');
  });

  it('does not complete tasks or set next_action', async () => {
    await new Promise(r => setTimeout(r, 5));
    const before = readState(root)!;
    markDirty(root, 'Edit', TEST_SESSION_ID);
    markReconcileRequested(root, new Date(), TEST_SESSION_ID);
    markReconciled(root, new Date(), TEST_SESSION_ID);
    const after = readState(root)!;
    expect(getActiveTopic(after).tasks.every(t => t.status !== 'done')).toBe(true);
    expect(getActiveTopic(after).next_action).toBe(getActiveTopic(before).next_action);
    expect(after.revision).toBe(before.revision);
  });
});

describe('markReconciled ownership (issue #23 review)', () => {
  // The one verb that CLEARS the shared dirty window. A session that does not
  // own the attachment calling it would tell the real owner its checkpoint is
  // clean while its work signal is still pending — so it gates on the same
  // record markDirty and shouldReconcile use.
  let root: string;
  beforeEach(async () => {
    root = makeTmpDir();
    seed(root);
    writeMode('conservative', root);
    // seed() writes state.json, and freshness compares state.updated_at with
    // last_signal_at at millisecond resolution — a dirty signal in the same
    // millisecond reads as "the checkpoint was already written". Same 5ms
    // barrier the rest of this suite uses.
    await new Promise(r => setTimeout(r, 5));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('a detached side session cannot clear the owner\'s dirty window', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(isAttachedOther('other-session', root)).toBe(false);

    expect(markReconciled(root, new Date(), 'other-session')).toBe('detached');

    // The owner's signal survives, and the owner is still asked to reconcile.
    const runtime = readRuntime(root);
    expect(runtime.signal_count).toBeGreaterThan(0);
    expect(runtime.dirty_since).not.toBeNull();
    expect(runtime.last_reconcile_at).toBeNull();
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reconcile).toBe(true);
  });

  it('a session with no id at all cannot clear the window', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(markReconciled(root)).toBe('detached');
    expect(readRuntime(root).dirty_since).not.toBeNull();
  });

  it('reports disabled rather than lying when the mode is off', () => {
    writeMode('off', root);
    expect(markReconciled(root, new Date(), TEST_SESSION_ID)).toBe('disabled');
  });

  it('the owner can still clear its own window', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(markReconciled(root, new Date(), TEST_SESSION_ID)).toBe('applied');
    expect(readRuntime(root).dirty_since).toBeNull();
  });

  it('markReconcileRequested is owner-gated too, so a side session cannot open the debounce window', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(markReconcileRequested(root, new Date(), 'other-session')).toBe('detached');
    // Nothing was recorded: the owner's next boundary may still ask.
    expect(readRuntime(root).last_reconcile_request_at).toBeNull();
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reconcile).toBe(true);
  });
});

describe('inactive-state gate', () => {
  // An archived or completed checkpoint has no work to reconcile. Without this
  // the Stop hook would inject a reconciliation instruction for a store the
  // agent cannot act on, and — because `auto check` also records the request —
  // it would burn the debounce window doing it.
  let root: string;
  beforeEach(async () => {
    root = makeTmpDir();
    seed(root);
    writeMode('conservative', root);
    // seed() writes state.json, and freshness compares state.updated_at with
    // last_signal_at at millisecond resolution — a dirty signal in the same
    // millisecond reads as "the checkpoint was already written". Same 5ms
    // barrier the rest of this suite uses.
    await new Promise(r => setTimeout(r, 5));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  for (const status of ['archived', 'completed'] as const) {
    it(`never asks for reconciliation when the store is ${status}`, () => {
      markDirty(root, 'Edit', TEST_SESSION_ID);
      // Force the active topic into the inactive status.
      const state = readState(root)!;
      getActiveTopic(state).status = status;
      writeFileSync(
        join(root, '.claude-task', 'state.json'),
        JSON.stringify(state, null, 2),
      );

      const decision = shouldReconcile(root, new Date(), TEST_SESSION_ID);
      expect(decision.reconcile).toBe(false);
      expect(decision.reason).toBe('inactive-state');
    });
  }

  it('still asks when the store is active', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(shouldReconcile(root, new Date(), TEST_SESSION_ID).reconcile).toBe(true);
  });
});

describe('pending instruction staging and binding', () => {
  let root: string;
  beforeEach(async () => {
    root = makeTmpDir();
    seed(root);
    writeMode('conservative', root);
    // seed() writes state.json, and freshness compares state.updated_at with
    // last_signal_at at millisecond resolution — a dirty signal in the same
    // millisecond reads as "the checkpoint was already written". Same 5ms
    // barrier the rest of this suite uses.
    await new Promise(r => setTimeout(r, 5));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('stages the canonical instruction for the owning session', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const staged = stagePendingInstruction(root, new Date(), TEST_SESSION_ID);
    expect(staged.reconcile).toBe(true);
    expect(staged.instruction).toBe(RECONCILE_INSTRUCTION);

    const record = JSON.parse(readFileSync(pendingInstructionFilePath(root), 'utf8'));
    expect(record.session_id).toBe(TEST_SESSION_ID);
    expect(record.instruction).toBe(RECONCILE_INSTRUCTION);
  });

  it('a detached session cannot stage anything', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    const staged = stagePendingInstruction(root, new Date(), 'other-session');
    expect(staged.reconcile).toBe(false);
    expect(staged.reason).toBe('detached');
    expect(existsSync(pendingInstructionFilePath(root))).toBe(false);
  });

  it('does not stage when the decision says no, and does not burn the debounce window doing it', () => {
    // Clean store: nothing has changed since the last write.
    const staged = stagePendingInstruction(root, new Date(), TEST_SESSION_ID);
    expect(staged.reconcile).toBe(false);
    expect(staged.instruction).toBeNull();
    expect(readRuntime(root).last_reconcile_request_at).toBeNull();
  });

  it('the owner collects its own staged instruction exactly once', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    stagePendingInstruction(root, new Date(), TEST_SESSION_ID);
    expect(takePendingInstruction(root, TEST_SESSION_ID)).toBe(RECONCILE_INSTRUCTION);
    expect(existsSync(pendingInstructionFilePath(root))).toBe(false);
    expect(takePendingInstruction(root, TEST_SESSION_ID)).toBeNull();
  });

  it('after a takeover the previous owner can neither stage nor consume', async () => {
    // This is the race the review found: the adapter used to ask the CLI and
    // then write the file itself, with the lock released in between.
    markDirty(root, 'Edit', TEST_SESSION_ID);
    stagePendingInstruction(root, new Date(), TEST_SESSION_ID);

    attach({ sessionId: 'new-owner', host: 'opencode', takeover: true, confirm: true }, root);

    // Consume: the displaced session owns nothing to collect...
    expect(takePendingInstruction(root, TEST_SESSION_ID)).toBeNull();
    // ...and the record it staged is not handed to the new owner either.
    expect(takePendingInstruction(root, 'new-owner')).toBeNull();
    // The file is left in place for the new owner's own staging to replace.
    expect(existsSync(pendingInstructionFilePath(root))).toBe(true);

    // Stage: a displaced session cannot stage a fresh instruction.
    expect(stagePendingInstruction(root, new Date(), TEST_SESSION_ID).reconcile).toBe(false);

    // The new owner is not locked out: it stages and collects its own record
    // normally. Ensure the new dirty signal lands after the previous owner's
    // request timestamp; both are millisecond-resolution ISO strings and a
    // same-tick signal is correctly classified as already-requested.
    await new Promise(r => setTimeout(r, 5));
    markDirty(root, 'Edit', 'new-owner');
    expect(stagePendingInstruction(root, laterBy(3600), 'new-owner').reconcile).toBe(true);
    expect(takePendingInstruction(root, 'new-owner')).toBe(RECONCILE_INSTRUCTION);
  });

  it('after a release the previous owner can neither stage nor consume', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    stagePendingInstruction(root, new Date(), TEST_SESSION_ID);
    release({ sessionId: TEST_SESSION_ID }, root);

    expect(takePendingInstruction(root, TEST_SESSION_ID)).toBeNull();
    expect(stagePendingInstruction(root, new Date(), TEST_SESSION_ID).reconcile).toBe(false);
  });

  it('discards an unreadable record instead of delivering it', () => {
    // A file left by a pre-binding version is not deliverable by anyone.
    const path = pendingInstructionFilePath(root);
    mkdirSync(join(root, '.claude-task'), { recursive: true });
    writeFileSync(path, 'free text from an older version', 'utf8');
    attach({ sessionId: TEST_SESSION_ID, host: 'claude-code' }, root);
    expect(takePendingInstruction(root, TEST_SESSION_ID)).toBeNull();
    expect(existsSync(path)).toBe(false);
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
    const task = getActiveTopic(readState(root)!).tasks.find(t => t.id === 'T1')!;
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
    markDirty(root, 'Bash', TEST_SESSION_ID);   // e.g. `npm test` exiting 0
    markDirty(root, 'Bash', TEST_SESSION_ID);
    expect(getActiveTopic(readState(root)!).tasks.every(t => t.status !== 'done')).toBe(true);
  });

  it('completion still requires explicit evidence through the CLI', () => {
    markDirty(root, 'Edit', TEST_SESSION_ID);
    expect(() => completeTask('T1', [], undefined, root)).toThrow(/Evidence is required/);
    completeTask('T1', ['src/lexer.ts'], undefined, root);
    expect(getActiveTopic(readState(root)!).tasks.find(t => t.id === 'T1')!.status).toBe('done');
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

describe('session-attachment gate (issue #23)', () => {
  // Auto-checkpoint is intentionally session-intent-scoped: a side session
  // in a project with active task-store state must NOT dirty the runtime
  // and must NOT receive reconciliation instructions, regardless of how
  // much it edits. The gate lives in markDirty / shouldReconcile, here.
  let root: string;
  beforeEach(() => { root = makeTmpDir(); storeSeed(root); writeMode('conservative', root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('markDirty is a complete no-op when no session_id is supplied', () => {
    // Attach first so the record exists: this isolates the `!sessionId` gate.
    // Without an attachment the call would short-circuit for the unowned-id
    // reason instead, and the missing-id branch would never run.
    attach({ sessionId: TEST_SESSION_ID, host: 'claude-code' }, root);
    expect(markDirty(root, 'Edit')).toBeNull();
    expect(existsSync(runtimeFilePath(root))).toBe(false);
  });

  it('markDirty is a no-op when the session_id does not own the store', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    expect(markDirty(root, 'Edit', 'side')).toBeNull();
    expect(existsSync(runtimeFilePath(root))).toBe(false);
  });

  it('markDirty proceeds only when the session_id matches the owner', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    const runtime = markDirty(root, 'Edit', 'owner');
    expect(runtime).not.toBeNull();
    expect(runtime!.signal_count).toBe(1);
  });

  it('markDirty is no-op for a side session even after work happened elsewhere', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    markDirty(root, 'Edit', 'owner');
    expect(readRuntime(root).signal_count).toBe(1);
    // A side session that runs after the owner dirties the store must NOT
    // add to the counter — its work belongs to its own detached context.
    markDirty(root, 'Edit', 'side');
    expect(readRuntime(root).signal_count).toBe(1);
  });

  it('shouldReconcile returns detached when no session_id is supplied', () => {
    // Attach + dirty as the real owner, then call without a session id. This
    // isolates the `!sessionId` gate: a stored dirty window is present, so the
    // only reason to report detached is the absent id.
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    markDirty(root, 'Edit', 'owner');
    const decision = shouldReconcile(root);
    expect(decision.reconcile).toBe(false);
    expect(decision.reason).toBe('detached');
    // Sanity: a dirty window really is recorded, so the assertion above is
    // about the missing id, not about a clean store. Read the marker rather
    // than comparing timestamps, which can collide within one millisecond.
    expect(readRuntime(root).dirty_since).not.toBeNull();
  });

  it('shouldReconcile returns detached when the session is not the owner', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    markDirty(root, 'Edit', 'owner');
    const decision = shouldReconcile(root, new Date(), 'side');
    expect(decision.reconcile).toBe(false);
    expect(decision.reason).toBe('detached');
  });

  it('shouldReconcile proceeds normally for the owning session (issue #23 acceptance)', async () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    // Allow the state.updated_at (set during storeSeed) and the runtime
    // last_signal_at (set during markDirty) to differ by at least one tick,
    // otherwise freshness reports the store as up-to-date. Mirrors the
    // pattern used elsewhere in this file.
    await new Promise((r) => setTimeout(r, 5));
    markDirty(root, 'Edit', 'owner');
    const decision = shouldReconcile(root, new Date(), 'owner');
    expect(decision.reconcile).toBe(true);
    expect(decision.reason).toBe('stale');
  });

  it('a takeover transfers the gate to the new session (issue #23 acceptance)', async () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    await new Promise((r) => setTimeout(r, 5));
    markDirty(root, 'Edit', 'owner');
    // Confirm a takeover from the old owner to a new one.
    attach({ sessionId: 'new', host: 'claude-code', takeover: true, confirm: true }, root);
    // New session can now dirty + reconcile; old session cannot.
    expect(shouldReconcile(root, new Date(), 'new').reason).toBe('stale');
    expect(shouldReconcile(root, new Date(), 'owner').reason).toBe('detached');
  });

  it('releasing an attachment gates subsequent calls as detached', async () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    await new Promise((r) => setTimeout(r, 5));
    markDirty(root, 'Edit', 'owner');
    expect(shouldReconcile(root, new Date(), 'owner').reconcile).toBe(true);
    // Owner releases its claim (e.g. session-end.sh fired).
    const r = release({ sessionId: 'owner' }, root);
    expect(r.outcome).toBe('released');
    // The owner can no longer dirty or reconcile — it has detached itself.
    expect(markDirty(root, 'Edit', 'owner')).toBeNull();
    expect(shouldReconcile(root, new Date(), 'owner').reason).toBe('detached');
  });

  it('declining to attach leaves the session detached for its lifetime', () => {
    // The "decline" path doesn't write anything — the session simply does
    // not run `task-store attach --yes`. The gate then stays detached for
    // the lifetime of that session_id. Re-attaching later is fine; we
    // verify the gate does not silently auto-attach.
    expect(markDirty(root, 'Edit', 'side')).toBeNull();
    expect(shouldReconcile(root, new Date(), 'side').reason).toBe('detached');
    // The session can still opt in later.
    attach({ sessionId: 'side', host: 'claude-code' }, root);
    expect(markDirty(root, 'Edit', 'side')).not.toBeNull();
  });

  it('markDirty with a different session_id than the one in the runtime does not corrupt state', () => {
    // Regression guard: the runtime is shared across the project, but only
    // the owner's signals are recorded. A side session running markDirty
    // must not silently overwrite the owner's signal_count downward.
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    markDirty(root, 'Edit', 'owner');
    markDirty(root, 'Edit', 'owner');
    markDirty(root, 'Edit', 'owner');
    expect(readRuntime(root).signal_count).toBe(3);
    markDirty(root, 'Edit', 'side');
    markDirty(root, 'Edit', 'side');
    expect(readRuntime(root).signal_count).toBe(3);
  });
});
