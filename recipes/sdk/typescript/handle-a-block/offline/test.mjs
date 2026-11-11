// Offline test: runs offline/demo.mjs and checks the log contract lines and the recoveries.
//
//   npm run test:offline
//
// Checks the approve run and the OFFLINE_APPROVAL=reject run. Needs no keys or network.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');

const COMMON = [
  // allow
  '[armoriq] plan: Deploy checkout build 512 to staging -> get_build_status, deploy_to_staging',
  '[armoriq] check get_build_status: ALLOWED (policy release-desk-policy: get_build_status -> allow)',
  '[armoriq] check deploy_to_staging: ALLOWED (policy release-desk-policy: deploy_to_staging -> allow)',
  '[armoriq] report deploy_to_staging: success',
  // hold
  '[armoriq] check deploy_to_production: HELD (policy release-desk-policy: deploy_to_production -> hold)',
  '[armoriq] args deploy_to_production: {',
  // block, then a re-plan that asks a human instead
  '[armoriq] check delete_environment: BLOCKED (policy release-desk-policy: delete_environment -> block)',
  '[agent] PolicyBlockedException: delete_environment was blocked',
  '[armoriq] plan: Tear down the idle staging-eu environment -> request_teardown',
  '[armoriq] check request_teardown: ALLOWED',
  'Refused: delete_environment (blocked by policy).',
  // off plan step, then a new plan and token
  '[armoriq] check rerun_ci: BLOCKED (intent mismatch: rerun_ci is not in signed plan',
  '[agent] Off plan: rerun_ci is not in the signed plan',
  '[armoriq] plan: Deploy payments build 77 to staging -> rerun_ci, deploy_to_staging',
  '[armoriq] check rerun_ci: ALLOWED (policy release-desk-policy: rerun_ci -> allow)',
  'Answer: Done: get_build_status, rerun_ci, deploy_to_staging.',
  // expired token, then a fresh one for the same plan
  '[agent] TokenExpiredException: Intent token expired',
  'Answer: Done: run_smoke_tests, deploy_to_staging.',
  '\nDone.',
];
const RUNS = [
  {
    label: 'approve',
    expected: [
      ...COMMON,
      '[armoriq] hold deploy_to_production: APPROVED',
      '[armoriq] report deploy_to_production: success',
      'Answer: Done: get_build_status, deploy_to_production.',
    ],
    unexpected: ['hold deploy_to_production: REJECTED', 'Error:'],
  },
  {
    label: 'reject',
    expected: [
      ...COMMON,
      '[armoriq] hold deploy_to_production: REJECTED',
      '[agent] DelegationException: deploy_to_production was not approved',
      'Refused: deploy_to_production (approval rejected).',
    ],
    unexpected: ['hold deploy_to_production: APPROVED', 'report deploy_to_production:', 'Error:'],
  },
];

function run(label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', './offline/register.mjs', 'offline/demo.mjs'], {
      cwd: recipe,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, OFFLINE_APPROVAL: label },
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

let failed = false;
for (const r of RUNS) {
  const { code, output } = await run(r.label);
  console.log(`--- run: ${r.label} ---`);
  console.log(output);
  const missing = r.expected.filter((line) => !output.includes(line));
  const present = r.unexpected.filter((line) => output.includes(line));
  if (code !== 0 || missing.length > 0 || present.length > 0) {
    failed = true;
    console.error(`FAIL offline run ${r.label} (exit ${code})`);
    for (const line of missing) console.error(`  missing: ${line}`);
    for (const line of present) console.error(`  should not appear: ${line}`);
  } else {
    console.log(`PASS offline run ${r.label}: ${r.expected.length} expected lines seen`);
  }
}
process.exit(failed ? 1 : 0);
