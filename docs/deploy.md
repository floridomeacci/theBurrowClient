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
pnpm exec wrangler d1 create adabuild-db --location weur
#    → copy database_id into wrangler.jsonc (d1_databases[0].database_id)
pnpm run db:migrate

# 2. R2 bucket (replays / snapshots)
pnpm exec wrangler r2 bucket create adabuild-replays

# 3. Queue
pnpm exec wrangler queues create adabuild-match-results

# 4. Token signing secret
pnpm exec wrangler secret put MATCH_TOKEN_SECRET

# 5. Private-preview access secrets
cd ../..
pnpm run site-password
```

## Deploy

```bash
pnpm run deploy
# First run: choose a local deployment password (no deployment occurs).
# Later runs: enter that password, confirm, then build and deploy the Worker,
# Durable Objects, and Containers together.
```

The password itself is never stored. Its salted PBKDF2 digest lives outside the
repository in the user's configuration directory. Use
`./deploy.sh --set-password` to replace it. Cloudflare login and account
permissions still control access to the actual infrastructure.

The local deployment password above is separate from the production preview
password. Production access is checked at the Worker, which stores only a slow
password verifier and a session-signing key as encrypted Cloudflare secrets.
Successful browser sessions use a 12-hour `HttpOnly`, `Secure`, `SameSite=Strict`
cookie. Wrangler rate-limit bindings cap password attempts and broader platform
traffic, while the Matchmaker Durable Object separately limits game-session
issuance.

## Flow in production

1. Browser loads client from Workers Static Assets.
2. `POST /api/session` → Matchmaker DO validates and rate-limits the request,
   then returns a signed, short-lived token for the selected room.
3. Client opens `wss://…/ws?token=…` → gateway verifies the token → routes the
   upgrade to that match's `MatchDO` → proxied into the container.
4. The container runs the same authoritative code as local dev
   (`MODE=container`, one match per instance) and exits after the match plus a
   reconnection grace period.
5. The provisioned `adabuild-match-results` Queue has an idempotent D1 consumer
   for match-result persistence. R2 is reserved for replay and snapshot storage.

Before operating the service, review the account's current Containers limits,
configure an appropriate `max_instances`, and validate the full staging flow.
