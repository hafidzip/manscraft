import * as THREE from 'three';
import { B, type WorldLike } from './World';
import { Inventory } from './Inventory';
import { AudioSynth } from './audio';
import { getAtlas, blockCubeGeometry } from './textures';
import { minImageF } from '../core/constants';
import { packCell } from '../core/cellKey';
import { DEFS } from '../world/blocks';
import { MK_CONVEYOR, MK_GHOST, dirXOf, dirZOf, kindOf } from '../world/machineRegistry';
import { ItemGrid } from './ItemGrid';
import { ItemInstancer } from './ItemInstancer';
import type { ChangeBus } from '../world/changeBus';

const POP_TIME = 0.28;
const PICKUP_DIST = 1.25;
const HALF = 0.13;
const GRAVITY = 20;
const BELT_SPEED = 2.6;
const BELT_CENTERING = 6;

const SLEEP_DIST = 24;
const SLEEP_DIST2 = SLEEP_DIST * SLEEP_DIST;
const SLEEP_VEL2 = 1e-4;
const WAKE_CHECKS_PER_FRAME = 32;
const MAX_ITEMS_DEFAULT = 512;
const EVICT_KEEP_DIST2 = 8 * 8;

export interface DroppedItem {
  mesh: THREE.Mesh | null;
  blockId: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  time: number;
  grounded: boolean;
  spin: number;
  cell: number;
  slot: number;
  index: number;
  awakeSlot: number;
  sleeping: boolean;
  inst: number;
  alive: boolean;
}

export interface ItemDropOptions {
  bus?: ChangeBus;
  instanced?: boolean;
  maxItems?: number;
  sleep?: boolean;
}

export class ItemDropManager {
  items: DroppedItem[] = [];
  readonly stats = {
    spawned: 0, despawned: 0, evicted: 0, live: 0, awake: 0, sleeping: 0,
    probes: 0, probeHits: 0, takeQueries: 0, takeHits: 0,
    pickups: 0, wakeChecks: 0, wakes: 0,
  };

  private grid = new ItemGrid();
  private awake: DroppedItem[] = [];
  private sleepers: DroppedItem[] = [];
  private recPool: DroppedItem[] = [];
  private meshPool: THREE.Mesh[] = [];
  private geoCache = new Map<number, THREE.BufferGeometry>();
  private mat: THREE.MeshLambertMaterial | null = null;

  private bus: ChangeBus | null = null;
  private instancer: ItemInstancer | null = null;
  private maxItems = MAX_ITEMS_DEFAULT;
  private sleepEnabled = true;
  private wakeCursor = 0;

  private pKey = -1;
  private pVal = false;
  private pEpoch = 0;

  private lastPx = 0;
  private lastPz = 0;

  constructor(
    private scene: THREE.Scene,
    private world: WorldLike,
    private inv: Inventory,
    private audio: AudioSynth,
    private onPickup?: (blockId: number) => void,
    opts: ItemDropOptions = {},
  ) {
    this.bus = opts.bus ?? null;
    this.maxItems = opts.maxItems ?? MAX_ITEMS_DEFAULT;
    this.sleepEnabled = opts.sleep ?? true;
    if (opts.instanced) {
      this.instancer = new ItemInstancer(
        this.scene,
        (id) => this.getGeometry(id),
        () => this.getMaterial(),
      );
    }
    this.bus?.add({ onBlock: () => { this.pKey = -1; } });
  }

  private getGeometry(blockId: number): THREE.BufferGeometry {
    let geo = this.geoCache.get(blockId);
    if (!geo) { geo = blockCubeGeometry(blockId, 0.22); this.geoCache.set(blockId, geo); }
    return geo;
  }

  private getMaterial(): THREE.MeshLambertMaterial {
    if (!this.mat) this.mat = new THREE.MeshLambertMaterial({ map: getAtlas() });
    return this.mat;
  }

  prewarm(blockIds: Iterable<number>, poolSize = 32): void {
    for (const id of blockIds) this.getGeometry(id);
    const mat = this.getMaterial();
    if (this.instancer) return;
    while (this.meshPool.length < poolSize) {
      const mesh = new THREE.Mesh(this.getGeometry(B.STONE), mat);
      mesh.visible = false;
      this.meshPool.push(mesh);
    }
  }

  spawn(blockId: number, pos: THREE.Vector3, velocity?: THREE.Vector3): void {
    if (blockId === B.AIR || blockId === B.BEDROCK) return;
    if (this.items.length >= this.maxItems) this.evictOne();

    const it = this.recPool.pop() ?? ({
      mesh: null, blockId: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      time: 0, grounded: false, spin: 0,
      cell: -1, slot: -1, index: -1, awakeSlot: -1,
      sleeping: false, inst: -1, alive: false,
    } as DroppedItem);

    it.blockId = blockId;
    it.pos.copy(pos);
    if (velocity) it.vel.copy(velocity);
    else it.vel.set((Math.random() - 0.5) * 2.6, 2.4 + Math.random() * 1.4, (Math.random() - 0.5) * 2.6);
    it.time = 0; it.grounded = false; it.spin = Math.random() * Math.PI * 2;
    it.sleeping = false; it.alive = true; it.inst = -1;

    if (this.instancer) {
      it.mesh = null;
      it.inst = this.instancer.acquire(it);
    } else {
      const mesh = this.meshPool.pop() ?? new THREE.Mesh(this.getGeometry(blockId), this.getMaterial());
      mesh.geometry = this.getGeometry(blockId);
      mesh.material = this.getMaterial();
      mesh.position.copy(it.pos);
      mesh.visible = true; mesh.castShadow = true; mesh.receiveShadow = false;
      this.scene.add(mesh);
      it.mesh = mesh;
    }

    it.index = this.items.length;
    this.items.push(it);
    this.grid.insert(it);
    this.pushAwake(it);
    this.stats.spawned++;
    this.stats.live = this.items.length;
  }

  private pushAwake(it: DroppedItem): void {
    it.sleeping = false;
    it.awakeSlot = this.awake.length;
    this.awake.push(it);
    this.stats.awake = this.awake.length;
  }

  private popList(list: DroppedItem[], it: DroppedItem): void {
    const last = list.pop()!;
    if (last !== it) { list[it.awakeSlot] = last; last.awakeSlot = it.awakeSlot; }
    it.awakeSlot = -1;
  }

  private sleep(it: DroppedItem): void {
    this.popList(this.awake, it);
    it.sleeping = true;
    it.awakeSlot = this.sleepers.length;
    this.sleepers.push(it);
    this.stats.sleeping = this.sleepers.length;
    this.stats.awake = this.awake.length;
  }

  private wake(it: DroppedItem): void {
    if (!it.sleeping || !it.alive) return;
    this.popList(this.sleepers, it);
    this.pushAwake(it);
    this.stats.wakes++;
    this.stats.sleeping = this.sleepers.length;
  }

  private unlink(it: DroppedItem): void {
    this.grid.remove(it);
    this.popList(it.sleeping ? this.sleepers : this.awake, it);
    const last = this.items.pop()!;
    if (last !== it) { this.items[it.index] = last; last.index = it.index; }
    it.index = -1;
    it.alive = false;
    if (this.instancer && it.inst >= 0) { this.instancer.release(it); it.inst = -1; }
    else if (it.mesh) {
      this.scene.remove(it.mesh);
      it.mesh.visible = false;
      this.meshPool.push(it.mesh);
      it.mesh = null;
    }
    this.stats.live = this.items.length;
    this.stats.awake = this.awake.length;
    this.stats.sleeping = this.sleepers.length;
  }

  recycle(it: DroppedItem): void {
    if (it.alive || it.index !== -1 || it.cell !== -1) return;
    if (this.recPool.length < 256) this.recPool.push(it);
  }

  private despawn(it: DroppedItem): void {
    this.unlink(it);
    this.recycle(it);
    this.stats.despawned++;
  }

  private evictOne(): void {
    let victim: DroppedItem | null = null;
    let bestD2 = -1;
    for (let i = 0; i < this.sleepers.length; i++) {
      const it = this.sleepers[i];
      const dx = minImageF(it.pos.x - this.lastPx);
      const dz = minImageF(it.pos.z - this.lastPz);
      const d2 = dx * dx + dz * dz;
      if (d2 > bestD2) { bestD2 = d2; victim = it; }
    }
    if (!victim) {
      let bestTime = -1;
      for (let i = 0; i < this.items.length; i++) {
        const it = this.items[i];
        const dx = minImageF(it.pos.x - this.lastPx);
        const dz = minImageF(it.pos.z - this.lastPz);
        if (dx * dx + dz * dz <= EVICT_KEEP_DIST2) continue;
        if (it.time > bestTime) { bestTime = it.time; victim = it; }
      }
    }
    if (!victim) {
      let bestTime = -1;
      for (let i = 0; i < this.items.length; i++) {
        if (this.items[i].time > bestTime) { bestTime = this.items[i].time; victim = this.items[i]; }
      }
    }
    if (victim) { this.despawn(victim); this.stats.evicted++; }
  }

  private probe(bx: number, by: number, bz: number): boolean {
    this.stats.probes++;
    const epoch = this.bus ? this.bus.version : 0;
    if (epoch !== this.pEpoch) { this.pEpoch = epoch; this.pKey = -1; }
    const key = packCell(bx, by, bz);
    if (key === this.pKey) { this.stats.probeHits++; return this.pVal; }
    const id = this.world.peekBlock(bx, by, bz);
    const blocked = id < 0 ? true : (DEFS[id].solid || (kindOf(id) & MK_GHOST) !== 0);
    this.pKey = key; this.pVal = blocked;
    return blocked;
  }

  private solidAt(x: number, y: number, z: number): boolean {
    const id = this.world.peekBlock(Math.floor(x), Math.floor(y), Math.floor(z));
    return id < 0 ? true : DEFS[id].solid;
  }

  private blocked(x: number, y: number, z: number): boolean {
    const x0 = Math.floor(x - HALF), x1 = Math.floor(x + HALF);
    const z0 = Math.floor(z - HALF), z1 = Math.floor(z + HALF);
    const y0 = Math.floor(y), y1 = Math.floor(y + HALF * 2);
    const nx = x1 !== x0 ? 2 : 1;
    const nz = z1 !== z0 ? 2 : 1;
    const ny = y1 !== y0 ? 2 : 1;
    for (let iy = 0; iy < ny; iy++) {
      const by = iy === 0 ? y0 : y1;
      for (let iz = 0; iz < nz; iz++) {
        const bz = iz === 0 ? z0 : z1;
        for (let ix = 0; ix < nx; ix++) {
          if (this.probe(ix === 0 ? x0 : x1, by, bz)) return true;
        }
      }
    }
    return false;
  }

  private takeX = 0; private takeY = 0; private takeZ = 0;
  private takeR2 = 0; private takeBest: DroppedItem | null = null;
  private takeBestD2 = 0;

  private takeVisit = (it: DroppedItem): void => {
    if (!it.grounded || it.time < POP_TIME) return;
    const dy = it.pos.y - this.takeY;
    if (dy > 0.6 || dy < -0.6) return;
    const dx = minImageF(it.pos.x - this.takeX);
    const dz = minImageF(it.pos.z - this.takeZ);
    const d2 = dx * dx + dz * dz;
    if (d2 > this.takeR2) return;
    if (this.takeBest !== null && d2 >= this.takeBestD2) return;
    this.takeBest = it;
    this.takeBestD2 = d2;
  };

  takeAt(x: number, y: number, z: number, radius = 0.55): DroppedItem | null {
    this.stats.takeQueries++;
    if (this.items.length === 0) return null;
    this.takeX = x; this.takeY = y; this.takeZ = z;
    this.takeR2 = radius * radius;
    this.takeBest = null; this.takeBestD2 = Infinity;
    this.grid.forEachBox(x - radius, y - 0.6, z - radius, x + radius, y + 0.6, z + radius, this.takeVisit);
    const it = this.takeBest;
    this.takeBest = null;
    if (it === null) return null;
    this.unlink(it);
    this.stats.takeHits++;
    return it;
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const step = Math.min(dt, 1 / 30);
    const px = playerPos.x, pz = playerPos.z;
    this.lastPx = px; this.lastPz = pz;

    for (let ai = this.awake.length - 1; ai >= 0; ai--) {
      const item = this.awake[ai];
      if (ai >= this.awake.length) continue;
      item.time += dt;
      const p = item.pos;

      item.vel.y -= GRAVITY * step;
      if (item.vel.y < -30) item.vel.y = -30;
      const ny = p.y + item.vel.y * step;
      if (item.vel.y < 0 && this.blocked(p.x, ny, p.z)) {
        p.y = Math.floor(ny) + 1; item.vel.y = 0; item.grounded = true;
      } else if (item.vel.y > 0 && this.blocked(p.x, ny + HALF * 2, p.z)) {
        item.vel.y = 0;
      } else {
        p.y = ny;
        if (!this.solidAt(p.x, p.y - 0.06, p.z)) item.grounded = false;
      }

      let onBelt = false;
      if (item.grounded) {
        const bx = Math.floor(p.x), by = Math.floor(p.y - 0.06), bz = Math.floor(p.z);
        const bid = this.world.peekBlock(bx, by, bz);
        if (bid >= 0 && (kindOf(bid) & MK_CONVEYOR) !== 0) {
          const dX = dirXOf(bid), dZ = dirZOf(bid);
          onBelt = true;
          const k = Math.min(1, 10 * step);
          item.vel.x += (dX * BELT_SPEED - item.vel.x) * k;
          item.vel.z += (dZ * BELT_SPEED - item.vel.z) * k;
          if (dX === 0) item.vel.x += (bx + 0.5 - p.x) * BELT_CENTERING * step;
          else item.vel.z += (bz + 0.5 - p.z) * BELT_CENTERING * step;
        }
      }

      const stuck = this.blocked(p.x, p.y, p.z);
      const nx = p.x + item.vel.x * step;
      if (!stuck && this.blocked(nx, p.y, p.z)) item.vel.x = 0;
      else p.x = nx;
      const nz = p.z + item.vel.z * step;
      if (!stuck && this.blocked(p.x, p.y, nz)) item.vel.z = 0;
      else p.z = nz;

      if (!onBelt) {
        const drag = item.grounded ? 9 : 1.2;
        const f = Math.max(0, 1 - drag * step);
        item.vel.x *= f; item.vel.z *= f;
      }

      item.spin += step * 2.4;
      const vy = p.y + 0.12 + Math.sin(item.time * 3 + item.spin) * 0.035;
      if (this.instancer) this.instancer.set(item, p.x, vy, p.z, item.spin);
      else if (item.mesh) { item.mesh.position.set(p.x, vy, p.z); item.mesh.rotation.y = item.spin; }

      this.grid.move(item);

      if (this.sleepEnabled && item.grounded && !onBelt && !stuck && item.time > POP_TIME) {
        const v2 = item.vel.x * item.vel.x + item.vel.z * item.vel.z + item.vel.y * item.vel.y;
        if (v2 < SLEEP_VEL2) {
          const dx = minImageF(p.x - px);
          const dz = minImageF(p.z - pz);
          if (dx * dx + dz * dz > SLEEP_DIST2) { this.sleep(item); continue; }
        }
      }
    }

    this.wakeSweep(px, pz);
    this.sweepPickup(playerPos);
    this.instancer?.flush();
  }

  private wakeSweep(px: number, pz: number): void {
    const n = this.sleepers.length;
    if (n === 0) return;
    const checks = Math.min(WAKE_CHECKS_PER_FRAME, n);
    for (let c = 0; c < checks; c++) {
      if (this.wakeCursor >= this.sleepers.length) this.wakeCursor = 0;
      const it = this.sleepers[this.wakeCursor];
      this.stats.wakeChecks++;
      const dx = minImageF(it.pos.x - px);
      const dz = minImageF(it.pos.z - pz);
      if (dx * dx + dz * dz < SLEEP_DIST2) this.wake(it);
      else this.wakeCursor++;
    }
  }

  private pickX = 0; private pickY = 0; private pickZ = 0;
  private pickBest: DroppedItem | null = null;
  private pickBestD2 = 0;

  private consumePickBest(): DroppedItem | null {
    const b = this.pickBest;
    this.pickBest = null;
    return b;
  }

  private pickVisit = (it: DroppedItem): void => {
    if (it.time < POP_TIME) return;
    const dy = this.pickY - it.pos.y;
    if (dy > 1.6 || dy < -1.6) return;
    const dx = minImageF(it.pos.x - this.pickX);
    const dz = minImageF(it.pos.z - this.pickZ);
    const d2 = dx * dx + dz * dz;
    if (d2 > PICKUP_DIST * PICKUP_DIST) return;
    if (this.pickBest !== null && d2 >= this.pickBestD2) return;
    this.pickBest = it;
    this.pickBestD2 = d2;
  };

  private sweepPickup(playerPos: THREE.Vector3): void {
    if (this.items.length === 0) return;
    this.pickX = playerPos.x; this.pickY = playerPos.y + 0.9; this.pickZ = playerPos.z;
    const r = PICKUP_DIST;
    for (let guard = 0; guard < 8; guard++) {
      this.pickBest = null; this.pickBestD2 = Infinity;
      this.grid.forEachBox(
        this.pickX - r, playerPos.y - 1.6, this.pickZ - r,
        this.pickX + r, playerPos.y + 1.6, this.pickZ + r,
        this.pickVisit,
      );
      const it = this.consumePickBest();
      if (it === null) return;
      if (!this.inv.addBlock(it.blockId, 1)) return;
      this.audio.foley('snap');
      this.onPickup?.(it.blockId);
      this.stats.pickups++;
      this.despawn(it);
    }
  }

  clear(): void {
    for (const it of this.items) {
      if (this.instancer && it.inst >= 0) this.instancer.release(it);
      else if (it.mesh) {
        this.scene.remove(it.mesh);
        it.mesh.visible = false;
        this.meshPool.push(it.mesh);
      }
      it.mesh = null; it.inst = -1; it.cell = -1; it.index = -1; it.alive = false;
    }
    this.items = [];
    this.awake.length = 0;
    this.sleepers.length = 0;
    this.grid.clear();
    this.stats.live = 0; this.stats.awake = 0; this.stats.sleeping = 0;
  }
}
