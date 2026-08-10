
import { B, DEFS, waterId, waterInfo, WATER_MAX_LEVEL } from './blocks';
import type { World } from './world';

const FLOW_DELAY = 0.12;

/* ------------------------------------------------------------------ keys */

const KEY_Y_SHIFT = 9;
const KEY_Z_SHIFT = 17;

/**
 * Packs a world cell into a 26-bit non-negative SMI — zero allocation.
 * `x & 0x1FF` is exactly `x mod 512` for negative x too, so it matches the
 * torus world (WORLD_SIZE = 512) and cells across the seam dedupe correctly.
 */
const cellKey = (x: number, y: number, z: number): number =>
  (x & 0x1FF) | ((y & 0xFF) << KEY_Y_SHIFT) | ((z & 0x1FF) << KEY_Z_SHIFT);

const KEY_EMPTY = -1;
const KEY_TOMB  = -2;

/** Open-addressed integer set: linear probing + tombstones. No per-op alloc. */
class IntSet {
  private keys: Int32Array;
  private mask: number;
  private limit: number;
  private live = 0;
  private used = 0;

  constructor(capPow2 = 1024) {
    this.keys  = new Int32Array(capPow2).fill(KEY_EMPTY);
    this.mask  = capPow2 - 1;
    this.limit = (capPow2 * 3) >> 2;   // keep >=25% of slots EMPTY
  }

  get size(): number { return this.live; }

  private slotOf(k: number, mask: number): number {
    return (Math.imul(k, 0x9E3779B1) >>> 15) & mask;   // Knuth multiplicative
  }

  /** has + add in a single probe. Returns true if newly inserted. */
  add(k: number): boolean {
    const t = this.keys, m = this.mask;
    let i = this.slotOf(k, m);
    let tomb = -1;
    for (;;) {
      const v = t[i];
      if (v === k) return false;
      if (v === KEY_EMPTY) {
        if (tomb >= 0) { t[tomb] = k; } else { t[i] = k; this.used++; }
        this.live++;
        if (this.used >= this.limit) this.rehash();
        return true;
      }
      if (v === KEY_TOMB && tomb < 0) tomb = i;
      i = (i + 1) & m;
    }
  }

  delete(k: number): boolean {
    const t = this.keys, m = this.mask;
    let i = this.slotOf(k, m);
    for (;;) {
      const v = t[i];
      if (v === k) { t[i] = KEY_TOMB; this.live--; return true; }
      if (v === KEY_EMPTY) return false;
      i = (i + 1) & m;
    }
  }

  clear(): void {
    this.keys.fill(KEY_EMPTY);
    this.live = 0; this.used = 0;
  }

  private rehash(): void {
    const old = this.keys;
    let cap = old.length;
    if (this.live * 2 >= cap) cap <<= 1;
    const t = new Int32Array(cap).fill(KEY_EMPTY);
    const m = cap - 1;
    for (let i = 0; i < old.length; i++) {
      const k = old[i];
      if (k < 0) continue;
      let j = this.slotOf(k, m);
      while (t[j] >= 0) j = (j + 1) & m;
      t[j] = k;
    }
    this.keys = t; this.mask = m;
    this.used = this.live;
    this.limit = (cap * 3) >> 2;
  }
}

/* ------------------------------------------------------------ ring queue */

// Next power of two >= the old MAX_QUEUE so head/count wrap with a mask.
const QCAP  = 8192;
const QMASK = QCAP - 1;

export class FluidSim {
  private qKey   = new Int32Array(QCAP);
  private qTime  = new Float64Array(QCAP);
  private qHead  = 0;
  private qCount = 0;
  private pending = new IntSet();
  private now = 0;

  constructor(private world: World) {}

  poke(x: number, y: number, z: number, delay = FLOW_DELAY): void {
    if (y < 0 || y >= 80) return;              // WORLD_HEIGHT guard
    if (this.qCount >= QCAP) return;           // drop-on-overflow, as before
    const k = cellKey(x, y, z);
    if (!this.pending.add(k)) return;          // already queued: one probe
    const w = (this.qHead + this.qCount) & QMASK;
    this.qKey[w]  = k;
    this.qTime[w] = this.now + delay;
    this.qCount++;
  }

  pokeAround(x: number, y: number, z: number, delay = FLOW_DELAY): void {
    this.poke(x, y, z, delay);
    this.poke(x + 1, y, z, delay);
    this.poke(x - 1, y, z, delay);
    this.poke(x, y, z + 1, delay);
    this.poke(x, y, z - 1, delay);
    this.poke(x, y + 1, z, delay);
    this.poke(x, y - 1, z, delay);
  }

  update(dt: number): void {
    this.now += dt;
    const keys = this.qKey, times = this.qTime;

    // Nothing due -> don't open a world batch at all.
    if (this.qCount === 0 || times[this.qHead] > this.now) return;

    this.world.beginBatch();
    let processed = 0;

    // qHead/qCount advance BEFORE recompute(), because recompute() re-enters
    // poke() for neighbours and needs the live write cursor.
    while (this.qCount > 0 && processed < 420) {
      const h = this.qHead;
      if (times[h] > this.now) break;          // monotone FIFO
      const k = keys[h];
      this.qHead = (h + 1) & QMASK;
      this.qCount--;
      this.pending.delete(k);
      this.recompute(
        k & 0x1FF,
        (k >>> KEY_Y_SHIFT) & 0xFF,
        (k >>> KEY_Z_SHIFT) & 0x1FF,
      );
      processed++;
    }
    this.world.endBatch();
  }

  /** Additive API — drop stale work on world regen / teleport. */
  clear(): void {
    this.qHead = 0;
    this.qCount = 0;
    this.pending.clear();
  }

  /* -------------------------------------------------------- water physics
     Unchanged from the original implementation; coordinates now arrive
     normalised into [0,512)/[0,80) which world.getBlockRaw/setBlock already
     wrap internally. */

  private g(x: number, y: number, z: number): number {
    return this.world.getBlockRaw(x, y, z);
  }

  private replaceable(id: number): boolean {
    if (id === -1) return false;
    return id === B.AIR || DEFS[id].cross === true;
  }

  private hasSupport(x: number, y: number, z: number): boolean {
    const below = this.g(x, y - 1, z);
    if (below === -1) return true;
    if (DEFS[below].solid) return true;
    const bi = waterInfo(below);
    return bi !== null && !bi.falling;
  }

  private recompute(x: number, y: number, z: number): void {
    const id = this.g(x, y, z);
    const info = waterInfo(id);
    if (!info) return;

    if (info.level === 0 && !info.falling) {
      this.fallBelow(x, y, z, 0);
      if (this.hasSupport(x, y, z)) this.spreadHorizontal(x, y, z, 1);
      return;
    }

    if (info.falling) {
      const ai = waterInfo(this.g(x, y + 1, z));
      if (!ai) {
        this.drain(x, y, z);
        return;
      }
      if (ai.level !== info.level) {
        this.world.setBlock(x, y, z, waterId(ai.level, true));
        this.poke(x, y, z);
      }
      this.fallBelow(x, y, z, ai.level);
      if (this.hasSupport(x, y, z) && ai.level < WATER_MAX_LEVEL) {
        this.spreadHorizontal(x, y, z, ai.level + 1);
      }
      return;
    }

    const H_OFF: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    let best = Infinity;
    for (const [ox, oz] of H_OFF) {
      const ni = waterInfo(this.g(x + ox, y, z + oz));
      if (!ni) continue;
      const feeds = !ni.falling || this.hasSupport(x + ox, y, z + oz);
      if (feeds) best = Math.min(best, ni.level + 1);
    }
    if (best > WATER_MAX_LEVEL) {
      this.drain(x, y, z);
      return;
    }
    if (best !== info.level) {
      this.world.setBlock(x, y, z, waterId(best, false));
      this.poke(x, y, z);
    }
    this.fallBelow(x, y, z, best);
    if (this.hasSupport(x, y, z) && best < WATER_MAX_LEVEL) {
      this.spreadHorizontal(x, y, z, best + 1);
    }
  }

  private fallBelow(x: number, y: number, z: number, level: number): void {
    const below = this.g(x, y - 1, z);
    if (this.replaceable(below)) {
      this.world.setBlock(x, y - 1, z, waterId(level, true));
      this.poke(x, y - 1, z);
      return;
    }
    const bi = waterInfo(below);
    if (bi && bi.falling && bi.level !== level) {
      this.world.setBlock(x, y - 1, z, waterId(level, true));
      this.poke(x, y - 1, z);
    }
  }

  private spreadHorizontal(x: number, y: number, z: number, childLevel: number): void {
    const H_OFF: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [ox, oz] of H_OFF) {
      const nx = x + ox;
      const nz = z + oz;
      const nid = this.g(nx, y, nz);
      if (this.replaceable(nid)) {
        this.world.setBlock(nx, y, nz, waterId(childLevel, false));
        this.poke(nx, y, nz);
        continue;
      }
      const ni = waterInfo(nid);
      if (ni && !ni.falling && ni.level > childLevel) {
        this.world.setBlock(nx, y, nz, waterId(childLevel, false));
        this.poke(nx, y, nz);
      }
    }
  }

  private drain(x: number, y: number, z: number): void {
    this.world.setBlock(x, y, z, B.AIR);
    this.pokeAround(x, y, z);
  }
}
