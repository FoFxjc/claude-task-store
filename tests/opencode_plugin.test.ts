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
  checkReconcileBoundary,
  writePendingReconciliation,
  consumePendingReconciliation,
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

  it('truncates output that exceeds the 400-token design cap', () => {
    writeState(root, 'active');
    writeCli(root);
    const oversized = 'X'.repeat(2000);
    _setRunResumeCliForTests(() => ({ status: 0, stdout: oversized, stderr: '' }));

    const result = buildResumeInjection(root);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(2000);
    expect(result).toContain('…truncated');
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
    markDirtyOnTool('', 'bash');
    expect(calls).toEqual([]);
  });

  it('returns without invoking the CLI when the tool is read-only', () => {
    writeCli(root);
    markDirtyOnTool(root, 'read');
    markDirtyOnTool(root, 'glob');
    markDirtyOnTool(root, 'grep');
    expect(calls).toEqual([]);
  });

  it('returns without invoking the CLI when the project-local CLI is missing', () => {
    // No writeCli(root) — partial install. Plugin must fail safe.
    expect(() => markDirtyOnTool(root, 'bash')).not.toThrow();
    expect(calls).toEqual([]);
  });

  it('invokes `task-store auto mark-dirty <tool> --root <worktree>` for mutating tools', () => {
    writeCli(root);
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    markDirtyOnTool(root, 'bash');
    expect(calls).toEqual([{ cli, worktree: root, signal: 'bash' }]);
  });

  it('passes the tool name as the signal label (CLI ignores it for storage)', () => {
    writeCli(root);
    markDirtyOnTool(root, 'edit');
    markDirtyOnTool(root, 'write');
    expect(calls.map((c) => c.signal)).toEqual(['edit', 'write']);
  });

  it('does not mutate any task state', () => {
    writeCli(root);
    writeState(root, 'active', {
      tasks: [{ id: 'T1', title: 'Task A', status: 'pending', evidence: [], attempts: [] }],
    });
    markDirtyOnTool(root, 'bash');
    const state = JSON.parse(readFileSync(join(root, '.claude-task', 'state.json'), 'utf8'));
    expect(state.tasks[0].status).toBe('pending');
    expect(state.revision).toBe(1);
  });
});

// ─── Auto-checkpoint: reconciliation boundary ─────────────────────────────

describe('checkReconcileBoundary', () => {
  let root: string;
  let calls: { cli: string; worktree: string }[];
  let defaultStatus: number;
  let defaultStdout: string;
  beforeEach(() => {
    root = makeTmpDir('reconcile');
    calls = [];
    defaultStatus = 1;
    defaultStdout = '';
    _resetCacheForTests();
    _setRunCliForTests({
      checkReconcile: (cli, worktree) => {
        calls.push({ cli, worktree });
        return { status: defaultStatus, stdout: defaultStdout, stderr: '' };
      },
    });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns not-reconcile when worktree is empty', () => {
    const decision = checkReconcileBoundary('');
    expect(decision).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('returns not-reconcile when the project-local CLI is missing', () => {
    const decision = checkReconcileBoundary(root);
    expect(decision).toEqual({ reconcile: false, instruction: null });
    expect(calls).toEqual([]);
  });

  it('invokes `task-store auto check --instruction --root <worktree>` when CLI exists', () => {
    writeCli(root);
    const cli = join(root, '.claude', 'task-store', 'bin', 'task-store.js');
    checkReconcileBoundary(root);
    expect(calls).toEqual([{ cli, worktree: root }]);
  });

  it('returns reconcile=false when the CLI exits non-zero (no-state, disabled, debounced, ...)', () => {
    writeCli(root);
    defaultStatus = 1;
    defaultStdout = 'no-reconcile: clean';
    const decision = checkReconcileBoundary(root);
    expect(decision.reconcile).toBe(false);
    expect(decision.instruction).toBeNull();
  });

  it('returns reconcile=true with instruction when the CLI exits 0', () => {
    writeCli(root);
    defaultStatus = 0;
    defaultStdout = '[task-store] The checkpoint may be stale ...';
    const decision = checkReconcileBoundary(root);
    expect(decision.reconcile).toBe(true);
    expect(decision.instruction).toBe(defaultStdout);
  });

  it('returned instruction contains the trust hierarchy verbatim', async () => {
    // The instruction text is owned by the CLI core; this test pins the
    // contract that whatever the plugin returns is exactly what the CLI
    // emitted (no plugin-side paraphrasing). The trust hierarchy appears
    // in the canonical instruction text in src/autocheckpoint.ts.
    const fs = await import('node:fs/promises');
    const src = await fs.readFile(join(process.cwd(), 'src', 'autocheckpoint.ts'), 'utf8');
    expect(src).toContain('repository/tests  >  git state  >  task-store  >  model memory');
  });
});

// ─── Auto-checkpoint: pending instruction bridge ───────────────────────────

describe('pending reconciliation bridge', () => {
  let root: string;
  beforeEach(() => {
    root = makeTmpDir('pending');
    _resetCacheForTests();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('writePendingReconciliation creates .pending-reconcile-instruction.txt under .claude-task/', () => {
    writePendingReconciliation(root, 'reconcile now');
    const path = join(root, '.claude-task', '.pending-reconcile-instruction.txt');
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe('reconcile now');
  });

  it('consumePendingReconciliation returns null when no pending file exists', () => {
    expect(consumePendingReconciliation(root)).toBeNull();
  });

  it('consumePendingReconciliation returns the staged text and deletes the file in one step', () => {
    writePendingReconciliation(root, 'reconcile me');
    expect(consumePendingReconciliation(root)).toBe('reconcile me');
    const path = join(root, '.claude-task', '.pending-reconcile-instruction.txt');
    expect(existsSync(path)).toBe(false);
    // Idempotent: a second consume is null.
    expect(consumePendingReconciliation(root)).toBeNull();
  });

  it('rejects empty worktree / empty instruction without touching the filesystem', () => {
    writePendingReconciliation('', 'something');
    expect(consumePendingReconciliation('')).toBeNull();
  });

  it('overwrites a previously staged instruction on a new boundary write', () => {
    writePendingReconciliation(root, 'first');
    writePendingReconciliation(root, 'second');
    expect(consumePendingReconciliation(root)).toBe('second');
  });

  it('handles project paths containing spaces and apostrophes', () => {
    const tricky = mkdtempSync(join(tmpdir(), `pat's odd proj-${randomBytes(4).toString('hex')}-`));
    try {
      writePendingReconciliation(tricky, 'reconcile');
      expect(consumePendingReconciliation(tricky)).toBe('reconcile');
    } finally {
      rmSync(tricky, { recursive: true, force: true });
    }
  });
});
