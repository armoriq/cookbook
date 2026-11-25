// A release-desk agent written as a plain plan -> intent token -> invoke loop on the ArmorIQ SDK.
//
// No agent framework. The loop plans with a model, mints one intent token for that plan, invokes
// each step through ArmorIQ, and when ArmorIQ says no (a block, a rejected hold, an expired token,
// a step outside the signed plan) it recovers: it re-plans, re-mints, or tells the user, instead
// of crashing.
//
//   node src/agent.js "Deploy checkout build 512 to staging"

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import {
  ArmorIQClient,
  ArmorIQException,
  DelegationException,
  MCPInvocationException,
  PolicyBlockedException,
  PolicyHoldException,
  TokenExpiredException,
} from '@armoriq/sdk';
import * as mcpStdio from './mcpStdio.js';
import * as planner from './planner.js';

const MCP_NAME = process.env.RELEASE_DESK_MCP_NAME || 'release-desk';
const MAX_PLANS = 3; // first plan plus two re-plans, then give up and say so

const say = (line) => console.log(`[agent] ${line}`);

function requireEnv(name) {
  if (!process.env[name]) {
    console.log(`[ERROR] ${name} environment variable is required. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return process.env[name];
}

// Look at what a step returned and decide whether the agent wants an extra step. A red build makes
// the agent want to rerun CI before it deploys. That step was not in the plan the token was signed
// for, which is what the off plan recovery below is about.
function react(step, result) {
  if (step.action === 'get_build_status' && result?.status === 'failed') {
    say(`build ${result.build_id} is red (${result.failing_test ?? 'a failing test'}), so I want to rerun CI first`);
    return { action: 'rerun_ci', params: { ...step.params } };
  }
  return null;
}

// What happened during one goal, for the answer at the end.
class Run {
  done = [];
  refused = [];
  answer(stopped) {
    const parts = [this.done.length ? `Done: ${this.done.join(', ')}.` : 'Nothing was done.'];
    if (this.refused.length) parts.push(`Refused: ${this.refused.join('; ')}.`);
    if (stopped) parts.push(stopped);
    return parts.join(' ');
  }
}

// In the TypeScript SDK there is no IntentMismatchException class. An action outside the signed
// plan is refused by ArmorIQ's proxy with HTTP 409, which surfaces as an MCPInvocationException.
const isOffPlan = (e) => e instanceof MCPInvocationException && e.statusCode === 409;

export async function run(goal, { client, userEmail, tokenSeconds = 300 }) {
  const tools = await mcpStdio.listTools();
  const record = new Run();
  const avoid = [];
  let steps = await planner.plan(goal, tools);

  for (let attempt = 1; attempt <= MAX_PLANS; attempt++) {
    steps = steps.filter((s) => !avoid.includes(s.action));
    if (steps.length === 0) return record.answer('No allowed way to finish this, so I stopped and am telling you instead.');
    if (attempt > 1) say(`re-planned (attempt ${attempt}): ${steps.map((s) => s.action).join(', ')}`);

    // Step 1: capture the plan. Every tool call the agent may make must be in here.
    const capture = client.capturePlan(planner.MODEL, goal, {
      goal,
      steps: steps.map((s) => ({ action: s.action, mcp: MCP_NAME, params: s.params })),
    });

    // Step 2: mint an intent token bound to that plan. A plan that names a denied tool can be
    // refused here, before anything runs.
    let token;
    try {
      token = await client.getIntentToken(capture, undefined, tokenSeconds, { userEmail });
    } catch (e) {
      if (!(e instanceof PolicyBlockedException)) throw e;
      const denied = e.metadata?.deniedTools ?? e.metadata?.denied_tools ?? [];
      say(`PolicyBlockedException at token issuance: ${e.reason ?? e.message}. Re-planning without ${denied.length ? denied : 'it'}.`);
      avoid.push(...(denied.length ? denied : steps.map((s) => s.action)));
      record.refused.push(`plan refused at token issuance (${e.reason ?? e.message})`);
      steps = await planner.plan(goal, tools, { avoid, done: record.done });
      continue;
    }

    // Step 3: invoke each step through ArmorIQ, and recover from each kind of "no".
    let nextPlan = null;
    let retriedExpiry = false;
    let i = 0;
    while (i < steps.length) {
      const step = steps[i];
      let result;
      try {
        ({ result } = await client.invokeWithPolicy(MCP_NAME, step.action, token, step.params, {
          userEmail,
          waitForApproval: true, // a hold waits for a human, then retries once approved
          delegationTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 300000),
          onHold: (info) => info.delegationId === undefined &&
            say(`${info.tool} is waiting for a human approver (${info.reason})`),
        }));
      } catch (e) {
        if (e instanceof TokenExpiredException) {
          if (retriedExpiry) throw e;
          // Same plan, fresh token. Nothing about the intent changed, only the clock.
          say(`TokenExpiredException: ${e.message}. Minting a fresh token for the same plan and retrying ${step.action}.`);
          token = await client.getIntentToken(capture, undefined, tokenSeconds, { userEmail });
          retriedExpiry = true;
          continue;
        }
        if (isOffPlan(e)) {
          // The agent drifted from the plan it signed. Make the drift the new plan, sign it, go on.
          say(`Off plan: ${step.action} is not in the signed plan (HTTP 409). Capturing a new plan from here and minting a new token.`);
          nextPlan = steps.slice(i);
          break;
        }
        if (e instanceof PolicyBlockedException) {
          // A hard no. Never retry the same tool; ask the planner for another way.
          say(`PolicyBlockedException: ${step.action} was blocked (${e.reason ?? e.message}). Re-planning without it.`);
          avoid.push(step.action);
          record.refused.push(`${step.action} (blocked by policy)`);
          nextPlan = await planner.plan(goal, tools, { avoid, done: record.done });
          break;
        }
        if (e instanceof DelegationException) {
          // The hold was rejected or timed out. A human said no: stop and say so, no workaround.
          say(`DelegationException: ${step.action} was not approved (${e.message}). Stopping here.`);
          record.refused.push(`${step.action} (approval ${e.message.replace('Delegation ', '')})`);
          return record.answer('A human declined that step, so I did not try another route.');
        }
        if (e instanceof PolicyHoldException) {
          // Held, but we could not wait (no user email to attribute the approval to).
          say(`PolicyHoldException: ${step.action} needs approval (${e.reason ?? e.message}).`);
          record.refused.push(`${step.action} (waiting for approval)`);
          return record.answer('Approve it on the ArmorIQ dashboard and run me again.');
        }
        if (e instanceof MCPInvocationException) {
          say(`MCPInvocationException: the release-desk server failed on ${step.action} (${e.message}).`);
          record.refused.push(`${step.action} (tool error)`);
          return record.answer('The tool itself failed, so I stopped.');
        }
        throw e;
      }

      say(`${step.action} -> ${JSON.stringify(result)}`);
      record.done.push(step.action);
      const extra = react(step, result);
      if (extra) steps.splice(i + 1, 0, extra);
      retriedExpiry = false;
      i += 1;
    }

    if (nextPlan === null) return record.answer();
    steps = nextPlan;
  }
  return record.answer(`Gave up after ${MAX_PLANS} plans.`);
}

export async function main(goal = 'Deploy checkout build 512 to staging') {
  const apiKey = requireEnv('ARMORIQ_API_KEY');
  requireEnv('GEMINI_API_KEY');
  const userEmail = process.env.USER_EMAIL || 'developer@armoriq.ai';
  const tokenSeconds = Number(process.env.TOKEN_VALIDITY_SECONDS || 300);

  console.log(`Goal: ${goal}`);
  const client = new ArmorIQClient({ apiKey });
  let answer;
  try {
    answer = await run(goal, { client, userEmail, tokenSeconds });
  } catch (e) {
    if (!(e instanceof ArmorIQException)) throw e;
    // Last line of defence: anything the loop did not handle still ends in a sentence, not a stack trace.
    say(`${e.constructor.name}: ${e.message}`);
    answer = 'ArmorIQ refused this in a way I could not recover from, so nothing more was done.';
  } finally {
    client.close();
  }
  console.log(`Answer: ${answer}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv[2]);
