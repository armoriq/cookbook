# Build a governed SQL analyst with LangChain and the ArmorIQ SDK in TypeScript

A data analyst agent on LangChain that answers questions over a SQLite warehouse, governed by the SDK's shipped `ArmorIQLangChain` callback handler rather than a hand rolled enforcement loop. Reads run, writes wait for a human, and anything that destroys or exports data is blocked. One row in the data is a planted prompt injection, so you can watch a model try to follow it and watch policy stop it.

Ported from the [Python sql-analyst recipe](https://github.com/Naveen-6087/aiq101/tree/main/cookbook/recipes/langchain/python/sql-analyst) by Naveen-6087. Same story, tool names, policy rules, and planted data. See [Differences from the Python version](#differences-from-the-python-version).

## What you'll build

An analyst you can ask "which product made the most revenue in October?" or "mark order 1042 as refunded". The model picks tools from a small SQLite MCP server that ships with this recipe, and ArmorIQ checks every call before it runs:

```
question → model picks a tool call → ArmorIQ checks it (allow / hold / block) → run if allowed → repeat until done
```

| Tool | What it does | Policy |
|---|---|---|
| `list_tables`, `describe_table`, `run_select` | Read the schema, run one `SELECT` | allow |
| `insert_row`, `update_rows` | Change business records | hold |
| `delete_rows`, `drop_table`, `export_table` | Destroy data, or send it outside the warehouse | block |

The `feedback` table has a "customer comment" (row 7) that claims a system override and tells the AI to drop `orders` and export `customers` to a paste site. Ask the agent to summarize this week's feedback and the model reads that row, then tries to do exactly what it says. ArmorIQ blocks both calls. It does not need to spot the injection: the policy says no tool may drop or export, whoever asked.

## Run it offline

No accounts, keys, or network needed. Offline mode runs the real `agent.js`, LangChain's real `createAgent`, the real MCP adapters, the real `ArmorIQLangChain` handler, and the real SQLite MCP server (spawned over stdio against a throwaway copy of the database). Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml`, and the Gemini model, which is a scripted tool calling chat model.

```bash
npm install
npm run demo:offline    # three requests: a read, a held write, and the injection row
npm run test:offline    # the same run as a pass or fail check, approved and rejected
```

Each decision prints one line, for example:

```
[armoriq] check run_select: ALLOWED (policy sql-warehouse-policy: run_select -> allow)
[armoriq] check update_rows: HELD (policy sql-warehouse-policy: update_rows -> hold)
[armoriq] hold update_rows: APPROVED
[armoriq] injection: result of run_select contains text telling the agent to drop and export tables
[armoriq] check drop_table: BLOCKED (policy sql-warehouse-policy: drop_table -> block)
[armoriq] check export_table: BLOCKED (policy sql-warehouse-policy: export_table -> block)
```

Held calls are approved by default. Set `OFFLINE_APPROVAL=reject` to reject them; the update never runs and the agent says so:

```bash
OFFLINE_APPROVAL=reject npm run demo:offline
```

Edit a rule in `policy.yaml` (say, change `update_rows` from `hold` to `allow`) and the offline result changes with it.

You will also see `Error in handler ArmorIQLangChainCallback, handleToolStart: PolicyBlockedException ...` on stderr for each refused call. That is LangChain logging the exception the handler threw to stop the tool. It is expected.

## Before you start

| Requirement | Why |
|---|---|
| Node.js v20 or later, and npm | Runs the agent and the MCP server |
| An ArmorIQ account | Policy enforcement, approvals, and the audit trail |
| A Gemini API key | Drives the agent's model calls |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Only the model construction in `agent.js` is Gemini specific. Swap `ChatGoogleGenerativeAI` for `ChatOpenAI` (`@langchain/openai`), `ChatAnthropic` (`@langchain/anthropic`), or any chat model that supports tool calling, and nothing else changes.

## Step 3: Install the project

```bash
npm install
cp .env.example .env
```

Every dependency in `package.json` is pinned to an exact version, and `package-lock.json` is committed. `sql.js` is SQLite compiled to WebAssembly, so nothing is built natively on any OS.

## Step 4: The SQLite MCP server

`src/sqlWarehouseMcp.js` is a small stdio MCP server built on `@modelcontextprotocol/sdk`. It builds `analytics.db` from `db/seed.sql` the first time it starts (customers, products, orders, feedback) and exposes the eight tools in the table above. Set `ANALYTICS_DB` to put the file somewhere else; delete it to reset the data.

The risk lives in the tool names on purpose. A single `run_sql` tool would force every policy decision to parse SQL. Separate `run_select`, `update_rows`, and `drop_table` tools let a policy say "reads yes, writes ask, drops never" by name, and let ArmorIQ show reviewers the exact table and values of a held write.

The server keeps its own guard rails too: `run_select` accepts a single `SELECT` and runs with `PRAGMA query_only` on, and every table and column name is checked against a plain identifier pattern. ArmorIQ is the policy layer, not a replacement for input hygiene.

## Step 5: Register the server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `sql-warehouse` (or set `SQL_MCP_NAME` in `.env` to the name you choose).
4. Save.

### Why `mode: "sdk"`

The server uses stdio, so it runs as a local subprocess of the agent. ArmorIQ's cloud proxy has no network path to it, so `mode: "proxy"` would fail. In `mode: "sdk"` ArmorIQ makes the allow, hold, or block decision and this process runs each approved call itself.

## Step 6: Write the policy

1. In the console, open **Policies → Policy Studio → Single Policy**.
2. Set **Target Type** to `mcp_server` and **Target ID** to the `sql-warehouse` server.
3. Set **Default enforcement action** to `block`.
4. Paste `policy.yaml` into the YAML editor:

```yaml
name: sql-warehouse-policy
version: v0.1.0
scope:
  target_type: mcp
  target: sql-warehouse   # replace with your registered server's id
  caller: all
default_action: block
priority: 50
rules:
  - tool: list_tables
    action: allow
  - tool: describe_table
    action: allow
  - tool: run_select
    action: allow
  - tool: insert_row
    action: hold
  - tool: update_rows
    action: hold
  - tool: delete_rows
    action: block
  - tool: drop_table
    action: block
  - tool: export_table
    action: block
```

5. Save and activate.

## Step 7: Configure environment variables

Fill in `.env` (copied from `.env.example`): `ARMORIQ_API_KEY`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `USER_EMAIL`, `SQL_MCP_NAME`. `.env` and `analytics.db` are already in `.gitignore`.

## Step 8: How the agent is built

`agent.js` is a plain LangChain 1.x agent. ArmorIQ adds a factory once per process and one callback per request:

```javascript
const armoriq = new ArmorIQLangChain({
  client: new ArmorIQClient({ apiKey: armoriqApiKey }),
  mode: "sdk",
  defaultMcpName: "sql-warehouse",
  validitySeconds: 2400,
});

const agent = createAgent({ model, tools, systemPrompt: SYSTEM_PROMPT, middleware: [refusalsAsToolMessages] });

const handler = await armoriq.forUser(userEmail, { goal, onEvent });
const result = await agent.invoke({ messages: [{ role: "user", content: goal }] }, { callbacks: [handler] });
```

The tools come from `MultiServerMCPClient` in `@langchain/mcp-adapters` with `prefixToolNameWithServerName: false`, so the model sees the bare names (`run_select`) that the policy matches.

The handler uses two LangChain callbacks. `handleLLMEnd` takes the tool calls the model just chose and mints an intent token for exactly those tools. `handleToolStart` asks ArmorIQ about each call before it runs. On allow it returns and the tool runs. On hold it emits a `hold` event and waits for the approval decision. On block, or a rejected or timed out hold, it throws `PolicyBlockedException` or `PolicyHoldException`, which stops the tool.

### The one piece of glue: refusals as tool results

`createAgent` runs tools in a tool node that re-throws errors. Without help, the first block would end the whole run. `refusalsAsToolMessages` is a short `createMiddleware` with a `wrapToolCall` hook that catches only the two ArmorIQ refusal exceptions and returns them to the model as an error `ToolMessage`. The model then reads "ArmorIQ refused drop_table" like any other tool result and explains it to the user. Every other error still propagates. Enforcement is unchanged: the tool already did not run.

## Step 9: Run it

```bash
node agent.js "Which product made the most revenue in October 2026? Show the top three."
node agent.js "Order 1042 was returned. Mark it as refunded."
node agent.js "Summarize this week's customer feedback."
```

The second request pauses on `update_rows` with `[ARMORIQ EVENT] hold: {...}`. Approve the delegation in the ArmorIQ dashboard and the update runs; reject it and the agent reports that it could not. The third request is the injection: watch the model try `drop_table` and `export_table` with the arguments the comment asked for, and watch both get blocked. A capable live model may also refuse on its own, which is fine; the policy is what you rely on when it does not.

## Step 10: See it in the dashboard

Open **Intent** in the console, filtered by your `USER_EMAIL`. Each run is a plan with its tool calls. The injection run shows `drop_table` on `orders` and `export_table` on `customers` with the paste site URL, both blocked, so a reviewer sees what was attempted, not just that something was stopped.

## Differences from the Python version

- **SQLite runs on `sql.js`** (WebAssembly) instead of the `sqlite3` module. It has no read only connection mode, so `run_select` sets `PRAGMA query_only = ON` around each query, and the file is rewritten after each write.
- **The MCP server uses `@modelcontextprotocol/sdk`** with zod schemas instead of FastMCP, and the agent loads tools with `@langchain/mcp-adapters` instead of `langchain-mcp-adapters`.
- **Refusal handling** is `createMiddleware({ wrapToolCall })` and matches the exception by `name`, instead of a Python `AgentMiddleware` subclass.
- **The SDK is `@armoriq/sdk` 0.8.24**, and the handler is `forUser(...)` returning a handler you pass in `callbacks`. Python pins `armoriq-sdk` 0.8.18.
- The offline test and demo are Node scripts; there is no Python venv.

## Honest limits

- **Approvals block the run.** A hold waits inside `handleToolStart` until the decision arrives or `approvalWaitSeconds` passes. Nothing is checkpointed. For a graph that pauses and resumes, see the LangGraph `approval-interrupt` recipe.
- **The offline stand-in decides by tool name only.** Live ArmorIQ also sees the arguments, so you can write richer rules than this policy uses. The offline `injection:` line comes from a phrase scan in the stand-in; live, nothing depends on detecting the injection, because the drop and export are blocked by policy.
- **Tools must be in the plan.** In `mode: "sdk"` ArmorIQ blocks a tool the model did not declare in the plan captured at `handleLLMEnd`. The handler mints that plan for you.
- **One handler per request.** Create a new `forUser` handler for each request.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| A block ends the run with an error | The `refusalsAsToolMessages` middleware is missing from `createAgent` |
| Everything is blocked, nothing held | No rule matched and `default_action` is `block`. Check the policy is active and its target matches `SQL_MCP_NAME` |
| The update was approved but nothing changed | You already ran it once. Delete `analytics.db` to reset the data |
| The model sees prefixed tool names | `prefixToolNameWithServerName` must be `false` so names match the policy |

## What's next

- **Add an argument rule.** Hold `update_rows` only when `table` is `orders`, and allow it on a scratch table.
- **Stream holds to a UI.** Send `onEvent` to your approvals screen instead of `console.log`.
- **Make approvals durable.** The LangGraph `approval-interrupt` recipe shows the same hold surviving a pause and a resume through a checkpointer.
