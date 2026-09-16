/**
 * Tests for the session-attachment record (src/attachment.ts).
 *
 * Covers the issue #23 acceptance criteria that map onto the provider-neutral
 * record itself: explicit attach, takeover requiring --confirm, release from
 * the owning session only, and read/write/clear lifecycle. The downstream
 * gates in markDirty / shouldReconcile are covered in tests/autocheckpoint.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';

import {
  attach,
  release,
  readAttachment,
  clearAttachment,
  normalizeIdentity,
  attachmentFilePath,
  isAttached,
  renderAttachPrompt,
  AttachmentConflictError,
  isKnownHost,
} from '../src/attachment.js';
import { initState } from '../src/operations.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `task-store-attach-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function seedStore(root: string): void {
  // A real task store is required so attach() can write under .claude-task/.
  initState('Ship the parser', ['Write lexer'], root);
}

describe('readAttachment', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('returns null when no attachment.json exists', () => {
    expect(readAttachment(root)).toBeNull();
  });

  it('returns null on malformed JSON without throwing', () => {
    const dir = join(root, '.claude-task');
    mkdirSync(dir, { recursive: true });
    writeFileSync(attachmentFilePath(root), '{ this is not json');
    expect(readAttachment(root)).toBeNull();
  });

  it('returns null when required fields are missing or empty', () => {
    const dir = join(root, '.claude-task');
    mkdirSync(dir, { recursive: true });
    writeFileSync(attachmentFilePath(root), JSON.stringify({ session_id: 'x', host: '' }));
    expect(readAttachment(root)).toBeNull();
  });

  it('round-trips a written record', () => {
    attach({ sessionId: 'sess-1', host: 'claude-code' }, root);
    const r = readAttachment(root);
    expect(r).not.toBeNull();
    expect(r?.session_id).toBe('sess-1');
    expect(r?.host).toBe('claude-code');
    expect(typeof r?.attached_at).toBe('string');
  });
});

describe('attach', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('writes a record when no current owner exists', () => {
    const result = attach({ sessionId: 'sess-1', host: 'claude-code' }, root);
    expect(result.outcome).toBe('attached');
    expect(result.previous).toBeNull();
    expect(result.current.session_id).toBe('sess-1');
    expect(result.current.host).toBe('claude-code');
    expect(existsSync(attachmentFilePath(root))).toBe(true);
  });

  it('refreshes the record when this session is already the owner', () => {
    attach({ sessionId: 'sess-1', host: 'claude-code' }, root);
    const first = readAttachment(root)!;
    const result = attach({ sessionId: 'sess-1', host: 'claude-code' }, root);
    expect(result.outcome).toBe('refreshed');
    expect(result.previous?.session_id).toBe('sess-1');
    expect(result.current.session_id).toBe('sess-1');
    // The record was rewritten; its attached_at may differ but session_id is stable.
    expect(first.session_id).toBe(result.current.session_id);
  });

  it('refuses to take over without --takeover --confirm (issue #23 acceptance)', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    expect(() =>
      attach({ sessionId: 'side', host: 'claude-code' }, root),
    ).toThrow(AttachmentConflictError);
  });

  it('refuses --takeover without --confirm', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    expect(() =>
      attach({ sessionId: 'side', host: 'claude-code', takeover: true }, root),
    ).toThrow(/--takeover requires --confirm/);
  });

  it('takes over with --takeover --confirm (issue #23 acceptance)', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    const result = attach({
      sessionId: 'side',
      host: 'claude-code',
      takeover: true,
      confirm: true,
    }, root);
    expect(result.outcome).toBe('took-over');
    expect(result.previous?.session_id).toBe('owner');
    expect(result.current.session_id).toBe('side');
    expect(readAttachment(root)?.session_id).toBe('side');
  });

  it('rejects empty sessionId', () => {
    expect(() => attach({ sessionId: '   ', host: 'claude-code' }, root))
      .toThrow(/sessionId is required/);
  });

  it('rejects empty host', () => {
    expect(() => attach({ sessionId: 's', host: '' }, root))
      .toThrow(/host is required/);
  });

  it('uses the injected clock when provided', () => {
    const now = new Date('2026-09-15T12:34:56Z');
    const result = attach({ sessionId: 's', host: 'claude-code', now }, root);
    expect(result.current.attached_at).toBe('2026-09-15T12:34:56.000Z');
  });

  it('persists the record atomically (no torn JSON on crash)', () => {
    attach({ sessionId: 's', host: 'claude-code' }, root);
    // The file must parse; a torn write would either be missing or unparseable.
    const raw = readFileSync(attachmentFilePath(root), 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

describe('release', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('clears the record when this session is the owner (issue #23 acceptance)', () => {
    attach({ sessionId: 's', host: 'claude-code' }, root);
    const result = release({ sessionId: 's' }, root);
    expect(result.outcome).toBe('released');
    expect(existsSync(attachmentFilePath(root))).toBe(false);
  });

  it('is a no-op when no record exists', () => {
    const result = release({ sessionId: 's' }, root);
    expect(result.outcome).toBe('not-attached');
  });

  it('refuses to release a record owned by a different session', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    const result = release({ sessionId: 'side' }, root);
    expect(result.outcome).toBe('not-owner');
    // Record survives the wrong session's release attempt.
    expect(readAttachment(root)?.session_id).toBe('owner');
  });

  it('rejects empty sessionId', () => {
    expect(() => release({ sessionId: '' }, root)).toThrow(/sessionId is required/);
  });

  it('surfaces an unlink failure instead of reporting a release that did not happen', () => {
    // A release that reports success while the record is still on disk leaves
    // the next session blocked by a dead owner, so only "the file was already
    // gone" (ENOENT) may be swallowed. Making the containing directory
    // unwritable is the portable way to force a non-ENOENT failure here.
    attach({ sessionId: 's', host: 'claude-code' }, root);
    const dir = dirname(attachmentFilePath(root));
    chmodSync(dir, 0o500);
    try {
      expect(() => release({ sessionId: 's' }, root)).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    // The record is still there, which is exactly why the failure must surface.
    expect(readAttachment(root)?.session_id).toBe('s');
  });
});

describe('identity normalization', () => {
  // readAttachment() trims what it reads back, so a stored id must be trimmed
  // on the way in too — otherwise `--session-id " abc"` is written verbatim,
  // read back as "abc", and the session can never prove ownership of its own
  // record, including to release it.
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('attaching with padded whitespace still round-trips to ownership', () => {
    attach({ sessionId: '  padded  ', host: ' claude-code ' }, root);
    expect(readAttachment(root)?.session_id).toBe('padded');
    expect(readAttachment(root)?.host).toBe('claude-code');
    expect(isAttached('padded', root)).toBe(true);
    // The padded spelling is the same session, so it must be recognised too.
    expect(isAttached('  padded  ', root)).toBe(true);
  });

  it('a padded spelling can release the record it created', () => {
    attach({ sessionId: ' padded ', host: 'opencode' }, root);
    expect(release({ sessionId: '  padded' }, root).outcome).toBe('released');
    expect(existsSync(attachmentFilePath(root))).toBe(false);
  });

  it('a padded spelling is not a different owner', () => {
    attach({ sessionId: 'owner', host: 'opencode' }, root);
    expect(attach({ sessionId: ' owner ', host: 'opencode' }, root).outcome).toBe('refreshed');
  });

  it('exposes the same normalization rule the pending record needs', () => {
    expect(normalizeIdentity('  x  ')).toBe('x');
    expect(normalizeIdentity('')).toBe('');
  });
});

describe('clearAttachment', () => {
  // The administrative clear used when auto-checkpoint is switched off: no
  // session owns the record by definition any more, so it is not owner-gated.
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('removes a record owned by any session', () => {
    attach({ sessionId: 'someone-else', host: 'claude-code' }, root);
    expect(clearAttachment(root)).toBe(true);
    expect(readAttachment(root)).toBeNull();
  });

  it('is a no-op when nothing is attached', () => {
    expect(clearAttachment(root)).toBe(false);
  });
});

describe('isAttached', () => {
  let root: string;
  beforeEach(() => { root = makeTmpDir(); seedStore(root); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('is false when no record exists', () => {
    expect(isAttached('s', root)).toBe(false);
  });

  it('is true only for the owning session', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    expect(isAttached('owner', root)).toBe(true);
    expect(isAttached('side', root)).toBe(false);
  });

  it('is false for empty sessionId', () => {
    attach({ sessionId: 'owner', host: 'claude-code' }, root);
    expect(isAttached('', root)).toBe(false);
  });
});

describe('renderAttachPrompt', () => {
  it('mentions the example issue wording when no owner exists', () => {
    const text = renderAttachPrompt({
      current: null,
      attachCommand: 'task-store attach --yes',
      takeoverCommand: 'task-store attach --takeover --confirm',
    });
    expect(text).toContain('This project has active task-store work. Continue those tasks in this session?');
    expect(text).toContain('task-store attach --yes');
  });

  it('mentions the takeover wording when another session owns', () => {
    const text = renderAttachPrompt({
      current: { session_id: 'owner', host: 'claude-code', attached_at: '2026-09-15T00:00:00Z' },
      attachCommand: 'task-store attach --yes',
      takeoverCommand: 'task-store attach --takeover --confirm',
    });
    expect(text).toContain('session_id=owner');
    expect(text).toContain('task-store attach --takeover --confirm');
  });

  it('stays small enough to inject at session start', () => {
    const text = renderAttachPrompt({
      current: null,
      attachCommand: 'X',
      takeoverCommand: 'Y',
    });
    expect(text.length).toBeLessThan(800);
  });
});

describe('isKnownHost', () => {
  it('recognises the documented hosts', () => {
    expect(isKnownHost('claude-code')).toBe(true);
    expect(isKnownHost('opencode')).toBe(true);
    expect(isKnownHost('manual')).toBe(true);
  });
  it('does not reject unknown hosts (advisory only)', () => {
    // Adapters can pass any string; the function flags but does not reject.
    expect(isKnownHost('totally-new-host')).toBe(false);
  });
});
