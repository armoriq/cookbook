// Offline stand-in for the ArmorIQ client and session. No network, no API key.
//
// It decides allow, hold or block from this recipe's own policy.yaml: a rule that names the tool
// wins, otherwise default_action applies. Every decision prints one line in the shared
// "[armoriq] ..." log format. The real ArmorIQStrands plugin runs on top of this.

import { readFileSync } from 'node:fs';

// Phrases the stand-in scanner treats as a prompt injection attempt inside a tool result.
const INJECTION_MARKERS = ['system override', 'pre-authorized', 'no approval needed'];
const LABEL = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' };

const log = (line) => console.log(`[armoriq] ${line}`);

// Reads the small subset of YAML that policy.yaml uses: name, scope.target, default_action, and a
// rules list of `- tool:` / `action:` pairs. No YAML dependency needed.
function loadPolicy() {
  const file = process.env.OFFLINE_POLICY ?? new URL('../policy.yaml', import.meta.url);
  const policy = { name: 'policy', target: 'support-desk', default_action: 'block', rules: [] };
  let rule = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+#.*$/, '');
    let m;
    if ((m = line.match(/^name:\s*(\S+)/))) policy.name = m[1];
    else if ((m = line.match(/^\s+target:\s*(\S+)/))) policy.target = m[1];
    else if ((m = line.match(/^default_action:\s*(\S+)/))) policy.default_action = m[1];
    else if ((m = line.match(/^\s*-\s*tool:\s*(\S+)/))) policy.rules.push((rule = { tool: m[1] }));
    else if (rule && (m = line.match(/^\s+action:\s*(\S+)/))) rule.action = m[1];
  }
  return policy;
}

function decide(policy, tool) {
  const rule = policy.rules.find((r) => r.tool === tool);
  if (rule) return { action: rule.action, reason: `policy ${policy.name}: ${tool} -> ${rule.action}` };
  const action = policy.default_action;
  return { action, reason: `policy ${policy.name}: no rule for ${tool}, default_action -> ${action}` };
}

class StandInSession {
  constructor(client) {
    this.client = client;
    this.holds = new Map();
  }

  async startPlan(toolCalls, goal) {
    log(`plan: ${goal ?? 'agent turn'} -> ${toolCalls.map((c) => c.name).join(', ')}`);
    return { token: 'offline-intent-token' };
  }

  async check(toolName, args) {
    const { action, reason } = decide(this.client.policy, toolName);
    log(`check ${toolName}: ${LABEL[action] ?? 'BLOCKED'} (${reason})`);
    log(`args ${toolName}: ${JSON.stringify(args)}`);
    let delegationId;
    if (action === 'hold') {
      delegationId = `offline-delegation-${this.holds.size + 1}`;
      this.holds.set(delegationId, toolName);
    }
    return { allowed: action === 'allow', action: action === 'allow' || action === 'hold' ? action : 'block', reason, delegationId };
  }

  async awaitApproval(delegationId) {
    const tool = this.holds.get(delegationId) ?? 'unknown';
    const approved = (process.env.OFFLINE_APPROVAL ?? 'approve').trim().toLowerCase() !== 'reject';
    log(`hold ${tool}: ${approved ? 'APPROVED' : 'REJECTED'}`);
    return approved ? 'approved' : 'rejected';
  }

  async report(toolName, args, result, options) {
    log(`report ${toolName}: ${options?.status ?? 'success'}`);
    const text = JSON.stringify(result ?? '').toLowerCase();
    if (INJECTION_MARKERS.some((marker) => text.includes(marker))) {
      log(`injection: result of ${toolName} tells the agent it is pre-authorized to skip approval`);
    }
  }

  async close() {}
}

export class ArmorIQClient {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey;
    this.policy = loadPolicy();
  }

  async bootstrap() {
    return { toolMap: Object.fromEntries(this.policy.rules.map((r) => [r.tool, this.policy.target])) };
  }

  forUser(userEmail) {
    const client = this;
    return { userEmail: userEmail.trim().toLowerCase(), startSession: () => new StandInSession(client) };
  }

  invalidateUser() {}
}
