// Scripted offline walkthrough: two on-call requests through the real agent.js graph.
//
//   npm run demo:offline
//
// The first request is held: the graph interrupts, the checkpointer saves the thread, and an
// automatic "reviewer" resumes it with Command({ resume }). Set OFFLINE_APPROVAL=reject to have
// ArmorIQ (the stand-in) reject the hold instead of approving it; the graph still finishes cleanly.
// Needs no API keys and no network, and never reads stdin.

import { run } from '../agent.js';

const REQUESTS = [
  ['Investigate and fix: reads allowed, restart held', 'checkout-api is throwing 502s. Find out why and fix it.'],
  ['Disk pressure: delete blocked', 'db-primary disk is almost full. Free up space.'],
];

// Stands in for your approvals UI: show the held calls, then resume the thread.
async function offlineReviewer(payload) {
  for (const item of payload.held) {
    console.log(`  [reviewer] sees HELD ${item.tool} ${JSON.stringify(item.args)} delegation=${item.delegationId}`);
  }
  return { reviewedBy: 'oncall-lead@example.com' };
}

for (const [title, goal] of REQUESTS) {
  console.log(`\n##### ${title}`);
  console.log(`Goal: ${goal}\n`);
  const answer = await run(goal, offlineReviewer);
  console.log('--------------------------------------------------');
  console.log('Final answer:', answer);
  console.log('--------------------------------------------------');
}
console.log('\nDone.');
