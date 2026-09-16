/**
 * Tests for claude-task-store OpenCode plugin (opencode-plugin/task-store.ts).
 *
 * These tests exercise the injection helpers in isolation. CLI invocations
 * are stubbed via the _setRun*CliForTests seams so the tests don't depend
 * on a real project-local runtime being present. End-to-end install /
 * uninstall coverage lives in tests/opencode_install_test.sh. Real
 * OpenCode end-to-end coverage lives in tests/opencode_smoke_test.sh.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  utimesSync,
  rmSync,
  readFileSync,
  unlinkSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import {
  buildResumeInjection,
  _setRunResumeCliForTests,
  _setRunCliForTests,
  _resetCacheForTests,
  isDirtyWorthyTool,
  markDirtyOnTool,
  stageReconcileBoundary,
  takePendingInstruction,
  _resetPromptStateForTests,
  applySystemInjection,
  mergeIntoPrimarySystem,
  SYSTEM_INJECTION_SEPARATOR,
  type CliRunResult,
} from '../opencode-plugin/task-store/injection.js';

function makeTmpDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cts-opencode-${label}-${randomBytes(6).toString('hex')}`));
  return dir;
}

function writeState(
  root: string,
  status: string,
  extra: Record<string, unknown> = {},
): void {
  const stateDir = join(root, '.claude-task');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify({
      version: '1',
      revision: 1,
      goal: extra.goal ?? 'Test goal',
      status,
      current_task: extra.current_task ?? null,
      tasks: extra.tasks ?? [],
      decisions: extra.decisions ?? [],
      blockers: extra.blockers ?? [],
      next_action: extra.next_action ?? null,
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-02T00:00:00Z',
    }, null, 2),
  );
}

// Emulates `task-store auto take-instruction`: hand back whatever is staged
// for this project and delete it, or report nothing to collect. Collection is
// the CLI's job in production (that is what makes the ownership check atomic
// with the delete), so the tests stub the collaborator rather than reimplement
// the plugin's half of it.
// Stages a pending instruction exactly the way the core does: a JSON record
// bound to the session that staged it. Staging lives in the core now (it has
// to be atomic with the ownership check), so the adapter never writes this
// file — the tests that exercise delivery have to produce the real format.
function stagePendingRecord(root: string, sessionId: string, instruction: string): void {
  mkdirSync(join(root, '.claude-task'), { recursive: true });
  writeFileSync(
    join(root, '.claude-task', '.pending-reconcile-instruction.txt'),
    JSON.stringify({
      session_id: sessionId,
      instruction,
      staged_at: new Date().toISOString(),
    }),
  );
}

// Emulates `task-store auto take-instruction`: hand back whatever is staged for
// this session and delete it, or report nothing to collect. The ownership and
// binding rules are the core's (enforced there, under the store lock); this
// only mirrors them so the composition tests exercise the delegation shape.
function stubTakeInstructionFromDisk(): void {
  _setRunCliForTests({
    takeInstruction: (_cli, worktree, sessionId) => {
      const staged = join(worktree, '.claude-task', '.pending-reconcile-instruction.txt');
      if (!existsSync(staged)) {
        return { status: 1, stdout: 'no-instruction: none-staged', stderr: '' };
      }
      let record: { session_id?: unknown; instruction?: unknown } | null = null;
      try {
        record = JSON.parse(readFileSync(staged, 'utf8'));
      } catch {
        unlinkSync(staged);
        return { status: 1, stdout: 'no-instruction: none-staged', stderr: '' };
      }
      if (!record || typeof record.instruction !== 'string' || record.session_id !== sessionId) {
        return { status: 1, stdout: 'no-instruction: detached', stderr: '' };
      }
      unlinkSync(staged);
      return { status: 0, stdout: record.instruction, stderr: '' };
    },
  });
}

function writeConfig(root: string, mode = 'conservative'): void {
  const stateDir = join(root, '.claude-task');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ auto_checkpoint: mode }, null, 2),
  );
}

function writeCli(root: string): void {
  const cliDir = join(root, '.claude', 'task-store', 'bin');
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(join(cliDir, 'task-store.js'), '#!/usr/bin/env node\n// stub\n');
  writeFileSync(
    join(root, '.claude', 'task-store', 'package.json'),
    JSON.stringify({ name: 'claude-task-store-runtime' }),
  );
}

function setMtime(path: string, iso: string): void {
  // Set mtime to a fixed time so cache-key tests are deterministic.
  const t = new Date(iso).getTime() / 1000;
  utimesSync(path, t, t);
}

describe('buildResumeInjection (OpenCode plugin)', () => {
  let root: string;
  // Captured invocations. Re-assigned in beforeEach so each test sees a
  // fresh array. The default runner (set in beforeEach) closes over this
  // shared array; tests that re-set the runner update its stdout but
  // continue pushing into the same array.
  let calls: { cli: string; worktree: string }[];
  let defaultStdout: string;
  beforeEach(() => {
    root = makeTmpDir('plugin');
    calls = [];
    defaultStdout = 'MOCK RESUME\n';
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunResumeCliForTests((cli, worktree): CliRunResult => {
      calls.push({ cli, worktree });
      return { status: 0, stdout: defaultStdout, stderr: '' };
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunResumeCliForTests(() => {
      throw new Error('default runner should not be invoked in tests');
    });
  });

  it('returns null when no .claude-task/state.json exists', () => {
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when state file is corrupt JSON', () => {
    const stateDir = join(root, '.claude-task');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), '{not json');
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when state status is archived', () => {
    writeState(root, 'archived');
    writeCli(root);
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the active version-2 topic is archived', () => {
    const stateDir = join(root, '.claude-task');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'state.json'), JSON.stringify({
      version: '2', revision: 1, active_topic: 'docs',
      topics: [{
        name: 'docs', goal: 'Write docs', status: 'archived', current_task: null,
        tasks: [], decisions: [], blockers: [], next_action: null,
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
      }],
      updated_at: '2024-01-02T00:00:00Z',
    }));
    writeCli(root);
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the project-local CLI runtime is missing', () => {
    writeState(root, 'active');
    // No CLI installed. Plugin must fail safe rather than half-injecting.
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('invokes the project-local CLI with the canonical resume command on active state', () => {
    writeState(root, 'active');
    writeCli(root);
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');

    const result = buildResumeInjection(root);

    expect(result).toBe('MOCK RESUME\n');
    expect(calls).toEqual([{ cli, worktree: root }]);
  });

  it('spawns the CLI via `node` (not via process.execPath, which is the OpenCode binary under OpenCode)', async () => {
    // Inside OpenCode >=1.x, `process.execPath` is the OpenCode binary
    // because the plugin executes inside a Bun runtime. Spawning it
    // with the CLI as an argument would print the OpenCode TUI banner
    // and exit non-zero. The default runner therefore uses `node` from
    // PATH, which works under both Bun (where PATH still resolves) and
    // plain Node. This test pins that contract so a future "simplify"
    // doesn't regress it.
    writeState(root, 'active');
    writeCli(root);
    buildResumeInjection(root);

    // The test seam records cli+worktree but not the executable. Inspect
    // the defaultRunResumeCli source to assert the literal "node" is used.
    // (Reading source is intentional — there is no other way to observe
    // a hard-coded binary path through the seam.)
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      join(process.cwd(), 'opencode-plugin', 'task-store', 'injection.ts'),
      'utf8',
    );
    expect(src).toMatch(/spawnSync\(\s*['"]node['"]\s*,/);
    expect(src).not.toMatch(/spawnSync\(\s*process\.execPath\s*,/);
  });

  it('returns null when the CLI exits non-zero', () => {
    writeState(root, 'active');
    writeCli(root);
    _setRunResumeCliForTests(() => ({ status: 1, stdout: '', stderr: 'oops' }));
    expect(buildResumeInjection(root)).toBeNull();
  });

  it('returns null when the CLI exits 0 but prints empty stdout', () => {
    writeState(root, 'active');
    writeCli(root);
    _setRunResumeCliForTests(() => ({ status: 0, stdout: '', stderr: '' }));
    expect(buildResumeInjection(root)).toBeNull();
  });

  it('caches the resume text across calls when state file is unchanged', () => {
    writeState(root, 'active');
    writeCli(root);
    defaultStdout = 'GOAL: cached\n';

    expect(buildResumeInjection(root)).toBe('GOAL: cached\n');
    expect(buildResumeInjection(root)).toBe('GOAL: cached\n');
    expect(calls).toHaveLength(1);
  });

  it('re-invokes the CLI when the state file is rewritten (mtime changes)', () => {
    writeState(root, 'active');
    writeCli(root);
    defaultStdout = 'GOAL: v1\n';

    expect(buildResumeInjection(root)).toBe('GOAL: v1\n');

    // Rewrite state with newer content; bump mtime to a future timestamp
    // to guarantee the cache key changes.
    const statePath = join(root, '.claude-task', 'state.json');
    writeFileSync(
      statePath,
      JSON.stringify({
        version: '1',
        revision: 2,
        goal: 'Test goal v2',
        status: 'active',
        current_task: null,
        tasks: [],
        decisions: [],
        blockers: [],
        next_action: null,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2099-01-01T00:00:00Z',
      }),
    );
    setMtime(statePath, '2099-01-01T00:00:00Z');

    defaultStdout = 'GOAL: v2\n';

    expect(buildResumeInjection(root)).toBe('GOAL: v2\n');
    expect(calls).toHaveLength(2);
  });

  it('caches null on archived state across calls', () => {
    writeState(root, 'archived');
    writeCli(root);
    expect(buildResumeInjection(root)).toBeNull();
    expect(buildResumeInjection(root)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('passes the canonical resume projection through verbatim (no host-specific cap)', () => {
    // GitHub issue #14: the canonical renderer in src/core.ts now enforces
    // a hard character budget on the resume projection. The OpenCode
    // adapter must NOT apply its own cap on top of that — doing so would
    // create a host-specific projection difference between Claude Code
    // and OpenCode. The adapter is a pure pass-through: whatever the
    // canonical CLI emits, the adapter pushes unchanged.
    writeState(root, 'active');
    writeCli(root);
    const oversized = 'X'.repeat(2000);
    _setRunResumeCliForTests(() => ({ status: 0, stdout: oversized, stderr: '' }));

    const result = buildResumeInjection(root);
    expect(result).toBe(oversized);
    // No truncation marker was injected by the adapter.
    expect(result).not.toContain('…truncated');
  });

  it('passes through output that is within the 400-token design cap', () => {
    writeState(root, 'active');
    writeCli(root);
    const small = 'GOAL: small\nNEXT ACTION: do the thing\n';
    _setRunResumeCliForTests(() => ({ status: 0, stdout: small, stderr: '' }));

    expect(buildResumeInjection(root)).toBe(small);
  });

  it('handles project paths containing spaces and apostrophes', () => {
    const tricky = mkdtempSync(
      join(tmpdir(), `pat's odd proj-${randomBytes(4).toString('hex')}-`),
    );
    try {
      writeState(tricky, 'active');
      writeConfig(tricky);
      writeCli(tricky);
      const cli = join(tricky, '.claude', 'task-store', 'bin', 'task-store.js');
      defaultStdout = 'GOAL: spaces work\n';

      expect(buildResumeInjection(tricky)).toBe('GOAL: spaces work\n');
      expect(calls).toEqual([{ cli, worktree: tricky }]);
    } finally {
      rmSync(tricky, { recursive: true, force: true });
    }
  });
});

describe('OpenCode plugin source — structural', () => {
  it('declares the ownership marker that uninstall.sh greps for', async () => {
    // The plugin source must contain the literal ownership marker so
    // install.sh can verify what it installed and uninstall.sh can remove
    // exactly that file. An accidental edit that removes the marker
    // silently disables safe uninstall.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      join(process.cwd(), 'opencode-plugin', 'task-store.ts'),
      'utf8',
    );
    expect(src).toContain('CLAUDE-TASK-STORE-OPENCODE-PLUGIN-V1');
  });

  it('has no external npm dependencies (uses node: built-ins or sibling modules only)', async () => {
    // The plugin must not pull in npm packages from the target project's
    // node_modules: install.sh does not modify package.json, and OpenCode
    // only knows how to resolve plugin deps through its own loader. Sibling
    // modules under opencode-plugin/ are fine; they ship with the plugin.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      join(process.cwd(), 'opencode-plugin', 'task-store.ts'),
      'utf8',
    );
    // Parse out the module specifiers of every `import ... from "X"` and
    // every bare `import "X"`. Comments and multi-line imports are
    // handled by walking only the import statement bodies, not by line-
    // splitting (which is fragile when an import spans many lines).
    const importSpecifiers: string[] = [];
    // `import x from "..."` (default), `import { a, b } from "..."` (named),
    // and bare `import "..."` (side-effect).
    const re = /import\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      importSpecifiers.push(m[1]);
    }
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const spec of importSpecifiers) {
      expect(spec).toMatch(/^(node:|\.\/|\.\.\/)/);
    }
  });

  it('imports only relative paths that exist on disk with that exact extension', async () => {
    // Packaging contract. install.sh copies opencode-plugin/task-store.ts and
    // opencode-plugin/task-store/injection.ts into .opencode/plugin/ verbatim,
    // preserving their relative layout. So every relative import specifier in
    // the plugin must resolve to a real file AS WRITTEN — extension included.
    //
    // A specifier like "./task-store/injection.js" would point at a path that
    // exists in neither the repo nor the installed tree; it only happens to
    // load because Bun remaps a missing .js to a sibling .ts. That is one
    // runtime's behaviour, not a contract, so this test refuses to depend on
    // it and fails if a specifier ever stops naming a real file.
    const fs = await import('node:fs/promises');
    const pluginDir = join(process.cwd(), 'opencode-plugin');
    const src = await fs.readFile(join(pluginDir, 'task-store.ts'), 'utf8');

    const re = /import\s+(?:[\w*${},\s]+\s+from\s+)?["']([^"']+)["']/g;
    const relative: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m[1].startsWith('.')) relative.push(m[1]);
    }

    expect(relative).toEqual(['./task-store/injection.ts']);

    for (const spec of relative) {
      const resolved = join(pluginDir, spec);
      await expect(fs.access(resolved)).resolves.toBeUndefined();
    }
  });

  it('exports a default plugin function', async () => {
    const mod = await import('../opencode-plugin/task-store.js');
    expect(typeof mod.default).toBe('function');
  });

  it('plugin file exports nothing besides default (avoids OpenCode multi-plugin confusion)', async () => {
    // OpenCode's plugin loader iterates over every export of a plugin file
    // and treats each as a candidate Plugin. Helper functions MUST live in
    // a sibling module. This test guards against accidental re-introduction
    // of a named export in task-store.ts.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(
      join(process.cwd(), 'opencode-plugin', 'task-store.ts'),
      'utf8',
    );
    const exportLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^(export|export default|export\s*\{)/.test(l));
    expect(exportLines).toEqual(['export default TaskStoreOpenCodePlugin;']);
  });
});

// ─── Auto-checkpoint: read-only tool classification ────────────────────────

describe('isDirtyWorthyTool', () => {
  it('returns false for an empty or missing tool name', () => {
    expect(isDirtyWorthyTool('')).toBe(false);
    // @ts-expect-error: testing runtime safety against undefined
    expect(isDirtyWorthyTool(undefined)).toBe(false);
    // @ts-expect-error: testing runtime safety against null
    expect(isDirtyWorthyTool(null)).toBe(false);
  });

  it('treats read-only tools as not dirty-worthy', () => {
    for (const t of ['read', 'glob', 'grep', 'list', 'webfetch', 'websearch', 'skill', 'task', 'question', 'todowrite']) {
      expect(isDirtyWorthyTool(t)).toBe(false);
    }
  });

  it('treats mutating tools as dirty-worthy', () => {
    for (const t of ['bash', 'edit', 'write']) {
      expect(isDirtyWorthyTool(t)).toBe(true);
    }
  });
});

// ─── Auto-checkpoint: dirty signal ─────────────────────────────────────────

describe('markDirtyOnTool', () => {
  let root: string;
  let calls: { cli: string; worktree: string; signal: string }[];
  beforeEach(() => {
    root = makeTmpDir('dirty');
    calls = [];
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunCliForTests({
      markDirty: (cli, worktree, signal) => {
        calls.push({ cli, worktree, signal });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns without invoking the CLI when worktree is empty', () => {
    markDirtyOnTool('', 'bash', '');
    expect(calls).toEqual([]);
  });

  it('returns without invoking the CLI when the tool is read-only', () => {
    writeCli(root);
    markDirtyOnTool(root, 'read', 'sess-1');
    markDirtyOnTool(root, 'glob', 'sess-1');
    markDirtyOnTool(root, 'grep', 'sess-1');
    expect(calls).toEqual([]);
  });

  it('returns without invoking the CLI when the project-local CLI is missing', () => {
    // No writeCli(root) — partial install. Plugin must fail safe.
    expect(() => markDirtyOnTool(root, 'bash', 'sess-1')).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('invokes `task-store auto mark-dirty <tool> --root <worktree>` for mutating tools', () => {
    writeCli(root);
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    markDirtyOnTool(root, 'bash', 'sess-1');
    expect(calls).toEqual([{ cli, worktree: root, signal: 'bash' }]);
  });

  it('passes the tool name as the signal label (CLI ignores it for storage)', () => {
    writeCli(root);
    markDirtyOnTool(root, 'edit', 'sess-1');
    markDirtyOnTool(root, 'write', 'sess-1');
    expect(calls.map((c) => c.signal)).toEqual(['edit', 'write']);
  });

  it('does not mutate any task state', () => {
    writeCli(root);
    writeState(root, 'active', {
      tasks: [{ id: 'T1', title: 'Task A', status: 'pending', evidence: [], attempts: [] }],
    });
    markDirtyOnTool(root, 'bash', 'sess-1');
    const state = JSON.parse(readFileSync(join(root, '.claude-task', 'state.json'), 'utf8'));
    expect(state.tasks[0].status).toBe('pending');
    expect(state.revision).toBe(1);
  });
});

// ─── Auto-checkpoint: reconciliation boundary ─────────────────────────────

describe('stageReconcileBoundary', () => {
  let root: string;
  let calls: { cli: string; worktree: string; sessionId: string }[];
  let defaultStatus: number;
  let defaultStdout: string;
  beforeEach(() => {
    root = makeTmpDir('reconcile');
    calls = [];
    defaultStatus = 1;
    defaultStdout = '';
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunCliForTests({
      stageReconcile: (cli, worktree, sessionId) => {
        calls.push({ cli, worktree, sessionId });
        return { status: defaultStatus, stdout: defaultStdout, stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunCliForTests({});
  });

  it('returns not-reconcile when worktree is empty', () => {
    const decision = stageReconcileBoundary('', 'sess-1');
    expect(decision).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('returns not-reconcile when the session id is missing', () => {
    // The id is read from this hook's own input; a hook with no id does
    // nothing session-scoped rather than borrowing another session's.
    writeCli(root);
    expect(stageReconcileBoundary(root, '')).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('returns not-reconcile when the project-local CLI is missing', () => {
    expect(stageReconcileBoundary(root, 'sess-1')).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('invokes `task-store auto stage-instruction --root <worktree> --session-id <id>`', () => {
    writeCli(root);
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    stageReconcileBoundary(root, 'sess-1');
    expect(calls).toEqual([{ cli, worktree: root, sessionId: 'sess-1' }]);
  });

  it('returns reconcile=false when the CLI exits non-zero (no-state, disabled, debounced, detached, ...)', () => {
    writeCli(root);
    defaultStatus = 1;
    defaultStdout = 'no-reconcile: clean';
    const decision = stageReconcileBoundary(root, 'sess-1');
    expect(decision.reconcile).toBe(false);
    expect(decision.instruction).toBeNull();
  });

  it('returns reconcile=true with the instruction when the CLI exits 0', () => {
    writeCli(root);
    defaultStatus = 0;
    defaultStdout = '[task-store] The checkpoint may be stale ...';
    const decision = stageReconcileBoundary(root, 'sess-1');
    expect(decision.reconcile).toBe(true);
    expect(decision.instruction).toBe(defaultStdout);
  });

  it('returned instruction contains the trust hierarchy verbatim', async () => {
    // The instruction text is owned by the CLI core; this pins the contract
    // that whatever the plugin returns is exactly what the CLI emitted (no
    // plugin-side paraphrasing). The trust hierarchy appears in the canonical
    // instruction text in src/autocheckpoint.ts.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(join(process.cwd(), 'src', 'autocheckpoint.ts'), 'utf8');
    expect(src).toContain('repository/tests  >  git state  >  task-store  >  model memory');
  });
});

// ─── Auto-checkpoint: pending instruction bridge ───────────────────────────

describe('pending instruction collection', () => {
  let root: string;
  let calls: { cli: string; worktree: string; sessionId: string }[];
  let takeStatus: number;
  let takeStdout: string;
  beforeEach(() => {
    root = makeTmpDir('pending');
    calls = [];
    takeStatus = 0;
    takeStdout = '';
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunCliForTests({
      takeInstruction: (cli, worktree, sessionId) => {
        calls.push({ cli, worktree, sessionId });
        return { status: takeStatus, stdout: takeStdout, stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunCliForTests({});
  });

  it('delegates collection to the CLI, which owns the record format and the ownership rule', () => {
    writeCli(root);
    stagePendingRecord(root, 'sess-1', 'reconcile me');
    takeStdout = 'reconcile me';
    expect(takePendingInstruction(root, 'sess-1')).toBe('reconcile me');
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    expect(calls).toEqual([{ cli, worktree: root, sessionId: 'sess-1' }]);
  });

  it('returns null when the CLI reports nothing to collect (detached or empty)', () => {
    writeCli(root);
    stagePendingRecord(root, 'sess-1', 'staged');
    takeStatus = 1;
    takeStdout = 'no-instruction: detached';
    expect(takePendingInstruction(root, 'sess-1')).toBeNull();
  });

  it('returns null without invoking the CLI when the session id or worktree is missing', () => {
    writeCli(root);
    expect(takePendingInstruction('', 'sess-1')).toBeNull();
    expect(takePendingInstruction(root, '')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null without invoking the CLI when the runtime is not installed', () => {
    // No writeCli(root): partial install. The collector must fail safe.
    stagePendingRecord(root, 'sess-1', 'staged');
    expect(takePendingInstruction(root, 'sess-1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('does not invoke the CLI when the project has no store directory', () => {
    // The common case in a project that never ran `task-store init`: nothing
    // can have been staged, so the per-chat-turn cost stays at zero.
    writeCli(root);
    expect(takePendingInstruction(root, 'sess-1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('does not invoke the CLI when a store exists but no pending record does', () => {
    // System transform runs on every chat call. An initialized task-store with
    // no staged instruction is by far the common case, so collection must stay
    // a cheap file-existence check rather than spawning Node every turn.
    writeCli(root);
    mkdirSync(join(root, '.claude-task'), { recursive: true });
    expect(takePendingInstruction(root, 'sess-1')).toBeNull();
    expect(calls).toEqual([]);
  });

  it('returns null when the CLI exits 0 but prints nothing', () => {
    writeCli(root);
    stagePendingRecord(root, 'sess-1', 'staged');
    takeStdout = '';
    expect(takePendingInstruction(root, 'sess-1')).toBeNull();
  });

  it('handles project paths containing spaces and apostrophes', () => {
    const tricky = mkdtempSync(join(tmpdir(), `pat's odd proj-${randomBytes(4).toString('hex')}-`));
    try {
      writeCli(tricky);
      stagePendingRecord(tricky, 'sess-1', 'staged');
      takeStdout = 'reconcile';
      const cli = join(tricky, '.claude', 'task-store', 'bin', 'task-store.js');
      expect(takePendingInstruction(tricky, 'sess-1')).toBe('reconcile');
      expect(calls).toEqual([{ cli, worktree: tricky, sessionId: 'sess-1' }]);
    } finally {
      rmSync(tricky, { recursive: true, force: true });
    }
  });
});

describe('attach prompt is asked once per session', () => {
  // The hook fires on every chat call. Without a memory, a detached session
  // that declined is asked again on every turn — the prompt stops reading as a
  // decision point and becomes noise the user learns to skip. The memory is
  // in-process and keyed by session, and never touches task-store files: a
  // decline is a property of the conversation, not of the project.
  let root: string;
  const SESSION = 'declining-session';
  beforeEach(() => {
    root = makeTmpDir('prompt-once');
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunResumeCliForTests((): CliRunResult => ({ status: 0, stdout: 'MOCK RESUME\n', stderr: '' }));
    _setRunCliForTests({
      attachStatus: () => ({ status: 0, stdout: 'attached: none', stderr: '' }),
      takeInstruction: () => ({ status: 1, stdout: 'no-instruction: none-staged', stderr: '' }),
    });
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunResumeCliForTests((): CliRunResult => {
      throw new Error('default runner should not be invoked in tests');
    });
    _setRunCliForTests({});
    _resetPromptStateForTests();
  });

  const promptMarker = 'Continue those tasks in this session?';

  it('prompts on the first chat call and not on the next', () => {
    const first = ['OPENCODE'];
    applySystemInjection(root, first, SESSION);
    expect(first[0]).toContain(promptMarker);

    const second = ['OPENCODE'];
    applySystemInjection(root, second, SESSION);
    expect(second[0]).not.toContain(promptMarker);
    // The resume projection keeps being injected: only the question is
    // suppressed, not the navigation aid.
    expect(second[0]).toContain('MOCK RESUME');
  });

  it('does not suppress another session\'s prompt', () => {
    const a = ['OPENCODE'];
    applySystemInjection(root, a, 'session-a');
    expect(a[0]).toContain(promptMarker);

    const b = ['OPENCODE'];
    applySystemInjection(root, b, 'session-b');
    expect(b[0]).toContain(promptMarker);
  });

  it('stopping the prompt never stops the attach command from working', () => {
    // The user who changes their mind later runs `task-store attach ...`; the
    // next chat call then sees this session as the owner and says nothing.
    const first = ['OPENCODE'];
    applySystemInjection(root, first, SESSION);
    expect(first[0]).toContain(promptMarker);

    _setRunCliForTests({
      attachStatus: () => ({
        status: 0,
        stdout: `attached: session_id=${SESSION} host=opencode attached_at=2026-09-15T00:00:00Z`,
        stderr: '',
      }),
      takeInstruction: () => ({ status: 1, stdout: 'no-instruction: none-staged', stderr: '' }),
    });
    const after = ['OPENCODE'];
    applySystemInjection(root, after, SESSION);
    expect(after[0]).not.toContain(promptMarker);
    expect(after[0]).toContain('MOCK RESUME');
  });

  it('writes nothing to the task store when a session declines', () => {
    applySystemInjection(root, ['OPENCODE'], SESSION);
    applySystemInjection(root, ['OPENCODE'], SESSION);
    // No decline file, no attachment, no state change: the memory is in-process.
    expect(existsSync(join(root, '.claude-task', 'attachment.json'))).toBe(false);
    expect(readFileSync(join(root, '.claude-task', 'state.json'), 'utf8')).not.toContain('declined');
  });
});

// ─── OpenCode adapter: per-session identity ────────────────────────────────
//
// One plugin instance serves every session in the project/process (OpenCode
// constructs it from `{ worktree, directory }` and reuses it). The adapter used
// to keep the session id in a closure captured from the last hook that saw one,
// which meant a second session's calls could be attributed to the first —
// dirtying, prompting, and consuming under the wrong identity. Each hook now
// reads the id from its own input, and this is what pins that: it can only pass
// if the id used by the chat hook comes from the chat hook's input.

import TaskStoreOpenCodePlugin from '../opencode-plugin/task-store.ts';

describe('OpenCode adapter session identity', () => {
  let root: string;
  let dirtyCalls: string[];
  let takeCalls: string[];
  let stageCalls: string[];

  beforeEach(() => {
    root = makeTmpDir('identity');
    dirtyCalls = [];
    takeCalls = [];
    stageCalls = [];
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunResumeCliForTests((): CliRunResult => ({ status: 0, stdout: 'MOCK RESUME\n', stderr: '' }));
    _setRunCliForTests({
      markDirty: (_cli, _worktree, _signal, sessionId) => {
        dirtyCalls.push(sessionId);
        return { status: 0, stdout: '', stderr: '' };
      },
      attachStatus: () => ({ status: 0, stdout: 'attached: none', stderr: '' }),
      takeInstruction: (_cli, _worktree, sessionId) => {
        takeCalls.push(sessionId);
        return { status: 1, stdout: 'no-instruction: none-staged', stderr: '' };
      },
      stageReconcile: (_cli, _worktree, sessionId) => {
        stageCalls.push(sessionId);
        return { status: 1, stdout: 'no-reconcile: clean', stderr: '' };
      },
    });
    // A store with a state file, so the session-scoped paths all run.
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunResumeCliForTests((): CliRunResult => {
      throw new Error('default runner should not be invoked in tests');
    });
    _setRunCliForTests({});
    _resetPromptStateForTests();
  });

  it('the chat hook uses its own input id, not the id of the last tool call', async () => {
    const plugin = await TaskStoreOpenCodePlugin({ worktree: root, directory: root });

    // Session A dirties the store through a tool call.
    await plugin['tool.execute.after'](
      { tool: 'edit', sessionID: 'session-a', callID: 'call-1', args: {} },
      undefined,
    );
    expect(dirtyCalls).toEqual(['session-a']);

    // Session B's chat call must be attributed to B, not to A.
    await plugin['experimental.chat.system.transform']({ sessionID: 'session-b' }, { system: ['sys'] });
    expect(takeCalls).toEqual(['session-b']);
    expect(stageCalls).toEqual([]);
  });

  it('the boundary hook uses the event properties id', async () => {
    const plugin = await TaskStoreOpenCodePlugin({ worktree: root, directory: root });
    await plugin['tool.execute.after'](
      { tool: 'edit', sessionID: 'session-a', callID: 'call-1', args: {} },
      undefined,
    );
    await plugin.event({ event: { type: 'session.idle', properties: { sessionID: 'session-b' } } });
    expect(stageCalls).toEqual(['session-b']);
  });

  it('a hook with no session id does nothing session-scoped rather than borrowing one', async () => {
    const plugin = await TaskStoreOpenCodePlugin({ worktree: root, directory: root });
    await plugin['tool.execute.after'](
      { tool: 'edit', sessionID: 'session-a', callID: 'call-1', args: {} },
      undefined,
    );

    // OpenCode triggers the transform internally (Agent.generate) with no
    // sessionID. Nothing session-scoped may be attributed to session-a.
    const system = ['sys'];
    await plugin['experimental.chat.system.transform']({}, { system });
    expect(takeCalls).toEqual([]);
    // The project-scoped resume projection is still delivered.
    expect(system[0]).toContain('MOCK RESUME');

    // An idle event without properties must not stage under a stale id either.
    await plugin.event({ event: { type: 'session.idle' } });
    expect(stageCalls).toEqual([]);
  });

  it('ignores idle events for other event types without consulting the CLI', async () => {
    const plugin = await TaskStoreOpenCodePlugin({ worktree: root, directory: root });
    await plugin.event({ event: { type: 'session.created', properties: { sessionID: 'session-a' } } });
    expect(stageCalls).toEqual([]);
  });
});

// ─── System-prompt composition (regression: GitHub issue #7) ────────────────
//
// OpenCode maps each element of `output.system` to its own `role: "system"`
// message for OpenAI-compatible providers. A LiteLLM-backed endpoint rejects
// any request whose system message is not the very first message:
//
//   litellm.BadRequestError: System message must be at the beginning
//
// The adapter therefore merges everything it contributes into `system[0]`.
// These tests pin that invariant — the block count must never grow — plus
// the ordering and one-shot consumption semantics around it.

describe('mergeIntoPrimarySystem', () => {
  it('appends to the existing first element instead of pushing a new one', () => {
    const system = ['EXISTING'];
    mergeIntoPrimarySystem(system, 'BLOCK');
    expect(system).toEqual([`EXISTING${SYSTEM_INJECTION_SEPARATOR}BLOCK`]);
  });

  it('creates exactly one element when the array is empty', () => {
    const system: string[] = [];
    mergeIntoPrimarySystem(system, 'BLOCK');
    expect(system).toEqual(['BLOCK']);
  });

  it('leaves later elements untouched when OpenCode supplied several', () => {
    const system = ['FIRST', 'SECOND'];
    mergeIntoPrimarySystem(system, 'BLOCK');
    expect(system).toHaveLength(2);
    expect(system[0]).toBe(`FIRST${SYSTEM_INJECTION_SEPARATOR}BLOCK`);
    expect(system[1]).toBe('SECOND');
  });

  it('is a no-op for an empty block', () => {
    const system = ['EXISTING'];
    mergeIntoPrimarySystem(system, '');
    expect(system).toEqual(['EXISTING']);
  });
});

describe('applySystemInjection (single system block invariant)', () => {
  let root: string;
  let defaultStdout: string;
  // Only the attached owner may consume the shared pending-instruction file,
  // so these tests run as the recorded owner.
  const SID = 'sess-owner';
  beforeEach(() => {
    root = makeTmpDir('systemblock');
    defaultStdout = 'MOCK RESUME\n';
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunResumeCliForTests((): CliRunResult => ({
      status: 0,
      stdout: defaultStdout,
      stderr: '',
    }));
    _setRunCliForTests({
      attachStatus: () => ({
        status: 0,
        stdout: `attached: session_id=${SID} host=opencode attached_at=2024-01-01T00:00:00Z`,
        stderr: '',
      }),
    });
    stubTakeInstructionFromDisk();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunResumeCliForTests(() => {
      throw new Error('default runner should not be invoked in tests');
    });
    _setRunCliForTests({});
  });

  it('existing system + resume => still exactly one system element', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toHaveLength(1);
    expect(system[0]).toContain('MOCK RESUME');
  });

  it('existing system + resume + pending => still exactly one system element', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toHaveLength(1);
    expect(system[0]).toContain('MOCK RESUME');
    expect(system[0]).toContain('RECONCILE INSTRUCTION');
  });

  it('preserves the existing system content byte-for-byte as a prefix', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    // Deliberately awkward content: trailing whitespace, blank lines and a
    // multi-byte character must all survive untouched.
    const existing = 'You are OpenCode.\n\n  Rules:\n   - be terse  \n☑ done';
    const system = [existing];
    applySystemInjection(root, system, SID);
    expect(system[0].startsWith(existing)).toBe(true);
  });

  it('orders existing system → resume → pending instruction', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    const merged = system[0];
    const existingAt = merged.indexOf('OPENCODE SYSTEM PROMPT');
    const resumeAt = merged.indexOf('MOCK RESUME');
    const pendingAt = merged.indexOf('RECONCILE INSTRUCTION');
    expect(existingAt).toBe(0);
    expect(resumeAt).toBeGreaterThan(existingAt);
    expect(pendingAt).toBeGreaterThan(resumeAt);
  });

  it('separates each part with the documented separator', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    const system = ['EXISTING'];
    applySystemInjection(root, system, SID);
    expect(system[0]).toBe(
      `EXISTING${SYSTEM_INJECTION_SEPARATOR}MOCK RESUME\n${SYSTEM_INJECTION_SEPARATOR}RECONCILE INSTRUCTION`,
    );
  });

  it('creates exactly one element when OpenCode supplied no system content', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    const system: string[] = [];
    applySystemInjection(root, system, SID);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe('MOCK RESUME\n');
  });

  it('leaves the system array unchanged when there is no state and no pending', () => {
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toEqual(['OPENCODE SYSTEM PROMPT']);
  });

  it('leaves the system array unchanged for archived state (no-injection unchanged)', () => {
    writeState(root, 'archived');
    writeCli(root);
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toEqual(['OPENCODE SYSTEM PROMPT']);
  });

  it('leaves the system array unchanged when the project-local CLI is missing', () => {
    writeState(root, 'active');
    writeConfig(root);
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toEqual(['OPENCODE SYSTEM PROMPT']);
  });

  it('injects a pending instruction even when there is no resume projection', () => {
    // State exists but the renderer yields nothing (a transient CLI failure):
    // the boundary-staged instruction must still reach the owner, and still
    // without adding a system block.
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    _setRunResumeCliForTests((): CliRunResult => ({ status: 0, stdout: '', stderr: '' }));
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).toHaveLength(1);
    expect(system[0]).toBe(
      `OPENCODE SYSTEM PROMPT${SYSTEM_INJECTION_SEPARATOR}RECONCILE INSTRUCTION`,
    );
  });

  it('emits no attach prompt when the project has no applicable state', () => {
    // No state.json at all. The adapter stays silent about the store, and
    // collection is still delegated — whether a stale instruction should be
    // delivered is the CLI's call, not the adapter's, so that the ownership
    // check and the delete stay in one place.
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system).not.toContain('Continue those tasks in this session?');
  });

  it('emits no attach prompt for a completed state', () => {
    // `completed` is a valid schema status and means there is nothing left to
    // continue. Without this check OpenCode would invite the user to resume
    // finished work — the Claude Code SessionStart hook already suppresses
    // both archived and completed, and the two hosts must agree.
    writeState(root, 'completed');
    writeConfig(root);
    writeCli(root);
    let attachCalls = 0;
    _setRunCliForTests({
      attachStatus: () => {
        attachCalls += 1;
        return { status: 0, stdout: 'attached: none', stderr: '' };
      },
    });
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system.join('\n')).not.toContain('Continue those tasks in this session?');
    expect(attachCalls).toBe(0);
  });

  it('injects no attach prompt, and consults no attachment, when opted out', () => {
    // The prompt is part of the conservative flow, so an explicitly-off
    // project promises no prompts — and, because the mode is read from disk
    // before any CLI call, it also pays nothing per chat turn.
    writeState(root, 'active');
    writeConfig(root, 'off');
    writeCli(root);
    let attachCalls = 0;
    _setRunCliForTests({
      attachStatus: () => {
        attachCalls += 1;
        return { status: 0, stdout: 'attached: none', stderr: '' };
      },
    });
    const system = ['OPENCODE SYSTEM PROMPT'];
    applySystemInjection(root, system, SID);
    expect(system[0]).toContain('MOCK RESUME');
    expect(system[0]).not.toContain('Continue those tasks in this session?');
    expect(attachCalls).toBe(0);
  });

  it('consumes the pending instruction exactly once', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, SID, 'RECONCILE INSTRUCTION');

    const first = ['SYS'];
    applySystemInjection(root, first, SID);
    expect(first[0]).toContain('RECONCILE INSTRUCTION');

    const second = ['SYS'];
    applySystemInjection(root, second, SID);
    expect(second[0]).not.toContain('RECONCILE INSTRUCTION');
    expect(second).toHaveLength(1);
    // The pending file is gone after the first consume.
    expect(
      existsSync(join(root, '.claude-task', '.pending-reconcile-instruction.txt')),
    ).toBe(false);
  });

  it('LiteLLM failure mode: task-store never increases the system block count', () => {
    // The exact shape that produced `litellm.BadRequestError: System message
    // must be at the beginning` — an existing OpenCode system prompt plus
    // both task-store contributions. The count before must equal the count
    // after, for every combination of contributions.
    const cases: { label: string; state: boolean; pending: boolean }[] = [
      { label: 'resume only', state: true, pending: false },
      { label: 'pending only', state: false, pending: true },
      { label: 'resume + pending', state: true, pending: true },
      { label: 'neither', state: false, pending: false },
    ];
    for (const c of cases) {
      const caseRoot = makeTmpDir(`litellm-${c.label.replace(/\W+/g, '-')}`);
      try {
        _resetCacheForTests();
    _resetPromptStateForTests();
        if (c.state) {
          writeState(caseRoot, 'active');
          writeCli(caseRoot);
        }
        if (c.pending) stagePendingRecord(caseRoot, SID, 'RECONCILE INSTRUCTION');
        const system = ['OPENCODE SYSTEM PROMPT'];
        const before = system.length;
        applySystemInjection(caseRoot, system, '');
        expect(system.length).toBe(before);
      } finally {
        rmSync(caseRoot, { recursive: true, force: true });
      }
    }
  });

  it('tolerates a missing system array without throwing', () => {
    // Defensive: OpenCode owns the shape of `output`. A checkpoint aid must
    // degrade to no-injection rather than break the chat call.
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    expect(() =>
      applySystemInjection(root, undefined as unknown as string[], SID),
    ).not.toThrow();
  });
});

// ─── Issue #23: session-attachment plumbing ─────────────────────────────────
//
// The OpenCode adapter must thread a session id through every CLI call
// (mark-dirty, check, attach-status) so the provider-neutral gate in
// src/attachment.ts can decide whether this session owns the auto-checkpoint
// flow. A missing/empty session id must NOT block the call — it is a
// silent no-op in the CLI — but the adapter still records it as missing
// in the test seam below.

describe('markDirtyOnTool — session id plumbing', () => {
  let root: string;
  let calls: { cli: string; worktree: string; signal: string; sessionId: string }[];
  beforeEach(() => {
    root = makeTmpDir('dirty-sid');
    calls = [];
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunCliForTests({
      markDirty: (cli, worktree, signal, sessionId) => {
        calls.push({ cli, worktree, signal, sessionId });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not invoke the CLI when sessionId is empty (the CLI would gate it anyway)', () => {
    writeCli(root);
    markDirtyOnTool(root, 'bash', '');
    expect(calls).toEqual([]);
  });

  it('forwards the sessionId to the CLI', () => {
    writeCli(root);
    markDirtyOnTool(root, 'bash', 'sess-1');
    expect(calls).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', signal: 'bash' }),
    ]);
  });
});

describe('stageReconcileBoundary — session id plumbing', () => {
  let root: string;
  let calls: { cli: string; worktree: string; sessionId: string }[];
  beforeEach(() => {
    root = makeTmpDir('reconcile-sid');
    calls = [];
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunCliForTests({
      stageReconcile: (cli, worktree, sessionId) => {
        calls.push({ cli, worktree, sessionId });
        return { status: 1, stdout: '', stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('does not invoke the CLI when sessionId is empty', () => {
    writeCli(root);
    const decision = stageReconcileBoundary(root, '');
    expect(decision).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('forwards the sessionId to the CLI', () => {
    writeCli(root);
    stageReconcileBoundary(root, 'sess-1');
    expect(calls).toEqual([
      expect.objectContaining({ sessionId: 'sess-1' }),
    ]);
  });
});

describe('applySystemInjection — attach prompt (issue #23)', () => {
  let root: string;
  let attachStdout: string;
  beforeEach(() => {
    root = makeTmpDir('attach-prompt');
    attachStdout = '';
    _resetCacheForTests();
    _resetPromptStateForTests();
    _setRunResumeCliForTests((): CliRunResult => ({ status: 0, stdout: 'MOCK RESUME\n', stderr: '' }));
    _setRunCliForTests({
      attachStatus: () => ({ status: 0, stdout: attachStdout, stderr: '' }),
    });
    stubTakeInstructionFromDisk();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    _setRunResumeCliForTests(() => { throw new Error('default runner should not be invoked in tests'); });
    _setRunCliForTests({});
  });

  it('emits a first-time attach prompt when no owner exists', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    attachStdout = 'attached: none';
    const system = ['OPENCODE'];
    applySystemInjection(root, system, 'sess-1');
    expect(system[0]).toContain('This project has active task-store work. Continue those tasks in this session?');
    // The printed command must be runnable as-is: the project-local CLI (a
    // bare `task-store` assumes an optional global install) and an explicit
    // --root (the agent may run it from any working directory).
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    expect(system[0]).toContain(`node '${cli}' attach --session-id 'sess-1' --host opencode --root '${root}' --yes`);
  });

  it('quotes the printed command so hostile project paths stay executable', () => {
    const tricky = mkdtempSync(join(tmpdir(), `pat's odd proj-${randomBytes(4).toString('hex')}-`));
    try {
      writeState(tricky, 'active');
      writeConfig(tricky);
      writeCli(tricky);
      attachStdout = 'attached: none';
      const system = ['OPENCODE'];
      applySystemInjection(tricky, system, 'sess-1');
      // The apostrophe in the path must be escaped, not left to break the
      // command the user is told to run.
      expect(system[0]).toContain(`'${tricky.replace(/'/g, `'\\''`)}'`);
      expect(system[0]).not.toContain(`--root ${tricky} `);
    } finally {
      rmSync(tricky, { recursive: true, force: true });
    }
  });

  it('emits a takeover prompt when a different session owns the store', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    attachStdout = 'attached: session_id=other host=opencode attached_at=2026-09-15T00:00:00Z';
    const system = ['OPENCODE'];
    applySystemInjection(root, system, 'sess-1');
    expect(system[0]).toContain('already attached to another session');
    expect(system[0]).toContain('--takeover --confirm');
  });

  it('emits no attach prompt when this session is the owner', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    attachStdout = 'attached: session_id=sess-1 host=opencode attached_at=2026-09-15T00:00:00Z';
    const system = ['OPENCODE'];
    applySystemInjection(root, system, 'sess-1');
    // Resume is still injected; no attach prompt is appended.
    expect(system[0]).toContain('MOCK RESUME');
    expect(system[0]).not.toContain('Continue those tasks in this session?');
  });

  it('does not invoke attach-status when sessionId is empty (degrades to no-op)', () => {
    writeState(root, 'active');
    writeCli(root);
    let called = false;
    _setRunCliForTests({
      attachStatus: () => { called = true; return { status: 0, stdout: 'attached: none', stderr: '' }; },
    });
    const system = ['OPENCODE'];
    applySystemInjection(root, system, '');
    expect(called).toBe(false);
    expect(system[0]).toContain('MOCK RESUME');
    expect(system[0]).not.toContain('Continue those tasks in this session?');
  });

  // Ordering is asserted per-ownership, because the two payloads are mutually
  // exclusive by design: a detached session is told to opt in, an attached one
  // is handed the staged reconciliation instruction. Neither gets both.
  it('orders existing system → resume → attach prompt (detached session)', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    attachStdout = 'attached: none';
    const system = ['OPENCODE'];
    applySystemInjection(root, system, 'sess-1');
    const merged = system[0];
    expect(merged.indexOf('OPENCODE')).toBeLessThan(merged.indexOf('MOCK RESUME'));
    expect(merged.indexOf('MOCK RESUME')).toBeLessThan(merged.indexOf('Continue those tasks'));
    // A detached session must not be handed the owner's instruction.
    expect(merged).not.toContain('RECONCILE INSTRUCTION');
  });

  it('orders existing system → resume → pending instruction (attached owner)', () => {
    writeState(root, 'active');
    writeConfig(root);
    writeCli(root);
    stagePendingRecord(root, 'sess-1', 'RECONCILE INSTRUCTION');
    attachStdout = 'attached: session_id=sess-1 host=opencode attached_at=2026-09-15T00:00:00Z';
    const system = ['OPENCODE'];
    applySystemInjection(root, system, 'sess-1');
    const merged = system[0];
    expect(merged.indexOf('OPENCODE')).toBeLessThan(merged.indexOf('MOCK RESUME'));
    expect(merged.indexOf('MOCK RESUME')).toBeLessThan(merged.indexOf('RECONCILE INSTRUCTION'));
    // The owner is never prompted to attach to what it already owns.
    expect(merged).not.toContain('Continue those tasks in this session?');
  });
});
