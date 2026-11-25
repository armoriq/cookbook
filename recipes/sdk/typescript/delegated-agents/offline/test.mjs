// Offline test: runs src/crew.js in offline mode and checks the log contract lines, the delegation,
// and the refusal.
//
//   npm run test:offline
//
// Runs twice, with OFFLINE_APPROVAL unset and set to reject. This policy holds nothing, so both runs
// must look the same. Needs no keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const expected = [
  // plan, then the delegation (the narrower token for the analyst)
  '[armoriq] plan: Respond to the checkout latency alert -> get_metrics, search_logs, restart_service',
  '[armoriq] delegate log-analyst: get_metrics, search_logs',
  // allow: the analyst's reads, on the delegated token
  '[armoriq] check get_metrics: ALLOWED (policy incident-ops-policy: get_metrics -> allow; delegated to log-analyst)',
  '[armoriq] check search_logs: ALLOWED (policy incident-ops-policy: search_logs -> allow; delegated to log-analyst)',
  '[armoriq] report get_metrics: success',
  // block: the analyst is refused the restart even though the policy allows it
  '[armoriq] check restart_service: BLOCKED (delegation log-analyst: restart_service is not in allowed_actions [get_metrics, search_logs])',
  '[agent] log-analyst: restart_service({"service":"checkout"}) -> REFUSED by ArmorIQ: log-analyst may not call restart_service',
  // allow: the lead makes the restart on its own token
  '[armoriq] check restart_service: ALLOWED (policy incident-ops-policy: restart_service -> allow; parent token)',
  '[armoriq] report restart_service: success',
  'INCIDENT UPDATE:',
];
const unexpected = ['Error:', 'check get_metrics: BLOCKED', 'check search_logs: BLOCKED'];

function run(approval) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'src/crew.js'], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OFFLINE_APPROVAL: approval },
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

let failed = false;
for (const approval of ['approve', 'reject']) {
  const { code, output } = await run(approval);
  console.log(`--- run: OFFLINE_APPROVAL=${approval} ---`);
  console.log(output);
  // Exactly one BLOCKED restart (the analyst's) and one ALLOWED restart (the lead's).
  const blocked = output.split('check restart_service: BLOCKED').length - 1;
  const allowed = output.split('check restart_service: ALLOWED').length - 1;
  const missing = expected.filter((line) => !output.includes(line));
  const present = unexpected.filter((line) => output.includes(line));
  if (code !== 0 || missing.length > 0 || present.length > 0 || blocked !== 1 || allowed !== 1) {
    failed = true;
    console.error(`FAIL offline run ${approval} (exit ${code}, restart BLOCKED x${blocked}, ALLOWED x${allowed})`);
    for (const line of missing) console.error(`  missing: ${line}`);
    for (const line of present) console.error(`  should not appear: ${line}`);
  } else {
    console.log(`PASS offline run ${approval}: ${expected.length} expected lines seen`);
  }
}
process.exit(failed ? 1 : 0);
