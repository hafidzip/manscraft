import * as THREE from 'three';
import { isWaterId } from '../../../world/blocks';

export function moveEnemyAxis(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  halfW: number,
  height: number,
  axis: 0 | 2,
  delta: number,
  world: any
): void {
  if (delta === 0) return;

  // Water entry barrier: enemies treat water columns as impassable walls so
  // chasing the player into the ocean / across a river stops at the shore.
  // The check runs at foot level against every voxel the enemy AABB would
  // overlap at the destination, matching the resolution of the solid-block
  // collision below. If the enemy is already submerged (edge case: spawned
  // or pushed into water) we let it move so it can walk back out onto dry
  // land; otherwise any destination voxel that holds water cancels this
  // axis of motion.
  const hw = halfW;
  const targetX = axis === 0 ? pos.x + delta : pos.x;
  const targetZ = axis === 2 ? pos.z + delta : pos.z;
  const footY = Math.floor(pos.y);
  const curFootId = world.get(Math.floor(pos.x), footY, Math.floor(pos.z));
  if (!isWaterId(curFootId)) {
    const minX = Math.floor(targetX - hw), maxX = Math.floor(targetX + hw);
    const minZ = Math.floor(targetZ - hw), maxZ = Math.floor(targetZ + hw);
    for (let x = minX; x <= maxX; x++) {
      for (let z = minZ; z <= maxZ; z++) {
        if (isWaterId(world.get(x, footY, z))) {
          if (axis === 0) vel.x = 0; else vel.z = 0;
          return;
        }
      }
    }
  }

  if (axis === 0) pos.x += delta; else pos.z += delta;
  const h = height;
  const minX = Math.floor(pos.x - hw), maxX = Math.floor(pos.x + hw);
  const minY = Math.floor(pos.y), maxY = Math.floor(pos.y + h - 0.001);
  const minZ = Math.floor(pos.z - hw), maxZ = Math.floor(pos.z + hw);
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
    if (!world.solid(x, y, z)) continue;
    if (axis === 0) {
      if (delta > 0) pos.x = x - hw - 0.001; else pos.x = x + 1 + hw + 0.001;
      vel.x = 0;
    } else {
      if (delta > 0) pos.z = z - hw - 0.001; else pos.z = z + 1 + hw + 0.001;
      vel.z = 0;
    }
  }
}

export function moveEnemyAxisY(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  halfW: number,
  height: number,
  delta: number,
  grounded: { v: boolean },
  world: any
): void {
  if (delta === 0) return;
  pos.y += delta;
  const hw = halfW, h = height;
  const minX = Math.floor(pos.x - hw), maxX = Math.floor(pos.x + hw);
  const minY = Math.floor(pos.y), maxY = Math.floor(pos.y + h - 0.001);
  const minZ = Math.floor(pos.z - hw), maxZ = Math.floor(pos.z + hw);
  for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
    if (!world.solid(x, y, z)) continue;
    if (delta > 0) { pos.y = y - h - 0.001; vel.y = 0; }
    else { pos.y = y + 1 + 0.001; vel.y = 0; grounded.v = true; }
  }
}

