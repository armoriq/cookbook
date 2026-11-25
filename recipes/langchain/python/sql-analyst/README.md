# Build a governed SQL analyst with LangChain and the ArmorIQ SDK

A data analyst agent on LangChain that answers questions over a SQLite warehouse, governed by the SDK's shipped `ArmorIQLangChain` callback handler rather than a hand rolled enforcement loop. Reads run, writes wait for a human, and anything that destroys or exports data is blocked. One row in the data is a planted prompt injection, so you can watch a model try to follow it and watch policy stop it.

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

No accounts, keys, or network needed. Offline mode runs the real `agent.py`, LangChain's real `create_agent`, the real MCP adapters, the real `ArmorIQLangChain` handler, and the real SQLite MCP server (spawned over stdio against a throwaway copy of the database). Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml`, and the Gemini model, which is a scripted tool calling chat model.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # three requests: a read, a held write, and the injection row
.venv/bin/python offline/test.py     # the same run as a pass or fail check, approved and rejected
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`.

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
OFFLINE_APPROVAL=reject .venv/bin/python offline/demo.py
```

Edit a rule in `policy.yaml` (say, change `update_rows` from `hold` to `allow`) and the offline result changes with it.

You will also see `Error in _ArmorIQLangChainCallback.on_tool_start callback: PolicyBlockedException(...)` on stderr for each refused call. That is LangChain logging the exception the handler raised to stop the tool. It is expected.

## Before you start

| Requirement | Why |
|---|---|
| Python 3.10 or later (tested on 3.12) | Runs the agent |
| An ArmorIQ account | Policy enforcement, approvals, and the audit trail |
| A Gemini API key | Drives the agent's model calls |

## Step 1: Create your ArmorIQ account and API key

1. Go to [platform.armoriq.ai](https://platform.armoriq.ai) and sign up or log in.
2. Open **Settings → API Keys**.
3. Click **Generate new key** and copy it.

## Step 2: Get a Gemini API key

1. Go to [aistudio.google.com](https://aistudio.google.com).
2. Click **Create API key** and copy it.

Only the model line in `agent.py` is Gemini specific. Swap `ChatGoogleGenerativeAI` for `ChatOpenAI` (`langchain-openai`), `ChatAnthropic` (`langchain-anthropic`), or any LangChain chat model that supports tool calling, and nothing else changes.

## Step 3: Install the project

```bash
python3 -m venv .venv
source .venv/bin/activate          # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

`requirements.txt` pins every package with `==`:

```
armoriq-sdk[langchain]==0.8.18
langchain==1.2.15
langchain-core==1.2.31
langgraph==1.1.6
langchain-google-genai==4.2.2
langchain-mcp-adapters==0.3.0
mcp==1.30.0
python-dotenv==1.2.4
PyYAML==6.0.3
```

`langchain` 1.2.15 and `langchain-core` 1.2.31 are the versions ArmorIQ lists as tested for its Python LangChain adapter. `mcp` stays on 1.x because `langchain-mcp-adapters` 0.3.0 still imports `mcp.server.fastmcp`, which `mcp` 2 renamed. PyYAML is only used by the offline stand-in to read `policy.yaml`.

## Step 4: The SQLite MCP server

`sql_warehouse_mcp.py` is a small FastMCP server over stdio. It builds `analytics.db` from `db/seed.sql` the first time it starts (customers, products, orders, feedback) and exposes the eight tools in the table above. Pass `--db <path>` or set `ANALYTICS_DB` to put the file somewhere else; delete it to reset the data.

The risk lives in the tool names on purpose. A single `run_sql` tool would force every policy decision to parse SQL. Separate `run_select`, `update_rows`, and `drop_table` tools let a policy say "reads yes, writes ask, drops never" by name, and let ArmorIQ show reviewers the exact table and values of a held write.

The server keeps its own guard rails too: `run_select` opens the database read only and accepts a single `SELECT`, and every table and column name is checked against a plain identifier pattern. ArmorIQ is the policy layer, not a replacement for input hygiene.

## Step 5: Register the server with ArmorIQ

1. In the ArmorIQ console, open **MCP Servers**.
2. Click **Add MCP Server**.
3. Name it `sql-warehouse` (or set `SQL_MCP_NAME` in `.env` to the name you choose).
4. Save.

### Why `mode="sdk"`

The server uses stdio, so it runs as a local subprocess of the agent. ArmorIQ's cloud proxy has no network path to it, so `mode="proxy"` would fail. In `mode="sdk"` ArmorIQ makes the allow, hold, or block decision and this process runs each approved call itself.

> The rest of this guide (the live setup steps on platform.armoriq.ai) lands in the next part.
