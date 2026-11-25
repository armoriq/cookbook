// Offline mode: run the real src/crew.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @armoriq/sdk   -> offline/armoriq-sdk.mjs  (reads policy.yaml, enforces the delegated token's
//                                               allowed actions, runs allowed calls on the real
//                                               incident-ops MCP server over stdio)
//   ./src/model.js -> offline/model.mjs        (a scripted model instead of Gemini)
// crew.js, agent.js, tools.js, and incidentOpsMcp.js run unchanged. The SDK's real exception classes
// and real Ed25519 key generation are used.
//
// OFFLINE_APPROVAL is read like in every offline recipe, but this policy holds nothing.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.GEMINI_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ and the model are local stand-ins.');
console.log(`[offline] Held calls will be ${process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED'} (this policy holds nothing).\n`);
