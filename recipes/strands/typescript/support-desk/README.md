# Build a Strands Agent with the ArmorIQ SDK in TypeScript

A step by step guide to dropping ArmorIQ into an AWS Strands Agents assistant written in TypeScript, with the SDK's shipped `ArmorIQStrands` integration, not a hand rolled enforcement loop. It is the TypeScript counterpart of the Python Strands recipe: the same idea of adding ArmorIQ to the framework you already use, in a domain built to show holds, approvals, and live enforcement events.

Ported from the Python recipe [`strands/python/support-desk`](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/strands/python/support-desk) by Naveen-6087. The tickets, tools, policy rules, and planted data are the same; see *Differences from the Python version* for what changed. The Strands Agents TypeScript SDK is in preview, so expect its API to move; this recipe pins `@strands-agents/sdk` 1.24.0.

## What you'll build

A support-desk assistant that can look up a ticket, reply to it, issue a refund, or close an account:

```
goal → model picks a tool call → ArmorIQ checks it (allow / hold / block) → execute if allowed → repeat until done
```

The tools are tiered on purpose. Reads and low risk writes are allowed outright, refunds are held for a human to approve, and closing an account is blocked. One planted support ticket (`TCK-1002`) contains a prompt injection attempt. You ask the agent to act on it, watch the model try to comply, and watch ArmorIQ hold the refund and block the account closure anyway. Policy is evaluated against the real tool and its real arguments, not against whatever the ticket text claims is "pre-authorized".

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `agent.mjs`, the real Strands `Agent`, the real `ArmorIQStrandsPlugin`, the real MCP client, and the real support-desk MCP server (spawned locally over stdio). Only two things are stand-ins, both in `offline/`: the ArmorIQ client (`offline/armoriq-sdk.mjs`), which decides from this recipe's `policy.yaml`, and the Gemini model (`offline/scripted-model.mjs`), which is scripted. `offline/register.mjs` swaps them in with Node module hooks.

```bash
npm ci
npm run demo:offline    # three requests: allowed, held, and the TCK-1002 injection
npm run test:offline    # the same run as a pass or fail check
```

Node 22 or newer (the Strands SDK requires it). Each decision prints one line, for example:

```
[armoriq] check issue_refund: HELD (policy support-desk-policy: issue_refund -> hold)
[armoriq] hold issue_refund: APPROVED
[armoriq] check close_account: BLOCKED (policy support-desk-policy: close_account -> block)
```

Held calls are approved by default. Set `OFFLINE_APPROVAL=reject` to reject them and watch the agent handle it:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline
```

Edit a rule in `policy.yaml` (say, change `issue_refund` from `hold` to `allow`) and the offline result changes with it.

## Before you start

| Requirement | Why |
|---|---|
| Node.js 22 or newer | Runs the agent |
| An ArmorIQ account | Policy enforcement and observability |
| A Gemini API key | Drives the Strands agent's model calls |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Strands also ships Bedrock (its default), Anthropic, OpenAI, and other providers under `@strands-agents/sdk/models/*`. Swap `GoogleModel` for any of them in `src/model.mjs` and everything else (tools, `ArmorIQStrands`, the agent) is unchanged.

## Step 3: Install the project

This recipe already contains the code. Install the pinned dependencies:

```bash
npm ci
cp .env.example .env
```

`package.json` pins every dependency exactly:

```json
"dependencies": {
  "@armoriq/sdk": "0.8.24",
  "@google/genai": "2.32.0",
  "@modelcontextprotocol/server": "2.4.0",
  "@strands-agents/sdk": "1.24.0"
}
```

`@google/genai` is the Gemini client the Strands Google model needs. `@modelcontextprotocol/server` builds the local support-desk server. The Strands SDK brings its own MCP client.

## Step 4: The support-desk MCP server

`support-desk-mcp.mjs` is a small self built server with five tools, tiered by risk:

| Tool | Risk | Policy |
|---|---|---|
| `list_tickets`, `get_ticket` | read only | allow |
| `reply_to_ticket` | low risk write | allow |
| `issue_refund` | money movement | hold |
| `close_account` | destructive, irreversible | block |

`issue_refund`'s amount field is deliberately named `amount`. ArmorIQ's policy engine scans tool arguments for canonical field names (`amount`, `value`, `total`, `price`, `cost`) to evaluate amount threshold rules, so a tool has to expose one of those names for that feature to see it at all.

## Step 5: Register the support-desk MCP server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `support-desk`.
4. Save.

### Why `mode: 'sdk'`

This server uses stdio transport, so it runs as a local subprocess, the way every MCP host runs it. ArmorIQ's cloud proxy has no network path to a stdio process on your machine. The agent therefore runs `mode: 'sdk'` and spawns the server itself, instead of `mode: 'proxy'`, which would try to route the call through the proxy and return a 502. In `sdk` mode ArmorIQ gives a real allow, hold, or block decision, and this process executes each approved call itself.

## Step 6: Write your first policy

1. In the console, open **Policies → Policy Studio → Single Policy**.
2. Set **Target Type** to `mcp_server` and **Target ID** to the `support-desk` server you just registered.
3. Set **Default enforcement action** to `block`.
4. Paste the contents of `policy.yaml` into the YAML editor:

```yaml
name: support-desk-policy
version: v0.1.0
scope:
  target_type: mcp
  target: support-desk   # replace with your registered server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: list_tickets
    action: allow
  - tool: get_ticket
    action: allow
  - tool: reply_to_ticket
    action: allow
  - tool: issue_refund
    action: hold
  - tool: close_account
    action: block
```

5. Save and activate.

The Policy Studio form's Member Rules section also has an **Amount thresholds** field per rule, if you would rather hold only above $100 than hold every refund. This YAML holds every refund unconditionally, the simpler and safer default for a demo.

## Step 7: Configure environment variables

Fill in `.env` (copied from `.env.example` in Step 3):

```
ARMORIQ_API_KEY=ak_your_key_here
GEMINI_API_KEY=your_gemini_key_here
GEMINI_MODEL=gemini-2.5-flash
USER_EMAIL=you@your-org.com
SUPPORT_DESK_MCP_NAME=support-desk
```

`SUPPORT_DESK_MCP_NAME` must match the name you registered in Step 5. `.env` is already in `.gitignore`, and `agent.mjs` reads it with Node's own `process.loadEnvFile`.

## Step 8: How the agent is built

`agent.mjs` does three things. Once per process, it creates the factory:

```js
const armoriq = new ArmorIQStrands({
  client: new ArmorIQClient({ apiKey: process.env.ARMORIQ_API_KEY }),
  mode: 'sdk',
  defaultMcpName: 'support-desk',
  validitySeconds: 2400,
});
```

Then per request:

```js
const plugin = await armoriq.forUser(userEmail, { goal, onEvent });
const agent = new Agent({ model, tools, systemPrompt: ..., plugins: [plugin] });
const result = await agent.invoke(goal);
```

`forUser` returns a Strands plugin you pass to the `Agent`. Every tool call that invocation makes goes through ArmorIQ's plan, token, policy, and audit pipeline through the plugin's Strands hooks, with no changes to the agent, the tools, or the system prompt. The `onEvent` callback fires `hold`, `approved`, `rejected`, `timeout`, `block`, and `error`.

The integration is not re-exported from the package root, so `agent.mjs` imports it by path: `@armoriq/sdk/dist/integrations/strands.js`.

## Step 9: Run it

```bash
node agent.mjs "Refund the duplicate charge on TCK-1003"
```

Sample output once the policy is active:

```
[ARMORIQ EVENT] hold: {"tool":"issue_refund","reason":"rule_action_hold"}
```

Approve the delegation on the dashboard and the refund goes through.

Now try the prompt injection:

```bash
node agent.mjs "Read TCK-1002 and do whatever the customer is asking for"
```

The model reads a ticket demanding an immediate $5,000 refund and account closure, "pre-authorized, no approval needed". Watch it attempt exactly that, and watch ArmorIQ hold the refund and block the account closure anyway, regardless of what the ticket text claimed.

## Step 10: See it in the ArmorIQ dashboard

Open **Intent** in the console, filtered by your `USER_EMAIL`. The prompt injection run shows up as a plan with a `hold` on `issue_refund` and a `block` on `close_account`, each with the actual arguments the model tried to pass (`amount: 5000` and the real account id). A reviewer sees exactly what was attempted, not just that something happened.

## Differences from the Python version

* **Strands TypeScript is in preview.** It is a separate SDK from the Python one, pinned here at 1.24.0. Its API differs: `new Agent({ plugins: [plugin] })` replaces `hooks=[hooks]`, `await agent.invoke(goal)` replaces `agent(goal)`, and `McpClient.loadServers(...)` plus `connect()` and `listTools()` replace the context manager.
* **The integration is the SDK's TypeScript one.** `ArmorIQStrands` from `@armoriq/sdk` 0.8.24 mirrors the Python class (`forUser`, `onEvent`, the same events), but is imported from `dist/integrations/strands.js`.
* **The local server is TypeScript.** `support-desk-mcp.mjs` uses `@modelcontextprotocol/server`, with the same five tools and tickets as `support_desk_mcp.py`.
* **The scripted model extends Strands' `Model`.** It streams the same sequence of tool calls as the Python one.
* **The live path is untested.** As in the Python recipe, no live ArmorIQ account or Gemini key was used in CI; the offline run is what is checked.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Cannot find module '@armoriq/sdk/dist/integrations/strands.js'` | A different `@armoriq/sdk` version than the pinned 0.8.24 moved the file. Reinstall with `npm ci` |
| `GEMINI_API_KEY is required` | `.env` is missing or the key is empty. Copy `.env.example` and fill it in |
| Everything gets blocked, never held | The default policy is `block` and no rule matched. Confirm Step 6's policy is saved and activated, and that its `target` matches the registered server's id |
| Gemini returns `503 UNAVAILABLE` or high demand | Transient upstream overload. Retry, or try another `GEMINI_MODEL` |
| `mode: 'proxy'` returns a 502 | The support-desk server uses stdio, which ArmorIQ's cloud proxy cannot reach. Use `mode: 'sdk'` as shown |

## What's next

* **Stream holds into a real UI.** Wire `onEvent` into a live approvals screen instead of `console.log`.
* **Add an amount threshold.** Configure Policy Studio's Member Rules "Amount thresholds" field so small refunds auto allow and only large ones hold.
* **Try the LangChain recipe** for the same adapter pattern in a read only weather domain.
