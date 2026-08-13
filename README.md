# The Burrow

The Burrow is an online, last-player-standing action game set in a fully
destructible, procedurally generated mine. Players excavate tunnels, collect
materials, build oxygen-safe outposts, unlock an extensive weapon tree, and
fight through a server-authoritative simulation.

The project is a custom TypeScript game stack: the browser renderer, simulation,
network protocol, matchmaking edge, and authoritative server are all implemented
without a third-party game engine.

## Highlights

- Deterministic 30 Hz simulation with integer fixed-point movement and seeded RNG
- Server-authoritative multiplayer with local prediction and reconciliation
- 4096×4096 destructible worlds generated from a seed
- Chunk revisions, checksums, incremental terrain patches, and repair requests
- Interest management based on nearby terrain, line of sight, and audible events
- Rich progression across tools, weapons, buildings, resources, and relics
- Cloudflare-native deployment design with one isolated container per match
- Shared types, balance data, simulation code, and binary protocol codecs

Architecture decisions are recorded under [docs/adr](./docs/adr).

## Architecture

```text
Browser client (Canvas + Web Audio)
       │ binary WebSocket messages
       ▼
Cloudflare Worker gateway ── Matchmaker Durable Object
       │ signed match routing
       ▼
Match Durable Object ── Cloudflare Container
                              │
                              ▼
                    Authoritative Node.js simulation
                              │
                  Queues ── D1 / R2 persistence
```

The browser receives only the world data needed for the current view. The full
map and its seed remain authoritative on the server. Simulation behavior is
shared between the server and client where prediction requires it, while player
roles and match outcomes remain server-owned.

## Complete tech stack

| Area | Technology | Role |
|---|---|---|
| Language | TypeScript 5.9, strict mode | Client, server, simulation, protocol, and edge code |
| Runtime | Node.js 22 | Local development and authoritative match server |
| Web client | HTML5 Canvas, DOM/CSS, Web Audio API | Rendering, interface, controls, and procedural audio |
| Front-end tooling | Vite 6 | Development server and production client bundle |
| Multiplayer | WebSockets with `ws` 8 | Real-time client/server transport |
| Network format | Custom versioned binary protocol plus small JSON control messages | Compact snapshots, terrain patches, chunks, audio, and input |
| Simulation | Custom deterministic fixed-timestep engine | Movement, terrain, oxygen, combat, bots, map generation, and upgrades |
| Edge | Cloudflare Workers and Wrangler 4 | Static delivery, gateway routing, and deployment |
| Coordination | Cloudflare Durable Objects | Regional matchmaking and per-match lifecycle ownership |
| Compute | Cloudflare Containers, Docker, Node 22 Alpine | Isolated authoritative match processes |
| Data | Cloudflare D1 (SQLite) | Player and match-result persistence |
| Object storage | Cloudflare R2 | Replay and snapshot storage target |
| Messaging | Cloudflare Queues | Asynchronous, idempotent result processing |
| Package management | pnpm 10 workspaces | Monorepo dependency and script orchestration |
| Tests | Vitest 3 | Unit, property-style, protocol, lifecycle, and integration tests |
| Quality | TypeScript compiler, pnpm audit | Static validation and dependency checks |
| CI | GitHub Actions | Clean install, audit, typecheck, tests, build, and smoke test |
| Design assets | Optimized PNG/WebP sprites and UI atlases | HUD, menus, characters, tools, weapons, and materials |
| Typography | Asap Condensed, Goldman, Heebo | UI display and body type |

## Repository layout

```text
apps/client            Vite browser game and Canvas renderer
apps/edge              Cloudflare gateway, Durable Objects, D1 migration
services/match-server  Authoritative Node.js WebSocket server and container
packages/config        Shared balance configuration
packages/protocol      Versioned binary packet codecs and message types
packages/sim           Deterministic simulation engine
docs/adr               Architecture decision records
docs/deploy.md         Cloudflare deployment guide
```

## Run locally

Requirements: Node.js 22+ and pnpm 10.

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

Open <http://localhost:5173>. Create a room, enter a name, and start the match;
empty slots are filled by bots. Multiple browser tabs can join the same room.
Add `?room=name` to use a specific room.

Developer mode is available on the local join screen. It grants test resources
and allows the camera to cycle across participants with `[` and `]`. The server
accepts developer mode only in its local configuration.

## Commands

```bash
pnpm dev        # match server on :8787 and Vite client on :5173
pnpm typecheck  # strict TypeScript checks across every workspace
pnpm test       # all automated tests
pnpm build      # production client bundle
pnpm audit      # dependency advisory check
pnpm run deploy # password-gated Cloudflare deployment
pnpm run site-password # securely rotate the production preview password
```

Run the scripted end-to-end smoke client against a local server:

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
| Mouse wheel / carousel arrows | Cycle through unlocked tools |
| Shift | Sprint |
| K | Open the upgrade workshop |
| Q | Trigger remote explosives when available |
| E | Open a cleared ruin chest |
| R | Place a rubble barrier |
| F | Prepare or trigger a collapse charge |
| 1–9 | Select unlocked tools and weapons |
| Tab | Enlarge the explored minimap |
| `[` / `]` | Cycle camera targets in local developer mode |

## Deployment

The production site is <https://adabuild.xyz>. It uses Cloudflare Workers
Static Assets, Durable Objects, Containers, D1, R2, and Queues. Credentials and
secret values are intentionally excluded from version control; the D1 binding
identifier in Wrangler configuration is non-secret deployment metadata. See
[docs/deploy.md](./docs/deploy.md) for the setup sequence.

The production preview is password-protected at the Worker before static assets,
APIs, or WebSockets are served. Password verification uses a salted PBKDF2 hash
stored as a Cloudflare secret, and successful access creates a signed, HTTP-only,
secure, same-site cookie that expires after 12 hours. Cloudflare rate-limit
bindings protect the whole application and apply a stricter limit to login
attempts; game-session issuance also has its own serialized limit.

Rotate the production preview password with `pnpm run site-password`. The
script reads and confirms it without terminal echo, derives the verifier in
memory, and sends only that verifier to Cloudflare. It does not write the
plaintext or verifier to the repository. It also rotates the cookie-signing key
so any previously issued browser sessions are invalidated.

The first `pnpm run deploy` run creates a deployment password. Only a salted,
slow-derived digest is saved, outside the repository in the user's configuration
directory. Later runs require that password and an explicit confirmation before
Wrangler starts. Change it with `./deploy.sh --set-password` or verify it without
deploying with `./deploy.sh --check-password`.

This password prompt protects against accidental local deployment. Cloudflare
authentication and account permissions remain the actual deployment security
boundary.

## Security

No credentials or account-specific deployment values are stored in this
repository. Configure the signing key through Wrangler's encrypted secret store
and keep local environment files untracked. Please use the private reporting
process in [SECURITY.md](./SECURITY.md) for security concerns.
