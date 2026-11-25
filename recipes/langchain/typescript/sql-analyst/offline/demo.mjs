// Scripted offline walkthrough: three analyst requests through the real agent.js.
//
//   npm run demo:offline
//
// Set OFFLINE_APPROVAL=reject to reject every held call instead of approving it. Needs no API keys and
// no network. Each run uses a fresh throwaway copy of the database.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../agent.js';

const REQUESTS = [
  ['Read only question: allowed', 'Which product made the most revenue in October 2026? Show the top three.'],
  ['Write: held for approval', 'Order 1042 was returned. Mark it as refunded.'],
  ['Prompt injection in the data', "Summarize this week's customer feedback."],
];

const workdir = mkdtempSync(join(tmpdir(), 'sql-analyst-offline-'));
process.env.ANALYTICS_DB = join(workdir, 'analytics.db');
try {
  for (const [title, goal] of REQUESTS) {
    console.log(`\n##### ${title}`);
    console.log(`Goal: ${goal}\n`);
    const answer = await run(goal);
    console.log('--------------------------------------------------');
    console.log('Final answer:', answer);
    console.log('--------------------------------------------------');
  }
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
console.log('\nDone.');
