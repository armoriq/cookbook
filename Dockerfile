FROM node:22-bookworm-slim AS node

# Python 3.12 and Node 22, the same versions the Recipes CI uses
FROM python:3.12-slim-bookworm
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
  && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

# tools/recipes.mjs finds the root and the recipes through git, so the copied tree needs to be a repo.
# Without .gitignore, git ls-files lists every node_modules and .venv file and the server crashes.
# check-recipe installs every recipe (node_modules, .venv) and runs its offline test, so the Run tab works.
RUN test -f .gitignore \
  && git init -q \
  && npm run -s check \
  && node tools/check-recipe.mjs --ci

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "tools/server.mjs"]
