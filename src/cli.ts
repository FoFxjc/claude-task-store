#!/usr/bin/env node
/**
 * task-store CLI
 * Usage: task-store <command> [args]
 */

import {
  initState, readState, writeState, startTask, completeTask, blockTask,
  resumeTask, addTask, recordAttempt, recordDecision, setNextAction,
  archiveState, buildResumeContext, repairState, detectStaleTasks,
  stateFilePath, historyFilePath, StateError, findProjectRoot,
} from './core.js';
import { readFileSync, existsSync } from 'fs';

const HELP = `
claude-task-store — persistent execution checkpoint for Claude Code

COMMANDS:
  init <goal> [task1] [task2] ...   Initialize a new task store
  status                            Show current state summary
  resume                            Print compact resume context (for session injection)
  add <title>                       Add a new task
  start <taskId>                    Mark task as in-progress (e.g. T1)
  done <taskId> -e <evidence> ...   Mark task done with evidence
  block <taskId> <reason>           Mark task blocked with reason
  resume-task <taskId>              Resume a blocked task
  attempt <taskId> <desc> <outcome> Record a failed attempt
  decide <summary> [rationale]      Record a key decision
  next <action>                     Set the next action
  history [--tail N]                Show history log
  archive                           Archive the current state
  repair                            Attempt to recover from corrupted state.json
  stale                             Detect tasks in_progress for >48h

FLAGS:
  --root <path>   Use a specific project root (default: auto-detect from cwd)
  --help, -h      Show this help
`;

function parseArgs(argv: string[]): { command: string; args: string[]; flags: Record<string, string | boolean> } {
  const args: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let command = '';

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { flags.help = true; }
    else if (a === '--root') { flags.root = argv[++i] ?? ''; }
    else if (a === '-e') {
      // evidence flag: collect all subsequent values until next flag
      const evidence: string[] = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        evidence.push(argv[++i]);
      }
      flags.evidence = evidence.join(',');
    } else if (a === '--tail') { flags.tail = argv[++i] ?? '20'; }
    else if (!command) { command = a; }
    else { args.push(a); }
  }

  return { command, args, flags };
}

function printState(projectRoot?: string): void {
  const state = readState(projectRoot);
  if (!state) {
    console.log('No task state found. Run `task-store init "<goal>" [tasks...]` to start.');
    return;
  }

  console.log(`\nGOAL: ${state.goal}`);
  console.log(`STATUS: ${state.status.toUpperCase()}`);
  console.log(`\nTASKS:`);
  for (const t of state.tasks) {
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

  if (state.decisions && state.decisions.length > 0) {
    console.log(`\nDECISIONS:`);
    for (const d of state.decisions) console.log(`  • ${d.summary}`);
  }

  if (state.blockers && state.blockers.length > 0) {
    console.log(`\nBLOCKERS:`);
    for (const b of state.blockers) console.log(`  ✗ [${b.task_id ?? '–'}] ${b.description}`);
  }

  console.log(`\nNEXT ACTION: ${state.next_action ?? '(not set)'}`);

  // Show stale task warnings
  const stale = detectStaleTasks(projectRoot);
  if (stale.length > 0) {
    console.log(`\n⚠  STALE TASKS (in_progress > 48h):`);
    for (const s of stale) {
      console.log(`   [${s.taskId}] ${s.title} — ${s.hoursElapsed}h elapsed`);
      console.log(`   Consider: block it, complete it, or reset to pending`);
    }
  }

  console.log(`\nState file: ${stateFilePath(projectRoot)}`);
  console.log(`Updated: ${state.updated_at}`);
}

async function main(): Promise<void> {
  const { command, args, flags } = parseArgs(process.argv.slice(2));
  const projectRoot = flags.root ? String(flags.root) : findProjectRoot();

  if (flags.help || !command) {
    console.log(HELP);
    process.exit(0);
  }

  try {
    switch (command) {
      case 'init': {
        const goal = args[0];
        if (!goal) { console.error('Error: goal is required\nUsage: task-store init "<goal>" [task1] [task2] ...'); process.exit(1); }
        const tasks = args.slice(1);
        const state = initState(goal, tasks, projectRoot);
        console.log(`✓ Initialized task store for: ${state.goal}`);
        console.log(`  ${state.tasks.length} task(s) created`);
        console.log(`  State: ${stateFilePath(projectRoot)}`);
        break;
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
        const state = addTask(title, undefined, projectRoot);
        const t = state.tasks[state.tasks.length - 1];
        console.log(`✓ Added task [${t.id}] ${t.title}`);
        break;
      }
      case 'start': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required (e.g. T1)'); process.exit(1); }
        const state = startTask(taskId, projectRoot);
        console.log(`▶ Started [${taskId}]`);
        console.log(`  State: ${stateFilePath(projectRoot)}`);
        break;
      }
      case 'done': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required'); process.exit(1); }
        const evidenceStr = String(flags.evidence ?? '');
        const evidence = evidenceStr ? evidenceStr.split(',').map(s => s.trim()).filter(Boolean) : args.slice(1);
        if (evidence.length === 0) {
          console.error('Error: evidence required. Use: task-store done T1 -e src/foo.ts -e "tests pass"');
          process.exit(1);
        }
        const state = completeTask(taskId, evidence, undefined, projectRoot);
        console.log(`✓ Completed [${taskId}]`);
        if (state.next_action) console.log(`  Next: ${state.next_action}`);
        break;
      }
      case 'block': {
        const taskId = args[0]?.toUpperCase();
        const reason = args.slice(1).join(' ');
        if (!taskId || !reason) { console.error('Usage: task-store block T1 "reason"'); process.exit(1); }
        blockTask(taskId, reason, projectRoot);
        console.log(`✗ Blocked [${taskId}]: ${reason}`);
        break;
      }
      case 'resume-task': {
        const taskId = args[0]?.toUpperCase();
        if (!taskId) { console.error('Error: taskId required'); process.exit(1); }
        resumeTask(taskId, projectRoot);
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
        recordAttempt(taskId, desc, outcome, projectRoot);
        console.log(`✓ Recorded failed attempt on [${taskId}]`);
        break;
      }
      case 'decide': {
        const summary = args[0];
        const rationale = args.slice(1).join(' ') || undefined;
        if (!summary) { console.error('Error: summary required'); process.exit(1); }
        recordDecision(summary, rationale, projectRoot);
        console.log(`✓ Decision recorded: ${summary}`);
        break;
      }
      case 'next': {
        const action = args.join(' ');
        if (!action) { console.error('Error: action text required'); process.exit(1); }
        setNextAction(action, projectRoot);
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
        archiveState(projectRoot);
        console.log('✓ State archived.');
        break;
      }
      case 'repair': {
        const recovered = repairState(projectRoot);
        if (recovered) {
          console.log(`✓ Recovered state from history. Goal: ${recovered.goal}`);
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
      case 'token-estimate': {        const state = readState(projectRoot);
        if (!state) { console.log('No state found.'); break; }
        const ctx = buildResumeContext(state);
        // Rough estimate: ~4 chars per token
        const estimate = Math.ceil(ctx.length / 4);
        console.log(`Resume context: ${ctx.length} chars ≈ ${estimate} tokens`);
        console.log(`State file: ${readFileSync(stateFilePath(projectRoot), 'utf8').length} bytes`);
        break;
      }
      default: {
        console.error(`Unknown command: ${command}\nRun task-store --help`);
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof StateError) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    throw err;
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
