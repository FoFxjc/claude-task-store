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
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';

import {
  buildResumeInjection,
  _setRunResumeCliForTests,
  _resetCacheForTests,
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

