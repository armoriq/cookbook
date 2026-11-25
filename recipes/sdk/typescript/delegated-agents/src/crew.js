// Two agent incident team where the lead delegates a narrower ArmorIQ token to a log analyst.
//
// The incident lead holds an intent token for the whole incident plan (read metrics, read logs,
// restart). It delegates a token to the log analyst that only allows the two reads. Both agents get
// the same toolbox; what they may actually do is decided by the token behind each tool.
//
//   node src/crew.js

import 'dotenv/config';
import { generateKeyPairSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ArmorIQClient, ArmorIQException } from '@armoriq/sdk';
import { runAgent } from './agent.js';
import { MODEL } from './model.js';
import { incidentTools } from './tools.js';

const MCP_NAME = process.env.INCIDENT_OPS_MCP_NAME || 'incident-ops';
const ALERT = 'checkout p95 latency is 4.2s against a 380ms baseline, and error rate is above 3%.';
const CHILD_ACTIONS = ['get_metrics', 'search_logs']; // what the analyst is trusted with

function requireEnv(name) {
  if (!process.env[name]) {
    console.log(`[ERROR] ${name} environment variable is required. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return process.env[name];
}

// delegate() wants the delegate's Ed25519 public key as 64 hex characters (the raw 32 bytes).
function publicKeyHex(publicKey) {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
}

export async function runCrew(client, userEmail) {
  // 1. The lead's plan: everything the incident might need. One token covers it.
  const plan = client.capturePlan(MODEL, `Respond to the checkout latency alert: ${ALERT}`, {
    goal: 'Respond to the checkout latency alert',
    steps: ['get_metrics', 'search_logs', 'restart_service'].map((action) => ({ action, mcp: MCP_NAME, params: { service: 'checkout' } })),
  });
  const leadToken = await client.getIntentToken(plan, undefined, 1800, { userEmail });

  // 2. Delegate a narrower token to the analyst: the two reads, nothing else, for 15 minutes.
  const { publicKey } = generateKeyPairSync('ed25519'); // the analyst's own identity; the token is bound to it
  const delegation = await client.delegate(
    leadToken,
    publicKeyHex(publicKey),
    900,
    CHILD_ACTIONS,
    'log-analyst',
    { goal: 'Diagnose the checkout latency alert', service: 'checkout' },
  );
  console.log(`[crew] delegation ${delegation.delegationId}: log-analyst may ${CHILD_ACTIONS.join(', ')}`);

  const lead = { agent: 'incident-lead', client, token: leadToken, userEmail, mcp: MCP_NAME };
  const analyst = { agent: 'log-analyst', client, token: delegation.delegatedToken, userEmail, mcp: MCP_NAME };

  // 3. The analyst investigates with the narrow token. Its restart attempt is refused.
  const report = await runAgent({
    name: 'log-analyst',
    system: 'You are the Log Analyst, an SRE who reads dashboards and logs carefully and reports what the evidence shows. ' +
      'If a tool is refused, do not try to work around it: report it and say who should act.',
    task: `Alert: ${ALERT} Investigate the checkout service: read its metrics, search its logs for errors, ` +
      'and if it looks stuck, restart it. Report what you found and what you did.',
    tools: incidentTools(analyst),
  });

  // 4. The lead reads the report and makes the restart with its own token.
  return runAgent({
    name: 'incident-lead',
    system: 'You are the Incident Lead, the on call incident commander. You own any action that changes production.',
    task: `Read the analyst's report. If checkout still needs a restart, restart it. Then write a two sentence incident update.\n\nAnalyst report:\n${report}`,
    tools: incidentTools(lead),
  });
}

export async function main() {
  const apiKey = requireEnv('ARMORIQ_API_KEY');
  requireEnv('GEMINI_API_KEY');
  const userEmail = process.env.USER_EMAIL || 'developer@armoriq.ai';
  const client = new ArmorIQClient({ apiKey });
  try {
    const update = await runCrew(client, userEmail);
    console.log('\n--------------------------------------------------');
    console.log(`INCIDENT UPDATE:\n\n${update}`);
  } catch (e) {
    if (!(e instanceof ArmorIQException)) throw e;
    console.log(`[crew] ArmorIQ refused to set up the crew: ${e.constructor.name}: ${e.message}`);
  } finally {
    client.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
