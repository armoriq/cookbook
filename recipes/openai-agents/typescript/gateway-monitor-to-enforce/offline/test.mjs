// Offline test: runs offline/demo.mjs in a subprocess and checks the log contract lines.
//
//   npm run test:offline
//
// Run 1 uses policy.yaml as shipped. Run 2 uses a copy where record_payment is allowed, to
// prove the stand-in decides from the policy file. No keys, no network beyond 127.0.0.1.

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHIPPED = {
  expected: [
    // Phase 1: record only
    '[gateway] recorded: lookup_invoice (no agent in the URL, nothing checked)',
    '[ledger] payment recorded: INV-1041',
    // Phase 2: Monitor mode, the payment still goes through
    '[armoriq] plan: Pay invoice INV-1042',
    '[armoriq] check lookup_invoice: ALLOWED (monitor mode; policy ap-clerk-policy: lookup_invoice -> allow)',
    '[armoriq] check record_payment: BLOCKED (monitor mode: would block, nothing stopped; policy ap-clerk-policy: record_payment -> block)',
    '[ledger] payment recorded: INV-1042',
    '[gateway] What policy would have done: 1 would block, 0 would hold, 1 allowed',
    // Phase 3: enforced
    '[armoriq] plan: Pay invoice INV-1043',
    '[armoriq] check record_payment: BLOCKED (policy ap-clerk-policy: record_payment -> block)',
    '[armoriq] args record_payment: {"invoice_id":"INV-1043","amount":4800}',
    'Tool call "record_payment" was blocked by policy: block:record_payment#0',
    '(Intent Gateway stopped a tool call; the note above names the rule.)',
    '[gateway] request from dana@example.com',
  ],
  unexpected: ['[ledger] payment recorded: INV-1043', 'Error'],
};

const LOOSENED = {
  expected: [
    '[armoriq] check record_payment: ALLOWED (policy ap-clerk-policy: record_payment -> allow)',
    '[ledger] payment recorded: INV-1043',
  ],
  unexpected: ['was blocked by policy'],
};

function run(env) {
  return new Promise((resolve) => {
    const clean = { ...process.env, OFFLINE_APPROVAL: 'reject' };
    for (const key of ['OPENAI_API_KEY', 'ARMORIQ_GATEWAY_KEY', 'ARMORIQ_AGENT_ID', 'ARMORIQ_GATEWAY_HOST', 'OFFLINE_POLICY']) {
      delete clean[key];
    }
    const child = spawn(process.execPath, ['offline/demo.mjs'], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...clean, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = setTimeout(() => child.kill(), 30_000);
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
console.log('\n=== policy.yaml as shipped');
ok = verify('shipped policy', await run({}), SHIPPED) && ok;

console.log('\n=== policy.yaml with record_payment -> allow');
const tmp = mkdtempSync(join(tmpdir(), 'gateway-monitor-'));
try {
  const loosened = join(tmp, 'policy.yaml');
  writeFileSync(loosened, readFileSync(join(recipe, 'policy.yaml'), 'utf8').replace(/action:\s*block/g, 'action: allow'));
  ok = verify('record_payment allowed', await run({ OFFLINE_POLICY: loosened }), LOOSENED) && ok;
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
