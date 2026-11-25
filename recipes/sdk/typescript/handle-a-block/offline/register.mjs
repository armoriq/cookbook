// Offline mode: run the real src/agent.js loop with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @armoriq/sdk     -> offline/armoriq-sdk.mjs  (reads policy.yaml, decides locally, runs allowed
//                                                 calls on the real release-desk MCP server)
//   ./src/planner.js -> offline/planner.mjs      (rule based planning, no Gemini key needed)
// agent.js, mcpStdio.js, and releaseDeskMcp.js run unchanged. The SDK's real exception classes are reused.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.GEMINI_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ and the planner are local stand-ins.');
console.log(`[offline] Held calls will be ${process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED'} (set OFFLINE_APPROVAL=reject or approve).`);
