/**
 * World — owns chunk data, streaming (load / unload / remesh) and block edits.
 * Rendering is merged: each chunk yields ≤ 3 draw calls (opaque, cutout, water).
 * `update()` is time-budgeted so it can be called every frame without spikes.
 */

import * as THREE from 'three';
import {
  CHUNK_SIZE as S, WORLD_HEIGHT as H, VIEW_DISTANCE, EVICT_DISTANCE, WORLD_SIZE, WORLD_CHUNKS,
  wrapChunk, wrapBlock, wrapDelta, chunkIndex,
} from '../core/constants';
import { B, DEFS, isWaterId } from './blocks';
import { TerrainGenerator } from './generator';
import { buildChunkGeometry } from './mesher';
import { raycastVoxel } from '../player/raycast';

/** chunks examined per incremental eviction pass */
const EVICT_SCAN_PER_PASS = 96;
/** meshes/data blocks actually retired per pass (disposal is the expensive bit) */
const EVICT_RETIRE_PER_PASS = 6;

export interface ChunkMaterials {
  opaque: THREE.Material;
  cutout: THREE.Material;
  water: THREE.Material;
}

export interface MapColumn {
  /** packed 0xRRGGBB minimap color, 0 when unexplored */
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
  /** nearest-image render offsets (multiples of WORLD_SIZE) — toroidal trick */
  kx: number;
  kz: number;
  /** mutated by players — kept resident so edits persist across the ring */
  dirty: boolean;
  /** minimap column cache */
  colH: Uint8Array;
  colC: Uint32Array;
  colW: Uint8Array;
}

export class World {
  readonly group = new THREE.Group();
  readonly gen: TerrainGenerator;

  // Numeric keys (cx << 5 | cz) — string template keys allocated on every
  // single voxel query, which dominated AI sensing cost.
  private chunks = new Map<number, Chunk>();
  /** 1-entry memo: neighbouring voxel queries almost always share a chunk */
  private memoKey = -1;
  private memoChunk: Chunk | null = null;
  private loadQueue: { cx: number; cz: number }[] = [];
  private dirtyQueue: Chunk[] = [];
  private dirtySet = new Set<Chunk>();
  private lastCenter = -1;
  private lastUnloadCheck = 0;
  private batchDepth = 0;
  /** rolling cost (ms) of one re-mesh / one generate+mesh — drives the budget */
  private meshCost = 1;
  private loadCost = 2;
  /** resumable cursor for the incremental eviction sweep */
  private evictCursor = 0;
  /** last camera position a full offset sync ran at */
  private syncX = Infinity;
  private syncZ = Infinity;
  /** latest camera position — drives nearest-image chunk placement */
  private camX = 8;
  private camZ = 8;

  /** fired after a block changes (suppressed during batches) */
  onChanged: ((x: number, y: number, z: number, oldId: number, newId: number) => void) | null = null;

  /** unified-game adapter: where the player spawns (fps systems read this) */
  spawn = new THREE.Vector3(8.5, 45, 8.5);

  constructor(public readonly seed: number, private mats: ChunkMaterials) {
    this.gen = new TerrainGenerator(seed);
  }

  // ---- unified-game adapter surface (fps systems expect this API) ----

  solid(x: number, y: number, z: number): boolean {
    // Resident-only: AI sensing, pathfinding and collision must never force a
    // synchronous chunk generation. Unloaded space reads as an impassable
    // wall, exactly like the documented getBlockRaw contract.
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

  /** top non-air block of a column — O(1) via the cached column heights */
  highestY(x: number, z: number): number {
    const px = Math.floor(wrapBlock(x));
    const pz = Math.floor(wrapBlock(z));
    const c = this.ensureData(Math.floor(px / S), Math.floor(pz / S));
    return c.colH[(px % S) + (pz % S) * S];
  }

  /** fps-style raycast (DDA) — point/normal/block/dist surface */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 120): {
    point: THREE.Vector3;
    normal: THREE.Vector3;
    block: number;
    x: number; y: number; z: number;
    dist: number;
  } | null {
    // projectiles / line-of-sight: plants are never cover
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

  /** Destroy blocks within a sphere (rockets). Returns destroyed count. */
  destroySphere(
    center: THREE.Vector3,
    radius: number,
    onBlockDestroyed?: (x: number, y: number, z: number, blockId: number) => void
  ): number {
    let count = 0;
    const r2 = radius * radius;
    const touched = new Map<number, Chunk>();
    /** flat [x, y, z, oldId] records, replayed to onChanged after the batch */
    const carved: number[] = [];

    // One batch for the entire blast. Without it every single voxel would
    // trigger a full chunk remesh (16 x 80 x 16 voxels each), so a rocket
    // carving ~100 blocks rebuilt ~100 chunk meshes in one frame and locked
    // the main thread for seconds.
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
          c.dirty = true; // blast craters are player edits: keep them resident
          touched.set(this.key(c.cx, c.cz), c);
          carved.push(px, y, pz, b);

          onBlockDestroyed?.(x, y, z, b);
          count++;
        }
      }
    }
    this.endBatch();

    // Rebuild each affected chunk exactly once (a blast spans 1–4 chunks),
    // and let the border neighbours refresh through the streaming queue.
    for (const c of touched.values()) {
      if (c.hasMesh) this.buildMesh(c);
      this.markNeighborBorders(c.cx, c.cz);
    }

    // Replay the edits for water reflow once the geometry is settled; the
    // fluid sim dedupes its own cell queue.
    const notify = this.onChanged;
    if (notify) {
      for (let i = 0; i < carved.length; i += 4) {
        notify(carved[i], carved[i + 1], carved[i + 2], carved[i + 3], B.AIR);
      }
    }
    return count;
  }

  // ------------------------------------------------------------------ utils

  /** canonical numeric chunk key — allocation-free (WORLD_CHUNKS = 32) */
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
    // Hot path: AI probes and meshing walk neighbouring voxels, so the same
    // chunk repeats over and over. Skip the Map hash entirely on a hit.
    if (k === this.memoKey && this.memoChunk) return this.memoChunk;
    let c = this.chunks.get(k);
    if (!c) {
      const data = new Uint8Array(S * H * S);
      this.gen.populateChunk(data, cx, cz);
      c = {
        cx, cz, data, meshes: [], hasMesh: false,
        kx: 0, kz: 0, dirty: false,
        colH: new Uint8Array(S * S),
        colC: new Uint32Array(S * S),
        colW: new Uint8Array(S * S),
      };
      this.chunks.set(k, c);
      this.buildColumnCache(c);
      // borders of existing neighbors may change -> re-mesh them once
      this.markNeighborBorders(cx, cz);
    }
    this.memoKey = k;
    this.memoChunk = c;
    return c;
  }

  // ------------------------------------------------- minimap column cache

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

  /** minimap lookup: top column color + height at wrapped world coords */
  mapColumn(wx: number, wz: number): MapColumn | null {
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const c = this.peekChunk(Math.floor(px / S), Math.floor(pz / S));
    if (!c) return null; // unexplored — never generate terrain for the radar
    const i = (px % S) + (pz % S) * S;
    return { color: c.colC[i], height: c.colH[i], water: c.colW[i] === 1 };
  }

  /**
   * Batched minimap read. The radar samples n² columns every refresh; going
   * through mapColumn() allocated one result object per pixel (~9k objects
   * every 180 ms) and re-hashed the chunk map for each of them. This walks
   * chunk-by-chunk instead: one lookup per 16-column run, zero allocation.
   */
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

  // -------------------------------------------------------------- block I/O

  /** resident chunk or undefined — never generates (memoized like ensureData) */
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

  /**
   * Resident-only block read: -1 when the chunk is not loaded.
   *
   * This is the accessor every *gameplay* query must use (raycasts, AI
   * sensing, collision, radar). getBlockRaw() generates missing chunks
   * on demand, so a single stray query — an enemy line-of-sight ray 120
   * blocks long, a rocket, or a radar pixel — used to synthesize whole
   * chunks (terrain noise + trees + column cache + neighbour re-mesh)
   * mid-frame. That was the main source of random multi-frame stalls
   * while exploring.
   */
  peekBlock(wx: number, wy: number, wz: number): number {
    if (wy < 0) return B.BEDROCK;
    if (wy >= H) return B.AIR;
    const px = Math.floor(wrapBlock(wx));
    const pz = Math.floor(wrapBlock(wz));
    const c = this.peekChunk(Math.floor(px / S), Math.floor(pz / S));
    if (!c) return -1;
    return c.data[chunkIndex(px % S, wy, pz % S)];
  }

  /** raw block id, or -1 when its chunk is not loaded (x/z wrap toroidally) */
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
    if (id === -1) return true; // unloaded => impassable wall (never falls through)
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
      c.dirty = true; // player edits persist (fluid batches exempt — natural flow)
      this.onChanged?.(px, wy, pz, oldId, id);
      // instant local re-mesh (edit responsiveness) + neighbor borders if needed
      this.buildMesh(c);
    }
    if (lx === 0) this.markDirty(cx - 1, cz);
    if (lx === S - 1) this.markDirty(cx + 1, cz);
    if (lz === 0) this.markDirty(cx, cz - 1);
    if (lz === S - 1) this.markDirty(cx, cz + 1);
    if (this.batchDepth > 0) this.markDirty(cx, cz);
  }

  /** keep the minimap column cache in sync (incremental, edit-local) */
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

  /** batch many edits: defer remeshing to the streaming queue, suppress callbacks */
  beginBatch(): void {
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth = Math.max(0, this.batchDepth - 1);
  }

  // --------------------------------------------------------------- meshing

  private buildMesh(c: Chunk): void {
    for (const m of c.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    c.meshes.length = 0;

    const geoms = buildChunkGeometry(this.boundGet, c.cx, c.cz, c.data);
    const [ox, oz] = this.renderOffset(c.cx, c.cz);
    c.kx = ox;
    c.kz = oz;
    const add = (
      g: THREE.BufferGeometry | undefined, mat: THREE.Material, order: number,
      castShadow: boolean,
    ) => {
      if (!g) return;
      const mesh = new THREE.Mesh(g, mat);
      mesh.position.set(c.cx * S + ox, 0, c.cz * S + oz);
      mesh.renderOrder = order;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      this.group.add(mesh);
      c.meshes.push(mesh);
    };
    // terrain casts + receives; foliage receives but never casts (dense
    // alpha-tested blades would thrash the shadow map for no visual gain)
    add(geoms.opaque, this.mats.opaque, 0, true);
    add(geoms.cutout, this.mats.cutout, 1, false);
    add(geoms.water, this.mats.water, 2, false);
    c.hasMesh = true;
    this.dirtySet.delete(c);
  }

  /**
   * Toroidal nearest-image offset: place the chunk at the copy of its logical
   * position closest to the camera. The copy change only happens WORLD_SIZE/2
   * away — far beyond the fog — so wrapping is invisible (zero blink).
   */
  private renderOffset(cx: number, cz: number): [number, number] {
    const ox = Math.round((this.camX - (cx * S + S / 2)) / WORLD_SIZE) * WORLD_SIZE;
    const oz = Math.round((this.camZ - (cz * S + S / 2)) / WORLD_SIZE) * WORLD_SIZE;
    return [ox, oz];
  }

  /** re-photo-position every meshed chunk to its nearest-image copy */
  syncChunkOffsets(camX: number, camZ: number): void {
    this.camX = camX;
    this.camZ = camZ;
    // An offset only flips when the camera crosses a half-world boundary
    // (256 blocks) relative to a chunk centre, so re-walking every resident
    // chunk on every frame is pure overhead. Sub-block camera motion can
    // never change the result.
    if (Math.abs(camX - this.syncX) < 1 && Math.abs(camZ - this.syncZ) < 1) return;
    this.syncX = camX;
    this.syncZ = camZ;
    for (const c of this.chunks.values()) {
      if (!c.hasMesh) continue;
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
    const c = this.chunks.get(this.key(cx, cz)); // key wraps canonically
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

  // -------------------------------------------------------------- streaming

  /**
   * Spend up to `budgetMs` generating / meshing / unloading around (px, pz).
   * Returns the number of chunks activated this call.
   */
  update(px: number, pz: number, budgetMs: number): number {
    const t0 = performance.now();
    let processed = 0;

    // Cost-aware budgeting. The old loop only checked the clock *before*
    // starting an item, so a single 20 ms chunk build could overrun a 6 ms
    // budget by 3x and drop a frame. We now refuse to start an item unless
    // the measured rolling cost of that kind of work still fits.
    // `did*` guarantees forward progress: even if one item is measured as
    // costing more than the whole budget we still retire one per call, so the
    // queues can never deadlock (the loading screen drains through here too).
    let now = t0;
    let didMesh = false;
    while (this.dirtyQueue.length > 0 && (!didMesh || now - t0 + this.meshCost <= budgetMs)) {
      const c = this.dirtyQueue.shift()!;
      if (!this.dirtySet.has(c)) continue;
      const s = now;
      this.buildMesh(c);
      now = performance.now();
      this.meshCost = this.meshCost * 0.6 + (now - s) * 0.4;
      didMesh = true;
    }

    const ccx = wrapChunk(Math.floor(wrapBlock(px) / S));
    const ccz = wrapChunk(Math.floor(wrapBlock(pz) / S));
    const centerKey = this.key(ccx, ccz);
    if (this.loadQueue.length === 0 && (centerKey !== this.lastCenter || this.lastCenter === -1)) {
      this.rebuildLoadQueue(ccx, ccz);
      this.lastCenter = centerKey;
    }

    let didLoad = false;
    while (this.loadQueue.length > 0 && (!didLoad || now - t0 + this.loadCost <= budgetMs)) {
      const item = this.loadQueue.shift()!;
      const s = now;
      const c = this.ensureData(item.cx, item.cz);
      if (!c.hasMesh) {
        this.buildMesh(c);
        processed++;
      }
      now = performance.now();
      this.loadCost = this.loadCost * 0.6 + (now - s) * 0.4;
      didLoad = true;
    }

    // Hysteresis eviction: meshes live out to EVICT_DISTANCE (no thrash at the
    // seam — crossing the boundary changes the resident set by one row, exactly
    // like any interior chunk boundary).
    //
    // Sweeping every chunk and disposing every stale mesh in one pass was a
    // periodic ~1 Hz hitch. It now runs more often, resumes where it stopped
    // (cursor over the map iterator) and caps how much it retires per pass.
    if (t0 - this.lastUnloadCheck > 350) {
      this.lastUnloadCheck = t0;
      const lim2 = (EVICT_DISTANCE + 2) * (EVICT_DISTANCE + 2);
      let scanned = 0;
      let retired = 0;
      const cursorStart = this.evictCursor;
      let i = 0;
      for (const [k, c] of this.chunks) {
        // resume the sweep from where the previous pass left off
        if (i++ < cursorStart) continue;
        this.evictCursor = i;
        if (++scanned > EVICT_SCAN_PER_PASS || retired >= EVICT_RETIRE_PER_PASS) break;

        // wrapped shortest-path distance on the torus
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
            retired++;
          }
        } else if (!c.dirty && d2 > lim2) {
          // modified chunks stay resident so player edits never vanish
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
    return this.loadQueue.length > 0 || this.dirtyQueue.length > 0;
  }

  private rebuildLoadQueue(ccx: number, ccz: number): void {
    const items: { cx: number; cz: number; d: number }[] = [];
    const r = VIEW_DISTANCE;
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
  }
}
