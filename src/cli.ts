#!/usr/bin/env node
/**
 * task-store CLI
 * Usage: task-store <command> [args]
 */

import {
  initState, startTask, completeTask, blockTask,
  resumeTask, addTask, recordAttempt, recordDecision, setNextAction,
  archiveState, buildResumeContext, repairState, detectStaleTasks, RESUME_BUDGET_CHARS,
  compareAndWriteState, ConflictError,
  addTopic, useTopic, commitBatch,
} from './core.js';
import { readState, writeState } from './storage.js';
import { StateError, getActiveTopic } from './codec.js';
import { findProjectRoot, storePath, stateFilePath, historyFilePath } from './paths.js';
import { withStoreLock, LockError } from './lock.js';
import {
  readConfig, writeMode, markDirty, shouldReconcile, markReconcileRequested,
  markReconciled, freshness, readRuntime, RECONCILE_INSTRUCTION, takePendingInstruction,
  stagePendingInstruction, pendingInstructionFilePath, isEnabled,
  DEFAULT_DEBOUNCE_SECONDS, debounceSeconds, configFilePath,
  NEW_STORE_MODE,
  type AutoCheckpointMode,
} from './autocheckpoint.js';
import {
  attach as attachSession,
  release as releaseSession,
  readAttachment,
  AttachmentConflictError,
  isKnownHost,
  isAttached as isAttachedSession,
} from './attachment.js';
import { readFileSync, existsSync } from 'fs';

const HELP = `
claude-task-store — persistent execution checkpoint for Claude Code

COMMANDS:
  init <goal> [task1] [task2] ...   Initialize a new task store (auto-checkpoint: ${NEW_STORE_MODE})
  status [--topic <name>]          Show current state summary
  show <taskId> [--topic <name>]   Show one task's checkpoint details
  resume                            Print compact resume context (for session injection)
  topic add <name> <goal> [tasks...] Add a named topic (does not switch to it)
  topic list                        List topics and show which one is active
  topic use <name>                  Switch the active topic
  add <title>                       Add a new task
  start <taskId>                    Mark task as in-progress (e.g. T1)
  done <taskId> -e <evidence> ...   Mark task done with evidence (--evidence works too)
  block <taskId> <reason>           Mark task blocked with reason
  resume-task <taskId>              Resume a blocked task
  attempt <taskId> <desc> <outcome> Record a failed attempt
  decide <summary> [rationale]      Record a key decision
  next <action>                     Set the next action
  commit --topic <name> [--expect-rev N] < batch.json
                                     Apply a batch of operations atomically (see docs/batch-commit.md)
  history [--tail N]                Show history log
  archive                           Archive the current state
  repair                            Attempt to recover from corrupted state.json
  stale                             Detect tasks in_progress for >48h
  token-estimate                    Estimate the token size of the resume context

CONFIG:
  config                            Show project-local task-store configuration
  config auto-checkpoint            Show the current auto-checkpoint mode
  config auto-checkpoint <mode>     Set the mode: off | conservative

AUTO-CHECKPOINT (adapter plumbing — used by hooks/plugins, rarely by hand):
  auto status                       Show dirty/freshness state and why
  auto mark-dirty [signal]          Record that repository state may have changed
                                    (requires --session-id matching the attached session)
  auto check [--instruction]        Exit 0 if reconciliation is warranted, else 1
                                    (requires --session-id matching the attached session)
  auto reconciled                   Record that reconciliation completed
                                    (requires --session-id matching the attachment)
  auto stage-instruction            Decide + stage a reconciliation instruction for
                                    the owning session's next chat call, in one step
  auto take-instruction             Hand the staged reconciliation instruction to
                                    the owning session (one-shot), else exit 1

  These commands never read or write task state. Checkpoint mutation stays
  exclusive to the verbs above (start/done/attempt/block/decide/next).

SESSION ATTACHMENT (intent boundary, conservative auto-checkpoint only):
  attach status                     Show the current attachment (or "none")
  attach --session-id <id> --host <h> --yes
                                    Attach this session (fails if another owns)
  attach --session-id <id> --host <h> --takeover --confirm
                                    Attach by taking over an existing owner
  attach --session-id <id> --release
                                    Release the attachment if owned by this session
                                    (--host is accepted but not required: release
                                    checks ownership, which the host is not part of)

FLAGS:
  --root <path>         Use a specific project root (default: auto-detect from cwd)
  --auto-checkpoint <mode>
                        Set the initial mode: ${NEW_STORE_MODE} (default) | off
  --by <agent>          Record who/what is writing (e.g. --by claude-code, --by codex)
  --session-id <id>     Session identifier (used by auto/attach to gate on ownership)
  --host <name>         Host identifier for attach: claude-code | opencode | manual
  --yes                 Attach without --takeover (default when no current owner)
  --takeover            Overwrite the existing attachment (requires --confirm)
  --confirm             Confirm a --takeover (required for explicit takeover)
  --expect-rev <N>      Optimistic concurrency: fail if on-disk revision != N.
                         Enforced atomically via an O_EXCL lock file around the
                         read-compare-write cycle for this CLI invocation — see
                         docs/pre-release-remediation.md item 3 for the exact
                         guarantee (protects concurrent task-store CLI callers;
                         does not protect direct library callers).
  --topic <name>        Topic scope for commit, status, and show.
  --help, -h            Show this help
`;
function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean>; evidence: string[] } {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const evidence: string[] = [];
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { flags.help = true; }
    else if (a === '--root') { flags.root = argv[++i] ?? ''; }
    else if (a === '-e' || a === '--evidence') {
      // Evidence flag: each `-e` takes exactly one following value, kept as
      // a single opaque string. Multiple `-e` flags accumulate into a plain
      // string[] — there is no delimiter-based join/split round trip, so
      // evidence text may safely contain commas, quotes, or any other
      // characters.
      //
      // `--evidence` is accepted as an alias because that is what an agent
      // writing the command from memory actually types. Without it the flag
      // fell through to the positional-args branch and `done` recorded the
      // literal string "--evidence" as the first piece of evidence — observed
      // in a real Claude Code session, and silently corrupting the one field
      // whose whole purpose is to be trustworthy.
      const value = argv[++i];
      if (value === undefined) {
        console.error(`Error: ${a} requires a value`);
        process.exit(1);
      }
      evidence.push(value);
    }
    else if (a === '--tail') { flags.tail = argv[++i] ?? '20'; }
    else if (a === '--auto-checkpoint') {
      const value = argv[++i];
      if (value === undefined) {
        console.error('Error: --auto-checkpoint requires a value');
        process.exit(1);
      }
      flags['auto-checkpoint'] = value;
    }
    else if (a === '--by') { flags.by = argv[++i] ?? ''; }
    else if (a === '--expect-rev') { flags['expect-rev'] = argv[++i] ?? ''; }
    else if (a === '--topic') {
      const value = argv[++i];
      if (value === undefined) {
        console.error('Error: --topic requires a value');
        process.exit(1);
      }
      flags.topic = value;
    }
    else if (a === '--session-id') {
      const value = argv[++i];
      if (value === undefined) {
        console.error('Error: --session-id requires a value');
        process.exit(1);
      }
      flags['session-id'] = value;
    }
    else if (a === '--host') {
      const value = argv[++i];
      if (value === undefined) {
        console.error('Error: --host requires a value');
        process.exit(1);
      }
      flags.host = value;
    }
    else if (a === '--yes') { flags.yes = true; }
    else if (a === '--takeover') { flags.takeover = true; }
    else if (a === '--confirm') { flags.confirm = true; }
    else if (a === '--release') { flags.release = true; }
    else if (!command) { command = a; }
    else { args.push(a); }
  }

  return { command, args, flags, evidence };
}

function printState(projectRoot?: string, topicName?: string): void {
  const state = readState(projectRoot);
  if (!state) {
    console.log('No task state found. Run `task-store init "<goal>" [tasks...]` to start.');
    return;
  }

  const topic = topicName === undefined
    ? getActiveTopic(state)
    : (() => {
        const normalizedName = topicName.trim();
        if (!normalizedName) throw new StateError('Topic name must be a non-empty string');
        const selected = state.topics.find(candidate => candidate.name === normalizedName);
        if (!selected) throw new StateError(`Topic not found: ${normalizedName}`);
        return selected;
      })();
  console.log(`\nTOPIC: ${topic.name}`);
  console.log(`GOAL: ${topic.goal}`);
  console.log(`STATUS: ${topic.status.toUpperCase()}`);
  console.log(`\nTASKS:`);
  for (const t of topic.tasks) {
    const icon = { done: '✓', in_progress: '▶', blocked: '✗', pending: '○', skipped: '–' }[t.status] ?? '?';
    console.log(`  ${icon} [${t.id}] ${t.title}  (${t.status})`);
    if (t.notes) console.log(`       ${t.notes}`);
    if (t.attempts && t.attempts.length > 0) {
      for (const a of t.attempts) console.log(`       ✗ tried: ${a.description} → ${a.outcome}`);
    }
    if (t.evidence && t.evidence.length > 0) {
      console.log(`       evidence: ${t.evidence.join(', ')}`);
    }
  }

  if (topic.decisions && topic.decisions.length > 0) {
    console.log(`\nDECISIONS:`);
    for (const d of topic.decisions) console.log(`  • ${d.summary}`);
  }

  if (topic.blockers && topic.blockers.length > 0) {
    console.log(`\nBLOCKERS:`);
    for (const b of topic.blockers) console.log(`  ✗ [${b.task_id ?? '–'}] ${b.description}`);
  }

  console.log(`\nNEXT ACTION: ${topic.next_action ?? '(not set)'}`);

  // Show stale task warnings
  const stale = topic.name === state.active_topic ? detectStaleTasks(projectRoot) : [];
  if (stale.length > 0) {
    console.log(`\n⚠  STALE TASKS (in_progress > 48h):`);
    for (const s of stale) {
      console.log(`   [${s.taskId}] ${s.title} — ${s.hoursElapsed}h elapsed`);
      console.log(`   Consider: block it, complete it, or reset to pending`);
    }
  }

  // Auto-checkpoint visibility. Always shown so a user can tell at a glance
  // whether the feature is on — "is this thing enabled?" should never require
  // reading a config file by hand.
  const config = readConfig(projectRoot);
  console.log(`\nAuto-checkpoint: ${config.auto_checkpoint}`);

  if (config.auto_checkpoint === 'conservative') {
    const fresh = freshness(projectRoot);
    if (fresh.stale) {
      // Deliberately hedged wording. All we actually know is that files or
      // commands changed something and the checkpoint has not been written
      // since — that is a hint, not proof that the checkpoint is wrong.
      console.log(`⚠  task-store may be stale — ${fresh.signals} change signal(s) since the last checkpoint write.`);
      console.log(`   Reconcile with: task-store start|done|attempt|block|decide|next`);
    }
  }

  console.log(`\nState file: ${stateFilePath(projectRoot)}`);
  console.log(`Updated: ${state.updated_at}${state.updated_by ? ` by ${state.updated_by}` : ''} (rev ${state.revision ?? 0})`);
}

function printTask(taskId: string, topicName: string | undefined, projectRoot?: string): void {
  const state = readState(projectRoot);
  if (!state) {
    throw new StateError('No state found.');
  }

  const normalizedTopicName = topicName === undefined ? state.active_topic : topicName.trim();
  if (!normalizedTopicName) throw new StateError('Topic name must be a non-empty string');
  const topic = state.topics.find(candidate => candidate.name === normalizedTopicName);
  if (!topic) throw new StateError(`Topic not found: ${normalizedTopicName}`);

  const normalizedTaskId = taskId.toUpperCase();
  const task = topic.tasks.find(candidate => candidate.id === normalizedTaskId);
  if (!task) throw new StateError(`Task not found: ${normalizedTaskId}`);

  console.log(`TASK: ${task.id}`);
  console.log(`TOPIC: ${topic.name}`);
  console.log(`TITLE: ${task.title}`);
  console.log(`STATUS: ${task.status.toUpperCase()}`);
  console.log(`NOTES: ${task.notes ?? '(none)'}`);
  console.log(`STARTED: ${task.started_at ?? '(not started)'}`);
  console.log(`COMPLETED: ${task.completed_at ?? '(not completed)'}`);

  const evidence = task.evidence ?? [];
  console.log('EVIDENCE:');
  if (evidence.length === 0) console.log('  (none)');
  else for (const item of evidence) console.log(`  - ${item}`);

  const attempts = task.attempts ?? [];
  console.log('ATTEMPTS:');
  if (attempts.length === 0) console.log('  (none)');
  else for (const attempt of attempts) {
    const at = attempt.at ? `[${attempt.at}] ` : '';
    console.log(`  - ${at}${attempt.description} → ${attempt.outcome}`);
  }

  const blockers = (topic.blockers ?? []).filter(blocker => blocker.task_id === task.id);
  console.log('BLOCKERS:');
  if (blockers.length === 0) console.log('  (none)');
  else for (const blocker of blockers) {
    const since = blocker.since ? ` [${blocker.since}]` : '';
    console.log(`  - ${blocker.description}${since}`);
  }
}

function printTopics(projectRoot?: string): void {
  const state = readState(projectRoot);
  if (!state) {
    console.log('No task state found. Run `task-store init "<goal>" [tasks...]` to start.');
    return;
  }

  console.log('TOPICS:');
  for (const topic of state.topics) {
    const marker = topic.name === state.active_topic ? '*' : ' ';
    console.log(`${marker} ${topic.name}  (${topic.status}) — ${topic.goal}`);
  }
}

async function main(): Promise<void> {
  const { command, args, flags, evidence } = parseArgs(process.argv.slice(2));
  const projectRoot = flags.root ? String(flags.root) : findProjectRoot();

  if (flags.help || !command) {
    console.log(HELP);
    process.exit(0);
  }

  try {
    const by = flags.by ? String(flags.by) : undefined;
    // Parse --expect-rev as a strict non-negative integer.
    // NaN coercion handles strings like "1abc" → NaN, rejected here.
    // The 'commit' command is excluded; commitBatch() is the only revision
    // check for it (under its own lock), and it handles its own strict validation.
    const expectRevStr = flags['expect-rev'];
    const expectRev = expectRevStr !== undefined
      ? (() => { const n = Number(expectRevStr); if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || String(n) !== String(expectRevStr)) { console.error('Error: --expect-rev must be a non-negative integer'); process.exit(1); } return n; })()
      : undefined;
    const initialAutoCheckpoint = flags['auto-checkpoint'] !== undefined
      ? String(flags['auto-checkpoint'])
      : NEW_STORE_MODE;

    if (flags['auto-checkpoint'] !== undefined && command !== 'init') {
      console.error('Error: --auto-checkpoint is only supported on `init`.');
      process.exit(1);
    }
    // --by is only meaningful on commands that write state. Passing it to a
    // read-only command was previously silently ignored, which is not
    // acceptable — reject it explicitly instead (see
    // docs/pre-release-remediation.md item 6).
    const READ_ONLY_COMMANDS = new Set(['status', 'show', 'resume', 'history', 'stale', 'token-estimate']);
    const topicSubcommand = command === 'topic' ? args[0] : undefined;
    const topicIsReadOnly = command === 'topic' && topicSubcommand === 'list';
    // `config` and `auto` write files, but never task state — recording an
    // author for them would be meaningless, so --by is rejected there too.
    const NON_STATE_COMMANDS = new Set(['config', 'auto']);
    if (by !== undefined && (READ_ONLY_COMMANDS.has(command) || topicIsReadOnly || NON_STATE_COMMANDS.has(command))) {
      console.error(`Error: --by is not supported on \`${command}\` (it never writes task state).`);
      process.exit(1);
    }
    if (flags.topic !== undefined && command !== 'commit' && command !== 'status' && command !== 'show') {
      console.error(`Error: --topic is not supported on \`${command}\`.`);
      process.exit(1);
    }

    // Session-attachment flags are only meaningful on `attach` and `auto`.
    // Reject them on every other command so an agent typing the wrong
    // place gets a loud error rather than silently no-op'ing later.
    const ATTACHMENT_FLAGS = ['session-id', 'host', 'yes', 'takeover', 'confirm', 'release'] as const;
    if (command !== 'attach' && command !== 'auto') {
      for (const f of ATTACHMENT_FLAGS) {
        if (flags[f] !== undefined) {
          console.error(`Error: --${f} is only supported on \`attach\` and \`auto\`.`);
          process.exit(1);
        }
      }
    }
    // On `auto`, the only meaningful attachment flag is --session-id. The
    // auto verbs never read a host, and a session cannot attach itself through
    // `auto` — so --host / --yes / --takeover / --confirm / --release there
    // were accepted and silently ignored, which reads as "the flag worked".
    // An adapter that tried to take over through `auto` would get no error and
    // no effect; fail loudly instead.
    if (command === 'auto') {
      for (const f of ATTACHMENT_FLAGS) {
        if (f !== 'session-id' && flags[f] !== undefined) {
          console.error(`Error: --${f} is not supported on \`auto\`.`);
          process.exit(1);
        }
      }
    }
    // On `attach`, --takeover and --release are mutually exclusive: one
    // writes the record, the other clears it. Forcing the caller to pick
    // one prevents an accidental "do both, last one wins" silent failure.
    if (command === 'attach' && flags.takeover && flags.release) {
      console.error('Error: --takeover and --release are mutually exclusive on `attach`.');
      process.exit(1);
    }
    if (command === 'attach' && flags.confirm && !flags.takeover) {
      console.error('Error: --confirm is only meaningful with --takeover on `attach`.');
      process.exit(1);
    }
    // Every command that writes state performs a read-modify-write cycle, so
    // every one of them must hold the store lock for the whole cycle — not
    // just the `--expect-rev` ones. Locking only the `--expect-rev` path
    // would leave plain `task-store done T1 -e x` racing another writer and
    // silently losing an update, while SECURITY.md/README promise that
    // concurrent CLI invocations are serialized.
    //
    // This set is enumerated explicitly rather than derived as "not
    const MUTATING_COMMANDS = new Set([
      'init', 'add', 'start', 'done', 'block', 'resume-task',
      'attempt', 'decide', 'next', 'archive', 'repair',
      // 'attach' mutates the (gitignored) attachment record. It must run
      // under the same store lock as task-state writers so a concurrent
      // `auto check` from the same project cannot observe a half-written
      // attachment record during a takeover.
      'attach',
      // 'commit' is deliberately absent here: commitBatch() acquires the lock
      // internally, and wrapping runCommand() in yet another withStoreLock()
      // would cause a double-lock deadlock.
    ]);
    const topicIsMutating = command === 'topic' && (topicSubcommand === 'add' || topicSubcommand === 'use');
    // Changing the auto-checkpoint mode mutates config plus ephemeral runtime
    // (and, for `off`, clears attachment/pending state). It must serialize
    // with the auto verbs and attach/takeover; otherwise a concurrent
    // stage-instruction can make a decision under conservative mode and write
    // pending state after another process has already switched the feature off.
    // Read-only `config` queries stay lock-free.
    const configIsMutating = command === 'config'
      && args[0] === 'auto-checkpoint'
      && args[1] !== undefined;
    // `attach status` is a pure read of attachment.json. It must NOT take the
    // store lock: withStoreLock() creates .claude-task/ before running, so
    // locking a status query would materialize a store directory in a project
    // that has never been initialized — which happens on every OpenCode chat
    // call, where the adapter asks for the attachment before anything else.
    const attachIsReadOnly = command === 'attach' && args[0] === 'status';
    // `auto mark-dirty` / `auto check` / `auto reconciled` write the shared
    // runtime, but they gate that write on the attachment record — which
    // `attach` can change concurrently. Without the lock a takeover landing
    // between the ownership check and the runtime write would attribute a
    // detached session's activity to the new owner. Taking the store lock
    // serializes the pair. `auto status` writes nothing and stays lock-free,
    // for the same reason `attach status` does.
    const autoSubcommand = command === 'auto' ? args[0] : undefined;
    const autoIsMutating = command === 'auto'
      && (autoSubcommand === 'mark-dirty'
        || autoSubcommand === 'check'
        || autoSubcommand === 'reconciled'
        || autoSubcommand === 'stage-instruction'
        || autoSubcommand === 'take-instruction');

    // Zero-materialization gate, evaluated BEFORE lock acquisition.
    //
    // withStoreLock() creates `.claude-task/` when it is missing — taking the
    // lock is itself a write. Without this gate, one `auto mark-dirty` from an
    // adapter in a project that never ran `task-store init` (or an OpenCode
    // project that has the plugin but no store) creates the directory the
    // no-op was supposed to leave alone, and an opted-out project stops being
    // free. So each verb must show it has something to do first.
    //
    // Both predicates are pure reads. When the gate says "not applicable" the
    // core call still runs unlocked, but every mutating core verb re-checks
    // the same conditions before it writes, so the only way to reach a write
    // through that path is for the mode and the state file to both appear in
    // the microseconds between the gate and the call — and the write itself is
    // an atomic rename. The lock exists to stop concurrent writers losing
    // updates; that window is not a new source of lost updates.
    const autoStoreApplicable = isEnabled(projectRoot) && existsSync(stateFilePath(projectRoot));
    const autoApplicable = autoSubcommand === 'take-instruction'
      // Collection must hold the lock whenever a store already exists. Gating
      // the lock on the pending file itself creates a TOCTOU hole: the file can
      // be staged after the existence check but before the unlocked collector
      // runs, reopening the exact owner-check/delete race this verb exists to
      // close. Checking the directory preserves zero-materialization because
      // an uninitialized project still does not create it.
      ? existsSync(storePath(projectRoot))
      : autoStoreApplicable;
    const autoNeedsLock = autoIsMutating && autoApplicable;

    // The revision check and the command's mutation both run inside
    // runCommand(), so when the whole thing runs under withStoreLock() the
    // check-then-write cycle is atomic against other task-store CLI
    // invocations (see docs/pre-release-remediation.md item 3).
    const runCommand = (): void => {
      // Skip the generic revision check for 'commit': commitBatch() is the sole
      // authoritative check, and it runs under its own lock.
      if (expectRev !== undefined && command !== 'commit') {
        const current = readState(projectRoot);
        const currentRev = current?.revision ?? 0;
        if (currentRev !== expectRev) {
          throw new ConflictError(
            `Revision conflict. Expected rev ${expectRev}, found rev ${currentRev}. ` +
            `Re-read state with \`task-store status\` before retrying.`,
            currentRev,
          );
        }
      }

      switch (command) {
        case 'init': {
          const goal = args[0];
          if (!goal) { console.error('Error: goal is required\nUsage: task-store init "<goal>" [task1] [task2] ... [--auto-checkpoint off|conservative]'); process.exit(1); }
          if (initialAutoCheckpoint !== 'off' && initialAutoCheckpoint !== 'conservative') {
            console.error(`Error: invalid auto-checkpoint mode \`${initialAutoCheckpoint}\`. Supported modes: off, conservative`);
            process.exit(1);
          }
          const tasks = args.slice(1);
          const state = initState(goal, tasks, projectRoot, by);
          // Persist the new-store choice explicitly. readConfig() deliberately
          // continues to fail closed to `off` for configless legacy stores.
          writeMode(initialAutoCheckpoint as AutoCheckpointMode, projectRoot);
          const topic = getActiveTopic(state);
          console.log(`✓ Initialized task store for: ${topic.goal}`);
          console.log(`  Topic: ${topic.name}`);
          console.log(`  ${topic.tasks.length} task(s) created`);
          console.log(`  State: ${stateFilePath(projectRoot)}`);
          break;
        }
      case 'topic': {
        const subcommand = args[0];
        if (subcommand === 'list') {
          if (args.length !== 1) {
            console.error('Usage: task-store topic list');
            process.exit(1);
          }
          printTopics(projectRoot);
          break;
        }
        if (subcommand === 'add') {
          const name = args[1];
          const goal = args[2];
          if (!name || !goal) {
            console.error('Usage: task-store topic add <name> "<goal>" [task1] [task2] ...');
            process.exit(1);
          }
          const state = addTopic(name, goal, args.slice(3), projectRoot, by);
          const topic = state.topics.find(candidate => candidate.name === name.trim())!;
          console.log(`✓ Added topic: ${topic.name}`);
          console.log(`  Goal: ${topic.goal}`);
          console.log(`  ${topic.tasks.length} task(s) created`);
          console.log(`  Active topic remains: ${state.active_topic}`);
          break;
        }
        if (subcommand === 'use') {
          const name = args[1];
          if (!name || args.length !== 2) {
            console.error('Usage: task-store topic use <name>');
            process.exit(1);
          }
          const state = useTopic(name, projectRoot, by);
          console.log(`✓ Active topic: ${state.active_topic}`);
          break;
        }
        console.error('Usage: task-store topic <add|list|use>');
        process.exit(1);
      }
      case 'status': {
        printState(projectRoot, flags.topic === undefined ? undefined : String(flags.topic));
        break;
      }
      case 'show': {
        if (args.length !== 1) {
          console.error('Usage: task-store show <taskId> [--topic <name>]');
          process.exit(1);
        }
        printTask(args[0], flags.topic === undefined ? undefined : String(flags.topic), projectRoot);
        break;
      }
      case 'resume': {
        const state = readState(projectRoot);
        if (!state) { console.log('No state found.'); break; }
        console.log(buildResumeContext(state));
        break;
      }
      case 'add': {
        const title = args.join(' ');
        if (!title) { console.error('Error: title required'); process.exit(1); }
        const state = addTask(title, undefined, projectRoot, by);
        const topic = getActiveTopic(state);
        const t = topic.tasks[topic.tasks.length - 1];
        console.log(`✓ Added task [${t.id}] ${t.title}`);
        break;
      }
      case 'start': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required (e.g. T1)'); process.exit(1); }
        const state = startTask(taskId, projectRoot, by);
        console.log(`▶ Started [${taskId}]`);
        console.log(`  State: ${stateFilePath(projectRoot)}`);
        break;
      }
      case 'done': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required'); process.exit(1); }
        // Evidence is a plain string[] end-to-end — no comma-delimited
        // join/split round trip, so evidence text may contain commas safely.
        // Falls back to positional args only if no -e flags were given.
        const evidenceList = evidence.length > 0 ? evidence : args.slice(1);
        if (evidenceList.length === 0) {
          console.error('Error: evidence required. Use: task-store done T1 -e src/foo.ts -e "tests pass"');
          process.exit(1);
        }
        const state = completeTask(taskId, evidenceList, undefined, projectRoot, by);
        console.log(`✓ Completed [${taskId}]`);
        const nextAction = getActiveTopic(state).next_action;
        if (nextAction) console.log(`  Next: ${nextAction}`);
        break;
      }
      case 'block': {
        const taskId = args[0]?.toUpperCase();
        const reason = args.slice(1).join(' ');
        if (!taskId || !reason) { console.error('Usage: task-store block T1 "reason"'); process.exit(1); }
        blockTask(taskId, reason, projectRoot, by);
        console.log(`✗ Blocked [${taskId}]: ${reason}`);
        break;
      }
      case 'resume-task': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required'); process.exit(1); }
        resumeTask(taskId, projectRoot, by);
        console.log(`▶ Resumed [${taskId}]`);
        break;
      }
      case 'attempt': {
        const taskId = args[0]?.toUpperCase();
        const desc = args[1];
        const outcome = args.slice(2).join(' ');
        if (!taskId || !desc || !outcome) {
          console.error('Usage: task-store attempt T1 "what was tried" "why it failed"');
          process.exit(1);
        }
        recordAttempt(taskId, desc, outcome, projectRoot, by);
        console.log(`✓ Recorded failed attempt on [${taskId}]`);
        break;
      }
      case 'decide': {
        const summary = args[0];
        const rationale = args.slice(1).join(' ') || undefined;
        if (!summary) { console.error('Error: summary required'); process.exit(1); }
        recordDecision(summary, rationale, projectRoot, by);
        console.log(`✓ Decision recorded: ${summary}`);
        break;
      }
      case 'next': {
        const action = args.join(' ');
        if (!action) { console.error('Error: action text required'); process.exit(1); }
        setNextAction(action, projectRoot, by);
        console.log(`✓ Next action: ${action}`);
        break;
      }
      case 'commit': {
        // Read batch from stdin (fd 0 — works with pipes, redirects, and TTYs).
        let rawInput: unknown;
        try {
          rawInput = JSON.parse(readFileSync(0, 'utf8'));
        } catch (err) {
          console.error('Error: could not read JSON batch from stdin:', (err as Error).message);
          process.exit(1);
        }
        if (typeof rawInput !== 'object' || rawInput === null) {
          console.error('Error: batch input must be a JSON object');
          process.exit(1);
        }
        const input = rawInput as Record<string, unknown>;

        // --topic is required; --expect-rev is optional
        if (flags.topic === undefined) {
          console.error('Error: --topic <name> is required');
          process.exit(1);
        }
        // CLI contract: stdin contains only operations. Topic and expect_rev come
        // exclusively from CLI flags. Delete any body values to enforce this.
        delete input.topic;
        delete input.expect_rev;
        input.topic = String(flags.topic);

        if (flags['expect-rev'] !== undefined) {
          const s = String(flags['expect-rev']);
          const n = Number(s);
          if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n) || String(n) !== s) {
            console.error('Error: --expect-rev must be a non-negative integer');
            process.exit(1);
          }
          input.expect_rev = n;
        }

        const result = commitBatch(input, projectRoot, by);
        console.log(`✓ Committed ${result.operationsApplied} operation(s) on topic ${result.topic}`);
        console.log(`  State revision: ${result.revision}`);
        break;
      }
      case 'history': {
        const histPath = historyFilePath(projectRoot);
        if (!existsSync(histPath)) { console.log('No history yet.'); break; }
        const lines = readFileSync(histPath, 'utf8').split('\n').filter(Boolean);
        const tail = parseInt(String(flags.tail ?? '20'), 10);
        const recent = lines.slice(-tail);
        for (const line of recent) {
          try {
            const entry = JSON.parse(line) as { event: string; at: string; [k: string]: unknown };
            const { event, at, snapshot, ...rest } = entry;
            const restStr = Object.entries(rest).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
            console.log(`[${at?.slice(0, 16) ?? '?'}] ${event} ${restStr}`);
          } catch {
            console.log(line);
          }
        }
        break;
      }
      case 'archive': {
        archiveState(projectRoot, by);
        console.log('✓ State archived.');
        break;
      }
      case 'repair': {
        const recovered = repairState(projectRoot, by);
        if (recovered) {
          console.log(`✓ Recovered state from history. Goal: ${getActiveTopic(recovered).goal}`);
        } else {
          console.log('✗ Could not recover state from history.');
          process.exit(1);
        }
        break;
      }
      case 'stale': {
        const warnings = detectStaleTasks(projectRoot);
        if (warnings.length === 0) {
          console.log('✓ No stale in_progress tasks detected.');
        } else {
          console.log(`⚠  ${warnings.length} stale task(s) detected:`);
          for (const w of warnings) {
            console.log(`  [${w.taskId}] ${w.title}`);
            console.log(`    Started: ${w.startedAt}`);
            console.log(`    Elapsed: ${w.hoursElapsed}h`);
            console.log(`    Action: block, complete, or reset to pending`);
          }
          process.exit(1);
        }
        break;
      }
      case 'token-estimate': {
        const state = readState(projectRoot);
        if (!state) { console.log('No state found.'); break; }
        const ctx = buildResumeContext(state);
        // Rough estimate: ~4 chars per token. The canonical renderer
        // enforces a hard character budget (RESUME_BUDGET_CHARS) so the
        // estimate is bounded by `budget / 4` for any input shape.
        const estimate = Math.ceil(ctx.length / 4);
        const budgetTokens = Math.ceil(RESUME_BUDGET_CHARS / 4);
        console.log(`Resume context: ${ctx.length} chars ≈ ${estimate} tokens (budget: ${RESUME_BUDGET_CHARS} chars / ${budgetTokens} tokens)`);
        console.log(`State file: ${readFileSync(stateFilePath(projectRoot), 'utf8').length} bytes`);
        break;
      }
      case 'config': {
        const key = args[0];
        const value = args[1];

        if (!key) {
          const cfg = readConfig(projectRoot);
          console.log(`auto-checkpoint: ${cfg.auto_checkpoint}`);
          console.log(`auto-checkpoint debounce: ${debounceSeconds(projectRoot)}s`);
          console.log(`config file: ${configFilePath(projectRoot)}`);
          break;
        }

        if (key !== 'auto-checkpoint') {
          console.error(`Error: unknown config key \`${key}\`. Supported: auto-checkpoint`);
          process.exit(1);
        }

        if (value === undefined) {
          console.log(readConfig(projectRoot).auto_checkpoint);
          break;
        }

        // `aggressive` is rejected explicitly rather than falling into the
        // generic error, so a user who tried it learns it is a deliberate
        // non-feature rather than a typo.
        if (value === 'aggressive') {
          console.error('Error: `aggressive` mode is not implemented. Supported modes: off, conservative');
          process.exit(1);
        }
        if (value !== 'off' && value !== 'conservative') {
          console.error(`Error: invalid mode \`${value}\`. Supported modes: off, conservative`);
          process.exit(1);
        }

        const cfg = writeMode(value as AutoCheckpointMode, projectRoot);
        console.log(`✓ auto-checkpoint: ${cfg.auto_checkpoint}`);
        if (cfg.auto_checkpoint === 'conservative') {
          console.log(`  Reconciliation is requested at session boundaries, at most once per ${debounceSeconds(projectRoot)}s.`);
          console.log(`  It never marks a task done and never invents a next action.`);
        } else {
          console.log('  Auto-checkpoint is off. No dirty tracking, no reconciliation prompts.');
        }
        break;
      }
      case 'auto': {
        const sub = args[0];
        const sessionId = flags['session-id'] !== undefined ? String(flags['session-id']) : undefined;

        switch (sub) {
          case 'mark-dirty': {
            // Hot path: called once per matched tool call by an adapter.
            // No-ops silently when disabled, when no task store exists, or
            // when the calling session is not the recorded owner — see
            // attachment.ts for the intent boundary.
            const runtime = markDirty(projectRoot, args[1], sessionId);
            if (runtime) console.log(`dirty since ${runtime.dirty_since} (${runtime.signal_count} signal(s))`);
            break;
          }
          case 'check': {
            const decision = shouldReconcile(projectRoot, new Date(), sessionId);
            if (!decision.reconcile) {
              console.log(`no-reconcile: ${decision.reason}`);
              process.exit(1);
            }
            // Requesting and reporting are one atomic step from the caller's
            // point of view: an adapter that prints the instruction has, by
            // definition, asked. Recording it here means no adapter can
            // forget to, and therefore no adapter can nag in a loop.
            const recorded = markReconcileRequested(projectRoot, new Date(), sessionId);
            if (recorded !== 'applied') {
              // The decision and the bookkeeping are serialized by the store
              // lock on the CLI path, but keep the second gate explicit: never
              // print an instruction if ownership/mode ceased to apply.
              console.log(`no-reconcile: ${recorded}`);
              process.exit(1);
            }
            if (args.includes('--instruction')) {
              console.log(RECONCILE_INSTRUCTION);
            } else {
              console.log(`reconcile: ${decision.reason}`);
            }
            break;
          }
          case 'stage-instruction': {
            // The OpenCode boundary hook's replacement for
            // `check` + an adapter-side file write. Asking whether
            // reconciliation is warranted and *staging* the instruction are
            // one operation here, under the store lock: the adapter used to do
            // them in two steps with the lock released in between, so a
            // takeover or a release landing in that gap let a session that had
            // just lost ownership stage an instruction anyway. The staged
            // record is bound to the session that staged it, and the core
            // refuses to hand it to anyone else.
            //
            // Claude Code does not use this: its Stop hook delivers the
            // instruction inline in the same call, so it calls `check`.
            const decision = stagePendingInstruction(projectRoot, new Date(), sessionId);
            if (!decision.reconcile || decision.instruction === null) {
              console.log(`no-reconcile: ${decision.reason}`);
              process.exit(1);
            }
            console.log(decision.instruction);
            break;
          }
          case 'take-instruction': {
            // The OpenCode adapter stages a reconciliation instruction to a
            // project-wide file and collects it on the next chat call. That
            // read-and-delete has to be atomic with the ownership check, or a
            // session taken over (or released) in between could consume the
            // instruction the current owner was staged for, leaving the owner
            // with nothing. Running it here, under the store lock the other
            // auto verbs also take, makes the pair indivisible — and keeps the
            // ownership rule in one place rather than in each adapter.
            // The core refuses a non-owner and a record staged by a different
            // session; that check is the policy and it lives there. This one
            // only exists to name the reason for a human or an agent reading
            // the output.
            if (!sessionId) {
              console.log('no-instruction: detached');
              process.exit(1);
            }
            // An instruction staged before the store was archived or completed
            // is no longer actionable: the agent would be told to reconcile a
            // checkpoint the resume projection no longer even shows it. Leave
            // the file in place rather than delivering a dead request.
            const current = readState(projectRoot);
            if (!current) {
              console.log('no-instruction: no-state');
              process.exit(1);
            }
            const activeStatus = getActiveTopic(current).status;
            if (activeStatus === 'archived' || activeStatus === 'completed') {
              console.log(`no-instruction: ${activeStatus}-state`);
              process.exit(1);
            }
            const staged = takePendingInstruction(projectRoot, sessionId);
            if (staged === null || staged.length === 0) {
              // Distinguish "you own nothing" from "there is nothing here"
              // purely for the reader: the core already refused whatever could
              // not be delivered.
              const owns = isAttachedSession(sessionId, projectRoot);
              console.log(`no-instruction: ${owns ? 'none-staged' : 'detached'}`);
              process.exit(1);
            }
            console.log(staged);
            break;
          }
          case 'reconciled': {
            // Closes the loop for an adapter that reconciled explicitly.
            // Optional: staleness is derived from state.updated_at, so an
            // agent that writes through the normal verbs is already fresh.
            //
            // Gated on the attachment, like every other verb that writes this
            // runtime. Clearing the shared dirty window is the most
            // destructive thing in the auto-checkpoint surface: a session that
            // does not own the attachment doing it would tell the real owner
            // its checkpoint is clean while its work signal is still pending.
            const outcome = markReconciled(projectRoot, new Date(), sessionId);
            if (outcome !== 'applied') {
              // Previously this printed success unconditionally, so a detached
              // session got a ✓ for a write that never happened.
              console.log(`no-reconcile: ${outcome}`);
              process.exit(1);
            }
            console.log('✓ reconciliation recorded');
            break;
          }
          case 'status': {
            const cfg = readConfig(projectRoot);
            const runtime = readRuntime(projectRoot);
            // Freshness is observed unconditionally: a user running
            // `auto status` (with or without --session-id) wants to see
            // whether the checkpoint is stale, not just whether *their*
            // session is the owner. The session gate is reported
            // separately as `attached:`, and `would_reconcile` still
            // respects it.
            const fresh = freshness(projectRoot);
            const decision = shouldReconcile(projectRoot, new Date(), sessionId);
            const attached = sessionId ? isAttachedSession(sessionId, projectRoot) : false;
            console.log(`mode: ${cfg.auto_checkpoint}`);
            console.log(`debounce: ${debounceSeconds(projectRoot)}s (default ${DEFAULT_DEBOUNCE_SECONDS}s)`);
            console.log(`dirty_since: ${runtime.dirty_since ?? '(clean)'}`);
            console.log(`last_signal_at: ${runtime.last_signal_at ?? '(none)'}`);
            console.log(`signal_count: ${runtime.signal_count}`);
            console.log(`last_reconcile_request_at: ${runtime.last_reconcile_request_at ?? '(never)'}`);
            console.log(`last_reconcile_at: ${runtime.last_reconcile_at ?? '(never)'}`);
            console.log(`attached: ${attached}`);
            console.log(`stale: ${fresh.stale}`);
            console.log(`would_reconcile: ${decision.reconcile} (${decision.reason})`);
            break;
          }
          default: {
            console.error('Usage: task-store auto <status|mark-dirty|check|reconciled|stage-instruction|take-instruction>');
            process.exit(1);
          }
        }
        break;
      }
      case 'attach': {
        // `task-store attach status` takes neither flag; the attach/takeover
        // forms take both; `--release` needs only --session-id, because
        // ownership is the whole check. They are validated up-front rather
        // than relying on attachSession() to throw — the error class carries
        // useful context but the CLI surface still wants clear human-facing
        // messages.
        const sub = args[0];
        if (sub === 'status') {
          const current = readAttachment(projectRoot);
          if (!current) {
            console.log('attached: none');
          } else {
            const known = isKnownHost(current.host);
            const hostLabel = known ? current.host : `${current.host} (unrecognised)`;
            console.log(`attached: session_id=${current.session_id} host=${hostLabel} attached_at=${current.attached_at}`);
          }
          break;
        }

        const sessionId = flags['session-id'] !== undefined ? String(flags['session-id']) : '';
        const host = flags.host !== undefined ? String(flags.host) : '';
        if (!sessionId) {
          console.error('Error: --session-id is required for `attach`.');
          process.exit(1);
        }

        if (flags.release) {
          // release() checks ownership, and the host is not part of the
          // record's identity — so requiring --host here would be an argument
          // that is parsed, validated, and then never read. It stays
          // *accepted* because existing callers pass it (session-end.sh), and
          // breaking a working invocation to tidy a signature is a worse
          // trade than ignoring a redundant flag.
          const result = releaseSession({ sessionId }, projectRoot);
          if (result.outcome === 'released') {
            console.log('✓ attachment released');
          } else if (result.outcome === 'not-attached') {
            console.log('(no attachment to release)');
          } else {
            console.error('Error: another session owns the attachment; this session cannot release it.');
            process.exit(4);
          }
          break;
        }

        if (!host) {
          console.error('Error: --host is required for `attach`.');
          process.exit(1);
        }

        const result = attachSession({
          sessionId,
          host,
          takeover: flags.takeover === true,
          confirm: flags.confirm === true,
        }, projectRoot);

        if (result.outcome === 'attached') {
          console.log(`✓ attached (session_id=${result.current.session_id}, host=${result.current.host})`);
        } else if (result.outcome === 'refreshed') {
          console.log(`✓ attached (refreshed; session_id=${result.current.session_id})`);
        } else {
          console.log(`✓ attached (took over from session_id=${result.previous?.session_id})`);
        }
        break;
      }
      default: {
        console.error(`Unknown command: ${command}\nRun task-store --help`);
        process.exit(1);
      }
      }
    };

    if ((MUTATING_COMMANDS.has(command) && !attachIsReadOnly) || autoNeedsLock || topicIsMutating || configIsMutating) {
      withStoreLock(projectRoot, runCommand);
    } else {
      // Read-only and unknown commands: no lock, so `status` on a project
      // that has never been initialized does not create .claude-task/.
      runCommand();
    }

  } catch (err) {
    if (err instanceof StateError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    if (err instanceof ConflictError) {
      console.error(`Error: ${err.message}`);
      process.exit(2);
    }
    if (err instanceof LockError) {
      console.error(`Error: ${err.message}`);
      process.exit(3);
    }
    if (err instanceof AttachmentConflictError) {
      console.error(`Error: ${err.message}`);
      process.exit(4);
    }
    throw err;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
