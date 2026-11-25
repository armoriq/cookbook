# Govern an OpenAI Agents SDK Agent with Intent Gateway in TypeScript

Ported from the Python recipe [`openai-agents/python/gateway-monitor-to-enforce`](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/openai-agents/python/gateway-monitor-to-enforce) by Naveen-6087. The story, tool names, policy rules, and planted data are the same; see *Differences from the Python version* for what changed.

A step by step guide to putting an OpenAI Agents SDK agent under ArmorIQ policy without adding an SDK, a wrapper, or a single line of enforcement code. The agent's OpenAI client points at Intent Gateway instead of OpenAI. You roll it out the way you would in production: record traffic first, then turn on Monitor mode to see what policy would do, then switch Monitor mode off and let the gateway enforce.

## What you'll build

An accounts payable clerk with two tools:

| Tool | What it does | Policy |
|---|---|---|
| `lookup_invoice` | reads an invoice | allow |
| `record_payment` | pays the supplier | block |

The path every model turn takes:

```
agent → Intent Gateway → OpenAI → Intent Gateway checks each tool call against policy → agent runs what is left
```

You ask it to pay an invoice three times, once per rollout phase:

| Phase | Base URL | Monitor mode | What happens to `record_payment` |
|---|---|---|---|
| 1. Record only | `/v1/t/<gateway-key>` | (n/a) | runs; the request is recorded, nothing is checked |
| 2. Monitor | `/v1/t/<gateway-key>/a/<agent-id>` | on | runs; the gateway records "would block" |
| 3. Enforce | `/v1/t/<gateway-key>/a/<agent-id>` | off | removed from the model's reply, with a note naming the rule |

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.mjs` and the real Agents SDK `run()`. Two things are stand-ins, both in `offline/`: the gateway (`offline/gateway.mjs`, a small `node:http` server on `127.0.0.1` that speaks Chat Completions and decides from this recipe's `policy.yaml`) and OpenAI behind it (`offline/scripted-provider.mjs`, a scripted model). The demo points the agent at the stand-in by changing only `ARMORIQ_GATEWAY_HOST`, the same one setting you change for the real gateway.

```bash
npm ci
npm run demo:offline    # the three phases: record, monitor, enforce
npm run test:offline    # the same run as a pass or fail check
```

Node 22 or newer. `OFFLINE_APPROVAL` changes nothing here: this recipe has no holds, and a hold acts as a block at the gateway today.

The monitor phase lets the payment through and records what policy thought of it:

```
[armoriq] check record_payment: BLOCKED (monitor mode: would block, nothing stopped; policy ap-clerk-policy: record_payment -> block)
[ledger] payment recorded: INV-1042 $1,250.00 to Acme Supplies
[gateway] What policy would have done: 1 would block, 0 would hold, 1 allowed
```

The enforce phase removes it:

```
[armoriq] check record_payment: BLOCKED (policy ap-clerk-policy: record_payment -> block)

INV-1043 from Contoso Freight is approved for $4,800.00. Recording the payment.

Tool call "record_payment" was blocked by policy: block:record_payment#0
```

Edit `policy.yaml` (change `record_payment` to `allow`) and run the demo again: phase 3 pays the invoice. `offline/test.mjs` checks both versions. To run the stand-in on its own and point `agent.mjs` at it by hand, run `node offline/gateway.mjs` (port 8787; `OFFLINE_MONITOR_MODE=on` for monitor mode).

## Before you start

| Requirement | Why |
|---|---|
| Node.js 22 or newer | Runs the agent |
| An ArmorIQ organization | The gateway key, the agent, its policy, and the dashboard |
| An OpenAI API key | The model. The gateway forwards it to OpenAI untouched |

## Step 1: Install the project

```bash
npm ci
cp .env.example .env
```

`package.json` pins every dependency exactly:

```json
"dependencies": {
  "@openai/agents": "0.21.0",
  "openai": "7.2.0",
  "zod": "4.6.7"
}
```

No ArmorIQ package is installed. The offline stand-in reads `policy.yaml` with a few lines of its own, so there is no YAML dependency either. `agent.mjs` reads `.env` with Node's own `process.loadEnvFile`.

## Step 2: The one ArmorIQ change

`agent.mjs` is a plain Agents SDK agent. The only ArmorIQ line is the client's base URL:

```js
const client = new OpenAI({
  baseURL: gatewayBaseURL(),               // https://gw.armoriq.ai/v1/t/<gateway-key>[/a/<agent-id>]
  apiKey: process.env.OPENAI_API_KEY,      // forwarded to OpenAI untouched
  defaultHeaders: { 'X-User-Email': process.env.USER_EMAIL ?? 'dana@example.com' },
});
const model = new OpenAIChatCompletionsModel(client, process.env.OPENAI_MODEL ?? 'gpt-4.1-mini');
const agent = new Agent({ name: 'AP clerk', instructions: ..., model, tools: [lookupInvoice, recordPayment] });
```

### Why `OpenAIChatCompletionsModel`

The Agents SDK calls OpenAI's Responses API by default. Intent Gateway supports Chat Completions (streaming and non streaming, with tool calls), not the Responses API. Passing an `OpenAIChatCompletionsModel` built on the gateway client makes this agent use Chat Completions. If you would rather set it once for every agent in the process, `setDefaultOpenAIClient(client)` plus `setOpenAIAPI('chat_completions')` does the same.

`X-User-Email` is optional. It attributes each request to the person using the agent instead of the gateway key's owner. The gateway reads it and does not forward it to OpenAI.

## Step 3: Phase 1, record only

1. In the dashboard, open **Gateway** and click **Create gateway key**. Name it something you will recognise in audit logs, for example `ap-clerk`. The key is shown once, inside the base URL. Store it like any API key.
2. Under **Agent policy**, pick **No agent**.
3. In `.env`, set `ARMORIQ_GATEWAY_KEY` and your `OPENAI_API_KEY`, and leave `ARMORIQ_AGENT_ID` empty.

```bash
node agent.mjs "Pay invoice INV-1041 from Northwind Paper in full"
```

The agent behaves exactly as it did against OpenAI. The **Gateway** page shows **Gateway traffic seen**, and each request appears in **Observability** under the service `armoriq-llm-gateway`, with the model, token use, and each tool call.

## Step 4: Phase 2, name the agent and turn on Monitor mode

1. Register the agent in ArmorIQ and make it active (see Add an agent in the platform docs). Enforcement only applies to an agent that exists and is active.
2. Author its policy in **Policies → Policy Studio → Single Policy**, targeting that agent. Paste `policy.yaml`:

```yaml
name: ap-clerk-policy
version: v0.1.0
scope:
  target_type: agent
  target: ap-clerk   # replace with your agent's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: lookup_invoice
    action: allow
  - tool: record_payment
    action: block
```

3. Open **Gateway** and turn on **Monitor mode** under the page title (org admins and IAM admins can change it). It applies within about 90 seconds, to every agent in the organization that reaches ArmorIQ through the gateway. Agents using the ArmorIQ SDK are not affected.
4. Set `ARMORIQ_AGENT_ID` in `.env`. The base URL becomes `/v1/t/<gateway-key>/a/<agent-id>`.

```bash
node agent.mjs "Pay invoice INV-1042 from Acme Supplies in full"
```

The payment still goes through. Monitor mode checks every tool call and records the verdict, but your agent receives every call exactly as the model wrote it, with no added delay: the gateway relays the reply first and checks after.

## Step 5: Read "What policy would have done"

Below the Monitor mode switch, **What policy would have done** covers the last 7 days: totals of calls that would be blocked, would be held, and were allowed, a row per tool and verdict with the policy that decided it, and the latest calls policy would have stopped, with the reason. Here it shows `record_payment` as would block under `ap-clerk-policy`.

Let real traffic run for a week or two. If a row shows a call you do not want stopped, use **Adjust policies** to change the rule and watch the counts on new traffic. When the report only shows calls you want stopped, move on.

## Step 6: Phase 3, switch Monitor mode off

Turn **Monitor mode** off on the **Gateway** page. Nothing changes in your code or `.env`.

```bash
node agent.mjs "Pay invoice INV-1043 from Contoso Freight in full"
```

The model asks for `record_payment`. The gateway removes that tool call from the reply and appends a note naming the rule:

```
INV-1043 from Contoso Freight is approved for $4,800.00. Recording the payment.

Tool call "record_payment" was blocked by policy: block:record_payment#0
```

That reply now has no tool calls left, and the Agents SDK treats a reply with no tool calls as the final answer. So `result.finalOutput` is the model's text plus the note, and the run ends there. `agent.mjs` checks for `was blocked by policy` and tells the user a call was stopped. If you want the model to explain the block in its own words, run it again with the note in the conversation.

## How the gateway decides

For each model turn on a URL that names an agent, the gateway registers the reply's tool calls with ArmorIQ as a plan, gets a signed intent token for it, checks each call against the agent's active policy, and then relays the reply: allowed calls unchanged, blocked calls removed with a note. An agent with no active policy has its tool calls allowed, and each one is recorded.

If the check cannot complete (ArmorIQ unreachable, slow, or rate limited, the agent unknown, disabled, or still a draft), the gateway withholds the tool call and gives the reason in the note. Calls are never released just because a check failed. An unknown agent id shows up as `agent_unresolved`.

## Differences from the Python version

* **Same agent, JavaScript API.** `tool({ name, description, parameters: z.object(...), execute })` replaces `@function_tool`; `new OpenAIChatCompletionsModel(client, model)` takes the client first, where Python takes `openai_client=` by keyword. `run(agent, goal)` is already async, so there is no `run_sync`.
* **Offline demo is `offline/demo.mjs`.** `npm run demo:offline` runs the three phases in one process. The stand-in gateway is a `node:http` server and the scripted model a plain module; both are rewritten from the Python ones with the same routes, notes, and log lines.
* **Monitor mode is a flag on the stand-in.** The demo flips `gateway.monitorMode` between phases, the way the dashboard switch does live.
* **Tracing is switched off offline** with `OPENAI_AGENTS_DISABLE_TRACING=1`, because Agents SDK traces upload to OpenAI.
* **No test for the live path.** As in the Python recipe, only the offline run is checked in CI.

## Limits today

* **Hold works like block.** A `hold` rule removes the call. The gateway creates an approval request, but approving it does not release the agent's next attempt yet. In Monitor mode a held call shows as "would hold" and creates no approval.
* **Rate.** A gateway key gets about 120 policy calls a minute, shared between plans (one per enforced turn) and checks (one per tool call). Past that, a named agent's tool calls are withheld when enforcing; in Monitor mode they are recorded as not checked and still run.
* **Long requests.** A request that runs longer than 5 minutes is cut off.
* **Responses API.** Not supported through the gateway; use Chat Completions as shown in Step 2.
* **Claude through the OpenAI SDK.** Not supported. Use the Anthropic SDK for Claude models.
* **Monitor mode is org wide.** It is one switch for every gateway agent in the organization, not per agent.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Errors from a `/responses` endpoint | The agent is using the Responses API. Use `OpenAIChatCompletionsModel` (or `setOpenAIAPI('chat_completions')`) |
| Every tool call withheld with `agent_unresolved` | The agent id in the URL does not exist in your organization |
| Every tool call withheld, no rule named | The agent is disabled or still a draft, or the key is over its rate limit |
| Nothing is ever checked | The base URL has no `/a/<agent-id>`, so the gateway only records |
| Calls still run after you turned Monitor mode off | The switch takes about 90 seconds to apply |

## What's next

* **Add a hold.** Change `record_payment` to `hold` to collect approval requests in the dashboard, knowing approving does not release the call yet.
* **Name the user.** Set `X-User-Email` per request in a multi user app so every trace is attributed to a person.
* **Let the model explain.** Feed the note back to the model once, with tools switched off, so it tells the user in its own words what it could not do.
