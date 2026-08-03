import * as THREE from 'three';

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
  if (axis === 0) pos.x += delta; else pos.z += delta;
  const hw = halfW, h = height;
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

