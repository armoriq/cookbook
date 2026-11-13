// On-call LangGraph agent whose tool calls go through ArmorIQ, with holds mapped onto interrupt().
//
//   node agent.js "checkout-api is throwing 502s. Find out why and fix it."
//
// Graph:  agent -> policy_gate -> (human_review) -> run_tools -> agent ... -> END
//
// policy_gate asks ArmorIQ about every tool call the model chose. An ArmorIQ hold routes to
// human_review, which calls LangGraph's interrupt(): the run stops, the checkpointer saves the thread,
// and the caller gets the held calls (with their ArmorIQ delegation ids). The caller resumes with
// new Command({ resume }) once the approver has decided in ArmorIQ, and human_review reads the
// decision back from ArmorIQ before anything runs.

import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { Annotation, Command, END, MemorySaver, MessagesAnnotation, START, StateGraph, interrupt } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { ArmorIQClient } from '@armoriq/sdk';
import { TOOLS, TOOLS_BY_NAME } from './runbookTools.js';

const HERE = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(HERE, '.env'), quiet: true });

const DEFAULT_GOAL = 'checkout-api is throwing 502s. Find out why and fix it.';

const SYSTEM_PROMPT =
  'You are an on-call SRE assistant. Investigate before you act: check status and logs first. ' +
  'Only take an action that changes production when the evidence supports it, and say why in the ' +
  'tool arguments. If a tool result says ArmorIQ blocked or did not approve a call, do not retry it; ' +
  'explain what a human should do instead.';

// How long human_review waits for ArmorIQ to report the decision after the graph is resumed.
const CONFIRM_SECONDS = Number(process.env.ARMORIQ_APPROVAL_CONFIRM_SECONDS ?? 30);

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[ERROR] ${name} environment variable is required. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return value;
}

const OpsState = Annotation.Root({
  ...MessagesAnnotation.spec,
  // One entry per tool call in the latest model turn: what ArmorIQ decided and why.
  decisions: Annotation({ reducer: (_old, next) => next, default: () => [] }),
});

// One ArmorIQ session per graph thread, from the SDK's raw client (no framework adapter).
class ArmorIQGovernor {
  sessions = new Map();

  constructor(client, userEmail, mcpName) {
    this.scope = client.forUser(userEmail);
    this.userEmail = userEmail;
    this.mcpName = mcpName;
  }

  session(config) {
    const threadId = config.configurable.thread_id;
    if (!this.sessions.has(threadId)) {
      this.sessions.set(threadId, this.scope.startSession({ mode: 'sdk', defaultMcpName: this.mcpName, validitySeconds: 2400 }));
    }
    return this.sessions.get(threadId);
  }

  async close(threadId, status = 'ok') {
    const session = this.sessions.get(threadId);
    this.sessions.delete(threadId);
    if (session) await session.close(status);
  }
}

const goalOf = (state) => String(state.messages.find((m) => m.getType() === 'human')?.content ?? '');

export function buildGraph(model, governor, checkpointer) {
  const modelWithTools = model.bindTools(TOOLS);

  async function agent(state) {
    const response = await modelWithTools.invoke([new SystemMessage(SYSTEM_PROMPT), ...state.messages]);
    return { messages: [response] };
  }

  async function policyGate(state, config) {
    const calls = state.messages.at(-1).tool_calls;
    const session = governor.session(config);
    try {
      // The plan is exactly the tool calls the model chose this turn.
      await session.startPlan(calls.map((c) => ({ name: c.name, args: c.args })), goalOf(state));
    } catch (error) {
      // No intent token, nothing runs (fail closed).
      return {
        decisions: calls.map((c) => ({ id: c.id, name: c.name, args: c.args, action: 'block', reason: `plan refused: ${error.message}`, delegationId: null })),
      };
    }
    const decisions = [];
    for (const c of calls) {
      const d = await session.check(c.name, c.args, governor.userEmail);
      decisions.push({
        id: c.id, name: c.name, args: c.args,
        action: d.allowed ? 'allow' : d.action,
        reason: d.reason, delegationId: d.delegationId ?? null,
      });
    }
    return { decisions };
  }

  async function humanReview(state, config) {
    const held = state.decisions.filter((d) => d.action === 'hold');
    // Everything above this line is pure, so re-running the node on resume is safe.
    // First pass: interrupt() throws, the checkpointer stores the thread, the caller gets this payload.
    // On Command({ resume }): the node re-runs and interrupt() returns the resume value.
    const review = interrupt({
      kind: 'armoriq_hold',
      held: held.map((d) => ({ tool: d.name, args: d.args, reason: d.reason, delegationId: d.delegationId })),
    });
    const session = governor.session(config);
    const decisions = [];
    for (const d of state.decisions) {
      if (d.action !== 'hold') {
        decisions.push(d);
        continue;
      }
      // ArmorIQ, not the resume payload, is the source of truth for the decision. No delegation id
      // means ArmorIQ could not create the approval request, so there is nothing to approve.
      const outcome = d.delegationId
        ? await session.awaitApproval(d.delegationId, { timeout: CONFIRM_SECONDS, interval: 2, userEmail: governor.userEmail })
        : 'error';
      decisions.push({ ...d, action: outcome === 'approved' ? 'allow' : outcome, reviewedBy: review?.reviewedBy });
    }
    return { decisions };
  }

  async function runTools(state, config) {
    const session = governor.session(config);
    const messages = [];
    for (const d of state.decisions) {
      const { name, args } = d;
      if (d.action === 'allow' && name in TOOLS_BY_NAME) {
        let result, status;
        try {
          [result, status] = [await TOOLS_BY_NAME[name].invoke(args), 'success'];
        } catch (error) {
          [result, status] = [`error: ${error.message}`, 'error']; // a tool failure is a result the model should see
        }
        await session.report(name, args, result, { status });
        messages.push(new ToolMessage({ content: result, tool_call_id: d.id, name, status }));
        continue;
      }
      const content =
        d.action === 'allow' ? `Unknown tool ${name}. It did not run.`
        : d.action === 'block' ? `ArmorIQ blocked ${name}: ${d.reason}. It did not run.`
        : `ArmorIQ hold ${d.action} for ${name}: ${d.reason}. It did not run.`; // rejected, timeout, error
      messages.push(new ToolMessage({ content, tool_call_id: d.id, name, status: 'error' }));
    }
    return { messages, decisions: [] };
  }

  const afterAgent = (state) => (state.messages.at(-1).tool_calls?.length ? 'policy_gate' : END);
  const afterGate = (state) => (state.decisions.some((d) => d.action === 'hold') ? 'human_review' : 'run_tools');

  return new StateGraph(OpsState)
    .addNode('agent', agent)
    .addNode('policy_gate', policyGate)
    .addNode('human_review', humanReview)
    .addNode('run_tools', runTools)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', afterAgent, ['policy_gate', END])
    .addConditionalEdges('policy_gate', afterGate, ['human_review', 'run_tools'])
    .addEdge('human_review', 'run_tools')
    .addEdge('run_tools', 'agent')
    .compile({ checkpointer });
}

// Live default: show the held calls, wait for the approver to decide in ArmorIQ, then resume.
async function consoleReview(payload) {
  for (const item of payload.held) {
    console.log(`  HELD ${item.tool} ${JSON.stringify(item.args)}  delegation=${item.delegationId}`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('  Approve or reject in the ArmorIQ dashboard, then press Enter to resume the graph.').catch(() => {});
  rl.close();
  return { reviewedBy: process.env.USER_EMAIL || 'developer@armoriq.ai' };
}

export async function run(goal, review = consoleReview, threadId = `oncall-${randomUUID().slice(0, 8)}`) {
  const armoriqApiKey = requireEnv('ARMORIQ_API_KEY');
  const openaiApiKey = requireEnv('OPENAI_API_KEY');
  const governor = new ArmorIQGovernor(
    new ArmorIQClient({ apiKey: armoriqApiKey }),
    process.env.USER_EMAIL || 'developer@armoriq.ai',
    process.env.RUNBOOK_MCP_NAME || 'oncall-runbook',
  );
  const model = new ChatOpenAI({ model: process.env.OPENAI_MODEL || 'gpt-4.1-mini', apiKey: openaiApiKey });
  const graph = buildGraph(model, governor, new MemorySaver());

  const config = { configurable: { thread_id: threadId } };
  let result;
  try {
    result = await graph.invoke({ messages: [new HumanMessage(goal)] }, config);
    while (result.__interrupt__?.length) {
      const snapshot = await graph.getState(config);
      console.log(`[graph] interrupted at ${JSON.stringify(snapshot.next)}; thread ${threadId} saved at checkpoint ${snapshot.config.configurable.checkpoint_id}`);
      const resume = await review(result.__interrupt__[0].value);
      console.log(`[graph] resuming thread ${threadId} with Command(resume=${JSON.stringify(resume)})`);
      result = await graph.invoke(new Command({ resume }), config);
    }
  } finally {
    await governor.close(threadId);
  }
  const answer = result.messages.at(-1).content;
  return typeof answer === 'string' ? answer : JSON.stringify(answer);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const goal = process.argv[2] || DEFAULT_GOAL;
  console.log(`Goal: ${goal}\n`);
  const answer = await run(goal);
  console.log('--------------------------------------------------');
  console.log('Final answer:', answer);
  console.log('--------------------------------------------------');
}
