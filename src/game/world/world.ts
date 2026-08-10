
import * as THREE from 'three';
import {
  CHUNK_SIZE as S, WORLD_HEIGHT as H, VIEW_DISTANCE, EVICT_DISTANCE, WORLD_SIZE, WORLD_CHUNKS,
  wrapChunk, wrapBlock, wrapDelta, chunkIndex,
} from '../core/constants';
import { B, DEFS, isWaterId } from './blocks';
import { TerrainGenerator } from './generator';
import { buildChunkGeometry } from './mesher';
import { raycastVoxel } from '../player/raycast';

const EVICT_SCAN_PER_PASS = 96;
const EVICT_RETIRE_PER_PASS = 6;

export interface ChunkMaterials {
  opaque: THREE.Material;
  cutout: THREE.Material;
  foliage: THREE.Material;
  water: THREE.Material;
  cutoutDepth?: THREE.Material;
  foliageDepth?: THREE.Material;
}

export interface MapColumn {
  color: number;
  height: number;
  water: boolean;
}

interface Chunk {
  cx: number;
  cz: number;
  data: Uint8Array;
  meshes: THREE.Mesh[];
  hasMesh: boolean;
  grass: THREE.Mesh | null;
  kx: number;
  kz: number;
  dirty: boolean;
  colH: Uint8Array;
  colC: Uint32Array;
  colW: Uint8Array;
}

export class World {
  readonly group = new THREE.Group();
  readonly gen: TerrainGenerator;

  private chunks = new Map<number, Chunk>();
  private meshedChunks = new Set<Chunk>();
  private memoKey = -1;
  private memoChunk: Chunk | null = null;
  private loadQueue: { cx: number; cz: number }[] = [];
  private loadHead = 0;
  private dirtyQueue: Chunk[] = [];
  private dirtyHead = 0;
  private dirtySet = new Set<Chunk>();
  private lastCenter = -1;
  private lastUnloadCheck = 0;
  private batchDepth = 0;
  private meshCost = 1;
  private loadCost = 2;
  private evictCursor = 0;
  private syncX = Infinity;
  private syncZ = Infinity;
  private camX = 8;
  private camZ = 8;
  private fullyPrepared = false;
  private bulkPreparing = false;
  private prepareCursor = 0;
  private loadRadius = VIEW_DISTANCE;

  onChanged: ((x: number, y: number, z: number, oldId: number, newId: number) => void) | null = null;

  spawn = new THREE.Vector3(8.5, 45, 8.5);

  constructor(public readonly seed: number, private mats: ChunkMaterials) {
    this.gen = new TerrainGenerator(seed);
  }

  get materials(): ChunkMaterials {
    return this.mats;
  }


  solid(x: number, y: number, z: number): boolean {
    const id = this.peekBlock(x, y, z);
    if (id === -1) return true;
    return DEFS[id].solid;
  }

  get(x: number, y: number, z: number): number {
    return this.getBlockRaw(x, y, z);
  }

  set(x: number, y: number, z: number, id: number): void {
    this.setBlock(x, y, z, id);
  }

  highestY(x: number, z: number): number {
    const px = Math.floor(wrapBlock(x));
    const pz = Math.floor(wrapBlock(z));
    const c = this.ensureData(Math.floor(px / S), Math.floor(pz / S));
    return c.colH[(px % S) + (pz % S) * S];
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 120): {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    block: number;
    x: number; y: number; z: number;
    dist: number;
  } | null {
    const h = raycastVoxel(this, origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, maxDist, {
      ignoreNonSolid: true,
    });
    if (!h) return null;
    return {
      point: origin.clone().addScaledVector(dir, h.dist),
      normal: new THREE.Vector3(h.nx, h.ny, h.nz),
      block: h.id,
      x: h.x, y: h.y, z: h.z,
      dist: h.dist,
    };
  }

  destroySphere(
    center: THREE.Vector3,
    radius: number,
    onBlockDestroyed?: (x: number, y: number, z: number, blockId: number) => void
  ): number {
    let count = 0;
    const r2 = radius * radius;
    const touched = new Map<number, Chunk>();
    const carved: number[] = [];

    this.beginBatch();
    for (let x = Math.floor(center.x - radius); x <= Math.ceil(center.x + radius); x++) {
      for (let y = Math.floor(center.y - radius); y <= Math.ceil(center.y + radius); y++) {
        if (y <= 0 || y >= H) continue;
        for (let z = Math.floor(center.z - radius); z <= Math.ceil(center.z + radius); z++) {
          const dx = x + 0.5 - center.x, dy = y + 0.5 - center.y, dz = z + 0.5 - center.z;
          if (dx * dx + dy * dy + dz * dz > r2 + Math.random() * 1.2) continue;
          const b = this.getBlockRaw(x, y, z);
          if (b === B.AIR || b === B.BEDROCK) continue;
          this.setBlock(x, y, z, B.AIR);

          const px = Math.floor(wrapBlock(x));
          const pz = Math.floor(wrapBlock(z));
          const c = this.ensureData(Math.floor(px / S), Math.floor(pz / S));
          c.dirty = true;
          touched.set(this.key(c.cx, c.cz), c);
          carved.push(px, y, pz, b);

          onBlockDestroyed?.(x, y, z, b);
          count++;
        }
      }
    }
    this.endBatch();

    for (const c of touched.values()) {
      if (c.hasMesh) this.buildMesh(c);
      this.markNeighborBorders(c.cx, c.cz);
    }

    const notify = this.onChanged;
    if (notify) {
      for (let i = 0; i < carved.length; i += 4) {
        notify(carved[i], carved[i + 1], carved[i + 2], carved[i + 3], B.AIR);
      }
    }
    return count;
  }


  private key(cx: number, cz: number): number {
    return (wrapChunk(cx) << 5) | wrapChunk(cz);
  }

  static cellsInRadius(r: number): number {
    let count = 0;
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= (r + 0.5) * (r + 0.5)) count++;
    return count;
  }

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(this.key(cx, cz));
  }

  private ensureData(rawCx: number, rawCz: number): Chunk {
    const cx = wrapChunk(rawCx);
    const cz = wrapChunk(rawCz);
    const k = (cx << 5) | cz;
    if (k === this.memoKey && this.memoChunk) return this.memoChunk;
    let c = this.chunks.get(k);
    if (!c) {
      const data = new Uint8Array(S * H * S);
      this.gen.populateChunk(data, cx, cz);
      c = {
        cx, cz, data, meshes: [], hasMesh: false, grass: null,
        kx: 0, kz: 0, dirty: false,
        colH: new Uint8Array(S * S),
        colC: new Uint32Array(S * S),
        colW: new Uint8Array(S * S),
      };
      this.chunks.set(k, c);
      this.buildColumnCache(c);
      if (!this.bulkPreparing) this.markNeighborBorders(cx, cz);
    }
    this.memoKey = k;
    this.memoChunk = c;
    return c;
  }


  private buildColumnCache(c: Chunk): void {
    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        this.rescanColumn(c, lx, lz, H - 1);
      }
    }
  }

  private rescanColumn(c: Chunk, lx: number, lz: number, fromY: number): void {
    const i = lx + lz * S;
    let top = -1;
    let id = 0;
    for (let y = Math.min(fromY, H - 1); y >= 0; y--) {
      const bid = c.data[chunkIndex(lx, y, lz)];
      if (bid !== B.AIR) {
        top = y;
        id = bid;
        break;
      }
    }
    if (top < 0) {
      c.colH[i] = 0;
      c.colC[i] = 0;
      c.colW[i] = 0;
      return;
    }
    c.colH[i] = top;
    c.colC[i] = DEFS[id].colors[0] ?? 0;
    c.colW[i] = isWaterId(id) ? 1 : 0;
  }

  mapColumn(wx: number, wz: number): MapColumn | null {
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const c = this.peekChunk(Math.floor(px / S), Math.floor(pz / S));
    if (!c) return null;
    const i = (px % S) + (pz % S) * S;
    return { color: c.colC[i], height: c.colH[i], water: c.colW[i] === 1 };
  }

  sampleMapRegion(
    originX: number, originZ: number, n: number,
    heights: Uint8Array, colors: Uint32Array, water: Uint8Array,
  ): void {
    let ck = -1;
    let chunk: Chunk | null = null;
    for (let sz = 0; sz < n; sz++) {
      const pz = Math.floor(wrapBlock(originZ + sz));
      const cz = Math.floor(pz / S);
      const lz = (pz % S) * S;
      for (let sx = 0; sx < n; sx++) {
        const px = Math.floor(wrapBlock(originX + sx));
        const cx = Math.floor(px / S);
        const k = (cx << 5) | cz;
        if (k !== ck) {
          ck = k;
          chunk = this.chunks.get(k) ?? null;
        }
        const o = sz * n + sx;
        if (!chunk) {
          heights[o] = 0;
          colors[o] = 0;
          water[o] = 0;
          continue;
        }
        const i = (px % S) + lz;
        heights[o] = chunk.colH[i];
        colors[o] = chunk.colC[i];
        water[o] = chunk.colW[i];
      }
    }
  }


  private peekChunk(rawCx: number, rawCz: number): Chunk | undefined {
    const k = (wrapChunk(rawCx) << 5) | wrapChunk(rawCz);
    if (k === this.memoKey && this.memoChunk) return this.memoChunk;
    const c = this.chunks.get(k);
    if (c) {
      this.memoKey = k;
      this.memoChunk = c;
    }
    return c;
  }

  peekBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= H) return B.AIR;
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const c = this.peekChunk(Math.floor(px / S), Math.floor(pz / S));
    if (!c) return -1;
    return c.data[chunkIndex(px % S, wy, pz % S)];
  }

  getBlockRaw(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= H) return B.AIR;
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const c = this.ensureData(Math.floor(px / S), Math.floor(pz / S));
    return c.data[chunkIndex(px % S, wy, pz % S)];
  }

  isSolid(wx: number, wy: number, wz: number): boolean {
    const id = this.getBlockRaw(wx, wy, wz);
    if (id === -1) return true;
    return DEFS[id].solid;
  }

  setBlock(wx: number, wy: number, wz: number, id: number): void {
    if (wy < 0 || wy >= H) return;
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const cx = Math.floor(px / S);
    const cz = Math.floor(pz / S);
    const lx = px % S;
    const lz = pz % S;
    const c = this.ensureData(cx, cz);
    const oldId = c.data[chunkIndex(lx, wy, lz)];
    if (oldId === id) return;
    c.data[chunkIndex(lx, wy, lz)] = id;
    this.updateColumn(c, lx, lz, wy, id);
    if (this.batchDepth === 0) {
      c.dirty = true;
      this.onChanged?.(px, wy, pz, oldId, id);
      this.buildMesh(c);
    }
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === S - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === S - 1) this.markDirty(cx, cz + 1);
    if (this.batchDepth > 0) this.markDirty(cx, cz);
  }

  private updateColumn(c: Chunk, lx: number, lz: number, y: number, id: number): void {
    const i = lx + lz * S;
    const h = c.colH[i];
    if (y > h) {
      if (id !== B.AIR) {
        c.colH[i] = y;
        c.colC[i] = DEFS[id].colors[0] ?? 0;
        c.colW[i] = isWaterId(id) ? 1 : 0;
      }
    } else if (y === h) {
      if (id === B.AIR) this.rescanColumn(c, lx, lz, y - 1);
      else {
        c.colC[i] = DEFS[id].colors[0] ?? 0;
        c.colW[i] = isWaterId(id) ? 1 : 0;
      }
    }
  }

  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth = Math.max(0, this.batchDepth - 1);
  }


  private buildMesh(c: Chunk): void {
    for (const m of c.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    c.meshes.length = 0;
    c.grass = null;

    const geoms = buildChunkGeometry(this.boundGet, c.cx, c.cz, c.data);
    const [ox, oz] = this.renderOffset(c.cx, c.cz);
    c.kx = ox;
    c.kz = oz;
    const add = (
      g: THREE.BufferGeometry | undefined, mat: THREE.Material, order: number,
      castShadow: boolean,
    ): THREE.Mesh | null => {
      if (!g) return null;
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(c.cx * S + ox, 0, c.cz * S + oz);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      c.meshes.push(mesh);
      return mesh;
    };
    add(geoms.opaque, this.mats.opaque, 0, true);
    const grass = add(geoms.cutout, this.mats.cutout, 1, false);
    if (grass && this.mats.cutoutDepth) {
      grass.customDepthMaterial = this.mats.cutoutDepth;
    }
    c.grass = grass;
    const foliage = add(geoms.foliage, this.mats.foliage, 1, true);
    if (foliage && this.mats.foliageDepth) {
      foliage.customDepthMaterial = this.mats.foliageDepth;
    }
    add(geoms.water, this.mats.water, 2, false);
    c.hasMesh = true;
    this.meshedChunks.add(c);
    this.dirtySet.delete(c);
  }

  updateGrassShadowCasters(camX: number, camZ: number, radius: number): boolean {
    const r2 = radius * radius;
    let changed = false;
    for (const c of this.meshedChunks) {
      const g = c.grass;
      if (!g) continue;
      const dx = c.cx * S + c.kx + S * 0.5 - camX;
      const dz = c.cz * S + c.kz + S * 0.5 - camZ;
      const want = dx * dx + dz * dz <= r2;
      if (g.castShadow !== want) {
        g.castShadow = want;
        changed = true;
      }
    }
    return changed;
  }

  private renderOffset(cx: number, cz: number): [number, number] {
    const ox = Math.round((this.camX - (cx * S + S / 2)) / WORLD_SIZE) * WORLD_SIZE;
    const oz = Math.round((this.camZ - (cz * S + S / 2)) / WORLD_SIZE) * WORLD_SIZE;
    return [ox, oz];
  }

  syncChunkOffsets(camX: number, camZ: number): void {
    this.camX = camX;
    this.camZ = camZ;
    if (Math.abs(camX - this.syncX) < 1 && Math.abs(camZ - this.syncZ) < 1) return;
    this.syncX = camX;
    this.syncZ = camZ;
    for (const c of this.meshedChunks) {
      const [ox, oz] = this.renderOffset(c.cx, c.cz);
      if (ox === c.kx && oz === c.kz) continue;
      c.kx = ox;
      c.kz = oz;
      for (const m of c.meshes) {
        m.position.set(c.cx * S + ox, 0, c.cz * S + oz);
        m.updateMatrix();
      }
    }
  }

  private boundGet = (wx: number, wy: number, wz: number): number => this.getBlockRaw(wx, wy, wz);

  private markDirty(cx: number, cz: number): void {
    const c = this.chunks.get(this.key(cx, cz));
    if (c && c.hasMesh && !this.dirtySet.has(c)) {
      this.dirtySet.add(c);
      this.dirtyQueue.push(c);
    }
  }

  private markNeighborBorders(cx: number, cz: number): void {
    this.markDirty(cx - 1, cz);
    this.markDirty(cx + 1, cz);
    this.markDirty(cx, cz - 1);
    this.markDirty(cx, cz + 1);
  }


  update(px: number, pz: number, budgetMs: number, radius = VIEW_DISTANCE): number {
    const t0 = performance.now();
    let processed = 0;

    let now = t0;

    // Process dirty (re-mesh) queue using index cursor instead of shift()
    while (this.dirtyHead < this.dirtyQueue.length) {
      // Budget check BEFORE doing work (except first item gets a pass)
      if (this.dirtyHead > 0 && now - t0 + this.meshCost > budgetMs) break;
      const c = this.dirtyQueue[this.dirtyHead++];
      if (!this.dirtySet.has(c)) continue;
      const s = now;
      this.buildMesh(c);
      now = performance.now();
      this.meshCost = this.meshCost * 0.6 + (now - s) * 0.4;
    }
    // Compact when fully drained
    if (this.dirtyHead >= this.dirtyQueue.length) {
      this.dirtyQueue.length = 0;
      this.dirtyHead = 0;
    } else if (this.dirtyHead > 64) {
      this.dirtyQueue = this.dirtyQueue.slice(this.dirtyHead);
      this.dirtyHead = 0;
    }

    const ccx = wrapChunk(Math.floor(wrapBlock(px) / S));
    const ccz = wrapChunk(Math.floor(wrapBlock(pz) / S));
    const centerKey = this.key(ccx, ccz);
    if (this.loadHead >= this.loadQueue.length && (centerKey !== this.lastCenter || this.lastCenter === -1 || radius !== this.loadRadius)) {
      this.loadRadius = radius;
      this.rebuildLoadQueue(ccx, ccz, radius);
      this.lastCenter = centerKey;
    }

    // Process load queue using index cursor instead of shift()
    while (this.loadHead < this.loadQueue.length) {
      // Budget check BEFORE doing work (except first item gets a pass)
      if (processed > 0 && now - t0 + this.loadCost > budgetMs) break;
      const item = this.loadQueue[this.loadHead++];
      const s = now;
      const c = this.ensureData(item.cx, item.cz);
      if (!c.hasMesh) {
        this.buildMesh(c);
        processed++;
      }
      now = performance.now();
      this.loadCost = this.loadCost * 0.6 + (now - s) * 0.4;
    }
    // Compact when fully drained
    if (this.loadHead >= this.loadQueue.length) {
      this.loadQueue.length = 0;
      this.loadHead = 0;
    }

    if (t0 - this.lastUnloadCheck > 350) {
      this.lastUnloadCheck = t0;
      const lim2 = (EVICT_DISTANCE + 2) * (EVICT_DISTANCE + 2);
      let scanned = 0;
      let retired = 0;
      const cursorStart = this.evictCursor;
      let i = 0;
      for (const [k, c] of this.chunks) {
        if (i++ < cursorStart) continue;
        this.evictCursor = i;
        if (++scanned > EVICT_SCAN_PER_PASS || retired >= EVICT_RETIRE_PER_PASS) break;

        const dx = wrapDelta(c.cx - ccx, WORLD_CHUNKS);
        const dz = wrapDelta(c.cz - ccz, WORLD_CHUNKS);
        const d2 = dx * dx + dz * dz;
        if (c.hasMesh) {
          if (d2 > EVICT_DISTANCE * EVICT_DISTANCE) {
            for (const m of c.meshes) {
              this.group.remove(m);
              m.geometry.dispose();
            }
            c.meshes.length = 0;
            c.hasMesh = false;
            this.meshedChunks.delete(c);
            retired++;
          }
        } else if (!this.fullyPrepared && !c.dirty && d2 > lim2) {
          this.chunks.delete(k);
          if (this.memoKey === k) { this.memoKey = -1; this.memoChunk = null; }
          retired++;
        }
      }
      if (i >= this.chunks.size) this.evictCursor = 0;
    }

    return processed;
  }

  get pendingWork(): boolean {
    return this.loadHead < this.loadQueue.length || this.dirtyHead < this.dirtyQueue.length;
  }

  prepareAllData(budgetMs: number): number {
    if (this.fullyPrepared) return 1;
    const deadline = performance.now() + budgetMs;
    this.bulkPreparing = true;
    do {
      const cx = Math.floor(this.prepareCursor / WORLD_CHUNKS);
      const cz = this.prepareCursor % WORLD_CHUNKS;
      this.ensureData(cx, cz);
      this.prepareCursor++;
    } while (this.prepareCursor < WORLD_CHUNKS * WORLD_CHUNKS && performance.now() < deadline);

    if (this.prepareCursor >= WORLD_CHUNKS * WORLD_CHUNKS) {
      this.bulkPreparing = false;
      this.fullyPrepared = true;
      this.memoKey = -1;
      this.memoChunk = null;
      return 1;
    }
    return this.prepareCursor / (WORLD_CHUNKS * WORLD_CHUNKS);
  }

  private rebuildLoadQueue(ccx: number, ccz: number, radius = VIEW_DISTANCE): void {
    const items: { cx: number; cz: number; d: number }[] = [];
    const r = radius;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        const d2 = dx * dx + dz * dz;
        if (d2 > (r + 0.5) * (r + 0.5)) continue;
        const cx = wrapChunk(ccx + dx);
        const cz = wrapChunk(ccz + dz);
        const c = this.chunks.get(this.key(cx, cz));
        if (!c || !c.hasMesh) items.push({ cx, cz, d: d2 });
      }
    }
    items.sort((a, b) => a.d - b.d);
    this.loadQueue = items.map(({ cx, cz }) => ({ cx, cz }));
    this.loadHead = 0;
  }
}
