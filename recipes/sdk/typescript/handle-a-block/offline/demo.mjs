// Scripted offline walkthrough: five release requests through the real src/agent.js loop.
//
//   npm run demo:offline
//
// Set OFFLINE_APPROVAL=reject to reject the held production deploy instead of approving it.
// Needs no API keys, no Docker, and no network. Run it through register.mjs (the npm script does).

import { main } from '../src/agent.js';

const REQUESTS = [
  ['Allowed: deploy to staging', 'Deploy checkout build 512 to staging', '300'],
  ['Held: deploy to production', 'Deploy checkout build 512 to production', '300'],
  ['Blocked, then re-planned', 'Tear down the idle staging-eu environment', '300'],
  ['Off plan step, then re-planned', 'Deploy payments build 77 to staging', '300'],
  // A 2 second token and a 3 second smoke test: the token runs out mid plan.
  ['Expired token, then re-minted', 'Run smoke tests on checkout build 512, then deploy it to staging', '2'],
];

for (const [title, goal, tokenSeconds] of REQUESTS) {
  console.log(`\n##### ${title}`);
  process.env.TOKEN_VALIDITY_SECONDS = tokenSeconds;
  await main(goal);
}
console.log('\nDone.');
