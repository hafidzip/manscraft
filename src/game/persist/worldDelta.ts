/* eslint-disable no-bitwise */
/**
 * src/game/persist/worldDelta.ts
 *
 * Feature A core — the per-planet edit overlay. Base terrain is deterministic from the
 * planet seed (TerrainGenerator), so ONLY player/sim edits are stored, as sparse per-chunk
 * maps: Map<chunkKey, Map<localIdx, blockId>>.
 * localIdx === chunkIndex(x,y,z) = (y*16+z)*16+x → fits in 15 bits for H=80.
 *
 * Replay happens inside `World.ensureData` (see world.ts integration) — i.e. BEFORE
 * buildColumnCache and onChunkData — so derived column caches and the MachineRegistry
 * rescan both see the edited voxels.
 *
 * NO three.js imports.
 */
import { CHUNK_SIZE as S, WORLD_HEIGHT as H, wrapBlock, wrapChunk } from '../core/constants';
import { packChunk, cellX, cellY, cellZ } from '../core/cellKey';
import { B } from '../world/blocks';
import type { FurnaceState } from '../crafting/smelting';

export const DELTA_MAGIC = 0x4d435744; // 'MCWD'
export const DELTA_VERSION = 1;

const localIdxOf = (lx: number, y: number, lz: number): number => (y * S + lz) * S + lx;
const lxOf = (i: number): number => i & 15;
const lzOf = (i: number): number => (i >> 4) & 15;
const lyOf = (i: number): number => i >> 8;

/** Structural view of the world, so this module never imports three via world.ts. */
export interface DeltaWorldLike {
  setBlock(x: number, y: number, z: number, id: number): void;
}

export interface DeltaSink {
  /** Apply stored edits onto freshly generated chunk data. Returns edits applied. */
  applyToChunk(cx: number, cz: number, data: Uint8Array): number;
}

export class WorldDeltaStore implements DeltaSink {
  private chunks = new Map<number, Map<number, number>>();

  /** Set while replaying/hydrating so the ChangeBus recorder ignores its own writes. */
  replaying = false;

  readonly stats = { edits: 0, records: 0, pruned: 0, applied: 0, chunksTouched: 0, ignored: 0 };

  private scratch: Uint8Array | null = null;
  private pruneCursor = 0;

  get size(): number {
    return this.stats.records;
  }
  get chunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Lit furnaces are a *derived* state owned by FurnaceState — canonicalise so a burning
   * furnace does not rewrite the delta twice per smelt and bloat the store.
   */
  private canonical(id: number): number {
    return id === B.FURNACE_LIT ? B.FURNACE : id;
  }

  /** ChangeBus onBlock sink. `x,z` must already be wrapped (World passes wrapped px/pz). */
  recordBlock(x: number, y: number, z: number, id: number): void {
    if (this.replaying) {
      this.stats.ignored++;
      return;
    }
    if (y < 0 || y >= H) return;
    const px = wrapBlock(Math.floor(x));
    const pz = wrapBlock(Math.floor(z));
    const ck = packChunk(px >> 4, pz >> 4);
    let m = this.chunks.get(ck);
    if (!m) {
      m = new Map<number, number>();
      this.chunks.set(ck, m);
    }
    const li = localIdxOf(px & 15, y | 0, pz & 15);
    if (!m.has(li)) this.stats.records++;
    m.set(li, this.canonical(id) & 0xff);
    this.stats.edits++;
  }

  /** -1 = no override (caller must consult the generator). */
  getOverride(x: number, y: number, z: number): number {
    if (y < 0 || y >= H) return -1;
    const px = wrapBlock(Math.floor(x));
    const pz = wrapBlock(Math.floor(z));
    const m = this.chunks.get(packChunk(px >> 4, pz >> 4));
    if (!m) return -1;
    const v = m.get(localIdxOf(px & 15, y | 0, pz & 15));
    return v === undefined ? -1 : v;
  }

  /**
   * CRITICAL INJECTION POINT (world.ts / ensureData): call right after
   * gen.populateChunk() and BEFORE buildColumnCache()/onChunkData.
   * Returns the number of voxels overwritten — the caller MUST pass
   * `fromGenerator = (returned === 0)` to onChunkData, otherwise MachineRegistry's
   * trust-generator fast path skips the rescan and restored machines stay unindexed.
   */
  applyToChunk(cx: number, cz: number, data: Uint8Array): number {
    const m = this.chunks.get(packChunk(cx, cz));
    if (!m || m.size === 0) return 0;
    let n = 0;
    for (const [li, id] of m) {
      if (data[li] !== id) {
        data[li] = id;
        n++;
      }
    }
    if (n > 0) {
      this.stats.applied += n;
      this.stats.chunksTouched++;
    }
    return n;
  }

  /** Bulk replay into a live world (used on restore while data is already generated). */
  replayInto(world: DeltaWorldLike): number {
    this.replaying = true;
    let n = 0;
    try {
      for (const [ck, m] of this.chunks) {
        const bx = wrapChunk((ck >> 5) & 31) * S;
        const bz = (ck & 31) * S;
        for (const [li, id] of m) {
          world.setBlock(bx + lxOf(li), lyOf(li), bz + lzOf(li), id);
          n++;
        }
      }
    } finally {
      this.replaying = false;
    }
    return n;
  }

  forEachEdit(cb: (x: number, y: number, z: number, id: number) => void): void {
    for (const [ck, m] of this.chunks) {
      const bx = ((ck >> 5) & 31) * S;
      const bz = (ck & 31) * S;
      for (const [li, id] of m) cb(bx + lxOf(li), lyOf(li), bz + lzOf(li), id);
    }
  }

  /**
   * Self-shrink: an edit that restored the GENERATED value is deleted.
   * Budgeted; call from an idle path (UniverseSim background tick), never per frame.
   */
  pruneStep(
    gen: { populateChunk(d: Uint8Array, cx: number, cz: number): void },
    budgetMs = 4,
  ): number {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (!this.scratch) this.scratch = new Uint8Array(S * H * S);
    const keys = Array.from(this.chunks.keys());
    let removed = 0;
    while (keys.length > 0) {
      if (this.pruneCursor >= keys.length) {
        this.pruneCursor = 0;
        break;
      }
      const ck = keys[this.pruneCursor++];
      const m = this.chunks.get(ck);
      if (m) {
        gen.populateChunk(this.scratch, (ck >> 5) & 31, ck & 31);
        for (const [li, id] of m) {
          if (this.scratch[li] === id) {
            m.delete(li);
            removed++;
            this.stats.records--;
          }
        }
        if (m.size === 0) this.chunks.delete(ck);
      }
      if ((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 >= budgetMs) break;
    }
    this.stats.pruned += removed;
    return removed;
  }

  // ---- persistence ------------------------------------------------------
  serialize(): Uint8Array {
    let bytes = 10;
    for (const m of this.chunks.values()) bytes += 4 + m.size * 3;
    const buf = new ArrayBuffer(bytes);
    const dv = new DataView(buf);
    dv.setUint32(0, DELTA_MAGIC);
    dv.setUint16(4, DELTA_VERSION);
    dv.setUint32(6, this.chunks.size);
    let o = 10;
    for (const [ck, m] of this.chunks) {
      dv.setUint16(o, ck);
      dv.setUint16(o + 2, m.size);
      o += 4;
      for (const [li, id] of m) {
        dv.setUint16(o, li);
        dv.setUint8(o + 2, id);
        o += 3;
      }
    }
    return new Uint8Array(buf);
  }

  static deserialize(bytes: Uint8Array | null | undefined): WorldDeltaStore {
    const s = new WorldDeltaStore();
    if (!bytes || bytes.byteLength < 10) return s;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0) !== DELTA_MAGIC || dv.getUint16(4) !== DELTA_VERSION) return s;
    const chunkCount = dv.getUint32(6);
    let o = 10;
    for (let c = 0; c < chunkCount && o + 4 <= bytes.byteLength; c++) {
      const ck = dv.getUint16(o);
      const n = dv.getUint16(o + 2);
      o += 4;
      let m = s.chunks.get(ck);
      if (!m) {
        m = new Map<number, number>();
        s.chunks.set(ck, m);
      }
      for (let i = 0; i < n && o + 3 <= bytes.byteLength; i++) {
        const li = dv.getUint16(o);
        const id = dv.getUint8(o + 2);
        o += 3;
        if (li < S * H * S && !m.has(li)) {
          m.set(li, id);
          s.stats.records++;
        }
      }
    }
    return s;
  }
}

/* ====================================================================== */
/* Furnace serialization — engine keys furnaces "x,y,z" (furnaceKey).      */
/* ====================================================================== */

/**
 * Flat tuple per furnace:
 * [x, y, z, inId, inN, fuelId, fuelN, outId, outN, burn, burnMax, cook]
 */
export type FurnaceTuple = [
  number, number, number,
  number, number,
  number, number,
  number, number,
  number, number, number,
];

type SlotLike = { kind?: string; blockId: number; count: number } | null;

const slotOut = (s: SlotLike): [number, number] => (s ? [s.blockId, s.count] : [0, 0]);
const slotIn = (id: number, n: number): FurnaceState['input'] =>
  id > 0 && n > 0 ? { kind: 'block', blockId: id, count: n } : null;

export function serializeFurnaces(m: Map<string, FurnaceState>): FurnaceTuple[] {
  const out: FurnaceTuple[] = [];
  for (const [k, st] of m) {
    const p = k.split(',');
    const [ii, ic] = slotOut(st.input as SlotLike);
    const [fi, fc] = slotOut(st.fuel as SlotLike);
    const [oi, oc] = slotOut(st.output as SlotLike);
    out.push([+p[0], +p[1], +p[2], ii, ic, fi, fc, oi, oc, st.burn, st.burnMax, st.cook]);
  }
  return out;
}

export function deserializeFurnaces(a: FurnaceTuple[] | null | undefined): Map<string, FurnaceState> {
  const m = new Map<string, FurnaceState>();
  if (!a) return m;
  for (const t of a) {
    m.set(`${t[0]},${t[1]},${t[2]}`, {
      input: slotIn(t[3], t[4]),
      fuel: slotIn(t[5], t[6]),
      output: slotIn(t[7], t[8]),
      burn: t[9],
      burnMax: t[10],
      cook: t[11],
    } as FurnaceState);
  }
  return m;
}

/** Cell-space position helpers reused by the sim (kept here next to packCell users). */
export const editCellX = cellX;
export const editCellY = cellY;
export const editCellZ = cellZ;
