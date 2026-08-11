import * as THREE from 'three';
import { B, type WorldLike } from './World';
import { Inventory, type SlotItem } from './Inventory';
import { AudioSynth } from './audio';
import { getAtlas, blockCubeGeometry, buildExtrudedItem, paintDrumstick } from './textures';
import { minImageF, WORLD_HALF } from '../core/constants';
import { packCell } from '../core/cellKey';
import { DEFS } from '../world/blocks';
import { MK_CONVEYOR, MK_GHOST, dirXOf, dirZOf, kindOf } from '../world/machineRegistry';
import { ItemGrid } from './ItemGrid';
import { ItemInstancer } from './ItemInstancer';
import { ItemLedger } from '../factory/itemLedger';
import { cellX, cellY, cellZ } from '../core/cellKey';
import type { ChangeBus } from '../world/changeBus';
import { buildWeapon, MATS, box } from './models';
import { deg } from './anim';

export type DropKind = 'block' | 'weapon' | 'food';

export interface DroppedItem {
  mesh: THREE.Mesh | null;
  group: THREE.Group | null;
  kind: DropKind;
  blockId: number;
  weaponId: string;
  foodId: string;
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

const LEDGER_WINDOW_DIST = 40;
const LEDGER_WINDOW_DIST2 = LEDGER_WINDOW_DIST * LEDGER_WINDOW_DIST;
const MATERIALIZE_DIST = SLEEP_DIST - 2;
const MATERIALIZE_PER_FRAME = 8;
const MATERIALIZE_SCAN_CELLS = 96;

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
  ledger?: ItemLedger;
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
  private weaponTemplates = new Map<string, THREE.Group>();
  private foodTemplate: THREE.Group | null = null;

  private bus: ChangeBus | null = null;
  private instancer: ItemInstancer | null = null;
  private ledger: ItemLedger | null = null;
  private maxItems = MAX_ITEMS_DEFAULT;
  private sleepEnabled = true;
  private wakeCursor = 0;

  private matCellsBuf = new Int32Array(MATERIALIZE_PER_FRAME);
  private matCount = 0;
  private matScanLeft = 0;
  private matVec = new THREE.Vector3();
  private matZero = new THREE.Vector3();

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
    this.ledger = opts.ledger ?? null;
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

  private newItemRecord(): DroppedItem {
    return this.recPool.pop() ?? ({
      mesh: null, group: null, kind: 'block',
      blockId: 0, weaponId: '', foodId: '',
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      time: 0, grounded: false, spin: 0,
      cell: -1, slot: -1, index: -1, awakeSlot: -1,
      sleeping: false, inst: -1, alive: false,
    } as DroppedItem);
  }

  private finishSpawn(it: DroppedItem): void {
    it.index = this.items.length;
    this.items.push(it);
    this.grid.insert(it);
    this.pushAwake(it);
    this.stats.spawned++;
    this.stats.live = this.items.length;
  }

  spawn(blockId: number, pos: THREE.Vector3, velocity?: THREE.Vector3): void {
    if (blockId === B.AIR || blockId === B.BEDROCK) return;
    if (this.ledger) {
      const dxw = minImageF(pos.x - this.lastPx);
      const dzw = minImageF(pos.z - this.lastPz);
      if (dxw * dxw + dzw * dzw > LEDGER_WINDOW_DIST2 || this.items.length >= this.maxItems) {
        this.ledger.add(pos.x, pos.y, pos.z, blockId, 1);
        this.stats.spawned++;
        return;
      }
    }
    if (this.items.length >= this.maxItems) this.evictOne();

    const it = this.newItemRecord();
    it.kind = 'block'; it.weaponId = ''; it.foodId = '';
    it.blockId = blockId;
    it.pos.copy(pos);
    if (velocity) it.vel.copy(velocity);
    else it.vel.set((Math.random() - 0.5) * 2.6, 2.4 + Math.random() * 1.4, (Math.random() - 0.5) * 2.6);
    it.time = 0; it.grounded = false; it.spin = Math.random() * Math.PI * 2;
    it.sleeping = false; it.alive = true; it.inst = -1; it.group = null;

    if (this.instancer) {
      it.mesh = null;
      it.inst = this.instancer.acquire(it);
      this.instancer.set(it, it.pos.x, it.pos.y + 0.12, it.pos.z, it.spin);
    } else {
      const mesh = this.meshPool.pop() ?? new THREE.Mesh(this.getGeometry(blockId), this.getMaterial());
      mesh.geometry = this.getGeometry(blockId);
      mesh.material = this.getMaterial();
      mesh.position.copy(it.pos);
      mesh.visible = true; mesh.castShadow = true; mesh.receiveShadow = false;
      this.scene.add(mesh);
      it.mesh = mesh;
    }

    this.finishSpawn(it);
  }

  spawnItem(item: SlotItem, pos: THREE.Vector3, velocity?: THREE.Vector3): void {
    if (item.kind === 'block') { this.spawn(item.blockId, pos, velocity); return; }
    if (item.kind === 'weapon') this.spawnWeaponDrop(item.weaponId, pos, velocity);
    else if (item.kind === 'food') this.spawnFoodDrop(item.foodId, pos, velocity);
  }

  private bakeGroundRest(group: THREE.Group): void {
    const box = new THREE.Box3().setFromObject(group);
    const raise = -0.11 - box.min.y;
    if (raise <= 0.001) return;
    const inner = new THREE.Group();
    while (group.children.length) inner.add(group.children[0]);
    inner.position.y = raise;
    group.add(inner);
  }

  private getWeaponDropTemplate(weaponId: string): THREE.Group {
    const cached = this.weaponTemplates.get(weaponId);
    if (cached) return cached;
    const tpl = weaponId === 'laser'
      ? this.buildLaserDropModel()
      : buildWeapon(weaponId).gun.clone(true);
    tpl.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; }
    });
    this.bakeGroundRest(tpl);
    this.weaponTemplates.set(weaponId, tpl);
    return tpl;
  }

  private getFoodDropTemplate(): THREE.Group {
    if (!this.foodTemplate) {
      this.foodTemplate = buildExtrudedItem(paintDrumstick, 0.017, 0.034);
      this.foodTemplate.scale.setScalar(1.15);
      this.foodTemplate.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.frustumCulled = false; }
      });
      this.bakeGroundRest(this.foodTemplate);
    }
    return this.foodTemplate;
  }

  private spawnWeaponDrop(weaponId: string, pos: THREE.Vector3, velocity?: THREE.Vector3): void {
    if (this.items.length >= this.maxItems) this.evictOne();
    const it = this.newItemRecord();
    it.kind = 'weapon'; it.weaponId = weaponId; it.foodId = ''; it.blockId = 0;
    it.pos.copy(pos);
    if (velocity) it.vel.copy(velocity);
    else it.vel.set((Math.random() - 0.5) * 2.6, 2.4 + Math.random() * 1.4, (Math.random() - 0.5) * 2.6);
    it.time = 0; it.grounded = false; it.spin = Math.random() * Math.PI * 2;
    it.sleeping = false; it.alive = true; it.inst = -1; it.mesh = null;

    const group = this.getWeaponDropTemplate(weaponId).clone();
    group.position.copy(it.pos);
    group.rotation.set(0, it.spin, 0);
    this.scene.add(group);
    it.group = group;

    this.finishSpawn(it);
  }

  private spawnFoodDrop(foodId: string, pos: THREE.Vector3, velocity?: THREE.Vector3): void {
    if (this.items.length >= this.maxItems) this.evictOne();
    const it = this.newItemRecord();
    it.kind = 'food'; it.foodId = foodId; it.weaponId = ''; it.blockId = 0;
    it.pos.copy(pos);
    if (velocity) it.vel.copy(velocity);
    else it.vel.set((Math.random() - 0.5) * 2.6, 2.4 + Math.random() * 1.4, (Math.random() - 0.5) * 2.6);
    it.time = 0; it.grounded = false; it.spin = Math.random() * Math.PI * 2;
    it.sleeping = false; it.alive = true; it.inst = -1; it.mesh = null;

    const group = this.getFoodDropTemplate().clone();
    group.position.copy(it.pos);
    group.rotation.set(0, it.spin, 0);
    this.scene.add(group);
    it.group = group;

    this.finishSpawn(it);
  }

  private buildLaserDropModel(): THREE.Group {
    const g = new THREE.Group();
    box(g, 0.05, 0.04, 0.13, 0, 0, 0, MATS.gun);
    box(g, 0.064, 0.064, 0.07, 0, 0.022, -0.02, MATS.black);
    box(g, 0.03, 0.03, 0.03, 0, 0.022, -0.02, MATS.whiteGlow);
    box(g, 0.032, 0.09, 0.05, 0, -0.058, 0.035, MATS.poly, deg(-12));
    box(g, 0.036, 0.012, 0.05, 0, -0.106, 0.045, MATS.black, deg(-12));
    return g;
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
    else if (it.group) {
      this.scene.remove(it.group);
      it.group = null;
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
    if (victim) {
      if (this.ledger && victim.kind === 'block') {
        this.ledger.add(victim.pos.x, victim.pos.y, victim.pos.z, victim.blockId, 1);
      }
      this.despawn(victim);
      this.stats.evicted++;
    }
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
    if (it.kind !== 'block') return;
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
    if (this.items.length === 0 && !this.ledger) return null;
    this.takeX = x; this.takeY = y; this.takeZ = z;
    this.takeR2 = radius * radius;
    this.takeBest = null; this.takeBestD2 = Infinity;
    this.grid.forEachBox(x - radius, y - 0.6, z - radius, x + radius, y + 0.6, z + radius, this.takeVisit);
    const it = this.takeBest;
    this.takeBest = null;
    if (it !== null) {
      this.unlink(it);
      this.stats.takeHits++;
      return it;
    }
    if (this.ledger) {
      const id = this.ledger.takeOneAt(x, y, z, radius);
      if (id > 0) {
        this.stats.takeHits++;
        const rec = this.newItemRecord();
        rec.kind = 'block'; rec.weaponId = ''; rec.foodId = '';
        rec.group = null;
        rec.blockId = id;
        rec.pos.set(x, y, z);
        rec.vel.set(0, 0, 0);
        rec.time = POP_TIME;
        rec.grounded = true;
        rec.mesh = null;
        rec.inst = -1;
        rec.alive = false;
        rec.index = -1;
        rec.cell = -1;
        rec.slot = -1;
        rec.awakeSlot = -1;
        rec.sleeping = false;
        return rec;
      }
    }
    return null;
  }

  private reimage(it: DroppedItem, px: number, pz: number): void {
    const dx = it.pos.x - px;
    if (dx > WORLD_HALF || dx < -WORLD_HALF) it.pos.x = px + minImageF(dx);
    const dz = it.pos.z - pz;
    if (dz > WORLD_HALF || dz < -WORLD_HALF) it.pos.z = pz + minImageF(dz);
  }

  private matVisit = (cell: number): void => {
    if (this.matScanLeft <= 0 || this.matCount >= MATERIALIZE_PER_FRAME) return;
    this.matScanLeft--;
    this.matCellsBuf[this.matCount++] = cell;
  };

  private materializeSweep(px: number, pz: number): void {
    const ledger = this.ledger;
    if (!ledger) return;
    const room = this.maxItems - this.items.length;
    if (room <= 0) return;
    this.matCount = 0;
    this.matScanLeft = MATERIALIZE_SCAN_CELLS;
    ledger.forEachOccupiedNear(px, pz, MATERIALIZE_DIST, this.matVisit);
    const n = Math.min(this.matCount, MATERIALIZE_PER_FRAME, room);
    for (let i = 0; i < n; i++) {
      const cell = this.matCellsBuf[i];
      if (ledger.takeAnyFromCell(cell, 1) <= 0) continue;
      this.matVec.set(
        px + minImageF(cellX(cell) + 0.5 - px),
        cellY(cell) + 0.1,
        pz + minImageF(cellZ(cell) + 0.5 - pz),
      );
      this.spawn(ledger.out.id, this.matVec, this.matZero);
    }
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const step = Math.min(dt, 1 / 30);
    const px = playerPos.x, pz = playerPos.z;
    this.lastPx = px; this.lastPz = pz;

    for (let ai = this.awake.length - 1; ai >= 0; ai--) {
      const item = this.awake[ai];
      if (ai >= this.awake.length) continue;
      item.time += dt;
      this.reimage(item, px, pz);
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
      if (item.inst >= 0 && this.instancer) this.instancer.set(item, p.x, vy, p.z, item.spin);
      else if (item.mesh) { item.mesh.position.set(p.x, vy, p.z); item.mesh.rotation.y = item.spin; }
      else if (item.group) { item.group.position.set(p.x, vy, p.z); item.group.rotation.y = item.spin; }

      this.grid.move(item);

      if (this.sleepEnabled && item.grounded && !onBelt && !stuck && item.time > POP_TIME) {
        const v2 = item.vel.x * item.vel.x + item.vel.z * item.vel.z + item.vel.y * item.vel.y;
        if (v2 < SLEEP_VEL2) {
          const dx = minImageF(p.x - px);
          const dz = minImageF(p.z - pz);
          if (dx * dx + dz * dz > SLEEP_DIST2) {
            if (this.ledger && item.kind === 'block') {
              this.ledger.add(p.x, p.y, p.z, item.blockId, 1);
              this.despawn(item);
            } else {
              this.sleep(item);
            }
            continue;
          }
        }
      }
    }

    this.wakeSweep(px, pz);
    this.materializeSweep(px, pz);
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
      if (dx * dx + dz * dz < SLEEP_DIST2) {
        this.reimage(it, px, pz);
        this.wake(it);
      } else this.wakeCursor++;
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
      if (it.kind === 'weapon') {
        if (!this.inv.addWeapon(it.weaponId)) return;
      } else if (it.kind === 'food') {
        if (!this.inv.addItem({ kind: 'food', foodId: it.foodId, count: 1 })) return;
      } else {
        if (!this.inv.addBlock(it.blockId, 1)) return;
      }
      this.audio.foley('snap');
      this.onPickup?.(it.kind === 'block' ? it.blockId : -1);
      this.stats.pickups++;
      this.despawn(it);
    }
  }

  clear(): void {
    if (this.ledger) {
      for (const it of this.items) {
        if (it.blockId > 0) this.ledger.add(it.pos.x, it.pos.y, it.pos.z, it.blockId, 1);
      }
    }
    for (const it of this.items) {
      if (this.instancer && it.inst >= 0) this.instancer.release(it);
      else if (it.mesh) {
        this.scene.remove(it.mesh);
        it.mesh.visible = false;
        this.meshPool.push(it.mesh);
      }
      else if (it.group) {
        this.scene.remove(it.group);
      }
      it.mesh = null; it.group = null; it.inst = -1; it.cell = -1; it.index = -1; it.alive = false;
    }
    this.items = [];
    this.awake.length = 0;
    this.sleepers.length = 0;
    this.grid.clear();
    this.stats.live = 0; this.stats.awake = 0; this.stats.sleeping = 0;
  }

  dispose(): void {
    this.clear();
    if (this.instancer) {
      this.instancer.dispose();
      this.instancer = null;
    }
    for (const geo of this.geoCache.values()) geo.dispose();
    this.geoCache.clear();
    if (this.mat) { this.mat.dispose(); this.mat = null; }
  }
}
