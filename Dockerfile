FROM node:24-slim AS base
RUN npm install -g pnpm@10

WORKDIR /app

# ── deps: copy only package.json manifests that exist in this repo ─────────────
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json                             ./lib/db/
COPY lib/api-spec/package.json                       ./lib/api-spec/
COPY lib/api-client-react/package.json               ./lib/api-client-react/
COPY lib/api-zod/package.json                        ./lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json  ./lib/integrations-openai-ai-server/
COPY lib/integrations-anthropic-ai/package.json      ./lib/integrations-anthropic-ai/
COPY artifacts/api-server/package.json               ./artifacts/api-server/
COPY artifacts/mtos-crm/package.json                 ./artifacts/mtos-crm/
COPY artifacts/client-portal/package.json            ./artifacts/client-portal/
COPY scripts/package.json                            ./scripts/
RUN pnpm install --no-frozen-lockfile

# ── codegen + build ────────────────────────────────────────────────────────────
FROM deps AS builder
COPY . .
RUN pnpm --filter @workspace/api-spec run codegen
RUN pnpm --filter @workspace/mtos-crm run build
RUN pnpm --filter @workspace/api-server run build

# ── runtime: lean image, only compiled output ──────────────────────────────────
FROM node:24-slim AS runtime
RUN npm install -g pnpm@10

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY lib/db/package.json                             ./lib/db/
COPY lib/api-spec/package.json                       ./lib/api-spec/
COPY lib/api-client-react/package.json               ./lib/api-client-react/
COPY lib/api-zod/package.json                        ./lib/api-zod/
COPY lib/integrations-openai-ai-server/package.json  ./lib/integrations-openai-ai-server/
COPY lib/integrations-anthropic-ai/package.json      ./lib/integrations-anthropic-ai/
COPY artifacts/api-server/package.json               ./artifacts/api-server/
COPY artifacts/mtos-crm/package.json                 ./artifacts/mtos-crm/
COPY artifacts/client-portal/package.json            ./artifacts/client-portal/
COPY scripts/package.json                            ./scripts/

RUN pnpm install --no-frozen-lockfile --prod

COPY --from=builder /app/artifacts/api-server/dist  ./artifacts/api-server/dist
COPY --from=builder /app/artifacts/mtos-crm/dist    ./artifacts/mtos-crm/dist
COPY --from=builder /app/docs                        ./docs

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/server/index.mjs"]
