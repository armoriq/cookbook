# Build a Delegating Agent Team with the ArmorIQ SDK in TypeScript

A step by step guide to giving a sub-agent less authority than its parent. The incident lead holds an ArmorIQ intent token for the whole incident. It hands its log analyst a delegated token that only covers reading metrics and logs. Both agents carry the exact same toolbox, and when the analyst reaches for the restart button, ArmorIQ refuses it, even though the policy allows that restart and the lead makes it a minute later.

Ported from the Python recipe [`crewai/python/delegated-crew`](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/crewai/python/delegated-crew) by Naveen-6087. CrewAI has no JavaScript version, so this port drops the framework: a small agent loop calls the ArmorIQ client directly, which is the same governance code the Python recipe runs inside its CrewAI tools. See *Differences from the Python version*.

## What you'll build

```
incident lead:  capturePlan → getIntentToken (metrics, logs, restart)
                     │
                     └─ delegate(allowedActions=[get_metrics, search_logs]) → analyst token
log analyst:    get_metrics ✓   search_logs ✓   restart_service ✗ (not delegated)
incident lead:  restart_service ✓ (its own token)
```

| Tool | Policy | Incident lead's token | Log analyst's delegated token |
|---|---|---|---|
| `get_metrics` | allow | allowed | allowed |
| `search_logs` | allow | allowed | allowed |
| `restart_service` | allow | allowed | refused, not in `allowedActions` |

The policy is the same for both. The difference is entirely in the token each agent holds.

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `src/crew.js`, the real agent loop and tools, the real incident-ops MCP server (`src/incidentOpsMcp.js`, spawned over stdio), the SDK's real exception classes, and real Ed25519 key generation for the analyst. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which reads `policy.yaml`, enforces the delegated token's allowed actions, and runs allowed calls on the local server (the job ArmorIQ's proxy does live), and the Gemini model, which is scripted.

```bash
npm install
npm run demo:offline    # analyst reads, is refused the restart, lead restarts
npm run test:offline    # the same run as a pass or fail check
```

The run prints the shared log lines, plus one for the delegation:

```
[armoriq] plan: Respond to the checkout latency alert -> get_metrics, search_logs, restart_service
[armoriq] delegate log-analyst: get_metrics, search_logs
[armoriq] check get_metrics: ALLOWED (policy incident-ops-policy: get_metrics -> allow; delegated to log-analyst)
[armoriq] check search_logs: ALLOWED (policy incident-ops-policy: search_logs -> allow; delegated to log-analyst)
[armoriq] check restart_service: BLOCKED (delegation log-analyst: restart_service is not in allowed_actions [get_metrics, search_logs])
[armoriq] check restart_service: ALLOWED (policy incident-ops-policy: restart_service -> allow; parent token)
[armoriq] report restart_service: success
```

The refusal goes back to the analyst as a tool result (`REFUSED by ArmorIQ: log-analyst may not call restart_service ...`), so it reports what it found and hands the restart to the lead instead of crashing the run. Remove `restart_service` from `CHILD_ACTIONS` in `src/crew.js` (or add it) and the offline result changes with it. `OFFLINE_APPROVAL=reject` is read like everywhere else, but this policy holds nothing.

## Before you start

| Requirement | Why |
|---|---|
| Node.js 20 or newer | Runs the agents |
| An ArmorIQ account | Tokens, delegation, policy, audit |
| A Gemini API key | Drives both agents |
| A way to expose a local port (a tunnel) or somewhere to deploy | ArmorIQ's proxy has to reach the MCP server, see *Run it live* |

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai), sign up or log in, open **Settings → API Keys**, and generate a key.
2. Install and configure:

```bash
npm install
cp .env.example .env     # fill in ARMORIQ_API_KEY and GEMINI_API_KEY
```

`package.json` pins every dependency exactly, including `@armoriq/sdk` 0.8.24.

## The policy

`policy.yaml` allows all three tools. Nothing in it singles out the analyst. That is the point: delegation narrows authority below what policy grants.

## How the team is built

### The lead's token

`src/crew.js` captures one plan for the whole incident and mints one token for it, for the end user the team acts on behalf of:

```js
const plan = client.capturePlan(MODEL, prompt, { goal, steps: [get_metrics, search_logs, restart_service] });
const leadToken = await client.getIntentToken(plan, undefined, 1800, { userEmail });
```

### The delegation

The analyst gets its own Ed25519 key, and the lead delegates a token bound to that key, limited to two actions and 15 minutes:

```js
const { publicKey } = generateKeyPairSync('ed25519');
const delegation = await client.delegate(
  leadToken,
  publicKeyHex(publicKey),      // the raw 32 bytes as 64 hex characters
  900,                          // validity in seconds
  ['get_metrics', 'search_logs'],
  'log-analyst',
  { goal: 'Diagnose the checkout latency alert', service: 'checkout' },
);
const analystToken = delegation.delegatedToken;
```

A delegate can only receive a subset of what its parent holds. Asking for an action outside the parent's plan fails the delegation itself.

### The tools

`src/tools.js` has one toolbox builder. Each toolbox is bound to an authority (the agent's label, the client, its token, the user, and the MCP name), and `run` is the raw client pattern from the ArmorIQ docs:

```js
const { result } = await authority.client.invoke(authority.mcp, tool.name, authority.token, params, authority.userEmail);
```

Both agents get `incidentTools(authority)`, the same three tools, each bound to that agent's token. A `PolicyBlockedException` (or any `ArmorIQException`) is returned as text instead of thrown, so the model sees it as an observation and adapts instead of the run failing.

### The loop

`src/agent.js` is the whole agent runtime: ask the model (`src/model.js`, Gemini function calling over REST), run each tool call it asks for through ArmorIQ, hand the results back, and stop when the model answers in text. The analyst runs first and its report becomes the lead's task, like a sequential crew.

## Run it live

`invoke()` sends each call to ArmorIQ's cloud proxy, which forwards it to the server URL you registered. A process on your laptop is not reachable from there, so run the server over streamable HTTP and expose it with a tunnel, or deploy it:

```bash
node src/incidentOpsMcp.js --http      # serves http://127.0.0.1:8000/mcp
```

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, name it `incident-ops`, and point it at the public URL.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to the `incident-ops` server.
3. Set **Default enforcement action** to `block` and paste `policy.yaml` into the YAML editor. Save and activate.
4. Run it, then open **Intent** in the console, filtered by your `USER_EMAIL`, to see the lead's plan, the delegation, and each call with the token it used:

```bash
node src/crew.js
```

## Differences from the Python version

* **No CrewAI.** CrewAI has no JavaScript version. The Python recipe already drove the raw ArmorIQ client from inside each CrewAI tool, so that code carries over unchanged; what is replaced is the agent runtime. `src/agent.js` is a 30 line tool calling loop, and the two CrewAI agents and tasks become two `runAgent` calls (the analyst, then the lead with the analyst's report). Nothing here depends on a framework, and CrewAI's result cache (which the Python recipe had to turn off) does not exist.
* **Same delegation API.** `client.delegate(token, publicKey, validitySeconds, allowedActions, targetAgent, subtask)` takes positional arguments in TypeScript, where Python used keyword arguments. The delegated token is a plain object, `delegation.delegatedToken`.
* **Key generation.** `node:crypto` `generateKeyPairSync('ed25519')` replaces the Python `cryptography` package, so there is no extra dependency.
* **MCP server.** `incident_ops_mcp.py` (FastMCP) becomes `src/incidentOpsMcp.js` on `@modelcontextprotocol/sdk`, with the same tools and canned data.
* **Offline MCP.** The Python stand-in called the tool functions in process. This one spawns the real server over stdio, as the proxy would.

## Limitations and honest notes

* **Not run live for this recipe.** The offline run is checked in CI. The live path follows the SDK 0.8.24 type definitions and source but has not been run against a deployed incident-ops server.
* **`delegate()` is marked legacy in the SDK source.** The code comment says to prefer `delegateSubtree()`, which bounds a child to a subtree of the parent's plan (`subtreePath`, `allowedTools`) instead of a list of actions. This recipe uses `delegate()` because `allowedActions` is the clearest way to show narrowing; the tool code does not change if you switch.
* **How the refusal arrives live is not confirmed.** The offline stand-in throws `PolicyBlockedException` for an action outside `allowedActions`. Live, the proxy could also answer with a token error (`InvalidTokenException`, HTTP 401 or 403). `src/tools.js` catches the base `ArmorIQException` too, so either way the analyst gets a refusal, not a crash.
* **A delegated token without an expiry is already expired.** The SDK builds the delegated token with `expiresAt` from the response, defaulting to 0 if the backend omits it, and `invoke()` checks expiry before sending. If every analyst call fails with `TokenExpiredException`, inspect `delegation.delegatedToken.expiresAt`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `DelegationException` at startup | The delegation endpoint refused the request, or the parent token expired. The run prints the reason and stops |
| The analyst's reads are refused too | `allowedActions` does not match the action names in the plan, or the delegated token has no expiry (see above) |
| `MCPInvocationException ... (HTTP 502)` | The proxy cannot reach the registered server URL. See *Run it live* |
| `InvalidTokenException` for the analyst's restart | The live proxy refused the narrower token with 401 or 403. That is the expected refusal; the analyst reports it |

## What's next

* **Handle refusals in a plain loop.** The [`handle-a-block`](../handle-a-block) recipe runs the same plan, token, invoke calls and shows the recovery for each ArmorIQ exception.
* **Delegate per task.** Mint a delegation per task instead of per agent, so a sub-agent's authority ends when its task does.
* **Chain it.** A delegated token can be delegated again with an even narrower `allowedActions`, for a three level team.
