FROM node:24-slim

# Install pnpm via corepack
RUN npm install -g corepack@0.24.1 && corepack enable

WORKDIR /app

# Copy workspace files
COPY . .

# Install all workspace packages (no frozen-lockfile: GitHub has client-portal not yet in lockfile)
RUN pnpm install --no-frozen-lockfile

# Full build pipeline: OpenAPI codegen → CRM frontend → API server
RUN pnpm --filter @workspace/api-spec run codegen && \
    pnpm --filter @workspace/mtos-crm run build && \
    pnpm --filter @workspace/api-server run build

EXPOSE 8080

CMD ["pnpm", "--filter", "@workspace/api-server", "run", "start"]
