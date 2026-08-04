import * as THREE from 'three';
import type { EnemyPlayer, EnemyDeps, EnemyConfig } from './enemyTypes';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

export function checkEnemyLos(
  pos: THREE.Vector3,
  player: EnemyPlayer,
  world: any
): boolean {
  const eye = tmpV2.copy(pos).add(tmpV3.set(0, 1.6, 0));
  for (const tgtY of [1.6, 1.1, 0.2]) {
    const dir = tmpV3.copy(player.pos).add(tmpV.set(0, tgtY, 0)).sub(eye);
    const d = dir.length();
    dir.divideScalar(d || 1);
    const hit = world.raycast(eye, dir, d);
    if (!hit || hit.dist > d - 0.3) return true;
  }
  return false;
}

export function fireEnemyShot(
  enemy: {
    cfg: EnemyConfig;
    muzzle: THREE.Object3D;
    deps: EnemyDeps;
    recoilT: number;
    weaponKick: number;
  },
  player: EnemyPlayer,
  dist: number
): void {
  enemy.recoilT = 0.06;
  enemy.weaponKick = 1;
  const muzzle = enemy.muzzle.getWorldPosition(new THREE.Vector3());
  const target = player.pos.clone().add(tmpV.set(0, 1.0, 0));
  const dir = target.sub(muzzle).normalize();
  const spread = (1 - enemy.cfg.accuracy) * 0.09;
  dir.x += (Math.random() - 0.5) * spread;
  dir.y += (Math.random() - 0.5) * spread;
  dir.z += (Math.random() - 0.5) * spread;
  dir.normalize();

  enemy.deps.effects.muzzleFlash(muzzle, 0.45);
  enemy.deps.audio.shot({ freq: 1700, dur: 0.07, gain: 0.26 * THREE.MathUtils.clamp(1 - dist / 150, 0.15, 1), sub: 260 });

  const toP = player.pos.clone().add(tmpV.set(0, 0.95, 0)).sub(muzzle);
  const t = toP.dot(dir);
  let hitPlayer = false;
  if (t > 0) {
    const closest = muzzle.clone().addScaledVector(dir, t);
    if (closest.distanceTo(player.pos.clone().add(tmpV.set(0, 0.95, 0))) < 0.55) {
      const worldHit = enemy.deps.world.raycast(muzzle, dir, t);
      if (!worldHit || worldHit.dist > t - 0.1) hitPlayer = true;
    }
  }
  const end = muzzle.clone().addScaledVector(dir, 200);
  if (hitPlayer) {
    enemy.deps.effects.tracer(muzzle, player.pos.clone().add(tmpV.set(0, 1.0, 0)));
    enemy.deps.onPlayerHit(enemy.cfg.damage, muzzle);
  } else {
    const worldHit = enemy.deps.world.raycast(muzzle, dir, 200);
    const endPoint = worldHit ? worldHit.point : end;
    enemy.deps.effects.tracer(muzzle, endPoint);
    if (worldHit) enemy.deps.effects.impact(worldHit.point, worldHit.normal, worldHit.block, worldHit);
  }
}

