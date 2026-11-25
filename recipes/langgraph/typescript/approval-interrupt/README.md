# Build a LangGraph approval interrupt with the ArmorIQ SDK in TypeScript

An on-call assistant built as a LangGraph `StateGraph`, where every tool call goes through ArmorIQ before it runs, and an ArmorIQ hold becomes a native LangGraph `interrupt()`. The run stops, the checkpointer saves the thread, your app shows the held call to a human, and `new Command({ resume })` picks the graph up where it left off. Nothing blocks a worker while you wait for the approver.

Ported from the [Python approval-interrupt recipe](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/langgraph/python/approval-interrupt) by Naveen-6087. Same story, tool names, policy rules, and planted data. See [Differences from the Python version](#differences-from-the-python-version).

## What you'll build

An agent you can page with "checkout-api is throwing 502s, find out why and fix it". It reads status and logs, decides a restart is needed, and asks for one. ArmorIQ holds the restart for approval:

```
agent → policy_gate ─┬─ all allowed or blocked ───────────────→ run_tools → agent → ... → END
                     └─ any HELD → human_review: interrupt() ─→ run_tools
                                    (checkpointed; resumed with Command({ resume }))
```

| Tool | What it does | Policy |
|---|---|---|
| `get_service_status`, `read_recent_logs` | Investigate | allow |
| `restart_service` | Rolling restart, changes production | hold |
| `delete_volume` | Destroys a storage volume | block |

The fleet in `runbookTools.js` is simulated in memory, so the recipe runs anywhere. Replace the function bodies with your real Kubernetes, cloud, or log store calls; the tool names and arguments are what the policy matches on.

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.js`: the real `StateGraph`, its `policy_gate`, `human_review`, and `run_tools` nodes, the real `interrupt()` and `Command({ resume })`, and the real `MemorySaver` checkpointer. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml`, and the OpenAI model, which is a scripted tool calling chat model. The demo's "reviewer" is a function that resumes the thread instead of waiting for you.

```bash
npm install
npm run demo:offline    # a held restart through interrupt and resume, then a blocked delete
npm run test:offline    # the same run as a pass or fail check, approved and rejected
```

The held call looks like this:

```
[armoriq] check restart_service: HELD (policy oncall-runbook-policy: restart_service -> hold)
[graph] interrupted at ["human_review"]; thread oncall-5ac21c42 saved at checkpoint 1f1dcc5e-...
  [reviewer] sees HELD restart_service {"service":"checkout-api","reason":"..."} delegation=offline-delegation-1
[graph] resuming thread oncall-5ac21c42 with Command(resume={"reviewedBy":"oncall-lead@example.com"})
[armoriq] hold restart_service: APPROVED
[armoriq] report restart_service: success
```

Holds are approved by default. Set `OFFLINE_APPROVAL=reject` and ArmorIQ rejects the restart after the resume; it never runs, the graph finishes cleanly, and the agent says a human should take over:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline
```

Edit `policy.yaml` (say, set `restart_service` to `allow`) and the interrupt disappears from the offline run.

## Before you start

| Requirement | Why |
|---|---|
| Node.js v20 or later, and npm | Runs the graph |
| An ArmorIQ account | Policy, approvals, and the audit trail |
| An OpenAI API key | Drives the model node |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get an OpenAI API key

Create one at [platform.openai.com/api-keys](https://platform.openai.com/api-keys). Only the `new ChatOpenAI(...)` line in `agent.js` is OpenAI specific; any LangChain chat model with tool calling works.

## Step 3: Install the project

```bash
npm install
cp .env.example .env
```

Every dependency in `package.json` is pinned to an exact version, and `package-lock.json` is committed: `@armoriq/sdk` 0.8.24, `@langchain/langgraph`, `@langchain/core`, `@langchain/openai`, `dotenv`, and `zod`.

## Step 4: Register the tools and write the policy

1. In the ArmorIQ console, open **MCP Servers**, click **Add MCP Server**, and name it `oncall-runbook` (or set `RUNBOOK_MCP_NAME` to your name). The tools here are local functions, not an MCP server; the session attributes them to this name through `defaultMcpName`, so policy has a target to attach to.
2. Open **Policies → Policy Studio → Single Policy**, set **Target Type** to `mcp_server` and **Target ID** to that server, and set **Default enforcement action** to `block`.
3. Paste `policy.yaml`:

```yaml
name: oncall-runbook-policy
version: v0.1.0
scope:
  target_type: mcp
  target: oncall-runbook   # replace with the registered server id
  caller: all
default_action: block
priority: 50
rules:
  - tool: get_service_status
    action: allow
  - tool: read_recent_logs
    action: allow
  - tool: restart_service
    action: hold
  - tool: delete_volume
    action: block
```

4. Save and activate.

## Step 5: Configure environment variables

Fill in `.env` (copied from `.env.example`): `ARMORIQ_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `USER_EMAIL`, `RUNBOOK_MCP_NAME`.

## Step 6: How the graph is governed

### Why not the LangChain adapter here

The SDK's `ArmorIQLangChain` handler is a LangChain callback, and LangGraph passes callbacks through. It just cannot pause a graph. On a hold it waits for the decision inside `handleToolStart` (`await session.awaitApproval(...)`), so the worker sits there until the approver answers or `approvalWaitSeconds` passes. And you cannot call `interrupt()` from inside it: the handler turns any unexpected error into a fail closed block, so LangGraph's interrupt would be caught and reported as an enforcement failure. Errors in your `onEvent` callback are swallowed the same way.

So this recipe uses the SDK one level down, the same session API the adapters are built on, from the graph's own nodes.

### The nodes

`ArmorIQGovernor` holds one ArmorIQ session per graph thread:

```javascript
const scope = new ArmorIQClient({ apiKey }).forUser(userEmail);
const session = scope.startSession({ mode: "sdk", defaultMcpName: "oncall-runbook", validitySeconds: 2400 });
```

**`policy_gate`** runs after every model turn. It declares the turn's tool calls as the plan (`session.startPlan(calls, goal)`) and asks ArmorIQ about each one (`session.check(name, args, userEmail)`). Each decision (allow, hold with its `delegationId`, or block) goes into graph state.

**`human_review`** runs only when something is held:

```javascript
const review = interrupt({ kind: "armoriq_hold", held: [{ tool, args, reason, delegationId }] });
const outcome = await session.awaitApproval(delegationId, { timeout: CONFIRM_SECONDS, interval: 2, userEmail });
```

The first time through, `interrupt()` throws, LangGraph saves the thread in the checkpointer, and `graph.invoke` returns with `__interrupt__` holding that payload. When the caller sends `new Command({ resume })`, LangGraph re-runs the node from the top and `interrupt()` returns the resume value. Everything before the `interrupt()` call is pure, so the re-run is safe. Then the node asks ArmorIQ for the decision. The resume payload says who reviewed it; it does not decide anything. ArmorIQ does, so a resumed thread can never run a call the approver rejected.

**`run_tools`** runs the allowed and approved calls, reports each one to ArmorIQ (`session.report`), and turns blocks, rejections, and timeouts into tool messages the model reads.

### The caller

```javascript
const config = { configurable: { thread_id: threadId } };
let result = await graph.invoke({ messages: [new HumanMessage(goal)] }, config);
while (result.__interrupt__?.length) {
  const resume = await review(result.__interrupt__[0].value);   // your approvals UI
  result = await graph.invoke(new Command({ resume }), config);
}
```

In `agent.js` the live `review` prints the held call and waits for Enter. In a real service the interrupt payload goes to your approvals UI (with the delegation id, so the approver can find it in ArmorIQ), the request ends, and a later request resumes the same `thread_id`.

## Step 7: Run it

```bash
node agent.js "checkout-api is throwing 502s. Find out why and fix it."
```

When the restart is held, approve or reject the delegation in the ArmorIQ dashboard, then press Enter. Try the blocked path too:

```bash
node agent.js "db-primary disk is almost full. Free up space."
```

A live model may not reach for `delete_volume` on its own. If it does, it is blocked; if it does not, ask it to delete the WAL archive volume directly to see the block.

## Differences from the Python version

- **LangGraph JS APIs.** `Annotation.Root` with `MessagesAnnotation.spec` defines the state, `MemorySaver` replaces `InMemorySaver`, and `new Command({ resume })` replaces `Command(resume=...)`. The interrupt comes back as `result.__interrupt__[0].value` on `graph.invoke`.
- **The ArmorIQ calls are native async.** The Python recipe wraps the blocking session calls in `asyncio.to_thread`; the TypeScript SDK's `startPlan`, `check`, `awaitApproval`, and `report` already return promises.
- **Camel case names.** The held call carries `delegationId` and the resume payload `reviewedBy`, instead of `delegation_id` and `reviewed_by`.
- **Tools are `tool()` from `@langchain/core` with zod schemas** instead of `@tool` functions, and the reject path ends with the same tool message the Python run produces.
- **The SDK is `@armoriq/sdk` 0.8.24.** Python pins `armoriq-sdk` 0.8.18.
- The offline test and demo are Node scripts; there is no Python venv.

## Honest limits

- **The approval decision lives in ArmorIQ, not in the resume payload.** The SDK has no call to approve a delegation from code, so the approver decides in the ArmorIQ dashboard and your app resumes the thread. If the thread is resumed while the delegation is still pending, `human_review` waits up to `ARMORIQ_APPROVAL_CONFIRM_SECONDS` (30 by default) and then treats it as not approved. The restart does not run; ask again.
- **The ArmorIQ session is in process memory.** The checkpointer saves the graph state, including the pending delegation id, but the session and its intent token live in `ArmorIQGovernor`. With `MemorySaver` both live in the same process, which is what this recipe runs. If you swap in a durable checkpointer and resume in another process, a fresh session can still read the delegation's decision, but you need to re-declare the plan before reporting or checking further calls. Test that path before relying on it.
- **This is not the shipped adapter.** It uses the public session API (`startPlan`, `check`, `awaitApproval`, `report`, `close`) that the adapters are built on, but you own the glue: about 100 lines in `agent.js`. ArmorIQ lists no tested LangGraph version.
- **One interrupt per turn.** If the model asks for several held calls in one turn, they are reviewed together in one interrupt. A rejection of one does not stop the allowed calls from the same turn.
- **The offline stand-in decides by tool name only.** Live ArmorIQ also sees the arguments, so you can hold restarts of `checkout-api` and allow restarts of a staging service.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| The interrupt is lost or LangGraph complains about a checkpointer | `interrupt()` needs a checkpointer. Keep `checkpointer` in `.compile({ ... })` |
| The resume runs the model again from the start | You resumed with a different `thread_id`. Use the same `config` for `graph.invoke(new Command({ resume }), config)` |
| The held call never runs after resume | The delegation was still pending in ArmorIQ. Approve it in the dashboard, then resume |
| Everything is blocked, nothing held | No rule matched. Check the policy is active and its target matches `RUNBOOK_MCP_NAME` |

## What's next

- **Persist threads.** Swap `MemorySaver` for a durable checkpointer such as `@langchain/langgraph-checkpoint-sqlite` and resume from a second process.
- **Route by argument.** Hold `restart_service` only for production services.
- **Try the LangChain adapter path.** The SQL analyst recipe shows `ArmorIQLangChain` inside `createAgent`, where a hold waits in place instead of interrupting.
