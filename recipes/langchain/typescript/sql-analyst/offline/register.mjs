// Offline mode: run the real agent.js with no API keys and no network.
//
//   npm run demo:offline
//
// Node loads this file first (node --import). It swaps two imports for local stand-ins:
//   @armoriq/sdk            -> offline/armoriq-sdk.mjs (reads policy.yaml and decides locally)
//   @langchain/google-genai -> offline/model.mjs       (a scripted tool calling chat model, no Gemini key)
// agent.js, createAgent, the real MCP adapters, the real SQLite MCP server (spawned over stdio), and
// the real ArmorIQLangChain callback handler all run unchanged.
//
// Set OFFLINE_APPROVAL=reject to play the human who rejects every held call.

import { register } from 'node:module';

process.env.ARMORIQ_API_KEY ??= 'offline';
process.env.GEMINI_API_KEY ??= 'offline';
process.env.USER_EMAIL ??= 'you@example.com';

register('./hooks.mjs', import.meta.url);

console.log('[offline] No API keys or network: ArmorIQ and the chat model are local stand-ins.');
console.log('[offline] The real ArmorIQLangChain handler and the real SQLite MCP server are running.\n');
