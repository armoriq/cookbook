// Offline walkthrough of the rollout: record only, then Monitor mode, then enforce.
//
//   npm run demo:offline
//
// Starts the stand-in gateway on a free 127.0.0.1 port, points the real agent.mjs at it by
// changing only ARMORIQ_GATEWAY_HOST, and runs one payment request per phase. No keys, no
// network beyond localhost.

import { startGateway } from './gateway.mjs';

// agent.mjs reads these; the stand-in checks only that a provider key is sent.
process.env.OPENAI_API_KEY ??= 'offline';
process.env.ARMORIQ_GATEWAY_KEY ??= 'offline-gateway-key';
process.env.USER_EMAIL ??= 'dana@example.com';
process.env.OPENAI_AGENTS_DISABLE_TRACING = '1'; // traces would upload to OpenAI

const { gatewayBaseURL, runClerk } = await import('../agent.mjs');

const PHASES = [
  ['Phase 1: record only (base URL without an agent)', '', false, 'Pay invoice INV-1041 from Northwind Paper in full'],
  ['Phase 2: agent in the URL, Monitor mode on', 'ap-clerk', true, 'Pay invoice INV-1042 from Acme Supplies in full'],
  ['Phase 3: Monitor mode off, policy enforced', 'ap-clerk', false, 'Pay invoice INV-1043 from Contoso Freight in full'],
];

const gateway = await startGateway();
process.env.ARMORIQ_GATEWAY_HOST = gateway.url;
console.log(`[offline] stand-in gateway on ${gateway.url}; OpenAI is scripted, no keys used.`);

for (const [title, agentId, monitor, goal] of PHASES) {
  console.log(`\n##### ${title}`);
  process.env.ARMORIQ_AGENT_ID = agentId;
  gateway.monitorMode = monitor;
  console.log(`[offline] base URL: ${gatewayBaseURL()}`);
  await runClerk(goal);
  if (monitor) gateway.printReport();
}
gateway.close();
console.log('\nDone.');
