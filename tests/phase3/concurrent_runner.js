#!/usr/bin/env node
// Run two commit CLI invocations concurrently and report fixed-format output.
// Output format: EXIT_A=<code> EXIT_B=<code> PID_A=<pid> PID_B=<pid>
import { spawn } from 'child_process';
import { readFileSync } from 'fs';

const cliPath = process.argv[2];
const root = process.argv[3];
const by1 = process.argv[4];
const by2 = process.argv[5];
const payload1 = readFileSync(process.argv[6], 'utf8').trim();
const payload2 = readFileSync(process.argv[7], 'utf8').trim();

async function run(payload, by) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, pid) => {
      if (settled) return;
      settled = true;
      resolve({ code: code ?? 1, pid });
    };
    const child = spawn('node', [cliPath, 'commit', '--topic', 'default', '--root', root, '--by', by], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => finish(1, child.pid));
    child.stdin.write(payload + '\n');
    child.stdin.end();
    child.on('close', (code) => finish(code, child.pid));
  });
}

const [result1, result2] = await Promise.all([
  run(payload1, by1),
  run(payload2, by2),
]);

// Fixed-format output — no eval, no shell interpolation risks.
// Matches: EXIT_A=<num> EXIT_B=<num> PID_A=<num> PID_B=<num>
process.stdout.write(
  `EXIT_A=${result1.code} EXIT_B=${result2.code} PID_A=${result1.pid} PID_B=${result2.pid}\n`
);
