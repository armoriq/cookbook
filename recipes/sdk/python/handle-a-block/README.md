# Build a Release Agent That Handles Blocks with the ArmorIQ SDK

A step by step guide to the ArmorIQ Python SDK with no framework at all: a hand written agent loop that plans, mints an intent token, and invokes each tool call through ArmorIQ. It is the template to copy when your agent has no framework, or when you want to see exactly what the framework adapters do for you.

The other half of the recipe is what happens when ArmorIQ says no. Most examples stop at the first `PolicyBlockedException`. This one keeps going: it re-plans around a blocked tool, stops cleanly when a human rejects a held call, signs a new plan when the agent drifts from the old one, and mints a fresh token when the old one runs out.

## What you'll build

A release desk assistant that reads CI results, deploys to staging and production, and manages environments, all through a small MCP server that ships with the recipe:

```
goal → plan (model) → capture_plan → get_intent_token → invoke_with_policy, step by step
                         ↑                                         │
                         └──── re-plan / re-mint on a refusal ─────┘
```

| Tool | Risk | Policy |
|---|---|---|
| `list_environments`, `get_build_status` | read only | allow |
| `rerun_ci`, `run_smoke_tests`, `deploy_to_staging`, `request_teardown` | low risk write | allow |
| `deploy_to_production` | customer facing | hold |
| `delete_environment` | irreversible | block |

## Run it offline

No accounts, keys, Docker, or network needed. Offline mode runs the real `agent.py` loop, the real `mcp_stdio.py` tool listing, the real `release_desk_mcp.py` server (spawned over stdio), and the SDK's real exception classes and models. Two things are stand-ins, both in `offline/`: the ArmorIQ client, which decides from this recipe's `policy.yaml` and runs allowed calls on the local server (the job ArmorIQ's proxy does live), and the planner, which is rule based instead of Gemini.

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python offline/demo.py     # five requests: allowed, held, blocked, off plan, expired token
.venv/bin/python offline/test.py     # the same run as a pass or fail check, approve and reject
```

On Windows, use `.venv\Scripts\python.exe` in place of `.venv/bin/python`. The armoriq-sdk 0.8.18 package needs Python 3.10 to 3.13.

The five requests and what each one shows:

| Request | What happens | Recovery |
|---|---|---|
| Deploy checkout build 512 to staging | Both steps allowed | none needed |
| Deploy checkout build 512 to production | `deploy_to_production` is held for a human | approved: it runs. Rejected: the agent stops and says so |
| Tear down the idle staging-eu environment | `delete_environment` is blocked | re-plans without it and files `request_teardown` for a human instead |
| Deploy payments build 77 to staging | The build is red, so the agent wants `rerun_ci`, which is not in the signed plan | catches `IntentMismatchException`, signs a new plan from that step on |
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
OFFLINE_APPROVAL=reject .venv/bin/python offline/demo.py
```

```
[armoriq] hold deploy_to_production: REJECTED
[agent] DelegationException: deploy_to_production was not approved (Delegation rejected). Stopping here.
Answer: Done: get_build_status. Refused: deploy_to_production (approval rejected). A human declined that step, so I did not try another route.
```

Edit a rule in `policy.yaml` (say, change `delete_environment` to `allow`) and the offline result changes with it.

> The rest of this guide (the live setup steps on platform.armoriq.ai) lands in the next part.
