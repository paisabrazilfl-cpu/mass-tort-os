FROM node:22-slim AS base
WORKDIR /app
RUN npm install -g corepack@0.32.0 && corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY tsconfig.base.json tsconfig.json ./
COPY artifacts/api-server/package.json artifacts/api-server/
COPY artifacts/api-spec/package.json artifacts/api-spec/
COPY artifacts/api-zod/package.json artifacts/api-zod/
COPY artifacts/api-client-react/package.json artifacts/api-client-react/
COPY artifacts/mtos-crm/package.json artifacts/mtos-crm/
COPY artifacts/client-portal/package.json artifacts/client-portal/
COPY artifacts/mockup-sandbox/package.json artifacts/mockup-sandbox/
COPY lib lib
RUN find lib -name "package.json" -exec dirname {} \; 2>/dev/null | while read d; do mkdir -p "$d"; done || true
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm --filter @workspace/api-spec run codegen 2>/dev/null || true
RUN pnpm --filter @workspace/api-server run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /app/artifacts/api-server/package.json ./artifacts/api-server/
COPY --from=build /app/package.json ./
EXPOSE 8080
CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/server/index.mjs"]
