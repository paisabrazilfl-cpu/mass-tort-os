FROM node:24-slim AS base
RUN npm install -g pnpm@10

WORKDIR /app

# ── deps ──────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json                    ./lib/db/
COPY lib/integrations/package.json          ./lib/integrations/
COPY lib/integrations/openai/package.json   ./lib/integrations/openai/
COPY artifacts/api-spec/package.json        ./artifacts/api-spec/
COPY artifacts/api-server/package.json      ./artifacts/api-server/
COPY artifacts/mtos-crm/package.json        ./artifacts/mtos-crm/
COPY scripts/package.json                   ./scripts/
RUN pnpm install --frozen-lockfile --prod=false

# ── codegen + build ───────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN pnpm --filter @workspace/api-spec run codegen
RUN BASE_PATH=/ pnpm --filter @workspace/mtos-crm run build
RUN pnpm --filter @workspace/api-server run build

# ── runtime ───────────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json                    ./lib/db/
COPY lib/integrations/package.json          ./lib/integrations/
COPY lib/integrations/openai/package.json   ./lib/integrations/openai/
COPY artifacts/api-spec/package.json        ./artifacts/api-spec/
COPY artifacts/api-server/package.json      ./artifacts/api-server/
COPY artifacts/mtos-crm/package.json        ./artifacts/mtos-crm/
COPY scripts/package.json                   ./scripts/

RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/mtos-crm/dist   ./artifacts/mtos-crm/dist

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/server/index.mjs"]
