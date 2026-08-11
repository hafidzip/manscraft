import * as THREE from 'three';
import { inserterDir, isInserter } from '../world/blocks';
import { wrapBlock, minImageF } from '../core/constants';
import { getAtlas, blockCubeGeometry } from './textures';
import type { ItemDropManager } from './ItemDrop';
import type { AudioSynth } from './audio';
import { MK_INSERTER, type MachineRecord } from '../world/machineRegistry';
import type { MachineAgent, MachineView } from './machineScheduler';

type WorldView = { get(x: number, y: number, z: number): number };

export interface InserterAutomation {
  tryInsert(x: number, y: number, z: number, itemId: number): boolean;
  emitAbove(x: number, y: number, z: number, itemId: number, count?: number): void;
  isMachine(x: number, y: number, z: number): boolean;
}

const pillarGeo = new THREE.BoxGeometry(0.15, 0.5, 0.15);
pillarGeo.translate(0, 0.25, 0);
const capGeo = new THREE.BoxGeometry(0.2, 0.1, 0.2);
capGeo.translate(0, 0.5, 0);
const beamGeo = new THREE.BoxGeometry(0.95, 0.09, 0.13);
beamGeo.translate(0.46, 0, 0);
const accentGeo = new THREE.BoxGeometry(0.26, 0.11, 0.15);
accentGeo.translate(0.3, 0, 0);
const rodGeo = new THREE.BoxGeometry(0.08, 0.36, 0.08);
rodGeo.translate(0.9, -0.14, 0);
const clawGeo = new THREE.BoxGeometry(0.2, 0.1, 0.2);
clawGeo.translate(0.9, -0.36, 0);

const darkMat = new THREE.MeshLambertMaterial({ color: 0x3c3c46 });
const steelMat = new THREE.MeshLambertMaterial({ color: 0x6e6e78 });
const clawMat = new THREE.MeshLambertMaterial({ color: 0xdc8c1e });

interface Arm {
  wx: number;
  y: number;
  wz: number;
  lastId: number;
  group: THREE.Group;
  swing: THREE.Group;
  tilt: THREE.Group;
  itemCube: THREE.Mesh | null;
  heldId: number;
  swingAngle: number;
  tiltAngle: number;
  state: 'idle' | 'dip' | 'carry' | 'release' | 'return';
  t: number;
}

const DIP_T = 0.14;
const CARRY_T = 0.46;
const RELEASE_T = 0.12;
const RETURN_T = 0.46;

const SCAN_RADIUS = 26;
const PRUNE_RADIUS = 42;
const MAX_ARMS = 24;

const smoothstep = (t: number) => t * t * (3 - 2 * t);

export class InserterManager implements MachineAgent {
  readonly kind = MK_INSERTER;
  readonly maxLive = MAX_ARMS;
  readonly scanRadius = SCAN_RADIUS;
  readonly pruneRadius = PRUNE_RADIUS;
  readonly yLo = -2;
  readonly yHi = 3;
  readonly thinkPerFrame = 0;
  private arms = new Map<string | number, Arm>();
  private scanT = 0;
  private pruneT = 0;
  private cubeGeoCache = new Map<number, THREE.BufferGeometry>();
  private cubeMat: THREE.MeshLambertMaterial | null = null;
  private readonly heldSize = 0.2;

  constructor(
    private scene: THREE.Scene,
    private world: WorldView,
    private drops: ItemDropManager,
    private audio: AudioSynth,
    private automation: InserterAutomation | null = null,
  ) {}

  setAutomation(automation: InserterAutomation | null): void {
    this.automation = automation;
  }

  private cubeGeo(blockId: number): THREE.BufferGeometry {
    let g = this.cubeGeoCache.get(blockId);
    if (!g) {
      g = blockCubeGeometry(blockId, this.heldSize);
      this.cubeGeoCache.set(blockId, g);
    }
    return g;
  }

  private getCubeMat(): THREE.MeshLambertMaterial {
    if (!this.cubeMat) this.cubeMat = new THREE.MeshLambertMaterial({ map: getAtlas() });
    return this.cubeMat;
  }

  private static angleFor(dx: number, dz: number): number {
    return Math.atan2(-dz, dx);
  }

  private buildArm(wx: number, y: number, wz: number, id: number): Arm {
    const group = new THREE.Group();
    const swing = new THREE.Group();
    const tilt = new THREE.Group();
    swing.position.y = 0.62;
    swing.add(tilt);

    const pillar = new THREE.Mesh(pillarGeo, darkMat);
    const cap = new THREE.Mesh(capGeo, steelMat);
    const beam = new THREE.Mesh(beamGeo, steelMat);
    const accent = new THREE.Mesh(accentGeo, clawMat);
    const rod = new THREE.Mesh(rodGeo, darkMat);
    const claw = new THREE.Mesh(clawGeo, clawMat);
    group.add(pillar, cap, swing);
    tilt.add(beam, accent, rod, claw);
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    this.scene.add(group);

    const dir = inserterDir(id)!;
    return {
      wx, y, wz, lastId: id,
      group, swing, tilt,
      itemCube: null, heldId: 0,
      swingAngle: InserterManager.angleFor(-dir[0], -dir[1]),
      tiltAngle: -0.12,
      state: 'idle', t: 0,
    };
  }

  private destroyArm(arm: Arm): void {
    if (arm.itemCube) arm.tilt.remove(arm.itemCube);
    this.scene.remove(arm.group);
  }

  has(key: number): boolean { return this.arms.has(key); }
  create(rec: MachineRecord): void {
    if (this.arms.has(rec.key)) return;
    const arm = this.buildArm(rec.x, rec.y, rec.z, rec.id);
    arm.group.visible = false;
    this.arms.set(rec.key, arm);
  }
  destroy(key: number): void {
    const arm = this.arms.get(key);
    if (!arm) return;
    this.destroyArm(arm);
    this.arms.delete(key);
  }
  setActive(key: number, active: boolean): void {
    const arm = this.arms.get(key);
    if (arm) arm.group.visible = active;
  }
  onIdChanged(rec: MachineRecord): void {
    const arm = this.arms.get(rec.key);
    if (arm) arm.lastId = rec.id;
  }
  tick(rec: MachineRecord, view: MachineView, dt: number): void {
    const arm = this.arms.get(rec.key);
    if (arm) this.tickArm(arm, rec.id, view.ix, view.iz, dt);
  }
  retain(key: number): boolean {
    const arm = this.arms.get(key);
    return !!arm && arm.state !== 'idle';
  }

  private scan(px: number, py: number, pz: number): void {
    const cx = Math.floor(px);
    const cy = Math.floor(py);
    const cz = Math.floor(pz);
    for (let y = cy - 2; y <= cy + 3; y++) {
      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
          if (dx * dx + dz * dz > SCAN_RADIUS * SCAN_RADIUS) continue;
          const wx = wrapBlock(cx + dx);
          const wz = wrapBlock(cz + dz);
          const id = this.world.get(wx, y, wz);
          if (id < 0 || !isInserter(id)) continue;
          const key = `${wx},${y},${wz}`;
          if (!this.arms.has(key)) this.arms.set(key, this.buildArm(wx, y, wz, id));
        }
      }
    }
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const px = playerPos.x;
    const py = playerPos.y;
    const pz = playerPos.z;

    this.scanT -= dt;
    if (this.scanT <= 0) {
      this.scanT = 0.5;
      this.scan(px, py, pz);
    }

    this.pruneT -= dt * this.arms.size;
    const pruneNow = this.pruneT <= 0;
    if (pruneNow) this.pruneT = this.arms.size;

    let live = 0;
    for (const [key, arm] of this.arms) {
      const ix = px + minImageF(arm.wx - px);
      const iz = pz + minImageF(arm.wz - pz);
      const id = this.world.get(arm.wx, arm.y, arm.wz);

      if (id >= 0 && !isInserter(id)) {
        this.destroyArm(arm);
        this.arms.delete(key);
        continue;
      }
      if (id < 0 && pruneNow && Math.hypot(ix - px, iz - pz) > PRUNE_RADIUS) {
        this.destroyArm(arm);
        this.arms.delete(key);
        continue;
      }

      const far = id < 0 || Math.hypot(ix - px, iz - pz) > SCAN_RADIUS || live >= MAX_ARMS;
      if (far) {
        arm.group.visible = false;
        continue;
      }
      live++;
      arm.group.visible = true;

      if (id >= 0 && id !== arm.lastId) {
        arm.lastId = id;
        arm.state = 'idle';
        arm.t = 0;
        const dir = inserterDir(id);
        if (dir) arm.swingAngle = InserterManager.angleFor(-dir[0], -dir[1]);
        if (arm.itemCube) {
          const d = dir ?? [0, 0];
          this.drops.spawn(arm.heldId, new THREE.Vector3(ix + 0.5 - d[0], arm.y + 1.15, iz + 0.5 - d[1]),
            new THREE.Vector3(0, -1, 0));
          arm.tilt.remove(arm.itemCube);
          arm.itemCube = null;
        }
      }

      this.tickArm(arm, id < 0 ? arm.lastId : id, ix, iz, dt);
    }
  }

  private tickArm(arm: Arm, id: number, ix: number, iz: number, dt: number): void {
    const dir = inserterDir(id) ?? [0, 0];
    const rest = InserterManager.angleFor(-dir[0], -dir[1]);
    const g = arm.group;
    g.position.set(ix + 0.5, arm.y, iz + 0.5);

    arm.t += dt;
    let tiltTarget = -0.12;

    switch (arm.state) {
      case 'idle': {
        arm.swingAngle += (rest - arm.swingAngle) * Math.min(1, 14 * dt);
        tiltTarget = -0.18;
        if (arm.t > 0.12) {
          const taken = this.drops.takeAt(ix + 0.5 - dir[0], arm.y, iz + 0.5 - dir[1], 0.52);
          if (taken) {
            arm.heldId = taken.blockId;
            this.drops.recycle(taken);
            const cube = new THREE.Mesh(this.cubeGeo(arm.heldId), this.getCubeMat());
            cube.position.set(0.9, -0.5, 0);
            cube.castShadow = true;
            cube.frustumCulled = false;
            arm.tilt.add(cube);
            arm.itemCube = cube;
            arm.state = 'dip';
            arm.t = 0;
            this.audio.foley('snap');
          }
        }
        break;
      }

      case 'dip': {
        tiltTarget = -0.5;
        if (arm.t >= DIP_T) {
          arm.state = 'carry';
          arm.t = 0;
        }
        break;
      }

      case 'carry': {
        const k = Math.min(1, arm.t / CARRY_T);
        arm.swingAngle = rest + Math.PI * smoothstep(k);
        tiltTarget = k < 0.5 ? 0.22 : -0.28;
        if (arm.itemCube) arm.itemCube.rotation.y += dt * 5;
        if (k >= 1) {
          arm.swingAngle = rest + Math.PI;
          arm.state = 'release';
          arm.t = 0;
        }
        break;
      }

      case 'release': {
        tiltTarget = -0.4;
        if (arm.t >= RELEASE_T) {
          if (arm.itemCube) {
            const fx = wrapBlock(arm.wx + dir[0]);
            const fz = wrapBlock(arm.wz + dir[1]);
            const held = arm.heldId;
            let transferred = false;
            if (this.automation?.isMachine(fx, arm.y, fz)) {
              if (!this.automation.tryInsert(fx, arm.y, fz, held)) {
                this.automation.emitAbove(fx, arm.y, fz, held, 1);
              }
              transferred = true;
            }
            if (!transferred) {
              const hx = ix + 0.5 + dir[0] * 0.95;
              const hz = iz + 0.5 + dir[1] * 0.95;
              this.drops.spawn(held, new THREE.Vector3(hx, arm.y + 1.22, hz),
                new THREE.Vector3(dir[0] * 0.6, -1.2, dir[1] * 0.6));
            }
            arm.tilt.remove(arm.itemCube);
            arm.itemCube = null;
            arm.heldId = 0;
          }
          arm.state = 'return';
          arm.t = 0;
        }
        break;
      }

      case 'return': {
        const k = Math.min(1, arm.t / RETURN_T);
        arm.swingAngle = rest + Math.PI + Math.PI * smoothstep(k);
        tiltTarget = k < 0.5 ? 0.22 : -0.12;
        if (k >= 1) {
          arm.swingAngle = rest;
          arm.state = 'idle';
          arm.t = 0;
        }
        break;
      }
    }

    arm.tiltAngle += (tiltTarget - arm.tiltAngle) * Math.min(1, 16 * dt);
    arm.swing.rotation.y = arm.swingAngle;
    arm.tilt.rotation.z = arm.tiltAngle;
  }

  clear(): void {
    for (const arm of this.arms.values()) this.destroyArm(arm);
    this.arms.clear();
  }
}
