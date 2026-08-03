/**
 * Voxel raycast (Amanatides & Woo DDA) — finds the first solid block hit
 * by a ray and the face normal of entry (used for mining / placing).
 */

import { B, DEFS, isWaterId } from '../world/blocks';
import type { World } from '../world/world';

export interface RayHit {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  id: number;
  dist: number;
}

export interface RaycastOptions {
  /**
   * Skip non-colliding decoration blocks (flowers, tall grass…).
   *
   * Mining/placement wants them (you must be able to target a flower), but
   * projectiles and line-of-sight have to fly straight through: a poppy is
   * not cover.
   */
  ignoreNonSolid?: boolean;
}

export function raycastVoxel(
  world: World,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  opts?: RaycastOptions
): RayHit | null {
  const ignoreNonSolid = opts?.ignoreNonSolid === true;
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * tDeltaX : Infinity;
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * tDeltaY : Infinity;
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * tDeltaZ : Infinity;

  let nx = 0, ny = 0, nz = 0, t = 0;

  for (let i = 0; i < 256; i++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX; t = tMaxX; tMaxX += tDeltaX;
      nx = -stepX; ny = 0; nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY; t = tMaxY; tMaxY += tDeltaY;
      ny = -stepY; nx = 0; nz = 0;
    } else {
      z += stepZ; t = tMaxZ; tMaxZ += tDeltaZ;
      nz = -stepZ; nx = 0; ny = 0;
    }
    if (t > maxDist) return null;

    const id = world.getBlockRaw(x, y, z);
    if (id === -1) return null;
    if (id === B.AIR || isWaterId(id)) continue;
    const def = DEFS[id];
    const blocks = ignoreNonSolid ? def.solid : def.solid || def.cross === true;
    if (blocks) {
      return { x, y, z, nx, ny, nz, id, dist: t };
    }
  }
  return null;
}
