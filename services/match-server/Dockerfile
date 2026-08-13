# The Burrow — authoritative match server container.
# One active match per container instance (spec §16.1). Deployed to
# Cloudflare Containers via apps/edge wrangler config.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

# Workspace manifests first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/sim/package.json packages/sim/
COPY packages/protocol/package.json packages/protocol/
COPY services/match-server/package.json services/match-server/

RUN pnpm install --frozen-lockfile --filter @burrow/match-server...

# Sources
COPY packages/config packages/config
COPY packages/sim packages/sim
COPY packages/protocol packages/protocol
COPY services/match-server services/match-server

ENV MODE=container
ENV PORT=8080
EXPOSE 8080

CMD ["pnpm", "--filter", "@burrow/match-server", "start"]
