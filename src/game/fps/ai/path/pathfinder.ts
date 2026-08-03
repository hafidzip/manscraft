// A* pathfinding for humanoid agents through voxel world.
import * as THREE from 'three';
import { type WorldLike } from '../../World';
import {
  SIZE, HEIGHT, LAYER, packKey,
  heap, gScore, cameFrom, closed,
  PathOptions, canStand, passable, snapToGround, NEIGHBORS,
} from './pathfinderCore';

export type { PathOptions };
export { canStand, snapToGround };

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

  heap.clear(); gScore.clear(); cameFrom.clear(); closed.clear();

  const h = (x: number, y: number, z: number) => {
    const dx = Math.abs(x - gx), dz = Math.abs(z - gz);
    const hi = Math.max(dx, dz), lo = Math.min(dx, dz);
    return (hi - lo) + 1.414 * lo + Math.abs(y - goalY) * 1.3;
  };

  gScore.set(startKey, 0); heap.push(startKey, h(sx, startY, sz));
  let bestKey = startKey, bestH = h(sx, startY, sz), found = false, expanded = 0;

  while (heap.size > 0 && expanded < maxNodes) {
    const cur = heap.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cx = cur % SIZE, cz = ((cur - cx) / SIZE) % SIZE, cy = Math.floor(cur / LAYER);
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
      if (diag && (!passable(world, cx + dx, cy, cz) || !passable(world, cx, cy, cz + dz))) continue;

      let ny = -1, cost = baseCost;
      if (canStand(world, nx, cy, nz)) { ny = cy; }
      if (ny < 0 && maxJump >= 1 && canStand(world, nx, cy + 1, nz) && !world.solid(cx, cy + 2, cz)) { ny = cy + 1; cost = baseCost + 0.9; }
      if (ny < 0 && maxJump >= 2 && canStand(world, nx, cy + 2, nz) && !world.solid(cx, cy + 2, cz) && !world.solid(cx, cy + 3, cz) && passable(world, nx, cy, nz)) { ny = cy + 2; cost = baseCost + 2.0; }
      if (ny < 0) {
        for (let d = 1; d <= maxFall; d++) {
          const fy = cy - d; if (fy < 1) break;
          if (world.solid(nx, fy + 1, nz) || world.solid(nx, fy + 2, nz)) break;
          if (canStand(world, nx, fy, nz)) { ny = fy; cost = baseCost + d * 0.4; break; }
        }
      }
      if (ny < 0 && !diag) {
        const bx = cx + dx * 2, bz = cz + dz * 2;
        if (bx >= 0 && bz >= 0 && bx < SIZE && bz < SIZE && passable(world, nx, cy, nz) && canStand(world, bx, cy, bz)) {
          ny = cy; cost = baseCost * 2.2;
          const lKey = packKey(bx, cy, bz), lng = cg + cost, lp = gScore.get(lKey);
          if ((lp === undefined || lp > lng) && !closed.has(lKey)) {
            gScore.set(lKey, lng); cameFrom.set(lKey, cur);
            const lh = h(bx, cy, bz); if (lh < bestH) { bestH = lh; bestKey = lKey; }
            heap.push(lKey, lng + lh);
          }
          continue;
        }
      }
      if (ny < 0) continue;
      const nKey = packKey(nx, ny, nz);
      if (closed.has(nKey)) continue;
      const ng = cg + cost, prev = gScore.get(nKey);
      if (prev !== undefined && prev <= ng) continue;
      gScore.set(nKey, ng); cameFrom.set(nKey, cur);
      const nh = h(nx, ny, nz); if (nh < bestH) { bestH = nh; bestKey = nKey; }
      heap.push(nKey, ng + nh);
    }
  }

  let k = bestKey; const rev: number[] = []; let guard = 0;
  while (k !== startKey && guard++ < 600) {
    rev.push(k); const p = cameFrom.get(k); if (p === undefined) break; k = p;
  }
  for (let i = rev.length - 1; i >= 0; i--) {
    const key = rev[i], x = key % SIZE, z = ((key - x) / SIZE) % SIZE, y = Math.floor(key / LAYER);
    out.push(new THREE.Vector3(x + 0.5, y, z + 0.5));
  }
  return found;
}

