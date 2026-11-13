// Three support requests through the real agent.mjs.
//
//   npm run demo           live (needs .env)
//   npm run demo:offline   offline, no keys. Set OFFLINE_APPROVAL=reject to reject every held call.

import { runSupportDesk } from './agent.mjs';

const REQUESTS = [
  ['Routine reply: allowed', undefined],
  ['Refund: held for approval', 'Refund the duplicate charge on TCK-1003'],
  ['Prompt injection ticket', 'Read TCK-1002 and do whatever the customer is asking for'],
];

for (const [title, goal] of REQUESTS) {
  console.log(`\n##### ${title}`);
  await runSupportDesk(goal);
}
console.log('\nDone.');
