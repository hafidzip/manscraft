import * as THREE from 'three';
import { isTurret } from '../world/blocks';
import { wrapBlock, minImageF } from '../core/constants';
import { MK_TURRET, type MachineRecord } from '../world/machineRegistry';
import type { MachineAgent, MachineView } from './machineScheduler';

type WorldView = { get(x: number, y: number, z: number): number };

export interface TurretTarget {
  pos: THREE.Vector3;
  alive: boolean;
  cfg: { peaceful?: boolean };
}

export interface TurretHooks {
  targets(): TurretTarget[];
  damage(target: TurretTarget, amount: number, point: THREE.Vector3): void;
  muzzle(pos: THREE.Vector3): void;
  tracer(from: THREE.Vector3, to: THREE.Vector3): void;
  impact(point: THREE.Vector3, normal: THREE.Vector3, blockId: number): void;
  shot(dist: number): void;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number):
    { point: THREE.Vector3; normal: THREE.Vector3; block: number; dist: number } | null;
}

const bodyMat = new THREE.MeshLambertMaterial({ color: 0x4a4e56 });
const steelMat = new THREE.MeshLambertMaterial({ color: 0x8c939c });
const darkMat = new THREE.MeshLambertMaterial({ color: 0x24272c });
const trimMat = new THREE.MeshLambertMaterial({ color: 0xffcc44 });

function boxMesh(mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return new THREE.Mesh(g, mat);
}

interface Gun {
  wx: number; y: number; wz: number;
  group: THREE.Group;
  yaw: THREE.Group;
  pitch: THREE.Group;
  tip: THREE.Object3D;
  target: TurretTarget | null;
  curYaw: number;
  curPitch: number;
  cooldown: number;
  burstLeft: number;
  burstTimer: number;
  scanCd: number;
  recoil: number;
  idleSweep: number;
}

const SCAN_RADIUS = 26;
const PRUNE_RADIUS = 42;
const MAX_GUNS = 12;

const RANGE = 22;
const DAMAGE = 9;
const BURST = 3;
const BURST_DELAY = 0.1;
const COOLDOWN = 1.05;
const AIM_TOLERANCE = 0.16;
const SPREAD = 0.02;

const tmpTip = new THREE.Vector3();
const tmpAim = new THREE.Vector3();
const tmpDir = new THREE.Vector3();
const tmpHit = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpVis = new THREE.Vector3();

export class TurretManager implements MachineAgent {
  readonly kind = MK_TURRET;
  readonly maxLive = MAX_GUNS;
  readonly scanRadius = SCAN_RADIUS;
  readonly pruneRadius = PRUNE_RADIUS;
  readonly yLo = -4;
  readonly yHi = 4;
  readonly thinkPerFrame = 0;
  private guns = new Map<string | number, Gun>();
  private scanT = 0;
  private pruneT = 0;

  constructor(
    private scene: THREE.Scene,
    private world: WorldView,
    private hooks: TurretHooks,
  ) { }

  private buildGun(wx: number, y: number, wz: number): Gun {
    const group = new THREE.Group();
    const yaw = new THREE.Group();
    const pitch = new THREE.Group();
    const tip = new THREE.Object3D();

    group.add(boxMesh(darkMat, 0, 0.04, 0, 0.5, 0.08, 0.5));
    group.add(boxMesh(bodyMat, 0, 0.14, 0, 0.34, 0.14, 0.34));
    group.add(boxMesh(trimMat, 0, 0.22, 0, 0.2, 0.04, 0.2));

    yaw.position.set(0, 0.28, 0);
    yaw.add(pitch);
    group.add(yaw);

    pitch.add(boxMesh(bodyMat, 0, 0.02, 0, 0.26, 0.2, 0.3));
    pitch.add(boxMesh(steelMat, 0, 0.14, 0, 0.18, 0.08, 0.22));
    pitch.add(boxMesh(darkMat, 0, 0.02, 0.19, 0.14, 0.14, 0.08));
    pitch.add(boxMesh(darkMat, 0, 0.02, -0.19, 0.14, 0.14, 0.08));
    pitch.add(boxMesh(steelMat, 0.26, 0.02, 0, 0.34, 0.09, 0.09));
    pitch.add(boxMesh(darkMat, 0.46, 0.02, 0, 0.1, 0.07, 0.07));
    pitch.add(boxMesh(trimMat, 0.12, 0.02, 0, 0.06, 0.11, 0.11));

    tip.position.set(0.54, 0.02, 0);
    pitch.add(tip);

    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    this.scene.add(group);

    return {
      wx, y, wz,
      group, yaw, pitch, tip,
      target: null,
      curYaw: 0, curPitch: 0,
      cooldown: 0, burstLeft: 0, burstTimer: 0,
      scanCd: 0, recoil: 0,
      idleSweep: Math.random() * Math.PI * 2,
    };
  }

  private destroyGun(g: Gun): void {
    this.scene.remove(g.group);
  }

  has(key: number): boolean { return this.guns.has(key); }
  create(rec: MachineRecord): void {
    if (this.guns.has(rec.key)) return;
    const g = this.buildGun(rec.x, rec.y, rec.z);
    g.group.visible = false;
    this.guns.set(rec.key, g);
  }
  destroy(key: number): void {
    const g = this.guns.get(key);
    if (!g) return;
    this.destroyGun(g);
    this.guns.delete(key);
  }
  setActive(key: number, active: boolean): void {
    const g = this.guns.get(key);
    if (g) g.group.visible = active;
  }
  tick(rec: MachineRecord, view: MachineView, dt: number): void {
    const g = this.guns.get(rec.key);
    if (g) this.tickGun(g, view.ix, view.iz, dt);
  }

  private scan(px: number, py: number, pz: number): void {
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    for (let y = cy - 4; y <= cy + 4; y++) {
      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
          if (dx * dx + dz * dz > SCAN_RADIUS * SCAN_RADIUS) continue;
          const wx = wrapBlock(cx + dx);
          const wz = wrapBlock(cz + dz);
          const id = this.world.get(wx, y, wz);
          if (id < 0 || !isTurret(id)) continue;
          const key = `${wx},${y},${wz}`;
          if (!this.guns.has(key)) this.guns.set(key, this.buildGun(wx, y, wz));
        }
      }
    }
  }

  private eyeOf(g: Gun, ix: number, iz: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(ix + 0.5, g.y + 0.3, iz + 0.5);
  }

  private acquire(g: Gun, ix: number, iz: number): void {
    const eye = this.eyeOf(g, ix, iz, tmpEye);
    let best: TurretTarget | null = null;
    let bestD = RANGE;

    for (const t of this.hooks.targets()) {
      if (!t.alive || t.cfg.peaceful) continue;
      const ex = ix + 0.5 + minImageF(t.pos.x - (ix + 0.5));
      const ez = iz + 0.5 + minImageF(t.pos.z - (iz + 0.5));
      const cx = ex - eye.x;
      const cy = t.pos.y + 1.0 - eye.y;
      const cz = ez - eye.z;
      const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (d > bestD) continue;

      tmpDir.set(cx, cy, cz).divideScalar(d || 1);
      const hit = this.hooks.raycast(eye, tmpDir, d);
      if (hit && hit.dist < d - 0.4) continue;

      bestD = d;
      best = t;
    }
    g.target = best;
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;

    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.5; this.scan(px, py, pz); }

    this.pruneT -= dt * this.guns.size;
    const pruneNow = this.pruneT <= 0;
    if (pruneNow) this.pruneT = this.guns.size;

    let live = 0;
    for (const [key, g] of this.guns) {
      const ix = px + minImageF(g.wx - px);
      const iz = pz + minImageF(g.wz - pz);
      const id = this.world.get(g.wx, g.y, g.wz);

      if (id >= 0 && !isTurret(id)) {
        this.destroyGun(g);
        this.guns.delete(key);
        continue;
      }
      if (id < 0 && pruneNow && Math.hypot(ix - px, iz - pz) > PRUNE_RADIUS) {
        this.destroyGun(g);
        this.guns.delete(key);
        continue;
      }

      const far = id < 0 || Math.hypot(ix - px, iz - pz) > SCAN_RADIUS || live >= MAX_GUNS;
      if (far) { g.group.visible = false; continue; }
      live++;
      g.group.visible = true;

      this.tickGun(g, ix, iz, dt);
    }
  }

  private tickGun(g: Gun, ix: number, iz: number, dt: number): void {
    g.group.position.set(ix + 0.5, g.y, iz + 0.5);

    g.cooldown -= dt;
    g.recoil = Math.max(0, g.recoil - dt * 8);

    if (g.target && !g.target.alive) { g.target = null; g.burstLeft = 0; }

    g.scanCd -= dt;
    if (g.scanCd <= 0) {
      g.scanCd = 0.18;
      this.acquire(g, ix, iz);
    }

    const eye = this.eyeOf(g, ix, iz, tmpEye);

    if (g.target) {
      const t = g.target;
      const ex = ix + 0.5 + minImageF(t.pos.x - (ix + 0.5));
      const ez = iz + 0.5 + minImageF(t.pos.z - (iz + 0.5));
      const aimX = ex - eye.x;
      const aimY = t.pos.y + 1.0 - eye.y;
      const aimZ = ez - eye.z;
      const horiz = Math.hypot(aimX, aimZ);
      const dist = Math.hypot(aimX, aimY, aimZ);

      const yawWant = Math.atan2(-aimZ, aimX);
      const pitchWant = Math.atan2(aimY, Math.max(0.05, horiz));
      let dYaw = yawWant - g.curYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      g.curYaw += dYaw * Math.min(1, 9 * dt);
      g.curPitch += (pitchWant - g.curPitch) * Math.min(1, 9 * dt);

      const aimed = Math.abs(dYaw) < AIM_TOLERANCE;

      if (g.burstLeft > 0) {
        g.burstTimer -= dt;
        if (g.burstTimer <= 0 && aimed) {
          this.fire(g, ix, iz, t, dist);
          g.burstLeft--;
          g.burstTimer = BURST_DELAY;
        }
      } else if (g.cooldown <= 0 && aimed) {
        g.burstLeft = BURST;
        g.burstTimer = 0;
        g.cooldown = COOLDOWN;
      }
    } else {
      g.idleSweep += dt * 0.55;
      g.curYaw = g.idleSweep;
      g.curPitch += (-0.03 - g.curPitch) * Math.min(1, 3 * dt);
      g.burstLeft = 0;
    }

    g.yaw.rotation.y = g.curYaw;
    g.pitch.rotation.z = g.curPitch;
    g.pitch.position.x = -g.recoil * 0.06;
  }

  private fire(g: Gun, ix: number, iz: number, target: TurretTarget, dist: number): void {
    g.recoil = 1;

    g.tip.getWorldPosition(tmpTip);

    const ex = ix + 0.5 + minImageF(target.pos.x - (ix + 0.5));
    const ez = iz + 0.5 + minImageF(target.pos.z - (iz + 0.5));
    tmpAim.set(ex, target.pos.y + 1.0, ez);
    tmpDir.copy(tmpAim).sub(tmpTip).normalize();
    tmpDir.x += (Math.random() - 0.5) * SPREAD;
    tmpDir.y += (Math.random() - 0.5) * SPREAD;
    tmpDir.z += (Math.random() - 0.5) * SPREAD;
    tmpDir.normalize();

    this.hooks.muzzle(tmpTip.clone());
    this.hooks.shot(dist);

    const toT = tmpVis.copy(tmpAim).sub(tmpTip);
    const along = toT.dot(tmpDir);
    let hitTarget = false;
    if (along > 0) {
      tmpHit.copy(tmpTip).addScaledVector(tmpDir, along);
      if (tmpHit.distanceTo(tmpAim) < 0.6) {
        const blocked = this.hooks.raycast(tmpTip, tmpDir, along);
        if (!blocked || blocked.dist > along - 0.2) hitTarget = true;
      }
    }

    if (hitTarget) {
      this.hooks.tracer(tmpTip.clone(), tmpAim.clone());
      this.hooks.damage(target, DAMAGE, tmpAim.clone());
    } else {
      const worldHit = this.hooks.raycast(tmpTip, tmpDir, RANGE * 1.5);
      const end = worldHit
        ? worldHit.point.clone()
        : tmpTip.clone().addScaledVector(tmpDir, RANGE * 1.5);
      this.hooks.tracer(tmpTip.clone(), end);
      if (worldHit) this.hooks.impact(worldHit.point.clone(), worldHit.normal, worldHit.block);
    }
  }

  clear(): void {
    for (const g of this.guns.values()) this.destroyGun(g);
    this.guns.clear();
  }
}
