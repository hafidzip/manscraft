// src/game/fps/EnemyGrid.ts
//
// Counting-sort uniform grid over a player-centred window.
// Zero allocation after construction. XZ only; callers filter on Y.

import { minImageF, WORLD_SIZE } from '../core/constants';

/* ------------------------------- tunables ------------------------------- */

export const SIM_RADIUS = 112;

const CELL     = 2;
const INV_CELL = 1 / CELL;

const WINDOW = Math.min(256, WORLD_SIZE);
const HALF   = WINDOW / 2;

const W     = (WINDOW / CELL) | 0;
const CELLS = W * W;

const MAX_AGENTS = 4096;
const MAX_HITS   = 1024;

/* -------------------------------- types --------------------------------- */

export interface GridAgent {
  pos: { x: number; y: number; z: number };
  alive: boolean;
}

/* -------------------------------- grid ---------------------------------- */

export class EnemyGrid {
  private cnt      = new Int32Array(CELLS);
  private start    = new Int32Array(CELLS + 1);
  private cursor   = new Int32Array(CELLS);
  private stampArr = new Int32Array(CELLS);
  private gen      = 0;

  private cellOf   = new Int32Array(MAX_AGENTS);
  private lx       = new Float32Array(MAX_AGENTS);
  private ly       = new Float32Array(MAX_AGENTS);
  private lz       = new Float32Array(MAX_AGENTS);

  private sIdx     = new Int32Array(MAX_AGENTS);
  private sX       = new Float32Array(MAX_AGENTS);
  private sY       = new Float32Array(MAX_AGENTS);
  private sZ       = new Float32Array(MAX_AGENTS);

  readonly qIdx    = new Int32Array(MAX_HITS);
  readonly qDX     = new Float32Array(MAX_HITS);
  readonly qDY     = new Float32Array(MAX_HITS);
  readonly qDZ     = new Float32Array(MAX_HITS);
  qCount           = 0;

  private originX  = 0;
  private originZ  = 0;
  private built    = false;

  get ready() { return this.built; }

  build(agents: GridAgent[], centreX: number, centreZ: number) {
    const n       = Math.min(agents.length, MAX_AGENTS);
    this.originX  = centreX;
    this.originZ  = centreZ;
    this.cnt.fill(0);

    const cellOf = this.cellOf, lx = this.lx, ly = this.ly, lz = this.lz, cnt = this.cnt;

    for (let i = 0; i < n; i++) {
      const a = agents[i];
      if (a === undefined || !a.alive) { cellOf[i] = -1; continue; }
      const dx = minImageF(a.pos.x - centreX);
      const dz = minImageF(a.pos.z - centreZ);
      if (dx < -HALF || dx >= HALF || dz < -HALF || dz >= HALF) { cellOf[i] = -1; continue; }
      const gx = ((dx + HALF) * INV_CELL) | 0;
      const gz = ((dz + HALF) * INV_CELL) | 0;
      cellOf[i]      = gz * W + gx;
      lx[i]          = dx;
      ly[i]          = a.pos.y;
      lz[i]          = dz;
      cnt[gz * W + gx]++;
    }

    const start = this.start;
    let sum = 0;
    for (let c = 0; c < CELLS; c++) { start[c] = sum; sum += cnt[c]; }
    start[CELLS] = sum;
    this.cursor.set(start.subarray(0, CELLS));

    const cur = this.cursor, sIdx = this.sIdx, sX = this.sX, sY = this.sY, sZ = this.sZ;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      if (c < 0) continue;
      const d    = cur[c]++;
      sIdx[d]    = i;
      sX[d]      = lx[i];
      sY[d]      = ly[i];
      sZ[d]      = lz[i];
    }

    this.built = true;
  }

  query(x: number, y: number, z: number, radius: number): number {
    this.qCount   = 0;
    const qx      = minImageF(x - this.originX);
    const qz      = minImageF(z - this.originZ);
    if (qx < -HALF || qx >= HALF || qz < -HALF || qz >= HALF) return 0;

    const span = Math.max(1, Math.ceil(radius * INV_CELL));
    const gx0  = ((qx + HALF) * INV_CELL) | 0;
    const gz0  = ((qz + HALF) * INV_CELL) | 0;
    const xLo  = gx0 - span < 0 ? 0 : gx0 - span;
    const xHi  = gx0 + span > W - 1 ? W - 1 : gx0 + span;
    const zLo  = gz0 - span < 0 ? 0 : gz0 - span;
    const zHi  = gz0 + span > W - 1 ? W - 1 : gz0 + span;

    const start = this.start, sIdx = this.sIdx, sX = this.sX, sY = this.sY, sZ = this.sZ;
    const qIdx  = this.qIdx, qDX = this.qDX, qDY = this.qDY, qDZ = this.qDZ;
    let k       = 0;

    for (let gz = zLo; gz <= zHi; gz++) {
      const row = gz * W;
      const e   = start[row + xHi + 1];
      for (let d = start[row + xLo]; d < e; d++) {
        if (k >= MAX_HITS) { this.qCount = k; return k; }
        qIdx[k] = sIdx[d];
        qDX[k]  = sX[d] - qx;
        qDY[k]  = sY[d] - y;
        qDZ[k]  = sZ[d] - qz;
        k++;
      }
    }
    this.qCount = k;
    return k;
  }

  queryRay(x: number, y: number, z: number, dirX: number, dirZ: number, len: number): number {
    this.qCount   = 0;
    const gen     = ++this.gen;
    const stamp   = this.stampArr;
    if (gen === 0x7fffffff) { stamp.fill(0); this.gen = 1; }

    const steps   = Math.ceil(len * INV_CELL * 2) + 1;
    const stepLen = len / Math.max(1, steps - 1);
    const start   = this.start, sIdx = this.sIdx, sX = this.sX, sY = this.sY, sZ = this.sZ;
    const qIdx    = this.qIdx, qDX = this.qDX, qDY = this.qDY, qDZ = this.qDZ;
    const oqx     = minImageF(x - this.originX);
    const oqz     = minImageF(z - this.originZ);
    let k         = 0;

    for (let s = 0; s < steps; s++) {
      const t  = s * stepLen;
      const px = minImageF(x + dirX * t - this.originX);
      const pz = minImageF(z + dirZ * t - this.originZ);
      if (px < -HALF || px >= HALF || pz < -HALF || pz >= HALF) continue;
      const gx0 = ((px + HALF) * INV_CELL) | 0;
      const gz0 = ((pz + HALF) * INV_CELL) | 0;
      const xLo = gx0 > 0 ? gx0 - 1 : 0, xHi = gx0 < W - 1 ? gx0 + 1 : W - 1;
      const zLo = gz0 > 0 ? gz0 - 1 : 0, zHi = gz0 < W - 1 ? gz0 + 1 : W - 1;

      for (let gz = zLo; gz <= zHi; gz++) {
        const row = gz * W;
        for (let gx = xLo; gx <= xHi; gx++) {
          const c = row + gx;
          if (stamp[c] === gen) continue;
          stamp[c]  = gen;
          const e   = start[c + 1];
          for (let d = start[c]; d < e; d++) {
            if (k >= MAX_HITS) { this.qCount = k; return k; }
            qIdx[k] = sIdx[d];
            qDX[k]  = sX[d] - oqx;
            qDY[k]  = sY[d] - y;
            qDZ[k]  = sZ[d] - oqz;
            k++;
          }
        }
      }
    }
    this.qCount = k;
    return k;
  }
}

void WORLD_SIZE;
