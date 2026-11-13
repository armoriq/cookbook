// Offline test: runs demo.mjs in a subprocess and checks the log contract lines.
//
//   npm run test:offline
//
// Checks the approve run and the OFFLINE_APPROVAL=reject run, including that the held call goes
// through a LangGraph interrupt and a Command({ resume }). Needs no keys or network.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = 'policy oncall-runbook-policy';

const COMMON = [
  '[armoriq] plan: ',
  `[armoriq] check get_service_status: ALLOWED (${P}: get_service_status -> allow)`, // allow
  '[armoriq] report get_service_status: success',
  `[armoriq] check read_recent_logs: ALLOWED (${P}: read_recent_logs -> allow)`,
  `[armoriq] check restart_service: HELD (${P}: restart_service -> hold)`, // hold
  '[armoriq] args restart_service: ',
  "[graph] interrupted at [\"human_review\"]",
  '[reviewer] sees HELD restart_service',
  '[graph] resuming thread ',
  `[armoriq] check delete_volume: BLOCKED (${P}: delete_volume -> block)`, // block
  'ArmorIQ blocked delete_volume',
];
const EXPECTED = {
  approve: [
    ...COMMON,
    '[armoriq] hold restart_service: APPROVED',
    '[armoriq] report restart_service: success',
    'Final answer: Done. checkout-api was restarted',
  ],
  reject: [
    ...COMMON,
    '[armoriq] hold restart_service: REJECTED',
    'ArmorIQ hold rejected for restart_service',
    'Final answer: I could not finish.',
  ],
};
const FORBIDDEN = {
  approve: ['hold restart_service: REJECTED', 'report delete_volume:', '[ERROR]'],
  reject: ['hold restart_service: APPROVED', 'report restart_service:', 'report delete_volume:', '[ERROR]'],
};

function run(mode) {
  const env = { ...process.env, OFFLINE_APPROVAL: mode };
  delete env.ARMORIQ_API_KEY;
  delete env.OPENAI_API_KEY;
  const proc = spawnSync(process.execPath, ['--import', './offline/register.mjs', 'offline/demo.mjs'], {
    cwd: recipe, env, input: '', encoding: 'utf8', timeout: 120_000,
  });
  process.stdout.write(proc.stdout);
  const problems = [];
  if (proc.status !== 0) problems.push(`demo exited ${proc.status}\n${(proc.stderr ?? '').slice(-2000)}`);
  for (const line of EXPECTED[mode]) if (!proc.stdout.includes(line)) problems.push(`missing: ${line}`);
  for (const line of FORBIDDEN[mode]) if (proc.stdout.includes(line)) problems.push(`unexpected: ${line}`);
  return problems;
}

let failed = false;
for (const mode of ['approve', 'reject']) {
  console.log(`\n=== OFFLINE_APPROVAL=${mode}`);
  const problems = run(mode);
  if (problems.length > 0) {
    failed = true;
    console.log(`FAIL offline run (${mode})`);
    for (const problem of problems) console.log(`  ${problem}`);
  } else {
    console.log(`PASS offline run (${mode}): ${EXPECTED[mode].length} expected lines seen`);
  }
}
process.exit(failed ? 1 : 0);
