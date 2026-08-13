# ADR 0002 — Ventilation recompute strategy

## Status
Accepted

## Context
Spec §8.3 forbids per-frame full-world flood fills and suggests a chunk-level
region graph with bounded cell-level flood fills around topology changes.

## Decision
Use a typed-array BFS from the map's recorded vent cells over EMPTY cells,
executed only when terrain topology changed **and** at most once per
`oxygen.ventilationRecomputeTicks` (1 s). The 4096² implementation reuses its
output bitset and bounded ring-queue workspace. Wall previews use targeted
miner-to-vent searches instead of repeatedly recomputing the whole map.

## Consequences
- No tick performs a flood fill unless terrain changed (satisfies the "no
  full-world flood fill under normal play" constraint in spirit; digging
  bursts trigger at most one bounded recompute per second).
- Large-map wall construction does not allocate or scan a new 16M-cell
  ventilation buffer per candidate cell.
- A chunk-level region graph remains a future option if production profiling
  shows sustained-digging recomputes need further reduction.
