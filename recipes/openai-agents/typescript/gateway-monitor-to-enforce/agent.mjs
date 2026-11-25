// An accounts payable clerk on the OpenAI Agents SDK, governed by ArmorIQ Intent Gateway.
//
//   node agent.mjs "Pay invoice INV-1042 from Acme Supplies in full"
//
// The agent, its tools and its prompt know nothing about ArmorIQ. The only ArmorIQ change is
// the base URL of the OpenAI client (see gatewayBaseURL below). Everything else is a plain
// OpenAI Agents SDK agent.

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Agent, OpenAIChatCompletionsModel, run, tool } from '@openai/agents';
import OpenAI from 'openai';
import { z } from 'zod';

if (existsSync('.env')) process.loadEnvFile('.env');

export const DEFAULT_GOAL = 'Pay invoice INV-1042 from Acme Supplies in full';
export const BLOCK_NOTE = 'was blocked by policy';

// A tiny in-memory ledger stands in for your AP system.
const INVOICES = {
  'INV-1041': { supplier: 'Northwind Paper', amount: 310.0, status: 'approved' },
  'INV-1042': { supplier: 'Acme Supplies', amount: 1250.0, status: 'approved' },
  'INV-1043': { supplier: 'Contoso Freight', amount: 4800.0, status: 'approved' },
};

const money = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const lookupInvoice = tool({
  name: 'lookup_invoice',
  description: 'Look up an invoice by id and return its supplier, amount and status.',
  parameters: z.object({ invoice_id: z.string().describe('The invoice id, for example INV-1042') }),
  execute: async ({ invoice_id }) => {
    const invoice = INVOICES[invoice_id];
    return JSON.stringify(invoice ? { invoice_id, ...invoice } : { error: `no invoice ${invoice_id}` });
  },
});

const recordPayment = tool({
  name: 'record_payment',
  description: 'Record a payment to the supplier of an invoice. This moves money.',
  parameters: z.object({ invoice_id: z.string(), amount: z.number().describe('The amount to pay, in USD') }),
  execute: async ({ invoice_id, amount }) => {
    const invoice = INVOICES[invoice_id];
    if (!invoice) return JSON.stringify({ error: `no invoice ${invoice_id}` });
    invoice.status = 'paid';
    console.log(`[ledger] payment recorded: ${invoice_id} $${money(amount)} to ${invoice.supplier}`);
    return JSON.stringify({ invoice_id, paid: amount, status: 'paid' });
  },
});

// The one ArmorIQ change: send model traffic to Intent Gateway instead of OpenAI.
//   /v1/t/<gateway-key>             records every request, checks nothing
//   /v1/t/<gateway-key>/a/<agent>   records, and checks each tool call against the agent's policy
export function gatewayBaseURL() {
  const host = (process.env.ARMORIQ_GATEWAY_HOST ?? 'https://gw.armoriq.ai').replace(/\/+$/, '');
  const url = `${host}/v1/t/${process.env.ARMORIQ_GATEWAY_KEY}`;
  const agent = process.env.ARMORIQ_AGENT_ID?.trim();
  return agent ? `${url}/a/${agent}` : url;
}

export function buildAgent() {
  const client = new OpenAI({
    baseURL: gatewayBaseURL(),
    apiKey: process.env.OPENAI_API_KEY, // forwarded to OpenAI untouched
    defaultHeaders: { 'X-User-Email': process.env.USER_EMAIL ?? 'dana@example.com' },
  });
  // The gateway speaks Chat Completions, not the Responses API the Agents SDK uses by
  // default, so the agent gets an explicit Chat Completions model on the gateway client.
  const model = new OpenAIChatCompletionsModel(client, process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
  return new Agent({
    name: 'AP clerk',
    instructions:
      'You are an accounts payable clerk. Look up an invoice before acting on it. ' +
      'Pay only approved invoices, for exactly the invoice amount. Be brief.',
    model,
    tools: [lookupInvoice, recordPayment],
  });
}

export async function runClerk(goal = DEFAULT_GOAL) {
  console.log(`> ${goal}`);
  const result = await run(buildAgent(), goal);
  const answer = String(result.finalOutput);
  console.log(`\n${answer}\n`);
  if (answer.includes(BLOCK_NOTE)) {
    // A blocked call is removed from the model's reply, so the reply often has no tool
    // calls left. The Agents SDK treats that as the final answer, gateway note included.
    console.log('(Intent Gateway stopped a tool call; the note above names the rule.)');
  }
  return answer;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runClerk(process.argv.slice(2).join(' ') || DEFAULT_GOAL);
}
