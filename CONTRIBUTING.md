# Contributing to the ArmorIQ Cookbook

Thanks for helping. The cookbook is a collection of complete, runnable agents that are governed by ArmorIQ. Every recipe should be something a reader can clone, run offline in one command, and then adapt for their own agent.

This guide covers what we accept, how to add a recipe, the checks your PR has to pass, and how we review it.

## Contents

- [What we accept](#what-we-accept)
- [Before you start](#before-you-start)
- [Add a recipe](#add-a-recipe)
- [What every recipe must have](#what-every-recipe-must-have)
- [Offline mode](#offline-mode)
- [The recipe.yaml manifest](#the-recipeyaml-manifest)
- [Writing the README](#writing-the-readme)
- [Pull requests](#pull-requests)
- [How we review](#how-we-review)
- [Official and community recipes](#official-and-community-recipes)
- [Changes outside recipes](#changes-outside-recipes)
- [Reporting bugs and asking for recipes](#reporting-bugs-and-asking-for-recipes)

## What we accept

**Yes, please:**

- A new recipe for any agent or scenario, in any framework, as long as it uses at least one ArmorIQ product: the SDK, Policies, Approvals, MCP registration, ArmorClaw, ArmorClaude, or ArmorCodex.
- A fix to an existing recipe: a bug, a broken step, an outdated SDK version, a clearer explanation.
- Improvements to the tooling (validator, index generator, CI, recipe browser), after a short issue first.

**We will decline:**

- Recipes that do not use ArmorIQ, or use it only in name (for example, a client is created but no tool call is ever checked).
- A recipe that duplicates an existing one with no new framework, language, or scenario. Improve the existing recipe instead.
- Recipes that need secrets, accounts, or network access to pass their offline test.
- Code that hides what it does: obfuscated code, downloaded scripts piped to a shell, binaries, or dependencies from outside the public npm and PyPI registries.
- Anything that demonstrates attacking a real system, real people's data, or getting around ArmorIQ's controls in production. Prompt injection scenarios are welcome when they use planted, fake data and show the attack being stopped.

## Before you start

- **Node.js 20 or later** for the repo tooling and the TypeScript lane.
- **Python 3.10 to 3.13** for the Python lane (the `armoriq-sdk` package does not support 3.14 yet). If your default `python3` is newer, set `PYTHON=python3.12` (or any supported version) when you run the checks.
- For a large change, or a new framework or language, open an issue first so we can agree on the shape before you build it.

Set up the repo once:

```bash
npm ci
npm run check            # schema fixtures, every recipe.yaml, and the README index
npm run check:recipes    # installs each recipe and runs its offline test (no keys needed)
```

To browse recipes and run them in the local recipe browser:

```bash
npm run serve            # http://localhost:3000
```

## Add a recipe

1. **Pick the path.** Every recipe lives at exactly `recipes/<framework>/<language>/<slug>/`.
   - `<framework>` is whatever runs the agent loop. If your code imports a framework's agent runner, that framework wins (`langchain`, `crewai`, `google-adk`, `strands`, ...). If you call the model and tools in your own loop with the ArmorIQ SDK, it is `sdk`. Using only a framework's model wrapper, an MCP client, or a model provider's client does not make it that framework. For a plugin policy recipe it is the host (`claude-code`, `codex`). For a config only recipe on the platform itself it is `armoriq`.
   - `<language>` is the language of the entry point the README tells readers to run first: `python`, `typescript` (also used for plain JavaScript), or `config` when there is no real program.
   - `<slug>` names the scenario in at most four words, for example `support-desk` or `github-write-guard`. Never repeat the framework or the language.
   - Every segment is lowercase kebab case (`^[a-z0-9]+(-[a-z0-9]+)*$`), at most 40 characters.
2. **Start from an existing recipe** in the same lane. `recipes/sdk/typescript/filesystem-notes/` (TypeScript) and `recipes/strands/python/support-desk/` (Python) are good starting points.
3. **Build the agent, the policy, and the offline mode** (see the next sections).
4. **Write `recipe.yaml` and the README.**
5. **Regenerate the index and run the checks:**

   ```bash
   npm run index
   npm run check
   npm run check:recipes <framework>/<language>/<slug>
   ```

6. **Open a pull request** against `main`.

If your recipe needs a framework, language, product, use case, outcome, service, or package that is not in `schema/taxonomy.yaml` yet, add it to that file in the same PR, with its label (and its note or description where the file asks for one).

## What every recipe must have

A recipe is self contained. Someone should be able to copy the folder out of the repo and run it.

| Item | Rule |
|---|---|
| `recipe.yaml` | Valid against `schema/recipe.schema.json`. See [the manifest](#the-recipeyaml-manifest). |
| `README.md` | The guide. Its first `# ` heading equals `title` in `recipe.yaml`, character for character. |
| Runnable code | The real agent, not pseudo code. |
| `policy.yaml` | The ArmorIQ policy the recipe expects, as a file, so readers do not rebuild it by hand. A recipe that spans several MCP servers ships one file per server (`policy.<server>.yaml`). |
| `.env.example` | Every environment variable the live run needs, with a comment saying where to get it. Never real values. |
| `.gitignore` | At least `node_modules/`, `.env`, and (Python) `.venv/` and `__pycache__/`. |
| Pinned dependencies | TypeScript: a committed `package-lock.json`. Python: `requirements.txt` with every line pinned with `==`. |
| `offline/` | Stand ins that let the recipe run and test with no keys. See [Offline mode](#offline-mode). |

And these rules always apply:

- **No secrets, ever.** No API keys, tokens, or personal data in code, fixtures, logs, or screenshots. Use `.env` locally (it is ignored) and `.env.example` in the repo.
- **No shared code between recipes.** Nothing may import, build, or reference a file outside its own folder. Copy what you need. (Markdown links to repo docs are fine.)
- **No symlinks** and no generated folders (`node_modules`, `.venv`, `dist`, `__pycache__`) in the commit.
- **The ArmorIQ check must be real.** Every tool call the agent makes goes through ArmorIQ before it runs.

## Offline mode

Every recipe runs and tests without keys, accounts, Docker, or network access. This is how reviewers and CI check a recipe they cannot run live, so it is required for every tier.

**TypeScript lane.** Add these scripts to `package.json`:

```json
"demo:offline": "node --import ./offline/register.mjs <entry file>",
"test:offline": "node offline/test.mjs"
```

`offline/register.mjs` uses Node's module hooks to swap the ArmorIQ SDK, the model, and the MCP client for local stand ins, so the real agent code runs unchanged. If the offline demo needs input from a person, also add a `demo:browser` script that runs unattended.

**Python lane.** Add `offline/demo.py` (a scripted, unattended run) and `offline/test.py` (runs the demo and asserts on its output). `offline/register.py` puts stand in modules into `sys.modules` before the agent is imported.

**Rules for the stand ins:**

- The ArmorIQ stand in decides allow, hold, or block by reading the recipe's own `policy.yaml` (a rule for the tool name, otherwise `default_action`). Never hardcode the decisions: changing the policy file must change the offline result.
- `OFFLINE_APPROVAL=reject` turns every held call into a rejection, and the agent must handle that without crashing. Approval is the default.
- The offline demo runs to the end with stdin closed.
- Print one line per event, in exactly this shape, so the test and the recipe browser can read the run:

  ```
  [armoriq] plan: <goal> -> <tool>, <tool>, ...
  [armoriq] check <tool>: ALLOWED (<reason>)
  [armoriq] check <tool>: HELD (<reason>)
  [armoriq] check <tool>: BLOCKED (<reason>)
  [armoriq] hold <tool>: APPROVED
  [armoriq] hold <tool>: REJECTED
  [armoriq] report <tool>: <status>
  ```

  Optionally, after a `check` line: `[armoriq] args <tool>: <single line JSON>`.

- The offline test asserts at least one line for every outcome the manifest lists in `demonstrates`, and fails (non zero exit) if anything is missing.

## The recipe.yaml manifest

The manifest describes the recipe once. The index, the badges, and CI all read from it. The full rules are in `schema/recipe.schema.json` and `docs/specs/0002-recipe-metadata-manifest.md`.

```yaml
# yaml-language-server: $schema=../../../../schema/recipe.schema.json
schema: 1
title: Build a Support Desk Agent with the ArmorIQ SDK
summary: One sentence, at most 200 characters, shown in the index.
framework: strands            # equals the first path segment
language: python              # equals the second path segment
tier: community               # see Official and community recipes
products: [sdk, policies, approvals]
use_case: support-ops
tags: [refunds, mcp]
demonstrates: [allow, hold, block, prompt-injection]
authors: [your-github-handle]
tested_with:
  "armoriq-sdk": "0.6.10"     # exact version, and it must match your lockfile or requirements.txt
requires:
  services: [armoriq, gemini]
```

Common mistakes the validator will catch:

- `framework` or `language` not matching the folder path.
- `variant` missing on a TypeScript recipe (`js` or `ts`), or present on any other language.
- A version range in `tested_with` (`^0.6.10`) instead of an exact version, or a version that differs from what your lockfile actually resolves.
- A value that is not in `schema/taxonomy.yaml`.
- `title` not matching the README's first heading.

## Writing the README

Write for someone who knows what ArmorIQ is but has never seen your agent. Use plain, direct language and short sentences. Explain each technical term the first time you use it.

Use this order (look at any existing recipe for an example):

1. `# Title` (same as `title` in `recipe.yaml`) and a short paragraph on what the agent does.
2. **What you'll build:** the flow, and a table of which tools are allowed, held, and blocked.
3. **Run it offline:** the one command, and what the reader should see.
4. **Before you start:** accounts, keys, and versions needed for the live run.
5. **Steps:** numbered, from creating the ArmorIQ account and policy to running the agent live.
6. **Troubleshooting:** the errors people actually hit, with fixes.

If you adapted someone else's work, credit them with a link.

## Pull requests

**Size limit.** A PR may change at most **1,000 lines** across at most **100 files**. Lockfiles (`package-lock.json`, `poetry.lock`, `uv.lock`, and similar) do not count. This is enforced by a required check on `main`.

- One recipe per PR. A recipe that is bigger than the limit is split into PRs that each make sense on their own (for example, the code first, then the README), each targeting `main`.
- Do not mix a recipe with unrelated tooling or other recipes' changes.
- Every PR targets `main`. Do not open PRs against another contributor's branch.

**Before you open it**, run:

```bash
npm run index
npm run check
npm run check:recipes <your recipe id>
```

**PR description.** Say what the recipe shows, which outcomes the offline run demonstrates, and anything a reviewer should know (a known limitation, a split README, a new taxonomy value).

**Commits.** Clear messages in the imperative ("Add Strands support desk recipe"). We squash merge, so the PR title becomes the commit on `main`.

**CI.** Every PR runs the metadata checks and builds and tests only the recipes it touches. Fork PRs run with read only permissions and no secrets, which is why the offline test has to stand on its own.

## How we review

A PR is merged when it has **one approving review** and every required check is green. Reviewers check the following, in this order.

**1. It runs.**

- `npm run check` passes.
- `npm run check:recipes <id>` passes on a clean install.
- `npm run demo:offline` (or `offline/demo.py`) shows the outcomes the manifest claims.

**2. It is honest.**

- Every tool call is checked by ArmorIQ before it executes. Nothing bypasses it.
- The offline stand in reads `policy.yaml`, so the offline story matches the live one.
- The README does not claim behavior the code does not have. Known limits are stated plainly.

**3. It is safe to run.**

- No secrets, no telemetry to third parties, no network calls in offline mode.
- Dependencies are pinned and come from npm or PyPI.
- Destructive actions (deletes, payments, account changes) are held or blocked by the shipped policy, or run against fake data only.

**4. It is useful and readable.**

- It teaches something the cookbook does not already show: a new framework, language, scenario, or ArmorIQ feature.
- The code is small enough to read in one sitting and follows the conventions of its lane.
- The README follows the order above and someone new can follow it without asking anyone.

**5. It fits the repo.**

- Correct path and naming, valid manifest, regenerated index.
- Within the PR size limit, one recipe per PR.

If a check fails, we will say which one and why.

## Official and community recipes

Every recipe is one of two tiers:

- **community**: reviewed, builds, and passes its offline test. There is no promise that it is kept up to date as the SDK changes. All new contributions start here.
- **official**: maintained by ArmorIQ and tested live against the real platform. A recipe is official only when its `recipe.yaml` says `tier: official` **and** its ID is listed in `.github/official-recipes.txt`, which only maintainers change. Do not set `tier: official` yourself. A maintainer may promote a community recipe later.

## Changes outside recipes

- **Taxonomy (`schema/taxonomy.yaml`):** add a value in the same PR that first uses it. Keep labels to the product's or framework's official name.
- **Schema and tooling (`schema/`, `tools/`, `.github/`):** open an issue first. These change the rules for every recipe, so they get a closer review. Add or update fixtures in `schema/fixtures/` for any schema change.
- **Specs (`docs/specs/`) and scope (`docs/scope/`):** maintained by the core team. If you think a decision should change, open an issue.
- **Recipe browser (`tools/server.mjs`, `tools/browser/`):** it uses the ArmorIQ design system. Use the `--color-aq-*`, `--text-aq-*`, and other tokens from `tools/browser/tokens.css`. Do not add raw color values or pixel font sizes.

## Reporting bugs and asking for recipes

- **A recipe is broken:** open an issue with the recipe ID, your OS, your Node or Python version, the command you ran, and the full output.
- **You want a recipe that does not exist:** open an issue describing the framework, the language, and the scenario. Someone may pick it up.
- **A security problem** (for example, a recipe that leaks a key or bypasses a check): do not open a public issue. Use the **Report a vulnerability** button on the repository's Security tab so maintainers can fix it privately.

## License

By contributing, you agree that your contribution is licensed under the same license as this repository (see `LICENSE`).
