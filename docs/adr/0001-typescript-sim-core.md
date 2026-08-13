# ADR 0001 — TypeScript simulation core (Rust/WASM deferred)

## Status
Accepted

## Context
The spec (§15.2/§15.3) recommends Rust crates (`sim-core`, `terrain-core`)
shared between the native server and a WASM client module, "if profiling
justifies it".

## Decision
Implement the deterministic simulation core in TypeScript (`@burrow/sim`),
shared verbatim between the authoritative server and client prediction.

Reasons:
- One language across sim/server/client removes an entire build pipeline and
  a codec boundary during the highest-churn phase of development.
- Client prediction uses the *identical* movement/collision code as the
  server, eliminating prediction drift by construction.
- Determinism is achieved with integer fixed-point positions (1/256 cell),
  typed arrays, and seeded integer RNG — no cross-language float concerns.
- Measured performance is far inside budget: full 8-player bot ticks run in
  well under 1 ms; map generation ~200 ms once per match.

## Consequences
- If profiling ever shows the terrain hot path exceeding budget (spec §21.2),
  port `terrain.ts`/`oxygen.ts` to a Rust crate compiled to native (server)
  and WASM (client) behind the same interface.
- The Node-based match server container is fully OCI-portable (spec §16.5).
