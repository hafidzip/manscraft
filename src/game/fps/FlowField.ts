// src/game/fps/FlowField.ts
//
// One attractor (the player), many followers. Replaces per-enemy A* for the
// steady-state chase. Integer Dijkstra over a torus-aligned walkable-height
// field, drained by a Dial bucket queue, double-buffered and time-sliced.
//
// Every buffer is allocated once in the constructor. No steady-state garbage.

import { WORLD_SIZE, WORLD_HEIGHT } from '../core/constants';
import { B, isWaterId, DEFS } from '../world/blocks';

/* ------------------------------------------------------------- geometry */

// `& MASK` is only a valid torus wrap on a power-of-two world.
if ((WORLD_SIZE & (WORLD_SIZE - 1)) !== 0) {
  throw new Error(`FlowField: WORLD_SIZE=${WORLD_SIZE} must be a power of two`);
}

const FIELD = WORLD_SIZE;          // one field cell == one world column
const MASK  = FIELD - 1;           // `& MASK` IS the torus wrap
const SHIFT = Math.log2(FIELD) | 0;
const CELLS = FIELD * FIELD;

/* --------------------------------------------------------------- tuning */

const HEADROOM = 2;                // air blocks an agent needs to stand up in
const MAX_STEP = 1;                // blocks climbable without a jump assist
const MAX_DROP = 4;                // blocks the agent will voluntarily fall

// Fixed point: 16 units == 1 block of travel.
const Q           = 16;
const C_STRAIGHT  = 16;
const C_DIAG      = 23;            // round(sqrt(2) * 16)
const C_CLIMB     = 8;             // per block climbed
const C_DROP      = 4;             // per block dropped
const C_WATER     = 96;            // passable, unattractive
const C_LEAVES    = 64;
const C_EXTRA_MAX = 200;
const BLOCKED     = 255;           // extra[] sentinel: column not walkable
const NO_SURFACE  = -1;            // surfY[] sentinel

const MAX_EDGE = C_DIAG + C_CLIMB * MAX_STEP + C_DROP * MAX_DROP + C_EXTRA_MAX;
const RING     = 256;              // power of two, must exceed MAX_EDGE
if (RING <= MAX_EDGE) throw new Error('FlowField: RING must exceed MAX_EDGE');

const UNREACHABLE = 0x3fffffff;    // finite. Never Infinity. Never NaN.
const MAX_COST    = 130 * C_STRAIGHT;  // stop expanding past ~130 blocks
const WALL_BIAS   = 2 * C_STRAIGHT;    // how much worse than "here" a wall reads
const ARRIVE_COST = 2 * C_STRAIGHT;    // inside this, melee steering takes over
const SEED_SEARCH = 3;             // radius, in columns, of the seed hunt

const EXPAND_BUDGET  = 9000;       // cell expansions per frame
const TIME_GUARD_MS  = 1.5;        // hard wall-clock stop
const SURFACE_BUDGET = 4096;       // columns re-derived per frame

const NEW = 0, OPEN = 1, SETTLED = 2;

// DX/DZ kept for reference but expand() uses hoisted address math instead.
void Int8Array; // suppress unused warnings

const RMASK = RING - 1;

/** ROW[z] === z << SHIFT — kills the shift in neighbour address math. */
const ROW: Int32Array = (() => {
  const t = new Int32Array(FIELD);
  for (let z = 0; z < FIELD; z++) t[z] = z << SHIFT;
  return t;
})();

// Scratch for the optimized expand: orthogonal + diagonal neighbour indices.
const ORTH_IDX = new Int32Array(4);
const ORTH_OK  = new Uint8Array(4);
const DIAG_IDX = new Int32Array(4);
const DIAG_CX  = new Uint8Array([0, 1, 0, 1]);
const DIAG_CZ  = new Uint8Array([2, 2, 3, 3]);

/* --------------------------------------------------------------- public */

export interface FlowSample {
  x: number;        // unit vector toward the player, XZ plane
  z: number;
  targetY: number;  // walkable Y of the column being stepped into, or -1
  climb: number;    // targetY - surfaceY(here): > 0 means "jump"
  cost: number;     // remaining travel to the player, in blocks
}

export interface FlowWorld {
  /** Y of the topmost non-air block in this column. */
  highestY(x: number, z: number): number;
  solid(x: number, y: number, z: number): boolean;
  /** Block id; < 0 when the column is not loaded. */
  get(x: number, y: number, z: number): number;
}

export class FlowField {
  /* cost fields, double buffered ---------------------------------------- */
  private costA = new Int32Array(CELLS);
  private costB = new Int32Array(CELLS);
  private front = this.costA;
  private back  = this.costB;
  private isReady = false;

  /* walkable surface, independent of the player -------------------------- */
  private surfY        = new Int16Array(CELLS);
  private extra        = new Uint8Array(CELLS);
  private surfaceReady = false;
  private scanCursor   = 0;
  private dirtyList: number[] = [];
  private dirtyMark    = new Uint8Array(CELLS);

  /* Dial bucket queue ---------------------------------------------------- */
  private bHead   = new Int32Array(RING);
  private bPrev   = new Int32Array(CELLS);
  private bNext   = new Int32Array(CELLS);
  private state   = new Uint8Array(CELLS);
  private open    = 0;
  private curCost = 0;

  /* build state machine -------------------------------------------------- */
  private building         = false;
  private rebuildRequested = true;

  /* instrumentation ------------------------------------------------------ */
  private lastNodes      = 0;
  private nodesThisBuild = 0;
  private lastBuildMs    = 0;
  private buildStartMs   = 0;

  constructor() {
    this.costA.fill(UNREACHABLE);
    this.costB.fill(UNREACHABLE);
    this.surfY.fill(NO_SURFACE);
    this.extra.fill(BLOCKED);
    this.bHead.fill(-1);
  }

  /* ------------------------------------------------------------ mutation */

  /** Ask for a fresh field. Does NOT abort a build already in flight. */
  invalidate() { this.rebuildRequested = true; }

  /** Player teleport / respawn: throw away the in-flight build and restart. */
  invalidateNow() { this.rebuildRequested = true; this.building = false; }

  /** One block placed or broken. Cheap: re-derives a single column. */
  markColumnDirty(x: number, z: number) {
    const i = (x & MASK) + ((z & MASK) << SHIFT);
    if (this.dirtyMark[i]) return;
    this.dirtyMark[i] = 1;
    this.dirtyList.push(i);
  }

  /** Chunk (un)load. */
  markChunkDirty(chunkX: number, chunkZ: number, size: number) {
    const bx = chunkX * size, bz = chunkZ * size;
    for (let z = 0; z < size; z++) {
      for (let x = 0; x < size; x++) this.markColumnDirty(bx + x, bz + z);
    }
  }

  /* ---------------------------------------------------------------- tick */

  /** Call once per frame, AFTER world.update() so streamed chunks are live. */
  update(px: number, py: number, pz: number, world: FlowWorld) {
    this.maintainSurface(world);
    if (!this.surfaceReady) return;

    if (!this.building && this.rebuildRequested) {
      if (this.beginBuild(px, py, pz)) {
        this.rebuildRequested = false;
        this.building = true;
      }
      // No valid seed this frame: keep serving the previous field, retry next.
    }

    if (this.building && this.expand()) {
      // Drained. Publish atomically: one pointer swap, no torn reads.
      const t = this.front; this.front = this.back; this.back = t;
      this.isReady    = true;
      this.building   = false;
      this.lastNodes  = this.nodesThisBuild;
      this.lastBuildMs = performance.now() - this.buildStartMs;
    }
  }

  /* ------------------------------------------------------------- surface */

  private maintainSurface(world: FlowWorld) {
    if (!this.surfaceReady) {
      const end = Math.min(CELLS, this.scanCursor + SURFACE_BUDGET);
      for (let i = this.scanCursor; i < end; i++) this.deriveColumn(i, world);
      this.scanCursor = end;
      if (this.scanCursor >= CELLS) this.surfaceReady = true;
      return;
    }
    let touched = 0;
    while (touched < SURFACE_BUDGET && this.dirtyList.length > 0) {
      const i = this.dirtyList.pop()!;
      this.dirtyMark[i] = 0;
      this.deriveColumn(i, world);
      touched++;
    }
    if (touched > 0) this.rebuildRequested = true;
  }

  /**
   * Walkability for one column.
   *
   * NOTE: world.highestY() returns the Y of the topmost NON-AIR block, so the
   * standable feet position is one above it. (The doc's version assumed
   * highestY already returned the feet Y, which would reject every column.)
   */
  private deriveColumn(i: number, world: FlowWorld) {
    const x = i & MASK, z = i >>> SHIFT;
    this.surfY[i] = NO_SURFACE;
    this.extra[i] = BLOCKED;

    const top = world.highestY(x, z);
    if (top < 1) return;

    // highestY() returns the topmost NON-AIR block, which on ordinary terrain
    // is usually tall grass, a flower, a torch or a ghost machine. Walk down
    // past that decoration to the first real standable block, or almost every
    // grassy column would read as unwalkable.
    let sy = top;
    let floor = world.get(x, sy, z);
    for (let guard = 0; guard < 6; guard++) {
      if (floor < 0) return;                        // not loaded
      if (floor !== B.AIR && (isWaterId(floor) || DEFS[floor]?.solid)) break;
      sy--;
      if (sy < 1) return;
      floor = world.get(x, sy, z);
    }
    if (floor < 0 || floor === B.AIR) return;
    if (!isWaterId(floor) && !DEFS[floor]?.solid) return;

    const feet = sy + 1;
    if (feet < 1 || feet >= WORLD_HEIGHT - HEADROOM) return;

    // Need clear air for the agent's body. world.solid() is false for grass
    // and flowers, so decoration does not block headroom.
    for (let k = 0; k < HEADROOM; k++) if (world.solid(x, feet + k, z)) return;

    let extra = 0;
    if (isWaterId(floor)) extra = C_WATER;
    else if (floor === B.LEAVES) extra = C_LEAVES;

    if (extra > C_EXTRA_MAX) extra = C_EXTRA_MAX;

    this.surfY[i] = feet;
    this.extra[i] = extra;
  }

  /* --------------------------------------------------------------- build */

  private beginBuild(px: number, py: number, pz: number): boolean {
    const seed = this.findSeed(px, py, pz);
    if (seed < 0) return false;

    this.back.fill(UNREACHABLE);
    this.state.fill(NEW);
    this.bHead.fill(-1);
    this.open           = 0;
    this.curCost        = 0;
    this.nodesThisBuild = 0;
    this.buildStartMs   = performance.now();

    this.back[seed]  = 0;
    this.state[seed] = OPEN;
    this.link(seed, 0);
    return true;
  }

  /**
   * The player is often not standing on the column they occupy — mid-jump,
   * swimming, on a ladder. Hunt a nearby column on the same storey.
   */
  private findSeed(px: number, py: number, pz: number): number {
    const bx = Math.floor(px) & MASK, bz = Math.floor(pz) & MASK;
    let best = -1, bestD = Infinity;
    for (let dz = -SEED_SEARCH; dz <= SEED_SEARCH; dz++) {
      for (let dx = -SEED_SEARCH; dx <= SEED_SEARCH; dx++) {
        const i = ((bx + dx) & MASK) + ((((bz + dz) & MASK)) << SHIFT);
        const y = this.surfY[i];
        if (y === NO_SURFACE || this.extra[i] === BLOCKED) continue;
        const dy = y - py;
        if (dy > 3 || dy < -6) continue;   // wrong storey
        const d = dx * dx + dz * dz + dy * dy * 4;
        if (d < bestD) { bestD = d; best = i; }
      }
    }
    return best;
  }

  /** Drains the queue within budget. Returns true when the field is complete. */
  private expand(): boolean {
    const dist = this.back, surf = this.surfY, extra = this.extra;
    const state = this.state, bHead = this.bHead;
    const orthIdx = ORTH_IDX, orthOk = ORTH_OK, diagIdx = DIAG_IDX;
    const tEnd = performance.now() + TIME_GUARD_MS;
    let budget = EXPAND_BUDGET;

    while (this.open > 0) {
      if (--budget < 0) return false;
      if ((budget & 2047) === 0 && performance.now() > tEnd) return false;

      // Bucket scan: only advance curCost when needed.
      let b = this.curCost & RMASK;
      if (bHead[b] === -1) {
        let cc = this.curCost;
        do { cc++; b = cc & RMASK; } while (bHead[b] === -1);
        this.curCost = cc;
      }

      const idx = bHead[b];
      this.unlink(idx, b);
      state[idx] = SETTLED;
      this.nodesThisBuild++;

      const cost = dist[idx];
      if (cost + C_STRAIGHT > MAX_COST) continue; // early-out at frontier edge

      const fromY    = surf[idx];
      const climbCap = fromY + MAX_STEP;
      const dropCap  = fromY - MAX_DROP;

      // Hoisted address math: 4 wrapped adds + 2 ROW loads instead of 16 mask ops.
      const cx = idx & MASK;
      const rc = idx - cx;                    // === cz << SHIFT, for free
      const xp = (cx + 1) & MASK, xm = (cx - 1) & MASK;
      const cz = idx >>> SHIFT;
      const rp = ROW[(cz + 1) & MASK], rm = ROW[(cz - 1) & MASK];

      orthIdx[0] = xp + rc; orthIdx[1] = xm + rc;
      orthIdx[2] = cx + rp; orthIdx[3] = cx + rm;
      diagIdx[0] = xp + rp; diagIdx[1] = xm + rp;
      diagIdx[2] = xp + rm; diagIdx[3] = xm + rm;

      // Pass 1: orthogonals. Cache the surface test for diagonal companions.
      for (let d = 0; d < 4; d++) {
        const nidx = orthIdx[d];
        const toY  = surf[nidx];
        const ok   = toY !== NO_SURFACE && toY <= climbCap && toY >= dropCap;
        orthOk[d]  = ok ? 1 : 0;
        if (!ok) continue;

        const st = state[nidx];
        if (st === SETTLED) continue;
        const e = extra[nidx];
        if (e === BLOCKED) continue;

        const dy = toY - fromY;
        const nc = cost + C_STRAIGHT + e +
                   (dy > 0 ? C_CLIMB * dy : dy < 0 ? C_DROP * -dy : 0);
        const dn = dist[nidx];
        if (nc > MAX_COST || nc >= dn) continue;

        if (st === OPEN) this.unlink(nidx, dn & RMASK);
        dist[nidx]  = nc;
        state[nidx] = OPEN;
        this.link(nidx, nc & RMASK);
      }

      // Pass 2: diagonals. Rejected when either orthogonal companion fails.
      for (let d = 0; d < 4; d++) {
        if (orthOk[DIAG_CX[d]] === 0 || orthOk[DIAG_CZ[d]] === 0) continue;

        const nidx = diagIdx[d];
        const st   = state[nidx];
        if (st === SETTLED) continue;
        const toY  = surf[nidx];
        if (toY === NO_SURFACE || toY > climbCap || toY < dropCap) continue;
        const e = extra[nidx];
        if (e === BLOCKED) continue;

        const dy = toY - fromY;
        const nc = cost + C_DIAG + e +
                   (dy > 0 ? C_CLIMB * dy : dy < 0 ? C_DROP * -dy : 0);
        const dn = dist[nidx];
        if (nc > MAX_COST || nc >= dn) continue;

        if (st === OPEN) this.unlink(nidx, dn & RMASK);
        dist[nidx]  = nc;
        state[nidx] = OPEN;
        this.link(nidx, nc & RMASK);
      }
    }
    return true;
  }

  private link(idx: number, b: number) {
    const h = this.bHead[b];
    this.bPrev[idx] = -1;
    this.bNext[idx] = h;
    if (h !== -1) this.bPrev[h] = idx;
    this.bHead[b] = idx;
    this.open++;
  }

  private unlink(idx: number, b: number) {
    const p = this.bPrev[idx], n = this.bNext[idx];
    if (p === -1) this.bHead[b] = n; else this.bNext[p] = n;
    if (n !== -1) this.bPrev[n] = p;
    this.open--;
  }

  /* -------------------------------------------------------------- sample */

  private gx = 0;
  private gz = 0;

  /**
   * Unit vector toward the player. Returns false when the caller must fall
   * back to A* or wander: no field yet, unreachable, wrong storey, already
   * on top of the player, or standing on a plateau.
   */
  sample(wx: number, wy: number, wz: number, out: FlowSample): boolean {
    if (!this.isReady) return false;

    const bx = Math.floor(wx), bz = Math.floor(wz);
    const i  = (bx & MASK) + ((bz & MASK) << SHIFT);
    const c  = this.front[i];
    if (c >= UNREACHABLE) return false;

    const sy = this.surfY[i];
    if (sy === NO_SURFACE) return false;
    if (wy - sy > 3 || sy - wy > 3) return false;   // cave / bridge: not our layer
    if (c <= ARRIVE_COST) return false;             // melee steering owns this

    // Bilinear blend of the four nearest cell-centre gradients. Without this
    // the direction snaps at every cell border and the crowd jitters.
    const fx  = wx - bx - 0.5, fz = wz - bz - 0.5;
    const i0x = fx < 0 ? bx - 1 : bx, i0z = fz < 0 ? bz - 1 : bz;
    const tx  = fx < 0 ? fx + 1 : fx, tz  = fz < 0 ? fz + 1 : fz;

    let gx = 0, gz = 0, wsum = 0;
    for (let k = 0; k < 4; k++) {
      const ox = k & 1, oz = k >> 1;
      const w  = (ox ? tx : 1 - tx) * (oz ? tz : 1 - tz);
      if (w <= 0) continue;
      if (!this.gradAt((i0x + ox) & MASK, (i0z + oz) & MASK)) continue;
      gx += this.gx * w; gz += this.gz * w; wsum += w;
    }
    if (wsum <= 0) return false;

    const m = Math.sqrt(gx * gx + gz * gz);
    if (m < 1e-4) return false;                     // plateau / local minimum

    out.x = gx / m;
    out.z = gz / m;

    const sx = out.x > 0.4 ? 1 : out.x < -0.4 ? -1 : 0;
    const sz = out.z > 0.4 ? 1 : out.z < -0.4 ? -1 : 0;
    const ti = ((bx + sx) & MASK) + ((((bz + sz) & MASK)) << SHIFT);
    const ty = this.surfY[ti];
    out.targetY = ty;
    out.climb   = ty === NO_SURFACE ? 0 : ty - sy;
    out.cost    = c / Q;
    return true;
  }

  /** Descent direction at a cell centre, written to this.gx / this.gz. */
  private gradAt(cx: number, cz: number): boolean {
    const f    = this.front;
    const base = f[cx + (cz << SHIFT)];
    if (base >= UNREACHABLE) return false;
    const xp = this.at(cx + 1, cz, base), xm = this.at(cx - 1, cz, base);
    const zp = this.at(cx, cz + 1, base), zm = this.at(cx, cz - 1, base);
    // Cost rises away from the player, so descent is -(d cost).
    this.gx = (xm - xp) * 0.5;
    this.gz = (zm - zp) * 0.5;
    return true;
  }

  /** Neighbour cost; a wall reads as slightly worse than here, so the
   *  gradient pushes away from it instead of producing a NaN. */
  private at(cx: number, cz: number, base: number): number {
    const v = this.front[(cx & MASK) + ((cz & MASK) << SHIFT)];
    return v >= UNREACHABLE ? base + WALL_BIAS : v;
  }

  /* ---------------------------------------------------------------- HUD */

  stats() {
    return {
      ready:        this.isReady,
      building:     this.building,
      openCells:    this.open,
      lastNodes:    this.lastNodes,
      lastBuildMs:  this.lastBuildMs,
      dirtyColumns: this.dirtyList.length,
    };
  }
}
