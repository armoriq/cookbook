// Offline stand-in for ArmorIQ Intent Gateway, speaking the OpenAI Chat Completions API.
//
// node:http only, no dependencies, listens on 127.0.0.1. It does what the real gateway does
// with each model turn, with a scripted provider in place of OpenAI:
//
//   /v1/t/<key>/chat/completions          record only: the reply passes through, nothing is checked
//   /v1/t/<key>/a/<agent>/chat/completions
//       monitor mode on   every tool call passes; each gets the verdict policy WOULD have given
//       monitor mode off  blocked (and held) tool calls are removed and the reply's text ends with
//                         'Tool call "<name>" was blocked by policy: <rule>'
//
// Decisions come from this recipe's policy.yaml (a rule naming the tool, else default_action).
//
//   node offline/gateway.mjs                         port 8787, enforce mode
//   OFFLINE_MONITOR_MODE=on node offline/gateway.mjs

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { respond } from './scripted-provider.mjs';

const ROUTE = /^\/v1\/t\/([^/]+)(?:\/a\/([^/]+))?\/chat\/completions$/;
const LABEL = { allow: 'ALLOWED', hold: 'HELD', block: 'BLOCKED' };

const log = (line) => console.log(`[armoriq] ${line}`);
const note = (line) => console.log(`[gateway] ${line}`);

// Reads the small subset of YAML that policy.yaml uses: name, default_action, and a rules list
// of `- tool:` / `action:` pairs. No YAML dependency needed.
function loadPolicy() {
  const file = process.env.OFFLINE_POLICY ?? new URL('../policy.yaml', import.meta.url);
  const policy = { name: 'policy', default_action: 'block', rules: [] };
  let rule = null;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
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

// Returns { action, reason, rule } for a tool name, from the policy file only.
function decide(policy, tool) {
  const rule = policy.rules.find((r) => r.tool === tool);
  if (rule) {
    return { action: rule.action, reason: `policy ${policy.name}: ${tool} -> ${rule.action}`, rule: `${rule.action}:${tool}#0` };
  }
  const action = policy.default_action;
  return { action, reason: `policy ${policy.name}: no rule for ${tool}, default_action -> ${action}`, rule: `default_action:${action}` };
}

export function startGateway({ monitorMode, port = 0 } = {}) {
  const gateway = {
    monitorMode: monitorMode ?? ['on', '1', 'true'].includes((process.env.OFFLINE_MONITOR_MODE ?? '').toLowerCase()),
    would: new Map(), // "tool verdict" -> count, for "What policy would have done"
    url: '',
    close: () => server.close(),
    // The offline version of the dashboard's "What policy would have done" panel.
    printReport() {
      const sum = (verdict) => [...this.would].filter(([k]) => k.endsWith(` ${verdict}`)).reduce((n, [, c]) => n + c, 0);
      note(`What policy would have done: ${sum('block')} would block, ${sum('hold')} would hold, ${sum('allow')} allowed`);
      for (const [key, count] of [...this.would].sort()) {
        const [tool, verdict] = key.split(' ');
        note(`  ${tool.padEnd(16)} ${verdict.padEnd(6)} x${count}`);
      }
    },
  };
  const seenUsers = new Set();

  function handleTurn(agentId, userEmail, body) {
    const messages = body.messages ?? [];
    const scripted = respond(messages);
    let content = scripted.content;
    let calls = scripted.calls.map(([name, args], i) => ({
      id: `call_${messages.length}_${i}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    }));
    const names = calls.map((c) => c.function.name);
    if (userEmail && !seenUsers.has(userEmail)) {
      seenUsers.add(userEmail);
      note(`request from ${userEmail} (X-User-Email, not forwarded to the provider)`);
    }

    if (calls.length > 0 && !agentId) {
      note(`recorded: ${names.join(', ')} (no agent in the URL, nothing checked)`);
    } else if (calls.length > 0) {
      const policy = loadPolicy();
      log(`plan: ${String(messages.find((m) => m.role === 'user')?.content ?? '')} -> ${names.join(', ')}`);
      const kept = [];
      const notes = [];
      for (const call of calls) {
        const tool = call.function.name;
        const { action, reason, rule } = decide(policy, tool);
        const label = LABEL[action] ?? 'BLOCKED';
        if (gateway.monitorMode) {
          const key = `${tool} ${action}`;
          gateway.would.set(key, (gateway.would.get(key) ?? 0) + 1);
          const prefix = action === 'allow' ? 'monitor mode' : `monitor mode: would ${action}, nothing stopped`;
          log(`check ${tool}: ${label} (${prefix}; ${reason})`);
          log(`args ${tool}: ${call.function.arguments}`);
          kept.push(call);
          continue;
        }
        const suffix = action === 'hold' ? '; hold acts as block at the gateway today' : '';
        log(`check ${tool}: ${label} (${reason}${suffix})`);
        log(`args ${tool}: ${call.function.arguments}`);
        if (action === 'allow') kept.push(call);
        else notes.push(`Tool call "${tool}" was blocked by policy: ${rule}`);
      }
      calls = kept;
      if (notes.length > 0) content = [content, notes.join('\n')].filter(Boolean).join('\n\n');
    }

    const message = { role: 'assistant', content };
    if (calls.length > 0) message.tool_calls = calls;
    return {
      id: `chatcmpl-offline-${messages.length}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? 'offline-model',
      choices: [{ index: 0, message, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }

  const send = (res, status, payload) => {
    const data = JSON.stringify(payload);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const match = req.method === 'POST' && ROUTE.exec(req.url);
      if (!match) {
        return send(res, 404, {
          error: {
            type: 'not_found',
            message: `stand-in gateway: ${req.method} ${req.url} is not served. Intent Gateway supports Chat Completions (/chat/completions), not the Responses API.`,
          },
        });
      }
      if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
        return send(res, 401, { error: { type: 'auth', message: 'missing provider key' } });
      }
      send(res, 200, handleTurn(match[2], req.headers['x-user-email'], JSON.parse(raw || '{}')));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      server.unref(); // let the process exit when the agent is done
      gateway.url = `http://127.0.0.1:${server.address().port}`;
      resolve(gateway);
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gateway = await startGateway({ port: Number(process.env.OFFLINE_GATEWAY_PORT ?? 8787) });
  note(`stand-in gateway on ${gateway.url} (monitor mode ${gateway.monitorMode ? 'on' : 'off'})`);
  note(`set ARMORIQ_GATEWAY_HOST=${gateway.url} and run agent.mjs. Ctrl+C to stop.`);
  setInterval(() => {}, 1 << 30);
}
