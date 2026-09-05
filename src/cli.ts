#!/usr/bin/env node
/**
 * task-store CLI
 * Usage: task-store <command> [args]
 */

import {
  initState, readState, writeState, startTask, completeTask, blockTask,
  resumeTask, addTask, recordAttempt, recordDecision, setNextAction,
  archiveState, buildResumeContext, repairState, detectStaleTasks,
  compareAndWriteState, ConflictError, withStoreLock, LockError,
  stateFilePath, historyFilePath, StateError, findProjectRoot,
  getActiveTopic, addTopic, useTopic,
} from './core.js';
import {
  readConfig, writeMode, markDirty, shouldReconcile, markReconcileRequested,
  markReconciled, freshness, readRuntime, RECONCILE_INSTRUCTION,
  DEFAULT_DEBOUNCE_SECONDS, debounceSeconds, configFilePath,
  type AutoCheckpointMode,
} from './autocheckpoint.js';
import { readFileSync, existsSync } from 'fs';

const HELP = `
claude-task-store — persistent execution checkpoint for Claude Code

COMMANDS:
  init <goal> [task1] [task2] ...   Initialize a new task store
  status                            Show current state summary
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
  history [--tail N]                Show history log
  archive                           Archive the current state
  repair                            Attempt to recover from corrupted state.json
  stale                             Detect tasks in_progress for >48h
  token-estimate                    Estimate the token size of the resume context

CONFIG:
  config                            Show project-local task-store configuration
  config auto-checkpoint            Show the current auto-checkpoint mode
  config auto-checkpoint <mode>     Set the mode: off (default) | conservative

AUTO-CHECKPOINT (adapter plumbing — used by hooks/plugins, rarely by hand):
  auto status                       Show dirty/freshness state and why
  auto mark-dirty [signal]          Record that repository state may have changed
  auto check [--instruction]        Exit 0 if reconciliation is warranted, else 1
  auto reconciled                   Record that reconciliation completed

  These commands never read or write task state. Checkpoint mutation stays
  exclusive to the verbs above (start/done/attempt/block/decide/next).

FLAGS:
  --root <path>         Use a specific project root (default: auto-detect from cwd)
  --by <agent>          Record who/what is writing (e.g. --by claude-code, --by codex)
  --expect-rev <N>      Optimistic concurrency: fail if on-disk revision != N.
                         Enforced atomically via an O_EXCL lock file around the
                         read-compare-write cycle for this CLI invocation — see
                         docs/pre-release-remediation.md item 3 for the exact
                         guarantee (protects concurrent task-store CLI callers;
                         does not protect direct library callers).
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
    else if (a === '--by') { flags.by = argv[++i] ?? ''; }
    else if (a === '--expect-rev') { flags['expect-rev'] = argv[++i] ?? ''; }
    else if (!command) { command = a; }
    else { args.push(a); }
  }

  return { command, args, flags, evidence };
}

function printState(projectRoot?: string): void {
  const state = readState(projectRoot);
  if (!state) {
    console.log('No task state found. Run `task-store init "<goal>" [tasks...]` to start.');
    return;
  }

  const topic = getActiveTopic(state);
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
  const stale = detectStaleTasks(projectRoot);
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
    const expectRev = flags['expect-rev'] !== undefined ? parseInt(String(flags['expect-rev']), 10) : undefined;

    // --by is only meaningful on commands that write state. Passing it to a
    // read-only command was previously silently ignored, which is not
    // acceptable — reject it explicitly instead (see
    // docs/pre-release-remediation.md item 6).
    const READ_ONLY_COMMANDS = new Set(['status', 'resume', 'history', 'stale', 'token-estimate']);
    const topicSubcommand = command === 'topic' ? args[0] : undefined;
    const topicIsReadOnly = command === 'topic' && topicSubcommand === 'list';
    // `config` and `auto` write files, but never task state — recording an
    // author for them would be meaningless, so --by is rejected there too.
    const NON_STATE_COMMANDS = new Set(['config', 'auto']);
    if (by !== undefined && (READ_ONLY_COMMANDS.has(command) || topicIsReadOnly || NON_STATE_COMMANDS.has(command))) {
      console.error(`Error: --by is not supported on \`${command}\` (it never writes task state).`);
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
    // read-only" so that an unknown/misspelled command does not take the
    // lock (and does not create .claude-task/) on its way to the usage error.
    const MUTATING_COMMANDS = new Set([
      'init', 'add', 'start', 'done', 'block', 'resume-task',
      'attempt', 'decide', 'next', 'archive', 'repair',
    ]);
    const topicIsMutating = command === 'topic' && (topicSubcommand === 'add' || topicSubcommand === 'use');

    // The revision check and the command's mutation both run inside
    // runCommand(), so when the whole thing runs under withStoreLock() the
    // check-then-write cycle is atomic against other task-store CLI
    // invocations (see docs/pre-release-remediation.md item 3).
    const runCommand = (): void => {
      if (expectRev !== undefined) {
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
          if (!goal) { console.error('Error: goal is required\nUsage: task-store init "<goal>" [task1] [task2] ...'); process.exit(1); }
          const tasks = args.slice(1);
          const state = initState(goal, tasks, projectRoot, by);
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
          const topic = state.topics.find(candidate => candidate.name === name)!;
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
        printState(projectRoot);
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
        // Rough estimate: ~4 chars per token
        const estimate = Math.ceil(ctx.length / 4);
        console.log(`Resume context: ${ctx.length} chars ≈ ${estimate} tokens`);
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

        switch (sub) {
          case 'mark-dirty': {
            // Hot path: called once per matched tool call by an adapter.
            // No-ops silently when disabled or when no task store exists.
            const runtime = markDirty(projectRoot, args[1]);
            if (runtime) console.log(`dirty since ${runtime.dirty_since} (${runtime.signal_count} signal(s))`);
            break;
          }
          case 'check': {
            const decision = shouldReconcile(projectRoot);
            if (!decision.reconcile) {
              console.log(`no-reconcile: ${decision.reason}`);
              process.exit(1);
            }
            // Requesting and reporting are one atomic step from the caller's
            // point of view: an adapter that prints the instruction has, by
            // definition, asked. Recording it here means no adapter can
            // forget to, and therefore no adapter can nag in a loop.
            markReconcileRequested(projectRoot);
            if (args.includes('--instruction')) {
              console.log(RECONCILE_INSTRUCTION);
            } else {
              console.log(`reconcile: ${decision.reason}`);
            }
            break;
          }
          case 'reconciled': {
            markReconciled(projectRoot);
            console.log('✓ reconciliation recorded');
            break;
          }
          case 'status': {
            const cfg = readConfig(projectRoot);
            const runtime = readRuntime(projectRoot);
            const decision = shouldReconcile(projectRoot);
            console.log(`mode: ${cfg.auto_checkpoint}`);
            console.log(`debounce: ${debounceSeconds(projectRoot)}s (default ${DEFAULT_DEBOUNCE_SECONDS}s)`);
            console.log(`dirty_since: ${runtime.dirty_since ?? '(clean)'}`);
            console.log(`last_signal_at: ${runtime.last_signal_at ?? '(none)'}`);
            console.log(`signal_count: ${runtime.signal_count}`);
            console.log(`last_reconcile_request_at: ${runtime.last_reconcile_request_at ?? '(never)'}`);
            console.log(`last_reconcile_at: ${runtime.last_reconcile_at ?? '(never)'}`);
            console.log(`stale: ${decision.freshness.stale}`);
            console.log(`would_reconcile: ${decision.reconcile} (${decision.reason})`);
            break;
          }
          default: {
            console.error('Usage: task-store auto <status|mark-dirty|check|reconciled>');
            process.exit(1);
          }
        }
        break;
      }
      default: {
        console.error(`Unknown command: ${command}\nRun task-store --help`);
        process.exit(1);
      }
      }
    };

    if (MUTATING_COMMANDS.has(command) || topicIsMutating) {
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
    throw err;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
