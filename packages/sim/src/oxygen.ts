import { MAT } from "./materials";
import type { World } from "./terrain";

export interface VentilationWorkspace {
  queue: Int32Array;
}

export interface VentilationOptions {
  target?: Uint8Array;
  workspace?: VentilationWorkspace;
  ventCells?: readonly { x: number; y: number }[];
}

/** Ventilation connectivity: BFS from every cell adjacent to a VENT block
 *  across EMPTY cells. Returns a bitset (1 byte per cell for simplicity).
 *
 *  Called only when terrain topology near a change is dirty, throttled by the
 *  match loop (never per-frame). Production callers reuse the output and ring
 *  queue and provide known vent positions, avoiding large-map allocation and
 *  a full material scan just to discover sources.
 */
export function computeVentilation(world: World, options: VentilationOptions = {}): Uint8Array {
  const size = world.size;
  const cellCount = size * size;
  const vent = options.target ?? new Uint8Array(cellCount);
  if (vent.length !== cellCount) throw new Error("ventilation target size does not match world");
  vent.fill(0);
  let queue = options.workspace?.queue ?? new Int32Array(Math.min(65536, cellCount));
  if (queue.length === 0) queue = new Int32Array(1);
  let head = 0;
  let tail = 0;
  let queued = 0;

  const enqueue = (i: number): void => {
    if (queued === queue.length) {
      const next = new Int32Array(Math.min(cellCount, Math.max(queue.length + 1, queue.length * 2)));
      for (let n = 0; n < queued; n++) next[n] = queue[(head + n) % queue.length];
      queue = next;
      head = 0;
      tail = queued;
      if (options.workspace) options.workspace.queue = queue;
    }
    queue[tail] = i;
    tail = (tail + 1) % queue.length;
    queued++;
  };

  const dequeue = (): number => {
    const i = queue[head];
    head = (head + 1) % queue.length;
    queued--;
    return i;
  };

  const mat = world.mat;
  const seedAround = (x: number, y: number): void => {
    seed(x + 1, y);
    seed(x - 1, y);
    seed(x, y + 1);
    seed(x, y - 1);
  };
  if (options.ventCells) {
    for (const cell of options.ventCells) seedAround(cell.x, cell.y);
  } else {
    for (let i = 0; i < mat.length; i++) {
      if (mat[i] !== MAT.VENT) continue;
      seedAround(i % size, (i / size) | 0);
    }
  }

  function seed(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = y * size + x;
    if (mat[i] !== MAT.EMPTY || vent[i]) return;
    vent[i] = 1;
    enqueue(i);
  }

  while (queued > 0) {
    const i = dequeue();
    const x = i % size;
    const y = (i / size) | 0;
    if (x + 1 < size) push(i + 1);
    if (x - 1 >= 0) push(i - 1);
    if (y + 1 < size) push(i + size);
    if (y - 1 >= 0) push(i - size);
  }

  function push(i: number): void {
    if (vent[i] || mat[i] !== MAT.EMPTY) return;
    vent[i] = 1;
    enqueue(i);
  }

  return vent;
}

/** Targeted safety query used while previewing a handful of temporary wall
 *  cells. This avoids recomputing ventilation for all 16M world cells. */
export function hasVentPath(world: World, sx: number, sy: number): boolean {
  if (!world.inBounds(sx, sy)) return false;
  const start = sy * world.size + sx;
  if (world.mat[start] === MAT.VENT) return true;
  if (world.mat[start] !== MAT.EMPTY) return false;

  const seen = new Set<number>([start]);
  const queue: number[] = [start];
  let head = 0;
  while (head < queue.length) {
    const i = queue[head++];
    const x = i % world.size;
    const visit = (next: number): boolean => {
      const mat = world.mat[next];
      if (mat === MAT.VENT) return true;
      if (mat !== MAT.EMPTY || seen.has(next)) return false;
      seen.add(next);
      queue.push(next);
      return false;
    };
    if (x + 1 < world.size && visit(i + 1)) return true;
    if (x > 0 && visit(i - 1)) return true;
    if (i + world.size < world.mat.length && visit(i + world.size)) return true;
    if (i >= world.size && visit(i - world.size)) return true;
  }
  return false;
}
