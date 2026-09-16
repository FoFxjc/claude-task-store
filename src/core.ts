#!/usr/bin/env node
/**
 * claude-task-store: Core task state management library
 *
 * Handles all read/write operations against .claude-task/state.json and history.jsonl
 * Uses atomic writes to prevent corruption.
 */

import { readFileSync, existsSync } from 'fs';
import { historyFilePath } from './paths.js';
import { withStoreLock } from './lock.js';
import { getActiveTopic, StateError, validateState } from './codec.js';
import { readState, writeState, appendHistory } from './storage.js';
import type {
  Decision, Task, TaskState, TopicState,
} from './types.js';
import { DEFAULT_TOPIC, SCHEMA_VERSION } from './types.js';

export { SCHEMA_VERSION, DEFAULT_TOPIC } from './types.js';


// ─── Compact resume summary ───────────────────────────────────────────────────

/** Hard character budget for the resume projection. The COMPLETE returned
 * string — including any global omission marker or truncation marker —
 * never exceeds this value. */
export const RESUME_BUDGET_CHARS = 1600;

/** Marker appended when the renderer had to truncate. */
export const RESUME_TRUNCATION_SUFFIX = "\n[…truncated, run `task-store status` for full details]";

// Global omission marker. Appended after a blank separator line when any
// section was collapsed, soft-capped, field-bounded, or dropped. The
// blank line is produced by `out.push('')` in the assembly, not by the
// marker itself. A reserved slice of the budget guarantees this line
// always fits.
const GLOBAL_OMISSION_MARKER = '[…details omitted, run `task-store status` for full details]';

// appendLines-style separation produces a blank line, so reserve two
// newlines as well as the marker itself.
const GLOBAL_RESERVED = GLOBAL_OMISSION_MARKER.length + 2;

const STATUS_POINT = "use \`task-store status\` for full details";

// Per-line bounds. Every emitted line is pre-truncated during assembly,
// so `fitResumeToBudget` only ever drops whole lines, never mid-line slices.
const MAX_TOPIC_CHARS = 50;
const MAX_GOAL_CHARS = 200;
const MAX_NEXT_ACTION_CHARS = 200;
const MAX_TITLE_CHARS = 80;
const MAX_NOTE_CHARS = 160;
const MAX_BLOCKER_CHARS = 160;
const MAX_DECISION_CHARS = 150;
const MAX_ATTEMPT_FIELD_CHARS = 100;
const SOFT_MAX_DONE = 5;
const SOFT_MAX_DECISIONS = 3;
const SOFT_MAX_ATTEMPTS = 2;

// Per-call stats object. Passed through every buildResumeContext call so
// the function is safe for concurrent / re-entrant use (no module-level
// mutable state that could bleed between concurrent calls).
interface RenderStats {
  fieldBounded: boolean;
}

function bound(s: string, max: number, stats: RenderStats): string {
  if (s.length <= max) return s;
  stats.fieldBounded = true;
  return s.slice(0, max - 1) + '…';
}

/** Enforce `result.length <= budget`. If the text already fits the budget
 * it is returned unchanged. Otherwise, the suffix is appended
 * at a complete-line boundary: find the last newline in the budget-allowable
 * prefix, truncate there, and append the suffix. If even the suffix alone
 * exceeds the budget (e.g. the budget was tightened below the suffix length),
 * the suffix is clamped to the budget and returned as-is.
 *
 * Postcondition: `result.length <= budget` always holds.
 * No partial line is ever emitted.
 */
export function fitResumeToBudget(text: string, budget = RESUME_BUDGET_CHARS): string {
  const safeBudget = Math.max(0, budget);
  if (text.length <= safeBudget) return text;
  // Clamp the suffix to the budget so maxPrefix is never negative.
  const safeSuffix = RESUME_TRUNCATION_SUFFIX.slice(0, safeBudget);
  const maxPrefix = safeBudget - safeSuffix.length;
  const lastNewline = text.slice(0, maxPrefix).lastIndexOf('\n');
  if (lastNewline > 0) {
    return text.slice(0, lastNewline) + safeSuffix;
  }
  return safeSuffix;
}

/**
 * Build a compact resume injection for session start.
 *
 * Output order, top to bottom. Priority is top-down so a budget-driven
 * tail-trim cannot remove a higher-priority field:
 *
 *   1. Header        — TOPIC, GOAL, STATUS (always shown, bounded per line)
 *   2. CURRENT       — in-progress task + last attempts (always shown)
 *   3. NEXT ACTION   — always shown, bounded
 *   4. BLOCKED       — with reason + last attempts (always shown)
 *   5. DONE          — optional, count summary if too long
 *   6. REMAINING     — optional, count summary if too long
 *   7. KEY DECISIONS — optional, count summary if too long
 *   8. Footer        — timestamp + hint (always shown)
 *
 * Every section that is not rendered in full is replaced with a one-line
 * marker naming the section, identifying the omitted content (count, and
 * task IDs for CURRENT/BLOCKED), and pointing at `task-store status`.
 * No omission is ever silent.
 *
 * Soft-capped sections (DONE/KEY DECISIONS with more items than the
 * soft cap) emit a `+N older — use \`task-store status\`` indicator
 * inside the section so the reader knows older items are present.
 * Attempts past the last 2 emit a `+N earlier attempts` line.
 *
 * Rendering uses a two-pass approach:
 *   • Pass 1 renders at full budget (1 600 chars) with no marker
 *     reservation. If no omission occurs, the result is returned
 *     immediately (no space is wasted on a marker that was not needed).
 *   • If any content is collapsed, soft-capped, field-bounded, or
 *     dropped, Pass 2 re-renders with an effective budget that reserves
 *     space for the global omission marker, and appends the marker.
 *
 * Token counts are approximate (no model-specific tokenizer). The
 * postcondition `result.length <= RESUME_BUDGET_CHARS` holds for the
 * COMPLETE returned string. This function is pure and safe for
 * concurrent / re-entrant calls (no module-level mutable state).
 */
export function buildResumeContext(state: TaskState): string {
  // Pure stats object — no module-level mutable state, so concurrent or
  // re-entrant calls cannot bleed into each other.
  const stats: RenderStats = { fieldBounded: false };

  const topic = getActiveTopic(state);
  const inProgress = topic.tasks.filter(t => t.status === 'in_progress');
  const blocked = topic.tasks.filter(t => t.status === 'blocked');
  const done = topic.tasks.filter(t => t.status === 'done');
  const remaining = topic.tasks.filter(t => t.status === 'pending');
  const decisions = topic.decisions ?? [];

  // Each section's lines are pre-bounded. Assembly picks the largest
  // form that fits; any non-full section gets an explicit marker.
  const sections: Section[] = [
    { label: 'header', lines: renderHeader(topic, stats) },
    { label: 'CURRENT', lines: renderCurrent(inProgress, stats),
      count: countWithIds('CURRENT', 'in-progress', inProgress) },
    { label: 'NEXT ACTION', lines: renderNextAction(topic, stats) },
    { label: 'BLOCKED', lines: renderBlocked(topic, blocked, stats),
      count: countWithIds('BLOCKED', 'blocked', blocked) },
    { label: 'DONE', lines: renderDone(done, stats),
      count: countOnly('DONE', 'completed', done.length) },
    { label: 'REMAINING', lines: renderRemaining(remaining, stats),
      count: countOnly('REMAINING', 'pending', remaining.length) },
    { label: 'KEY DECISIONS', lines: renderDecisions(decisions, stats),
      count: countOnly('KEY DECISIONS', 'recorded', decisions.length) },
    { label: 'footer', lines: renderFooter(state) },
  ];

  // ── Pass 1: full budget, no marker reservation ────────────────────────
  const out1: string[] = [];
  let droppedCount = 0;
  let collapsedCount = 0;
  let softCappedCount = 0;
  for (const section of sections) {
    const r = appendSection(out1, section, RESUME_BUDGET_CHARS);
    if (r.dropped) droppedCount++;
    if (r.collapsed) collapsedCount++;
    if (r.softCapped) softCappedCount++;
  }

  const anyOmission = stats.fieldBounded || droppedCount > 0 || collapsedCount > 0 || softCappedCount > 0;
  if (!anyOmission) {
    // No omission occurred. The complete pre-bounded render is within
    // 1 600 chars. Return it directly — no marker space was wasted.
    // Wrap in fitResumeToBudget as a last-resort hard bound; it returns
    // text unchanged when length <= budget so this is a zero-cost safety net.
    return fitResumeToBudget(out1.join('\n'));
  }

  // ── Pass 2: omission was needed — re-render with marker budget ───────
  // Sections may be dropped at a tighter effective budget. The `stats`
  // flags are deterministic (bound() is pure) so the result is consistent.
  const out2: string[] = [];
  droppedCount = 0;
  collapsedCount = 0;
  softCappedCount = 0;
  const effectiveBudget = RESUME_BUDGET_CHARS - GLOBAL_RESERVED;
  for (const section of sections) {
    const r = appendSection(out2, section, effectiveBudget);
    if (r.dropped) droppedCount++;
    if (r.collapsed) collapsedCount++;
    if (r.softCapped) softCappedCount++;
  }
  out2.push('');
  out2.push(GLOBAL_OMISSION_MARKER);
  // Wrap in fitResumeToBudget as a last-resort hard bound, even though
  // accounting guarantees the result is within budget.
  return fitResumeToBudget(out2.join('\n'));
}

interface Section {
  label: string;
  lines: string[];
  count?: string;
  omitted?: string;
}

interface AppendResult {
  dropped: boolean;
  collapsed: boolean;
  /** True if the section's rendering already includes a soft-cap indicator
   * (e.g. `+N older` for DONE). Tracked separately from `dropped` and
   * `collapsed` because it fires the global marker even when the full
   * form fits in the budget. */
  softCapped: boolean;
}

function appendSection(out: string[], section: Section, effectiveBudget: number): AppendResult {
  const omitted = `${section.label}: omitted — ${STATUS_POINT}`;
  const softCapped = section.lines.some(l => /^\s*\+\d+ (older|earlier)/.test(l));

  if (section.lines.length === 0) {
    return { dropped: false, collapsed: false, softCapped: false };
  }
  if (sectionFits(out, section.lines, effectiveBudget)) {
    appendLines(out, section.lines);
    return { dropped: false, collapsed: false, softCapped };
  }
  if (section.count && sectionFits(out, [section.count], effectiveBudget)) {
    appendLines(out, [section.count]);
    return { dropped: false, collapsed: true, softCapped: false };
  }
  if (sectionFits(out, [omitted], effectiveBudget)) {
    appendLines(out, [omitted]);
    return { dropped: false, collapsed: true, softCapped: false };
  }
  // Even the omitted line does not fit. The section is dropped.
  // The global omission marker is added at the end of the build.
  return { dropped: true, collapsed: false, softCapped: false };
}

// appendLines inserts an empty element, which renders as a blank line and
// therefore costs two newline characters between non-empty sections.
function sectionFits(out: string[], lines: string[], effectiveBudget: number): boolean {
  return joinLength(out) + joinLength(lines) + (out.length > 0 ? 2 : 0) <= effectiveBudget;
}

function appendLines(out: string[], lines: string[]): void {
  if (out.length > 0) out.push('');
  out.push(...lines);
}

function joinLength(lines: string[]): number {
  if (lines.length === 0) return 0;
  let n = 0;
  for (const l of lines) n += l.length;
  return n + (lines.length - 1);
}

function countOnly(label: string, kind: string, n: number): string {
  return `${label}: ${n} ${kind} — ${STATUS_POINT}`;
}

function countWithIds(label: string, kind: string, tasks: Task[]): string {
  return `${label}: ${tasks.length} ${kind} (${tasks.map(t => t.id).join(', ')}) — ${STATUS_POINT}`;
}

// ─── Section renderers. Each returns pre-bounded lines. ───────────────────

function renderHeader(topic: TopicState, stats: RenderStats): string[] {
  return [
    '╔══════════════════════════════════════╗',
    '║  TASK STORE — RESUME CONTEXT         ║',
    '╚══════════════════════════════════════╝',
    `TOPIC: ${bound(topic.name, MAX_TOPIC_CHARS, stats)}`,
    `GOAL: ${bound(topic.goal, MAX_GOAL_CHARS, stats)}`,
    `STATUS: ${topic.status.toUpperCase()}`,
  ];
}

function renderCurrent(inProgress: Task[], stats: RenderStats): string[] {
  if (inProgress.length === 0) return [];
  const lines = ['CURRENT:'];
  for (const t of inProgress) {
    lines.push(`  ▶ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
    if (t.notes) lines.push(`    NOTE: ${bound(t.notes, MAX_NOTE_CHARS, stats)}`);
    if (t.attempts && t.attempts.length > 0) {
      const recent = t.attempts.slice(-SOFT_MAX_ATTEMPTS);
      const earlier = t.attempts.length - SOFT_MAX_ATTEMPTS;
      if (earlier > 0) lines.push(`    +${earlier} earlier attempts`);
      for (const a of recent) {
        lines.push(`    ✗ tried: ${bound(a.description, MAX_ATTEMPT_FIELD_CHARS, stats)} → ${bound(a.outcome, MAX_ATTEMPT_FIELD_CHARS, stats)}`);
      }
    }
  }
  return lines;
}

function renderBlocked(topic: TopicState, blocked: Task[], stats: RenderStats): string[] {
  if (blocked.length === 0) return [];
  const lines = ['BLOCKED:'];
  for (const t of blocked) {
    // The blocker reason lives in topic.blockers (task.notes is preserved,
    // not overwritten, when a task is blocked) — look up the most recent
    // blocker entry for this task to render the reason.  Only include a
    // reason when one was explicitly recorded; do not echo the task title
    // as a self-referential "title: title" fallback.
    const blocker = (topic.blockers ?? []).slice().reverse().find(b => b.task_id === t.id);
    const explicitReason = blocker?.description ?? t.notes;
    if (explicitReason) {
      lines.push(`  ✗ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}: ${bound(explicitReason, MAX_BLOCKER_CHARS, stats)}`);
    } else {
      lines.push(`  ✗ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
    }
    if (t.attempts && t.attempts.length > 0) {
      const recent = t.attempts.slice(-SOFT_MAX_ATTEMPTS);
      const earlier = t.attempts.length - SOFT_MAX_ATTEMPTS;
      if (earlier > 0) lines.push(`    +${earlier} earlier attempts`);
      for (const a of recent) {
        lines.push(`    ✗ tried: ${bound(a.description, MAX_ATTEMPT_FIELD_CHARS, stats)} → ${bound(a.outcome, MAX_ATTEMPT_FIELD_CHARS, stats)}`);
      }
    }
  }
  return lines;
}

function renderNextAction(topic: TopicState, stats: RenderStats): string[] {
  return [`NEXT ACTION: ${bound(topic.next_action ?? '(not set — run /task-status)', MAX_NEXT_ACTION_CHARS, stats)}`];
}

function renderDone(done: Task[], stats: RenderStats): string[] {
  if (done.length === 0) return [];
  const recent = done.slice(-SOFT_MAX_DONE);
  const older = done.length - SOFT_MAX_DONE;
  const lines: string[] = ['DONE:'];
  if (older > 0) lines.push(`  +${older} older — use \`task-store status\` to see all`);
  for (const t of recent) {
    lines.push(`  ✓ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`);
  }
  return lines;
}

function renderRemaining(remaining: Task[], stats: RenderStats): string[] {
  if (remaining.length === 0) return [];
  return ['REMAINING:', ...remaining.map(t => `  ○ [${t.id}] ${bound(t.title, MAX_TITLE_CHARS, stats)}`)];
}

function renderDecisions(decisions: Decision[], stats: RenderStats): string[] {
  if (decisions.length === 0) return [];
  const recent = decisions.slice(-SOFT_MAX_DECISIONS);
  const older = decisions.length - SOFT_MAX_DECISIONS;
  const lines: string[] = ['KEY DECISIONS:'];
  if (older > 0) lines.push(`  +${older} earlier — use \`task-store status\` to see all`);
  for (const d of recent) {
    lines.push(`  • ${bound(d.summary, MAX_DECISION_CHARS, stats)}`);
  }
  return lines;
}

function renderFooter(state: TaskState): string[] {
  return [
    `Updated: ${state.updated_at.slice(0, 16).replace('T', ' ')} UTC`,
    '─── /task-status for details | /task-history for audit ───',
  ];
}




/** Stale threshold: tasks in_progress for more than this many hours trigger a warning. */
const STALE_TASK_HOURS = 48;

export interface StaleTaskWarning {
  taskId: string;
  title: string;
  startedAt: string;
  hoursElapsed: number;
}

/**
 * Detect tasks that have been in_progress for an abnormally long time.
 * Returns warnings, does NOT modify state — the model decides what to do.
 */
export function detectStaleTasks(projectRoot?: string): StaleTaskWarning[] {
  const state = readState(projectRoot);
  if (!state) return [];
  const topic = getActiveTopic(state);

  const now = Date.now();
  const warnings: StaleTaskWarning[] = [];

  for (const task of topic.tasks) {
    if (task.status === 'in_progress' && task.started_at) {
      const startMs = new Date(task.started_at).getTime();
      const hoursElapsed = (now - startMs) / (1000 * 60 * 60);
      if (hoursElapsed > STALE_TASK_HOURS) {
        warnings.push({
          taskId: task.id,
          title: task.title,
          startedAt: task.started_at,
          hoursElapsed: Math.round(hoursElapsed),
        });
      }
    }
  }

  return warnings;
}

/**
 * Attempt to recover the last valid state from history.jsonl
 */
export function repairState(projectRoot?: string, updatedBy?: string): TaskState | null {
  const histPath = historyFilePath(projectRoot);
  if (!existsSync(histPath)) return null;

  const lines = readFileSync(histPath, 'utf8').split('\n').filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { event: string; snapshot?: TaskState };
      if (entry.event === 'state_updated' && entry.snapshot) {
        const state = validateState(entry.snapshot);
        writeState(state, projectRoot, updatedBy);
        return state;
      }
    } catch {
      continue;
    }
  }
  return null;
}
