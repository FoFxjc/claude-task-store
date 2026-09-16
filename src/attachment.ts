/**
 * claude-task-store: session-attachment record (provider-neutral core)
 *
 * PURPOSE
 * -------
 * Auto-checkpoint in conservative mode is project-scoped by default: any
 * session opened in a project with `.claude-task/state.json` could dirty the
 * auto-checkpoint runtime and receive reconciliation instructions, even when
 * the user never intended that session to continue the existing task-store
 * work. This module implements the smallest thing that fixes that — an
 * explicit, opt-in ownership record for auto-checkpoint.
 *
 *     session-start     ->  check ownership
 *                            ->  if owner is missing, prompt the user
 *                            ->  if owner is a different session, prompt takeover
 *     explicit confirm  ->  attach (or takeover)   (this session becomes owner)
 *     tool activity     ->  markDirty(sessionId)   (no-op when not owner)
 *     boundary          ->  shouldReconcile(sessionId)
 *                            (returns 'detached' when not owner)
 *     session-end       ->  release(sessionId)     (clears the record)
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * -----------------------------------------
 * - It does not invent an attachment. A session becomes the owner only when
 *   `attach()` is called explicitly, with `--takeover --confirm` if another
 *   session currently owns the record.
 * - It does not persist tool names, conversation content, or anything that
 *   could be turned into a session transcript.
 * - It does not change the published `state.json` schema. The record lives
 *   in its own gitignored file (`.claude-task/attachment.json`).
 * - It does not auto-evict a stale owner. If the previous session crashed
 *   without running `release()`, the next session must explicitly take over.
 *   This is the cost of treating attachment as an intent boundary rather
 *   than a lease.
 *
 * PROVIDER NEUTRALITY
 * -------------------
 * Nothing here knows about "SessionStart", "session.idle", "tool.execute.after",
 * or any other Claude Code / OpenCode event name. The host identifier is an
 * opaque string the caller passes; everything else is a pure function of
 * persisted state and the inputs.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { storePath, findProjectRoot } from './paths.js';

const ATTACHMENT_FILE = 'attachment.json';

/**
 * Stable, host-chosen identifier for the session. We do not validate the
 * format: a session_id is an opaque string the caller chooses, and treating
 * it as one keeps this module provider-neutral.
 */
export interface AttachmentRecord {
  session_id: string;
  /** Host that owns the attachment: e.g. "claude-code", "opencode", "manual". */
  host: string;
  /** ISO timestamp at which this session became the owner. */
  attached_at: string;
}

/**
 * Advisory set of host identifiers that the adapters actually use. The
 * module itself never reads this; `attach()` records whatever the caller
 * passes. The set exists so the CLI's `attach status` output can flag
 * unrecognised hosts without rejecting them.
 */
const KNOWN_HOSTS: Record<string, true> = {
  'claude-code': true,
  'opencode': true,
  'manual': true,
};

export class AttachmentConflictError extends Error {
  readonly current: AttachmentRecord;
  constructor(message: string, current: AttachmentRecord) {
    super(message);
    this.name = 'AttachmentConflictError';
    this.current = current;
  }
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export function attachmentFilePath(projectRoot?: string): string {
  return join(storePath(projectRoot), ATTACHMENT_FILE);
}

// ─── Atomic write (mirrors core.ts / autocheckpoint.ts) ───────────────────────

function atomicWriteJson(filePath: string, value: unknown): void {
  const dir = filePath.replace(/[/\\][^/\\]+$/, '') || '.';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp_${randomBytes(8).toString('hex')}`);
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
}

// ─── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize a caller-supplied identity string (session id or host).
 *
 * readAttachment() trims what it reads back, so trimming what we write and
 * compare is the only way to make the round trip consistent. Without it,
 * `--session-id " abc"` is stored verbatim, read back as "abc", and the
 * session can never prove ownership of its own record — including to release
 * it, which would leave exactly the dead owner this feature exists to prevent.
 * Normalizing at the boundary also means a hand-edited record with stray
 * whitespace still matches.
 *
 * Exported because the pending-instruction record binds itself to a session id
 * (src/autocheckpoint.ts) and must compare identities by the same rule.
 */
export function normalizeIdentity(value: string): string {
  return value.trim();
}

// ─── Read / write / clear ────────────────────────────────────────────────────

/**
 * Read the current attachment record, or null when no session is attached.
 *
 * A missing file, an unreadable file, and a malformed JSON file all resolve
 * to null — there is no valid "attached to nothing" state, and a corrupt
 * record must not silently block the next session's attach.
 */
export function readAttachment(projectRoot?: string): AttachmentRecord | null {
  const path = attachmentFilePath(projectRoot);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const raw = parsed as Record<string, unknown>;

  const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
  const host = typeof raw.host === 'string' ? raw.host.trim() : '';
  const attachedAt = typeof raw.attached_at === 'string' ? raw.attached_at : '';
  if (!sessionId || !host || !attachedAt) return null;

  return { session_id: sessionId, host, attached_at: attachedAt };
}

function writeAttachmentRecord(record: AttachmentRecord, projectRoot?: string): void {
  atomicWriteJson(attachmentFilePath(projectRoot), record);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

export type AttachOutcome = 'attached' | 'refreshed' | 'took-over';

export interface AttachOptions {
  sessionId: string;
  host: string;
  /** When true, overwrite an existing attachment owned by a different session. */
  takeover?: boolean;
  /** Required when takeover is true; ignored otherwise. Refuses silent steals. */
  confirm?: boolean;
  /** Injectable clock; tests use this to make attached_at deterministic. */
  now?: Date;
}

export interface AttachResult {
  outcome: AttachOutcome;
  previous: AttachmentRecord | null;
  current: AttachmentRecord;
}

/**
 * Make this session the owner of the project's auto-checkpoint flow.
 *
 * Three outcomes:
 *   - 'attached'   — no prior owner, or the prior owner was this session.
 *                    The record is written (or refreshed).
 *   - 'took-over'  — a different session owned the record; takeover was
 *                    requested and confirmed. The record is overwritten.
 *   - throws AttachmentConflictError when a different session owns the
 *     record and takeover was not requested/confirmed.
 *
 * The error class carries the current owner so the CLI can render a useful
 * message ("session X is already attached; pass --takeover --confirm").
 *
 * `host` is recorded as-is for diagnostic visibility. It is NOT used as part
 * of the ownership check — two sessions on the same host must still use
 * distinct session_ids, and the model assumes the caller enforces that.
 */
export function attach(opts: AttachOptions, projectRoot?: string): AttachResult {
  const sessionId = normalizeIdentity(opts.sessionId ?? '');
  const host = normalizeIdentity(opts.host ?? '');
  if (!sessionId) {
    throw new Error('attach: sessionId is required');
  }
  if (!host) {
    throw new Error('attach: host is required');
  }
  if (opts.takeover && !opts.confirm) {
    // The explicit --confirm gate is the whole point of "explicit takeover":
    // refusing without it makes a forgotten flag loud rather than silent.
    throw new Error('attach: --takeover requires --confirm');
  }

  const root = projectRoot ?? findProjectRoot();
  const now = opts.now ?? new Date();
  const current = readAttachment(root);

  if (current && current.session_id !== sessionId) {
    if (!opts.takeover) {
      throw new AttachmentConflictError(
        `Another session is already attached (session_id=${current.session_id}, host=${current.host}, attached_at=${current.attached_at}). ` +
        `Pass --takeover --confirm to take over explicitly.`,
        current,
      );
    }
    const next: AttachmentRecord = {
      session_id: sessionId,
      host,
      attached_at: now.toISOString(),
    };
    writeAttachmentRecord(next, root);
    return { outcome: 'took-over', previous: current, current: next };
  }

  const next: AttachmentRecord = {
    session_id: sessionId,
    host,
    attached_at: now.toISOString(),
  };
  writeAttachmentRecord(next, root);
  return {
    outcome: current ? 'refreshed' : 'attached',
    previous: current,
    current: next,
  };
}

export type ReleaseOutcome = 'released' | 'not-attached' | 'not-owner';

export interface ReleaseResult {
  outcome: ReleaseOutcome;
}

/**
 * Clear the attachment if and only if this session owns it.
 *
 *   - 'released'    — the record existed, was owned by this session, and was deleted.
 *   - 'not-attached'— no record existed. Idempotent.
 *   - 'not-owner'   — a different session owns the record; the call is a no-op.
 *                     This is what session-end.sh relies on when called from
 *                     a session that never attached.
 */
export function release(opts: { sessionId: string }, projectRoot?: string): ReleaseResult {
  const sessionId = normalizeIdentity(opts.sessionId ?? '');
  if (!sessionId) {
    throw new Error('release: sessionId is required');
  }
  const root = projectRoot ?? findProjectRoot();
  const current = readAttachment(root);
  if (!current) return { outcome: 'not-attached' };
  if (current.session_id !== sessionId) return { outcome: 'not-owner' };
  try {
    unlinkSync(attachmentFilePath(root));
  } catch (err) {
    // Only a missing file means "already released". Anything else (a
    // permissions problem, a directory in the way) leaves the record on disk,
    // and reporting 'released' would tell the caller ownership is gone while
    // the next session is still blocked by it — so let it surface.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return { outcome: 'released' };
}

/**
 * Clear the attachment unconditionally, whoever owns it.
 *
 * This is NOT a session operation — `release()` is, and it is owner-gated.
 * This exists for the one administrative case where no session owns the
 * record by definition any more: auto-checkpoint being switched off. The
 * attachment is the intent boundary *for auto-checkpoint*, so with the mode
 * off there is nothing left for it to gate, and leaving it behind means the
 * next session to enable the mode is greeted by an owner that no longer
 * exists and is forced through a takeover confirmation for no reason.
 *
 * Returns true when a record was removed. A missing file is not an error;
 * anything else surfaces, for the same reason `release()` surfaces it — a
 * silent failure here leaves the dead owner in place, which is the whole bug.
 */
export function clearAttachment(projectRoot?: string): boolean {
  const root = projectRoot ?? findProjectRoot();
  if (!readAttachment(root)) return false;
  try {
    unlinkSync(attachmentFilePath(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return false;
  }
  return true;
}

/**
 * True when an attachment exists and is owned by this session.
 *
 * A missing or unreadable record is "not attached" — there is no implicit
 * attachment. This is the single check markDirty / shouldReconcile rely on.
 */
export function isAttached(sessionId: string, projectRoot?: string): boolean {
  const normalized = normalizeIdentity(sessionId ?? '');
  if (!normalized) return false;
  const current = readAttachment(projectRoot);
  return current !== null && current.session_id === normalized;
}

/**
 * Convenience for adapters: the prompt that should accompany a fresh session
 * opening in a project with active task-store work.
 *
 * When `current` is null the wording mirrors the issue example ("This project
 * has active task-store work. Continue those tasks in this session?"). When
 * `current` is set, the wording tells the agent a takeover is required and
 * gives the exact command to run. The text is intentionally short — it is
 * injected at session start, which is a boundary the user did not ask for.
 *
 * Caller passes the command this session would run to attach (or takeover).
 * The host formats session_id into the command using its own conventions;
 * this module stays provider-neutral.
 */
export interface AttachPromptInput {
  current: AttachmentRecord | null;
  attachCommand: string;
  takeoverCommand: string;
  /** When set, override the "since Y" suffix (otherwise derived from current). */
  attachedSince?: string;
}

export function renderAttachPrompt(input: AttachPromptInput): string {
  if (input.current) {
    const since = input.attachedSince ?? input.current.attached_at;
    return [
      '[task-store] Active task-store work is already attached to another session',
      `(session_id=${input.current.session_id}, host=${input.current.host}, since=${since}).`,
      '',
      'This session is detached from auto-checkpoint by design. Ask the user:',
      '"Another session is already attached to this project\'s task-store work.',
      'Continue those tasks in this session?"',
      `  yes (take over) -> ${input.takeoverCommand}`,
      '  no              -> do nothing; this session stays detached',
    ].join('\n');
  }
  return [
    '[task-store] Active task-store work exists for this project.',
    'This session is detached from auto-checkpoint by design. Ask the user:',
    '"This project has active task-store work. Continue those tasks in this session?"',
    `  yes -> ${input.attachCommand}`,
    '  no  -> do nothing; this session stays detached',
  ].join('\n');
}

/**
 * Advisory check used by `attach status` to flag unknown host identifiers.
 * Not enforced — adapters can pass any string — but useful for surfacing
 * typos and stale values to humans reading the status output.
 */
export function isKnownHost(host: string): boolean {
  return KNOWN_HOSTS[host] === true;
}
