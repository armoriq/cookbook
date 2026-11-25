// Offline test: runs the real demo.mjs in a subprocess and checks the log contract lines.
//
//   npm run test:offline
//
// Checks the OFFLINE_APPROVAL=approve run and the =reject run, then a run with a copy of the
// policy that allows everything, to prove the stand-in decides from policy.yaml.
// No keys, no network.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMON = [
  '[armoriq] plan: ',
  '[armoriq] check get_ticket: ALLOWED (policy support-desk-policy: get_ticket -> allow)',
  '[armoriq] check reply_to_ticket: ALLOWED',
  '[armoriq] report reply_to_ticket: success',
  '[armoriq] check issue_refund: HELD (policy support-desk-policy: issue_refund -> hold)',
  '[armoriq] args issue_refund: ',
  '[armoriq] injection: ',
  '[armoriq] check close_account: BLOCKED (policy support-desk-policy: close_account -> block)',
];
const RUNS = {
  approve: {
    expected: [...COMMON, '[armoriq] hold issue_refund: APPROVED', '[armoriq] report issue_refund: success'],
    unexpected: ['hold issue_refund: REJECTED', 'Traceback', 'Error:'],
  },
  reject: {
    expected: [...COMMON, '[armoriq] hold issue_refund: REJECTED'],
    unexpected: ['hold issue_refund: APPROVED', 'report issue_refund:', 'report close_account:', 'Error:'],
  },
  loosened: {
    expected: [
      '[armoriq] check close_account: ALLOWED (policy support-desk-policy: close_account -> allow)',
      '[armoriq] report close_account: success',
    ],
    unexpected: ['BLOCKED', 'HELD'],
  },
};

function run(env) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    for (const key of ['ARMORIQ_API_KEY', 'GEMINI_API_KEY', 'OFFLINE_POLICY']) delete clean[key];
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'demo.mjs'], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...clean, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

function verify(label, { code, output }, spec) {
  process.stdout.write(output);
  const problems = [];
  if (code !== 0) problems.push(`demo exited ${code}`);
  for (const line of spec.expected) if (!output.includes(line)) problems.push(`missing: ${line}`);
  for (const line of spec.unexpected) if (output.includes(line)) problems.push(`unexpected: ${line}`);
  if (problems.length > 0) {
    console.log(`FAIL offline run (${label})`);
    for (const problem of problems) console.log(`  ${problem}`);
    return false;
  }
  console.log(`PASS offline run (${label}): ${spec.expected.length} expected lines seen`);
  return true;
}

let ok = true;
for (const mode of ['approve', 'reject']) {
  console.log(`\n=== OFFLINE_APPROVAL=${mode}`);
  ok = verify(mode, await run({ OFFLINE_APPROVAL: mode }), RUNS[mode]) && ok;
}

console.log('\n=== policy.yaml with every rule set to allow');
const tmp = mkdtempSync(join(tmpdir(), 'support-desk-'));
try {
  const loosened = join(tmp, 'policy.yaml');
  writeFileSync(loosened, readFileSync(join(recipe, 'policy.yaml'), 'utf8').replace(/action:\s*(hold|block)/g, 'action: allow'));
  ok = verify('everything allowed', await run({ OFFLINE_POLICY: loosened }), RUNS.loosened) && ok;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
