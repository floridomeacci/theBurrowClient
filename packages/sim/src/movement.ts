import { FP } from "./constants";
import type { World } from "./terrain";

/** Circle vs solid-cell overlap test. Position/radius in FP units. */
export function circleCollides(world: World, xFp: number, yFp: number, rFp: number): boolean {
  const minX = Math.floor((xFp - rFp) / FP);
  const maxX = Math.floor((xFp + rFp) / FP);
  const minY = Math.floor((yFp - rFp) / FP);
  const maxY = Math.floor((yFp + rFp) / FP);
  for (let cy = minY; cy <= maxY; cy++) {
    for (let cx = minX; cx <= maxX; cx++) {
      if (!world.isSolid(cx, cy)) continue;
      // closest point on cell rect to circle center
      const rx0 = cx * FP;
      const ry0 = cy * FP;
      const px = Math.max(rx0, Math.min(xFp, rx0 + FP));
      const py = Math.max(ry0, Math.min(yFp, ry0 + FP));
      const dx = xFp - px;
      const dy = yFp - py;
      if (dx * dx + dy * dy < rFp * rFp) return true;
    }
  }
  return false;
}

export interface MoveResult {
  x: number;
  y: number;
  hitX: boolean;
  hitY: boolean;
}

export interface CircleObstacle {
  x: number;
  y: number;
  radius: number;
}

/** Dynamic circle obstacles such as deployed bases. An entity already inside
 * an obstacle may move outward, which keeps recovery and old snapshots from
 * trapping it forever. */
function circleObstaclesBlockMove(
  x: number,
  y: number,
  nextX: number,
  nextY: number,
  radius: number,
  obstacles: readonly CircleObstacle[]
): boolean {
  for (const obstacle of obstacles) {
    const combined = radius + obstacle.radius;
    const combined2 = combined * combined;
    const nextDx = nextX - obstacle.x;
    const nextDy = nextY - obstacle.y;
    const nextDistance2 = nextDx * nextDx + nextDy * nextDy;
    if (nextDistance2 >= combined2) continue;
    const dx = x - obstacle.x;
    const dy = y - obstacle.y;
    const distance2 = dx * dx + dy * dy;
    if (distance2 >= combined2 || nextDistance2 <= distance2) return true;
  }
  return false;
}

/** Axis-separated, sub-stepped integer movement. Shared by the server sim and
 *  client prediction so both produce identical results. */
export function moveCircle(
  world: World,
  xFp: number,
  yFp: number,
  rFp: number,
  dxFp: number,
  dyFp: number,
  obstacles: readonly CircleObstacle[] = []
): MoveResult {
  const maxStep = FP >> 2; // quarter-cell substeps prevent tunneling
  let x = xFp;
  let y = yFp;
  let hitX = false;
  let hitY = false;

  let remX = dxFp;
  while (remX !== 0) {
    const step = Math.abs(remX) > maxStep ? Math.sign(remX) * maxStep : remX;
    if (circleCollides(world, x + step, y, rFp) || circleObstaclesBlockMove(x, y, x + step, y, rFp, obstacles)) {
      hitX = true;
      break;
    }
    x += step;
    remX -= step;
  }

  let remY = dyFp;
  while (remY !== 0) {
    const step = Math.abs(remY) > maxStep ? Math.sign(remY) * maxStep : remY;
    if (circleCollides(world, x, y + step, rFp) || circleObstaclesBlockMove(x, y, x, y + step, rFp, obstacles)) {
      hitY = true;
      break;
    }
    y += step;
    remY -= step;
  }

  return { x, y, hitX, hitY };
}

/** Push a circle out of solid terrain (used after collapses / rubble under a
 *  player). Searches outward in rings; returns new position. */
export function depenetrate(world: World, xFp: number, yFp: number, rFp: number): { x: number; y: number } {
  if (!circleCollides(world, xFp, yFp, rFp)) return { x: xFp, y: yFp };
  for (let ring = 1; ring <= 24; ring++) {
    const d = ring * (FP >> 1);
    for (let a = 0; a < 16; a++) {
      const ang = (a / 16) * Math.PI * 2;
      const nx = Math.round(xFp + Math.cos(ang) * d);
      const ny = Math.round(yFp + Math.sin(ang) * d);
      if (!circleCollides(world, nx, ny, rFp)) return { x: nx, y: ny };
    }
  }
  return { x: xFp, y: yFp };
}
