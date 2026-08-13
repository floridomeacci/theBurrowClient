# Deploying The Burrow to Cloudflare

Everything runs on Cloudflare (spec §16): Workers, Durable Objects,
Containers, D1, R2, and Queues. `apps/edge/wrangler.jsonc` is the single
deployment entrypoint; the container image is built from
`services/match-server/Dockerfile` (context = repo root).

## Prerequisites

- Cloudflare account with **Workers Paid** plan (Durable Objects + Containers)
- `wrangler` 4.x logged in: `pnpm --filter @burrow/edge exec wrangler login`
- Docker running locally (wrangler builds the container image)

## One-time setup

```bash
cd apps/edge

# 1. D1 database
pnpm exec wrangler d1 create burrow-db
#    → copy database_id into wrangler.jsonc (d1_databases[0].database_id)
pnpm run db:migrate

# 2. R2 bucket (replays / snapshots)
pnpm exec wrangler r2 bucket create burrow-replays

# 3. Queue
pnpm exec wrangler queues create burrow-match-results

# 4. Token signing secret
pnpm exec wrangler secret put MATCH_TOKEN_SECRET
```

## Deploy

```bash
pnpm deploy
# First run: choose a local deployment password (no deployment occurs).
# Later runs: enter that password, confirm, then build and deploy the Worker,
# Durable Objects, and Containers together.
```

The password itself is never stored. Its salted PBKDF2 digest lives outside the
repository in the user's configuration directory. Use
`./deploy.sh --set-password` to replace it. Cloudflare login and account
permissions still control access to the actual infrastructure.

## Flow in production

1. Browser loads client from Workers Static Assets.
2. `POST /api/queue` → Matchmaker DO groups players, allocates a match ID,
   pre-warms the match container, returns a signed short-lived match token.
3. Client opens `wss://…/ws?token=…` → gateway verifies the token → routes the
   upgrade to that match's `MatchDO` → proxied into the container.
4. The container runs the same authoritative code as local dev
   (`MODE=container`, one match per instance) and exits after the match plus a
   reconnection grace period.
5. Match results flow through `burrow-match-results` (Queue) into D1 with
   idempotent `INSERT OR IGNORE` writes.

Before operating the service, review the account's current Containers limits,
configure an appropriate `max_instances`, and validate the full staging flow.
