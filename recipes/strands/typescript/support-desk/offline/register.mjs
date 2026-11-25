// Offline mode: run the real demo.mjs with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @armoriq/sdk      -> offline/armoriq-sdk.mjs     (reads policy.yaml and decides locally)
//   ./src/model.mjs   -> offline/scripted-model.mjs  (a scripted Strands model, no Gemini key)
// The real ArmorIQStrands plugin, the real Strands agent loop, and the real MCP client and
// server all run unchanged. Set OFFLINE_APPROVAL=reject to play the human who rejects every hold.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ and the model are local stand-ins.');
console.log(`[offline] Held calls will be ${process.env.OFFLINE_APPROVAL === 'reject' ? 'REJECTED' : 'APPROVED'} (set OFFLINE_APPROVAL=reject or approve).\n`);
