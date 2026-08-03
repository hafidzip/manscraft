// Voxel A* pathfinding for humanoid agents (2-block tall, 1-2 block jump-up,
// multi-block falls, gap bridging). Pooled binary heap + hard node budget
// keeps cost bounded. Returns a best-effort partial path when the goal is
// unreachable so agents still close the distance.
import * as THREE from 'three';
import { type WorldLike } from './World';
import { WORLD_SIZE, WORLD_HEIGHT } from '../core/constants';

const SIZE = WORLD_SIZE;
const HEIGHT = WORLD_HEIGHT;
const LAYER = SIZE * SIZE;

const packKey = (x: number, y: number, z: number) => (y * SIZE + z) * SIZE + x;

// ------------------------------------------------------------------ min-heap
class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  size = 0;

  clear() { this.size = 0; }

  push(key: number, p: number) {
    let i = this.size++;
    this.keys[i] = key;
    this.prio[i] = p;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.prio[par] <= this.prio[i]) break;
      this.swap(i, par);
      i = par;
    }
  }

  pop(): number {
    const top = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size];
      this.prio[0] = this.prio[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.size && this.prio[l] < this.prio[s]) s = l;
        if (r < this.size && this.prio[r] < this.prio[s]) s = r;
        if (s === i) break;
        this.swap(i, s);
        i = s;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const tk = this.keys[a], tp = this.prio[a];
    this.keys[a] = this.keys[b]; this.prio[a] = this.prio[b];
    this.keys[b] = tk; this.prio[b] = tp;
  }
}

// pooled search state (single-threaded, one search at a time)
const heap = new MinHeap();
const gScore = new Map<number, number>();
const cameFrom = new Map<number, number>();
const closed = new Set<number>();

export interface PathOptions {
  maxNodes?: number;    // max A* expansions (CPU guard)
  maxFall?: number;     // max blocks an agent drops in one step
  maxJump?: number;     // max blocks the agent jumps up (1 = step, 2 = pillar-jump)
  reachRadius?: number; // accept within this distance of goal
}

/** Can a 2-block-tall entity stand with its feet at (x,y,z)? */
export function canStand(world: WorldLike, x: number, y: number, z: number): boolean {
  if (y < 1 || y >= HEIGHT - 1) return false;
  if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return false;
  return world.solid(x, y - 1, z) && !world.solid(x, y, z) && !world.solid(x, y + 1, z);
}

/** Can a 2-block-tall entity pass through (x,y,z) — no floor requirement. */
function passable(world: WorldLike, x: number, y: number, z: number): boolean {
  if (y < 0 || y >= HEIGHT - 1 || x < 0 || z < 0 || x >= SIZE || z >= SIZE) return false;
  return !world.solid(x, y, z) && !world.solid(x, y + 1, z);
}

/** Snap a position to the nearest standable voxel (scans down, then up). */
export function snapToGround(world: WorldLike, x: number, y: number, z: number, range = 8): number {
  if (canStand(world, x, y, z)) return y;
  for (let d = 1; d <= range; d++) {
    if (canStand(world, x, y - d, z)) return y - d;
    if (canStand(world, x, y + d, z)) return y + d;
  }
  return -1;
}

const NEIGHBORS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/**
 * A* through the voxel world. Returns true = full path found, false =
 * partial best-effort path toward the goal (or empty = totally stuck).
 */
export function findPath(
  world: WorldLike,
  sx: number, sy: number, sz: number,
  gx: number, gy: number, gz: number,
  out: THREE.Vector3[],
  opts: PathOptions = {}
): boolean {
  const maxNodes = opts.maxNodes ?? 1800;
  const maxFall = opts.maxFall ?? 8;
  const maxJump = opts.maxJump ?? 2;
  const reach = opts.reachRadius ?? 0;

  out.length = 0;

  const startY = snapToGround(world, sx, sy, sz, 6);
  if (startY < 0) return false;
  let goalY = snapToGround(world, gx, gy, gz, 6);
  if (goalY < 0) goalY = gy;

  const startKey = packKey(sx, startY, sz);
  const goalKey = packKey(gx, goalY, gz);
  if (startKey === goalKey) return true;

  heap.clear();
  gScore.clear();
  cameFrom.clear();
  closed.clear();

  const h = (x: number, y: number, z: number) => {
    const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
    const hi = Math.max(dx, dz), lo = Math.min(dx, dz);
    return (hi - lo) + 1.414 * lo + Math.abs(y - goalY) * 1.3;
  };

  gScore.set(startKey, 0);
  heap.push(startKey, h(sx, startY, sz));

  let bestKey = startKey;
  let bestH = h(sx, startY, sz);
  let found = false;
  let expanded = 0;

  while (heap.size > 0 && expanded < maxNodes) {
    const cur = heap.pop();
    if (closed.has(cur)) continue;   // skip stale entries
    closed.add(cur);

    const cx = cur % SIZE;
    const cz = ((cur - cx) / SIZE) % SIZE;
    const cy = Math.floor(cur / LAYER);

    if (cur === goalKey) { bestKey = cur; found = true; break; }
    if (reach > 0) {
      const dx = cx - gx, dys = cy - goalY, dz = cz - gz;
      if (dx * dx + dys * dys + dz * dz <= reach * reach) { bestKey = cur; found = true; break; }
    }

    expanded++;
    const cg = gScore.get(cur)!;

    for (let n = 0; n < NEIGHBORS.length; n++) {
      const [dx, dz] = NEIGHBORS[n];
      const nx = cx + dx, nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= SIZE || nz >= SIZE) continue;

      const diag = dx !== 0 && dz !== 0;
      const baseCost = diag ? 1.414 : 1;

      // diagonal must not clip corners (all 4 cells clear at the 2 adjacent
      // columns as well as the destination)
      if (diag) {
        if (!passable(world, cx + dx, cy, cz) || !passable(world, cx, cy, cz + dz)) continue;
      }

      let ny = -1;
      let cost = baseCost;

      // 1. flat walk
      if (canStand(world, nx, cy, nz)) {
        ny = cy;
      }
      // 2. step / jump up 1 block (need headroom above current position)
      if (ny < 0 && maxJump >= 1 && canStand(world, nx, cy + 1, nz) && !world.solid(cx, cy + 2, cz)) {
        ny = cy + 1;
        cost = baseCost + 0.9;
      }
      // 3. jump up 2 blocks (need 3 blocks clear above current feet)
      if (ny < 0 && maxJump >= 2 && canStand(world, nx, cy + 2, nz) &&
          !world.solid(cx, cy + 2, cz) && !world.solid(cx, cy + 3, cz) &&
          passable(world, nx, cy, nz)) {
        ny = cy + 2;
        cost = baseCost + 2.0;
      }
      // 4. walk off a ledge and fall
      if (ny < 0) {
        for (let d = 1; d <= maxFall; d++) {
          const fy = cy - d;
          if (fy < 1) break;
          // the drop shaft at the neighbor column must be open
          if (world.solid(nx, fy + 1, nz) || world.solid(nx, fy + 2, nz)) break;
          if (canStand(world, nx, fy, nz)) {
            ny = fy;
            cost = baseCost + d * 0.4;
            break;
          }
        }
      }
      // 5. bridge-over-gap: step across a 1-block gap at the same level
      //    (can be vital for crossing chasms or navigating architecture)
      if (ny < 0 && !diag) {
        const bx = cx + dx * 2, bz = cz + dz * 2;
        if (bx >= 0 && bz >= 0 && bx < SIZE && bz < SIZE &&
            passable(world, nx, cy, nz) &&         // gap column is clear
            canStand(world, bx, cy, bz)) {          // landing is solid
          // add an intermediate waypoint at the landing
          ny = cy;
          cost = baseCost * 2.2;
          // The actual path will route to the gap then again to the landing,
          // so we just treat the landing as the neighbor for A* purposes.
          const lKey = packKey(bx, cy, bz);
          const lng = cg + cost;
          const lp = gScore.get(lKey);
          if ((lp === undefined || lp > lng) && !closed.has(lKey)) {
            gScore.set(lKey, lng);
            cameFrom.set(lKey, cur);
            const lh = h(bx, cy, bz);
            if (lh < bestH) { bestH = lh; bestKey = lKey; }
            heap.push(lKey, lng + lh);
          }
          continue;   // skip normal neighbor insertion for this direction
        }
      }

      if (ny < 0) continue;

      const nKey = packKey(nx, ny, nz);
      if (closed.has(nKey)) continue;
      const ng = cg + cost;
      const prev = gScore.get(nKey);
      if (prev !== undefined && prev <= ng) continue;

      gScore.set(nKey, ng);
      cameFrom.set(nKey, cur);

      const nh = h(nx, ny, nz);
      if (nh < bestH) { bestH = nh; bestKey = nKey; }
      heap.push(nKey, ng + nh);
    }
  }

  // reconstruct
  let k = bestKey;
  const rev: number[] = [];
  let guard = 0;
  while (k !== startKey && guard++ < 600) {
    rev.push(k);
    const p = cameFrom.get(k);
    if (p === undefined) break;
    k = p;
  }
  for (let i = rev.length - 1; i >= 0; i--) {
    const key = rev[i];
    const x = key % SIZE;
    const z = ((key - x) / SIZE) % SIZE;
    const y = Math.floor(key / LAYER);
    out.push(new THREE.Vector3(x + 0.5, y, z + 0.5));
  }

  return found;
}
