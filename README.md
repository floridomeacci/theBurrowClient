# The Burrow

The Burrow is an online last-player-standing game set in a procedurally generated mine. Players dig through destructible terrain, collect materials, build oxygen-safe outposts, unlock tools and weapons, and fight until one player remains.

The browser renderer, simulation, network protocol, matchmaking edge, and authoritative server are written in TypeScript without a third-party game engine.

Play the private preview at [adabuild.xyz](https://adabuild.xyz).

## How the game is built

- A deterministic 30 Hz simulation with fixed-point movement and seeded random generation
- A 4096 x 4096 destructible map generated from a seed
- Server-authoritative multiplayer with client prediction and reconciliation
- Binary snapshots, terrain patches, chunk checksums, and repair requests
- Interest management based on nearby terrain, line of sight, and audible events
- Shared simulation, balance data, and protocol types across the monorepo
- One isolated Cloudflare Container for each match

The main design decisions are recorded in [docs/adr](./docs/adr).

## Architecture

```text
Browser client (Canvas and Web Audio)
       | binary WebSocket messages
       v
Cloudflare Worker gateway -> Matchmaker Durable Object
       | signed match routing
       v
Match Durable Object -> Cloudflare Container
                              |
                              v
                    Authoritative Node.js simulation
                              |
                  Queues -> D1 and R2 persistence
```

The server owns the full map, player roles, and match outcome. The client receives the world data needed for its current view and runs shared simulation code where local prediction is useful.

## Tech stack

| Area | Technology | Purpose |
|---|---|---|
| Language | TypeScript 5.9 in strict mode | Client, server, simulation, protocol, and edge code |
| Runtime | Node.js 22 | Local tools and authoritative match server |
| Browser client | HTML5 Canvas, DOM/CSS, and Web Audio API | Rendering, interface, input, and procedural audio |
| Frontend tooling | Vite 6 | Development server and production bundle |
| Multiplayer | WebSockets with `ws` 8 | Real-time client and server transport |
| Network protocol | Versioned binary packets with small JSON control messages | Snapshots, terrain, chunks, audio, and player input |
| Simulation | Custom fixed-timestep engine | Movement, terrain, oxygen, combat, bots, map generation, and upgrades |
| Edge | Cloudflare Workers and Wrangler 4 | Static delivery, authentication, and match routing |
| Coordination | Cloudflare Durable Objects | Matchmaking and per-match lifecycle ownership |
| Compute | Cloudflare Containers and Docker | Isolated authoritative match processes |
| Data | Cloudflare D1 | Player and match-result records |
| Object storage | Cloudflare R2 | Replay and snapshot storage target |
| Messaging | Cloudflare Queues | Asynchronous result processing |
| Workspace | pnpm 10 | Monorepo dependency and script management |
| Tests | Vitest 3 | Simulation, protocol, authentication, and lifecycle tests |
| CI | GitHub Actions | Install, audit, typecheck, test, build, and smoke checks |

## Run locally

You need Node.js 22 and pnpm 10.

```bash
git clone https://github.com/floridomeacci/theBurrowClient.git
cd theBurrowClient
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173>. The match server runs on port `8787`. Create a room and start a match; empty slots are filled by bots. Multiple browser tabs can join the same room, and `?room=name` selects a specific room.

Local developer mode adds test resources and camera switching. The match server accepts that mode only in its local configuration.

## Commands

```bash
pnpm dev              # match server and browser client
pnpm typecheck        # TypeScript checks across all workspaces
pnpm test             # automated test suite
pnpm build            # production client bundle
pnpm audit            # dependency advisory check
pnpm run deploy       # password-gated Cloudflare deployment
pnpm run site-password # rotate the preview password
```

Run the scripted smoke client against a local match server with:

```bash
pnpm --filter @burrow/match-server exec tsx src/index.ts &
pnpm --filter @burrow/match-server exec tsx src/smoke.ts
```

## Controls

| Input | Action |
|---|---|
| WASD | Move |
| Mouse | Aim |
| Left mouse button | Use the selected tool, dig, build, or deploy |
| Mouse wheel or carousel arrows | Cycle through unlocked tools |
| Shift | Sprint |
| K | Open the upgrade workshop |
| Q | Trigger remote explosives when available |
| E | Open a cleared ruin chest |
| R | Place a rubble barrier |
| F | Prepare or trigger a collapse charge |
| 1 to 9 | Select unlocked tools and weapons |
| Tab | Enlarge the explored minimap |
| `[` and `]` | Cycle camera targets in local developer mode |

## Repository layout

```text
apps/client            Vite browser game and Canvas renderer
apps/edge              Cloudflare gateway, authentication, Durable Objects, and D1 migration
services/match-server  Authoritative Node.js WebSocket server and container
packages/config        Shared balance configuration
packages/protocol      Binary packet codecs and message types
packages/sim           Deterministic simulation engine
docs/adr               Architecture decision records
docs/deploy.md         Cloudflare deployment guide
```

## Deployment and security

Production uses Cloudflare Workers Static Assets, Durable Objects, Containers, D1, R2, and Queues. The setup sequence is documented in [docs/deploy.md](./docs/deploy.md).

The preview password is verified before static assets, API routes, or WebSockets are served. The password verifier and cookie-signing key are stored as Cloudflare secrets. Successful access creates a signed, secure, HTTP-only cookie with a 12-hour lifetime. Application requests, login attempts, and game-session issuance have separate rate limits.

`pnpm run deploy` adds a local confirmation gate before Wrangler runs. It stores a derived verifier outside the repository and does not replace Cloudflare authentication or account permissions. Use `./deploy.sh --set-password` to change that local deployment password.

No credentials belong in the repository. See [SECURITY.md](./SECURITY.md) for private reporting instructions.
