# Apply the ArmorDev Policy Pack to Claude Code with ArmorClaude

A ready policy for a coding agent doing everyday software work. Reads, edits, tests, and builds run without a prompt. Secrets and keys are out of reach, destructive commands and pushes to `main` never run, and publishing a package or reaching the network from the shell waits for you. There is no app code here: the recipe is the policy itself, in the format ArmorClaude loads, plus the same rules for ArmorCodex.

## What you'll get

| Area | What the agent tries | ArmorClaude |
|---|---|---|
| Secret and key quarantine | Read, Write, Edit, Grep, or Glob on `.env*` (not `.env.example`), `~/.ssh`, `~/.aws`, `id_rsa` style keys, `*.pem`, `*.key`, `credentials` files, `.netrc`, `.npmrc`, `.pypirc`, `.kube/config`. A shell command that names one (`cat .env`) | block |
| Destructive commands | `rm -r` / `rm -rf`, `git reset --hard`, `git clean -f`, `dd of=`, `mkfs`, `shred`, `Remove-Item -Recurse` | block |
| Git safety | `git push --force` (or `-f`, `--force-with-lease`, `+branch`), any push that names `main` or `master` | block |
| Network from the shell | `curl ... \| sh`, `bash -c "$(curl ...)"`, `iwr ... \| iex` | block |
| | Any other `curl`, `wget`, `nc`, `scp`, `rsync`, `ssh` | hold |
| Publishing | `npm publish`, `cargo publish`, `twine upload`, `poetry publish`, `gem push`, `gh release create`, `docker push` | hold |
| Tests and builds | `npm test`, `npm run build`, `pytest`, `go test`, `cargo build`, `make`, `tsc`, `git status/diff/log/add/commit`, `ls`, `cat`, `grep` | allow |
| Everything else in the shell | `docker compose up`, `git push origin feature/x`, `echo x > file`, anything chained with `&&` or `;` | hold |
| Everything else | Read, Grep, Glob, edits outside the secret list, web search, MCP tools | allow |

The pack lives in three files:

| File | What it is |
|---|---|
| `armorclaude/armordev.json` | The policy ArmorClaude enforces: an `armor.policy.v1` `PolicyProfile`. |
| `armorcodex/policy-profiles.json` | The same rules in ArmorCodex's rule list format, as a saved profile named `armordev`. |
| `policy.yaml` | A readable summary for the recipe browser. Neither plugin reads it. |

## Run it offline

No plugin, accounts, keys, or network needed. Node 20 or newer, no `npm install`:

```bash
node offline/demo.mjs     # one coding session: a read, a blocked .env, tests, a blocked reset and push, a held publish
node offline/test.mjs     # 42 sample calls against both plugins' rules, as a pass or fail check
```

`offline/test.mjs` first validates `armorclaude/armordev.json` with the same checks ArmorClaude runs when you stage a policy, and checks that `policy.yaml` names the same rules. Then it runs every call in `offline/cases.mjs` through a small evaluator that copies each plugin's matching rules (`offline/evaluate.mjs` says which source files it follows) and exits non zero on any verdict that differs from the table. Each decision prints one line:

```
[armoriq] check Bash: ALLOWED (policy armordev: allow-test-build -> allow)
[armoriq] check Bash: HELD (policy armordev: hold-package-publish -> hold)
[armoriq] hold Bash: APPROVED
[armoriq] check Bash: BLOCKED (policy armordev: forbid-push-protected-branch -> block)
```

Set `OFFLINE_APPROVAL=reject` to see held calls rejected instead. Edit a statement in `armorclaude/armordev.json` (say, change `hold-package-publish` to `forbid`) and the offline result changes with it; the test then tells you which rows of `offline/cases.mjs` and `policy.yaml` to update.

## Before you start

| Requirement | Why |
|---|---|
| Claude Code | The agent this pack guards |
| ArmorClaude installed | Enforces the policy in Claude Code's hooks |

Install ArmorClaude if you have not:

```bash
curl -fsSL https://armoriq.ai/install_armorclaude.sh | bash
```

> The rest of this guide (the live setup steps on platform.armoriq.ai) lands in the next part.
