// Offline stand-in for the ArmorIQClient in @armoriq/sdk. No network, no API key.
//
// It offers the calls the agent makes (capturePlan, getIntentToken, invokeWithPolicy, close) and
// raises the SDK's real exception classes in the same situations:
//
//   token past its expiry      -> TokenExpiredException            (the real client checks this before sending)
//   action not in signed plan  -> MCPInvocationException, HTTP 409 (the real proxy refuses; 0.8.24 has no IntentMismatchException)
//   policy says block          -> PolicyBlockedException
//   policy says hold           -> waits for OFFLINE_APPROVAL, then runs it or raises DelegationException
//
// Decisions come from this recipe's policy.yaml (a rule that names the tool wins, otherwise
// default_action). Allowed calls run on the real src/releaseDeskMcp.js, spawned over stdio, which is
// the job ArmorIQ's proxy does live. Every decision prints one "[armoriq] ..." log line.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The real exception classes and IntentToken helper, loaded from the installed package by path so
// this file's own specifier swap (see hooks.mjs) does not apply.
const require = createRequire(import.meta.url);
const real = require(require.resolve('@armoriq/sdk'));
export const { ArmorIQException, DelegationException, InvalidTokenException, IntentToken, MCPInvocationException, PolicyBlockedException, PolicyHoldException, TokenExpiredException } = real;

const SERVER = fileURLToPath(new URL('../src/releaseDeskMcp.js', import.meta.url));
const log = (line) => console.log(`[armoriq] ${line}`);

// Reads the small subset of YAML that policy.yaml uses: name, default_action, and a rules list of
// `- tool:` / `action:` pairs. No YAML dependency needed.
function loadPolicy(file) {
  const policy = { name: 'policy', default_action: 'block', rules: [] };
  let rule = null;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^name:\s*(\S+)/))) policy.name = m[1];
    else if ((m = line.match(/^default_action:\s*(\S+)/))) policy.default_action = m[1];
    else if ((m = line.match(/^\s*-\s*tool:\s*(\S+)/))) policy.rules.push((rule = { tool: m[1] }));
    else if (rule && (m = line.match(/^\s+action:\s*(\S+)/))) rule.action = m[1];
  }
  return policy;
}

const policy = loadPolicy(new URL('../policy.yaml', import.meta.url));
const WORDS = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' };

function decide(tool) {
  const rule = policy.rules.find((r) => r.tool === tool);
  const action = rule?.action ?? policy.default_action;
  const normalized = action === 'allow' || action === 'hold' ? action : 'block';
  const reason = rule
    ? `policy ${policy.name}: ${tool} -> ${normalized}`
    : `policy ${policy.name}: no rule for ${tool}, default_action -> ${normalized}`;
  return { action: normalized, reason };
}

export class ArmorIQClient {
  #mcp = null;
  #tokens = 0;
  #holds = 0;

  capturePlan(llm, prompt, plan) {
    if (!plan || !plan.steps) throw new Error("Plan must contain 'steps' key");
    log(`plan: ${plan.goal ?? prompt} -> ${plan.steps.map((s) => s.action).join(', ')}`);
    return { plan, llm, prompt, metadata: {} };
  }

  async getIntentToken(capture, _policy, validitySeconds = 60, options = {}) {
    this.#tokens += 1;
    const now = Date.now() / 1000;
    const token = {
      tokenId: `offline-token-${this.#tokens}`,
      planHash: `offline-plan-${this.#tokens}`,
      signature: 'offline',
      issuedAt: now,
      expiresAt: now + validitySeconds,
      policy: {},
      compositeIdentity: options.userEmail ?? '',
      stepProofs: [],
      totalSteps: capture.plan.steps.length,
      rawToken: { plan: capture.plan },
    };
    log(`token: ${token.tokenId} for ${token.totalSteps} step(s), valid ${validitySeconds}s`);
    return token;
  }

  async invokeWithPolicy(mcp, action, token, params = {}, options = {}) {
    if (IntentToken.isExpired(token)) {
      throw new TokenExpiredException(
        `Intent token expired ${Math.abs(IntentToken.timeUntilExpiry(token)).toFixed(1)}s ago`,
        token.tokenId,
        token.expiresAt,
      );
    }
    const planned = (token.rawToken.plan?.steps ?? []).map((s) => s.action);
    if (!planned.includes(action)) {
      log(`check ${action}: BLOCKED (intent mismatch: ${action} is not in signed plan ${token.tokenId})`);
      throw new MCPInvocationException(`MCP invocation failed: intent mismatch, ${action} is not in the signed plan`, mcp, action, 409);
    }

    const { action: verdict, reason } = decide(action);
    log(`check ${action}: ${WORDS[verdict]} (${reason})`);
    log(`args ${action}: ${JSON.stringify(params)}`);
    if (verdict === 'hold') {
      if (!options.waitForApproval || !options.userEmail) throw new PolicyHoldException('Action held for approval', {}, {}, policy.name, reason);
      this.#holds += 1;
      options.onHold?.({ reason, tool: action, mcp });
      await new Promise((resolve) => setTimeout(resolve, 300));
      const approved = (process.env.OFFLINE_APPROVAL ?? 'approve').trim().toLowerCase() !== 'reject';
      log(`hold ${action}: ${approved ? 'APPROVED' : 'REJECTED'}`);
      if (!approved) throw new DelegationException('Delegation rejected', undefined, `offline-delegation-${this.#holds}`);
    } else if (verdict !== 'allow') {
      throw new PolicyBlockedException('Action blocked by policy', 'block', reason, {}, policy.name);
    }

    this.#mcp ??= await connect();
    const started = Date.now();
    const reply = await this.#mcp.callTool({ name: action, arguments: params });
    const text = (reply.content ?? []).map((c) => c.text ?? '').join(' ').trim();
    if (reply.isError) {
      log(`report ${action}: error`);
      throw new MCPInvocationException(`MCP tool error: ${text}`, mcp, action);
    }
    log(`report ${action}: success`);
    let result = text;
    try { result = JSON.parse(text); } catch { /* plain text result */ }
    return { mcp, action, result, status: 'success', executionTime: (Date.now() - started) / 1000, verified: true, metadata: {} };
  }

  close() {
    this.#mcp?.close();
    this.#mcp = null;
  }
}

async function connect() {
  const client = new Client({ name: 'offline-proxy', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER] }));
  return client;
}
