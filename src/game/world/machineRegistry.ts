import { CHUNK_SIZE, WORLD_CHUNKS, minImageF } from '../core/constants';
import {
  CHUNK_BUCKETS, cellX, cellY, cellZ, chunkOfBlock, chunkRadiusFor,
  packCell, packChunk,
} from '../core/cellKey';
import {
  DEFS, conveyorDir, inserterDir, isConveyor, isInserter, isLaserMiner,
  isTurret, laserMinerDir,
} from './blocks';
import type { ChangeBus } from './changeBus';

export const MK_NONE = 0;
export const MK_INSERTER = 1;
export const MK_LASER = 2;
export const MK_TURRET = 4;
export const MK_CONVEYOR = 8;
export const MK_GHOST = MK_INSERTER | MK_LASER | MK_TURRET;
export const MK_ANY = MK_GHOST | MK_CONVEYOR;

const KIND_OF = new Uint8Array(256);
const DIR_X = new Int8Array(256);
const DIR_Z = new Int8Array(256);

for (let id = 0; id < 256; id++) {
  if (!DEFS[id]) continue;
  let kind = MK_NONE;
  let dir: readonly [number, number] | null = null;
  if (isInserter(id)) { kind = MK_INSERTER; dir = inserterDir(id); }
  else if (isLaserMiner(id)) { kind = MK_LASER; dir = laserMinerDir(id); }
  else if (isTurret(id)) kind = MK_TURRET;
  else if (isConveyor(id)) { kind = MK_CONVEYOR; dir = conveyorDir(id); }
  KIND_OF[id] = kind;
  if (dir) { DIR_X[id] = dir[0]; DIR_Z[id] = dir[1]; }
}

export const kindOf = (id: number): number => id >= 0 && id < 256 ? KIND_OF[id] : MK_NONE;
export const dirXOf = (id: number): number => id >= 0 && id < 256 ? DIR_X[id] : 0;
export const dirZOf = (id: number): number => id >= 0 && id < 256 ? DIR_Z[id] : 0;

export interface MachineRecord {
  key: number;
  x: number; y: number; z: number;
  id: number; kind: number;
  dx: number; dz: number;
  live: boolean;
  dormantAt: number;
  bucket: number;
  slot: number;
  seen: boolean;
}

export interface MachineListener {
  onAdd?(rec: MachineRecord): void;
  onIdChanged?(rec: MachineRecord, oldId: number): void;
  onLive?(rec: MachineRecord, live: boolean): void;
  onRemove?(rec: MachineRecord): void;
}

interface Bucket { recs: MachineRecord[]; mask: number; loaded: boolean }

export interface MachineRegistryOptions {
  indexedKinds?: number;
  trustGenerator?: boolean;
}

export class MachineRegistry {
  version = 1;
  readonly stats = {
    records: 0, dormant: 0, adds: 0, removes: 0, idChanges: 0,
    rescans: 0, rescanVoxels: 0, rescansSkipped: 0,
    queries: 0, bucketsVisited: 0, recordsVisited: 0, voxelReadsAvoided: 0,
  };

  private readonly indexedKinds: number;
  private readonly trustGenerator: boolean;
  private readonly buckets: (Bucket | null)[] = new Array(CHUNK_BUCKETS).fill(null);
  private readonly byKey = new Map<number, MachineRecord>();
  private readonly listeners: MachineListener[] = [];
  private readonly pool: MachineRecord[] = [];
  private nowSec = 0;

  constructor(opts: MachineRegistryOptions = {}) {
    this.indexedKinds = opts.indexedKinds ?? MK_GHOST;
    this.trustGenerator = opts.trustGenerator ?? true;
  }

  attach(bus: ChangeBus): () => void {
    return bus.add({
      onBlock: (x, y, z, oldId, newId) => this.onBlock(x, y, z, oldId, newId),
      onChunkData: (cx, cz, data, fromGenerator) => {
        if (fromGenerator && this.trustGenerator) {
          this.clearChunk(cx, cz);
          this.setChunkLive(cx, cz, true);
          this.stats.rescansSkipped++;
        } else this.rescanChunk(cx, cz, data);
      },
      onChunkGone: (cx, cz) => this.setChunkLive(cx, cz, false),
    });
  }

  bootstrap(world: { forEachLoadedChunk(cb: (cx: number, cz: number, d: Uint8Array) => void): void }): void {
    world.forEachLoadedChunk((cx, cz, data) => this.rescanChunk(cx, cz, data));
  }

  addListener(listener: MachineListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  get(key: number): MachineRecord | undefined { return this.byKey.get(key); }
  getAt(x: number, y: number, z: number): MachineRecord | undefined {
    return this.byKey.get(packCell(x, y, z));
  }
  get size(): number { return this.byKey.size; }

  forEachNear(
    px: number, pz: number, radius: number, yLo: number, yHi: number,
    kindMask: number,
    cb: (rec: MachineRecord, ix: number, iz: number, d2: number) => void,
  ): void {
    this.stats.queries++;
    const r2 = radius * radius;
    const cr = chunkRadiusFor(radius);
    const pcx = chunkOfBlock(Math.floor(px));
    const pcz = chunkOfBlock(Math.floor(pz));
    const span = cr * 2 + 1;

    if (span >= WORLD_CHUNKS) {
      for (let bi = 0; bi < CHUNK_BUCKETS; bi++) this.visitBucket(this.buckets[bi], px, pz, r2, yLo, yHi, kindMask, cb);
      return;
    }
    for (let dz = -cr; dz <= cr; dz++) {
      for (let dx = -cr; dx <= cr; dx++) {
        this.visitBucket(this.buckets[packChunk(pcx + dx, pcz + dz)], px, pz, r2, yLo, yHi, kindMask, cb);
      }
    }
  }

  private visitBucket(
    bucket: Bucket | null, px: number, pz: number, r2: number,
    yLo: number, yHi: number, kindMask: number,
    cb: (rec: MachineRecord, ix: number, iz: number, d2: number) => void,
  ): void {
    if (!bucket || bucket.recs.length === 0 || (bucket.mask & kindMask) === 0) return;
    this.stats.bucketsVisited++;
    for (let i = 0; i < bucket.recs.length; i++) {
      const rec = bucket.recs[i];
      if (!rec.live || (rec.kind & kindMask) === 0 || rec.y < yLo || rec.y > yHi) continue;
      const dx = minImageF(rec.x - px);
      const dz = minImageF(rec.z - pz);
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;
      this.stats.recordsVisited++;
      cb(rec, px + dx, pz + dz, d2);
    }
  }

  private onBlock(x: number, y: number, z: number, oldId: number, newId: number): void {
    const oldKind = kindOf(oldId) & this.indexedKinds;
    const newKind = kindOf(newId) & this.indexedKinds;
    if (oldKind === 0 && newKind === 0) return;
    const key = packCell(x, y, z);
    const existing = this.byKey.get(key);
    if (newKind !== 0) {
      if (existing && existing.kind === newKind) {
        const prev = existing.id;
        if (prev !== newId) {
          existing.id = newId;
          existing.dx = DIR_X[newId]; existing.dz = DIR_Z[newId];
          this.stats.idChanges++;
          for (const l of this.listeners) l.onIdChanged?.(existing, prev);
        }
        if (!existing.live) this.markLive(existing, true);
      } else {
        if (existing) this.removeRec(existing);
        this.addRec(key, newId, newKind);
      }
    } else if (existing) this.removeRec(existing);
    this.version++;
  }

  private addRec(key: number, id: number, kind: number): MachineRecord {
    const x = cellX(key), y = cellY(key), z = cellZ(key);
    const bi = packChunk(chunkOfBlock(x), chunkOfBlock(z));
    let b = this.buckets[bi];
    if (!b) { b = { recs: [], mask: 0, loaded: true }; this.buckets[bi] = b; }
    const rec = this.pool.pop() ?? {
      key: 0, x: 0, y: 0, z: 0, id: 0, kind: 0, dx: 0, dz: 0,
      live: true, dormantAt: 0, bucket: 0, slot: 0, seen: true,
    };
    rec.key = key; rec.x = x; rec.y = y; rec.z = z;
    rec.id = id; rec.kind = kind; rec.dx = DIR_X[id]; rec.dz = DIR_Z[id];
    rec.live = true; rec.dormantAt = 0; rec.seen = true;
    rec.bucket = bi; rec.slot = b.recs.length;
    b.recs.push(rec); b.mask |= kind;
    this.byKey.set(key, rec);
    this.stats.records++; this.stats.adds++;
    for (const l of this.listeners) l.onAdd?.(rec);
    return rec;
  }

  private removeRec(rec: MachineRecord): void {
    const b = this.buckets[rec.bucket];
    if (b) {
      const last = b.recs.pop()!;
      if (last !== rec) { b.recs[rec.slot] = last; last.slot = rec.slot; }
      let mask = 0;
      for (let i = 0; i < b.recs.length; i++) mask |= b.recs[i].kind;
      b.mask = mask;
    }
    this.byKey.delete(rec.key);
    if (!rec.live) this.stats.dormant--;
    this.stats.records--; this.stats.removes++;
    for (const l of this.listeners) l.onRemove?.(rec);
    rec.slot = -1; rec.bucket = -1;
    if (this.pool.length < 512) this.pool.push(rec);
  }

  private markLive(rec: MachineRecord, live: boolean): void {
    if (rec.live === live) return;
    rec.live = live;
    rec.dormantAt = live ? 0 : this.nowSec;
    this.stats.dormant += live ? -1 : 1;
    for (const l of this.listeners) l.onLive?.(rec, live);
  }

  private setChunkLive(cx: number, cz: number, live: boolean): void {
    const b = this.buckets[packChunk(cx, cz)];
    if (!b) return;
    b.loaded = live;
    for (let i = 0; i < b.recs.length; i++) this.markLive(b.recs[i], live);
    this.version++;
  }

  private clearChunk(cx: number, cz: number): void {
    const b = this.buckets[packChunk(cx, cz)];
    if (!b) return;
    for (let i = b.recs.length - 1; i >= 0; i--) this.removeRec(b.recs[i]);
    b.mask = 0;
    this.version++;
  }

  rescanChunk(cx: number, cz: number, data: Uint8Array): void {
    if (CHUNK_SIZE !== 16) throw new Error('MachineRegistry assumes CHUNK_SIZE=16');
    this.stats.rescans++; this.stats.rescanVoxels += data.length;
    const bi = packChunk(cx, cz);
    let b = this.buckets[bi];
    if (b) for (const rec of b.recs) rec.seen = false;
    const baseX = (cx & 31) * 16, baseZ = (cz & 31) * 16;
    for (let i = 0; i < data.length; i++) {
      const id = data[i];
      const kind = KIND_OF[id] & this.indexedKinds;
      if (!kind) continue;
      const x = (baseX + (i & 15)) & 511;
      const z = (baseZ + ((i >> 4) & 15)) & 511;
      const y = i >> 8;
      const key = packCell(x, y, z);
      const ex = this.byKey.get(key);
      if (ex && ex.kind === kind) {
        ex.seen = true;
        if (ex.id !== id) {
          const prev = ex.id; ex.id = id; ex.dx = DIR_X[id]; ex.dz = DIR_Z[id];
          this.stats.idChanges++;
          for (const l of this.listeners) l.onIdChanged?.(ex, prev);
        }
        this.markLive(ex, true);
      } else {
        if (ex) this.removeRec(ex);
        this.addRec(key, id, kind).seen = true;
      }
    }
    b = this.buckets[bi];
    if (b) {
      for (let i = b.recs.length - 1; i >= 0; i--) if (!b.recs[i].seen) this.removeRec(b.recs[i]);
      b.loaded = true;
    }
    this.version++;
  }

  tickClock(dt: number): void { this.nowSec += dt; }

  retain: ((key: number) => boolean) | null = null;

  pruneDormant(maxAgeSec = 120, maxPerCall = 32): number {
    if (!this.stats.dormant) return 0;
    const cutoff = this.nowSec - maxAgeSec;
    let removed = 0;
    for (const rec of this.byKey.values()) {
      if (rec.live || rec.dormantAt > cutoff) continue;
      if (this.retain?.(rec.key)) continue;
      this.removeRec(rec);
      if (++removed >= maxPerCall) break;
    }
    if (removed) this.version++;
    return removed;
  }

  snapshot() { return { ...this.stats, version: this.version, size: this.byKey.size }; }
}