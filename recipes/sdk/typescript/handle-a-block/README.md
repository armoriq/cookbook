# Build a Release Agent That Handles Blocks with the ArmorIQ SDK in TypeScript

A step by step guide to the ArmorIQ TypeScript SDK with no framework at all: a hand written agent loop that plans, mints an intent token, and invokes each tool call through ArmorIQ. It is the template to copy when your agent has no framework, or when you want to see exactly what the framework adapters do for you.

Ported from the Python recipe [`sdk/python/handle-a-block`](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/sdk/python/handle-a-block) by Naveen-6087. The story, tool names, policy rules, and planted data are the same; see *Differences from the Python version* for what had to change.

The other half of the recipe is what happens when ArmorIQ says no. Most examples stop at the first `PolicyBlockedException`. This one keeps going: it re-plans around a blocked tool, stops cleanly when a human rejects a held call, signs a new plan when the agent drifts from the old one, and mints a fresh token when the old one runs out.

## What you'll build

A release desk assistant that reads CI results, deploys to staging and production, and manages environments, all through a small MCP server that ships with the recipe (`src/releaseDeskMcp.js`):

```
goal → plan (model) → capturePlan → getIntentToken → invokeWithPolicy, step by step
                         ↑                                    │
                         └──── re-plan / re-mint on a refusal ┘
```

| Tool | Risk | Policy |
|---|---|---|
| `list_environments`, `get_build_status` | read only | allow |
| `rerun_ci`, `run_smoke_tests`, `deploy_to_staging`, `request_teardown` | low risk write | allow |
| `deploy_to_production` | customer facing | hold |
| `delete_environment` | irreversible | block |

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `src/agent.js` loop, the real `src/mcpStdio.js` tool listing, the real `src/releaseDeskMcp.js` server (spawned over stdio), and the SDK's real exception classes. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml` and runs allowed calls on the local server (the job ArmorIQ's proxy does live), and the planner, which is rule based instead of Gemini.

```bash
npm install
npm run demo:offline    # five requests: allowed, held, blocked, off plan, expired token
npm run test:offline    # the same run as a pass or fail check, approve and reject
```

The five requests and what each one shows:

| Request | What happens | Recovery |
|---|---|---|
| Deploy checkout build 512 to staging | Both steps allowed | none needed |
| Deploy checkout build 512 to production | `deploy_to_production` is held for a human | approved: it runs. Rejected: the agent stops and says so |
| Tear down the idle staging-eu environment | `delete_environment` is blocked | re-plans without it and files `request_teardown` for a human instead |
| Deploy payments build 77 to staging | The build is red, so the agent wants `rerun_ci`, which is not in the signed plan | the off plan refusal (HTTP 409) makes it sign a new plan from that step on |
| Run smoke tests, then deploy | A 2 second token, a 3 second smoke test | catches `TokenExpiredException`, mints a fresh token for the same plan, retries |

The block and its recovery, as printed:

```
[armoriq] check delete_environment: BLOCKED (policy release-desk-policy: delete_environment -> block)
[agent] PolicyBlockedException: delete_environment was blocked (...). Re-planning without it.
[agent] re-planned (attempt 2): request_teardown
[armoriq] plan: Tear down the idle staging-eu environment -> request_teardown
[armoriq] check request_teardown: ALLOWED (policy release-desk-policy: request_teardown -> allow)
Answer: Done: list_environments, request_teardown. Refused: delete_environment (blocked by policy).
```

Held calls are approved by default. Set `OFFLINE_APPROVAL=reject` to reject them and watch the agent stop without crashing:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline
```

```
[armoriq] hold deploy_to_production: REJECTED
[agent] DelegationException: deploy_to_production was not approved (Delegation rejected). Stopping here.
Answer: Done: get_build_status. Refused: deploy_to_production (approval rejected). A human declined that step, so I did not try another route.
```

Edit a rule in `policy.yaml` (say, change `delete_environment` to `allow`) and the offline result changes with it.

## Before you start

| Requirement | Why |
|---|---|
| Node.js 20 or newer | Runs the agent |
| An ArmorIQ account | Tokens, policy, approvals, audit |
| A Gemini API key | Drives the planner |
| A way to expose a local port (a tunnel) or somewhere to deploy | ArmorIQ's proxy has to reach the MCP server, see *Run it live* |

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai), sign up or log in, open **Settings → API Keys**, and generate a key.
2. Install and configure:

```bash
npm install
cp .env.example .env     # fill in ARMORIQ_API_KEY and GEMINI_API_KEY
```

`package.json` pins every dependency exactly, including `@armoriq/sdk` 0.8.24.

## The loop, step by step

Everything below is in `src/agent.js`, in the `run()` function. Read it top to bottom.

### Step 1: Plan

```js
steps = await planner.plan(goal, tools);
// [{ action: 'get_build_status', params: {...} }, { action: 'deploy_to_staging', params: {...} }]
```

`src/planner.js` sends the goal and the tool catalog (read from the MCP server by `src/mcpStdio.js`) to Gemini and asks for JSON. Any model works here. The only contract is the list of `{ action, params }` steps, and the loop drops any tool the model invents.

### Step 2: Capture the plan

```js
const capture = client.capturePlan(planner.MODEL, goal, {
  goal,
  steps: steps.map((s) => ({ action: s.action, mcp: MCP_NAME, params: s.params })),
});
```

`capturePlan` is local. It wraps the plan in a `PlanCapture`. Every tool the agent is going to call has to be in here, because the token you mint next is bound to exactly this plan.

### Step 3: Mint an intent token

```js
token = await client.getIntentToken(capture, undefined, tokenSeconds, { userEmail });
```

This is the first network call. ArmorIQ hashes the plan, signs a token for it, and tags it with the end user. The SDK default lifetime is 60 seconds and its maximum is 3600; this recipe uses 300 (`TOKEN_VALIDITY_SECONDS`). If the plan names a tool the policy denies outright, ArmorIQ can refuse here with `PolicyBlockedException` before anything runs, so the loop catches it at this step too.

### Step 4: Invoke each step

```js
({ result } = await client.invokeWithPolicy(MCP_NAME, step.action, token, step.params, {
  userEmail,
  waitForApproval: true,
  delegationTimeoutMs: 300000,
  onHold: (info) => say(`${info.tool} is waiting for a human approver (${info.reason})`),
}));
```

`invokeWithPolicy` sends the call to ArmorIQ's proxy, which verifies the token, checks the policy, and forwards the call to the registered MCP server. On a hold it creates the approval request, calls `onHold`, and polls until a human approves (then retries the call), rejects, or the timeout passes. Plain `client.invoke()` is the same call without the hold handling: a hold throws `PolicyHoldException` and stops there.

### Step 5: Recover

Each `catch` branch in the loop answers one question: what would a careful human do next?

| Error | What it means | What the loop does |
|---|---|---|
| `PolicyBlockedException` | Policy says no to this tool | Never retries it. Adds it to `avoid` and asks the planner for another way to the goal |
| `DelegationException` | The hold was rejected or timed out | Stops and tells the user. A human said no, so it does not route around them |
| `PolicyHoldException` | Held, and the loop could not wait | Tells the user to approve on the dashboard and run again |
| `MCPInvocationException` with `statusCode` 409 | The step is not in the plan the token was signed for | Captures a new plan from that step on and mints a new token |
| `TokenExpiredException` | The token outlived its validity | Mints a fresh token for the same plan and retries the step once |
| any other `MCPInvocationException` | The tool itself failed | Stops and reports it; that is not an ArmorIQ decision |

`main()` also catches the base `ArmorIQException`, so anything the loop does not handle ends in a sentence, not a stack trace. The loop gives up after three plans (`MAX_PLANS`), so a planner that keeps choosing refused tools cannot spin forever.

The off plan case is worth a second look. The agent reacts to results (`react()`): when `get_build_status` comes back red, it wants to `rerun_ci` first. That step was not in the signed plan, and the loop does not try to remember that. It just calls `invokeWithPolicy`, lets ArmorIQ refuse, and handles the refusal in the one place that re-plans. A changed plan always means a new signature.

## Run it live

`invokeWithPolicy` does not call your MCP server directly. It sends the call to ArmorIQ's cloud proxy, and the proxy forwards it to the server URL you registered. A stdio process on your laptop is not reachable from there, so for the live path run the same server over streamable HTTP:

```bash
node src/releaseDeskMcp.js --http      # serves http://127.0.0.1:8000/mcp
```

Expose that port with a tunnel of your choice, or deploy the file somewhere public. The agent still spawns the server over stdio, but only to read the tool list for the planner (`src/mcpStdio.js`); it never executes a tool that way.

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, name it `release-desk`, and point it at the public URL.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to the `release-desk` server.
3. Set **Default enforcement action** to `block` and paste `policy.yaml` into the YAML editor. Save and activate.
4. Run it:

```bash
node src/agent.js "Deploy checkout build 512 to staging"
node src/agent.js "Deploy checkout build 512 to production"      # approve or reject it in the console
node src/agent.js "Tear down the idle staging-eu environment"
```

If you want a local stdio server with no deployment, use a framework adapter in `mode: "sdk"` instead, where ArmorIQ decides and your process executes the call.

## Differences from the Python version

* **No `IntentMismatchException`.** `@armoriq/sdk` 0.8.24 has no such class. An off plan call is refused by the proxy with HTTP 409, which surfaces as an `MCPInvocationException` whose `statusCode` is 409, so `src/agent.js` checks for that. The offline stand-in raises exactly that error. Whether the live proxy answers 409 in every off plan case has not been confirmed.
* **Plain data tokens.** In TypeScript an intent token is a plain object, and expiry is checked with `IntentToken.isExpired(token)`, not a property on a class.
* **Camel case API.** `capturePlan`, `getIntentToken(capture, policy, validitySeconds, { userEmail })`, `invokeWithPolicy(..., { waitForApproval, onHold })`. The result is `.result`, as in Python.
* **Hand written MCP and planner clients.** The release-desk server uses `@modelcontextprotocol/sdk` (the low level `Server`), and the Gemini planner calls the REST API with `fetch`, so there is no Google SDK dependency.
* **Live path not run.** As in the Python recipe, the live path has not been run against a deployed release-desk server; the offline run is what CI checks.

## Limitations and honest notes

* **Where a block lands.** Depending on the policy, ArmorIQ can refuse a plan at token issuance (the whole plan) or a single call at invoke time. The loop handles both with the same recovery. The offline stand-in only blocks at invoke time.
* **Off plan checks.** The offline stand-in compares the action name only. The docs also say changed `params` can trigger a refusal live; the stand-in does not check arguments.
* **Hold, then expiry.** `invokeWithPolicy` retries a call once its hold is approved. If the approval took longer than the token's lifetime, that retry can throw `TokenExpiredException`, and the loop's retry with a fresh token may be held again. Give approval gated plans a longer `TOKEN_VALIDITY_SECONDS`.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `MCPInvocationException: Could not reach the ArmorIQ proxy` | Network or proxy endpoint problem, not policy |
| `MCPInvocationException ... (HTTP 502)` on every call | The proxy cannot reach the registered server URL. See *Run it live* |
| Everything is blocked, never held | `default_action: block` and no rule matched. Check the policy is active and its `target` is the registered server's id |
| `TokenExpiredException` on long runs | Raise `TOKEN_VALIDITY_SECONDS`; the SDK default is 60 seconds |

## What's next

* **Add a framework.** The [`delegated-agents`](../delegated-agents) recipe runs this same plan, token, invoke pattern and adds delegated tokens for a sub-agent.
* **Stream holds into a UI.** Send `onHold` to your approvals screen instead of printing it.
* **Narrow the blast radius.** Hold `deploy_to_staging` for one service, or add an amount style threshold, and watch the same loop handle the new refusals without code changes.
