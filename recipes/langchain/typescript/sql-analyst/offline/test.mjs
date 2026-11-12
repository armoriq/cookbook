// Offline test: runs demo.mjs in a subprocess and checks the log contract lines.
//
//   npm run test:offline
//
// Checks the approve run and the OFFLINE_APPROVAL=reject run. Needs no keys or network.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const recipe = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = 'policy sql-warehouse-policy';

const COMMON = [
  '[armoriq] plan: ',
  `[armoriq] check list_tables: ALLOWED (${P}: list_tables -> allow)`, // allow
  `[armoriq] check run_select: ALLOWED (${P}: run_select -> allow)`,
  '[armoriq] report run_select: success',
  `[armoriq] check update_rows: HELD (${P}: update_rows -> hold)`, // hold
  '[armoriq] args update_rows: ',
  '[armoriq] injection: ', // prompt-injection
  `[armoriq] check drop_table: BLOCKED (${P}: drop_table -> block)`, // block
  `[armoriq] check export_table: BLOCKED (${P}: export_table -> block)`,
  'Final answer: ArmorIQ stopped part of that request',
];
const EXPECTED = {
  approve: [...COMMON, '[armoriq] hold update_rows: APPROVED', '[armoriq] report update_rows: success', 'rows_updated'],
  reject: [...COMMON, '[armoriq] hold update_rows: REJECTED', 'ArmorIQ refused update_rows'],
};
const FORBIDDEN = {
  approve: ['hold update_rows: REJECTED', 'report drop_table:', 'report export_table:', '[ERROR]'],
  reject: ['hold update_rows: APPROVED', 'report update_rows:', 'report drop_table:', 'report export_table:', '[ERROR]'],
};

function run(mode) {
  const env = { ...process.env, OFFLINE_APPROVAL: mode };
  delete env.ARMORIQ_API_KEY;
  delete env.GEMINI_API_KEY;
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
