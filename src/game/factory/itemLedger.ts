/* eslint-disable no-bitwise */
import { WORLD_HEIGHT, CHUNK_LOG2, wrapBlock, minImageF } from '../core/constants';
import { packCell, cellX, cellY, cellZ, packChunk, chunkRadiusFor } from '../core/cellKey';
import { DEFS, isConveyor } from '../world/blocks';

export const LEDGER_MAGIC = 0x4d43494c;
export const LEDGER_VERSION = 1;

export const BELT_SPEED = 2.6;
export const BELT_CELL_CAP = 8;

const NIL = -1;

export const clampCellY = (y: number): number =>
  y < 0 ? 0 : y >= WORLD_HEIGHT ? WORLD_HEIGHT - 1 : y | 0;

export const ledgerCell = (x: number, y: number, z: number): number =>
  packCell(wrapBlock(Math.floor(x)), clampCellY(Math.floor(y)), wrapBlock(Math.floor(z)));

export interface TakeResult {
  id: number;
  count: number;
  cell: number;
}

export class ItemLedger {
  private cap: number;
  private sCell: Int32Array;
  private sId: Int32Array;
  private sCount: Float64Array;
  private sNext: Int32Array;
  private head = new Map<number, number>();
  private byChunk = new Map<number, Set<number>>();
  private freeHead = NIL;
  private top = 0;
  private liveSlots = 0;

  total = 0;

  readonly stats = { added: 0, removed: 0, moved: 0, grows: 0, peakStacks: 0, voided: 0 };

  readonly out: TakeResult = { id: 0, count: 0, cell: 0 };

  constructor(initialCapacity = 1024) {
    this.cap = Math.max(64, initialCapacity | 0);
    this.sCell = new Int32Array(this.cap);
    this.sId = new Int32Array(this.cap);
    this.sCount = new Float64Array(this.cap);
    this.sNext = new Int32Array(this.cap);
  }

  get stackCount(): number {
    return this.liveSlots;
  }
  get cellCount(): number {
    return this.head.size;
  }
  get bytes(): number {
    return this.cap * 20 + this.head.size * 48;
  }

  private grow(): void {
    const n = this.cap * 2;
    const c = new Int32Array(n);
    c.set(this.sCell);
    this.sCell = c;
    const i = new Int32Array(n);
    i.set(this.sId);
    this.sId = i;
    const k = new Float64Array(n);
    k.set(this.sCount);
    this.sCount = k;
    const x = new Int32Array(n);
    x.set(this.sNext);
    this.sNext = x;
    this.cap = n;
    this.stats.grows++;
  }

  private alloc(): number {
    let s = this.freeHead;
    if (s !== NIL) this.freeHead = this.sNext[s];
    else {
      if (this.top >= this.cap) this.grow();
      s = this.top++;
    }
    this.liveSlots++;
    if (this.liveSlots > this.stats.peakStacks) this.stats.peakStacks = this.liveSlots;
    return s;
  }

  private release(s: number): void {
    this.sCell[s] = -1;
    this.sId[s] = 0;
    this.sCount[s] = 0;
    this.sNext[s] = this.freeHead;
    this.freeHead = s;
    this.liveSlots--;
  }

  private indexCell(cell: number): void {
    const ck = packChunk(cellX(cell) >> CHUNK_LOG2, cellZ(cell) >> CHUNK_LOG2);
    let set = this.byChunk.get(ck);
    if (!set) {
      set = new Set<number>();
      this.byChunk.set(ck, set);
    }
    set.add(cell);
  }

  private unindexCell(cell: number): void {
    const ck = packChunk(cellX(cell) >> CHUNK_LOG2, cellZ(cell) >> CHUNK_LOG2);
    const set = this.byChunk.get(ck);
    if (!set) return;
    set.delete(cell);
    if (set.size === 0) this.byChunk.delete(ck);
  }

  private unlink(cell: number, slot: number): void {
    const p = this.head.get(cell) ?? NIL;
    if (p === slot) {
      const nx = this.sNext[slot];
      if (nx === NIL) {
        this.head.delete(cell);
        this.unindexCell(cell);
      } else this.head.set(cell, nx);
      return;
    }
    let cur = p;
    while (cur !== NIL) {
      const nx = this.sNext[cur];
      if (nx === slot) {
        this.sNext[cur] = this.sNext[slot];
        return;
      }
      cur = nx;
    }
  }

  addAtCell(cell: number, itemId: number, n = 1): void {
    if (n <= 0 || itemId <= 0) return;
    let remaining = n;
    for (let p = this.head.get(cell) ?? NIL; p !== NIL && remaining > 0; p = this.sNext[p]) {
      if (this.sId[p] !== itemId) continue;
      this.sCount[p] += remaining;
      remaining = 0;
    }
    if (remaining > 0) {
      const s = this.alloc();
      this.sCell[s] = cell;
      this.sId[s] = itemId;
      this.sCount[s] = remaining;
      const h = this.head.get(cell) ?? NIL;
      this.sNext[s] = h;
      this.head.set(cell, s);
      if (h === NIL) this.indexCell(cell);
    }
    this.total += n;
    this.stats.added += n;
  }

  add(x: number, y: number, z: number, itemId: number, n = 1): void {
    this.addAtCell(ledgerCell(x, y, z), itemId, n);
  }

  takeAnyFromCell(cell: number, n = 1): number {
    const p = this.head.get(cell) ?? NIL;
    if (p === NIL) {
      this.out.id = 0;
      this.out.count = 0;
      this.out.cell = cell;
      return 0;
    }
    const take = Math.min(n, this.sCount[p]);
    this.sCount[p] -= take;
    this.total -= take;
    this.stats.removed += take;
    this.out.id = this.sId[p];
    this.out.count = take;
    this.out.cell = cell;
    if (this.sCount[p] <= 0) {
      this.unlink(cell, p);
      this.release(p);
    }
    return take;
  }

  takeFromCell(cell: number, itemId: number, n = 1): number {
    for (let p = this.head.get(cell) ?? NIL; p !== NIL; p = this.sNext[p]) {
      if (this.sId[p] !== itemId) continue;
      const take = Math.min(n, this.sCount[p]);
      this.sCount[p] -= take;
      this.total -= take;
      this.stats.removed += take;
      this.out.id = itemId;
      this.out.count = take;
      this.out.cell = cell;
      if (this.sCount[p] <= 0) {
        this.unlink(cell, p);
        this.release(p);
      }
      return take;
    }
    this.out.id = 0;
    this.out.count = 0;
    this.out.cell = cell;
    return 0;
  }

  countAtCell(cell: number): number {
    let n = 0;
    for (let p = this.head.get(cell) ?? NIL; p !== NIL; p = this.sNext[p]) n += this.sCount[p];
    return n;
  }

  takeOneAt(x: number, y: number, z: number, radius = 0.55): number {
    const bx = wrapBlock(Math.floor(x));
    const by = clampCellY(Math.floor(y));
    const bz = wrapBlock(Math.floor(z));
    if (this.takeAnyFromCell(ledgerCell(bx, by + 1, bz), 1) > 0) return this.out.id;
    if (this.takeAnyFromCell(ledgerCell(bx, by, bz), 1) > 0) return this.out.id;
    if (radius > 0.5) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          if (dx * dx + dz * dz > (radius + 0.5) * (radius + 0.5)) continue;
          if (this.takeAnyFromCell(ledgerCell(bx + dx, by + 1, bz + dz), 1) > 0) return this.out.id;
          if (this.takeAnyFromCell(ledgerCell(bx + dx, by, bz + dz), 1) > 0) return this.out.id;
        }
      }
    }
    if (this.takeAnyFromCell(ledgerCell(bx, by - 1, bz), 1) > 0) return this.out.id;
    return 0;
  }

  drainCell(cell: number, cb: (id: number, count: number) => void, maxUnits = Infinity): number {
    let drained = 0;
    let p = this.head.get(cell) ?? NIL;
    while (p !== NIL && drained < maxUnits) {
      const nx = this.sNext[p];
      const take = Math.min(maxUnits - drained, this.sCount[p]);
      this.sCount[p] -= take;
      drained += take;
      cb(this.sId[p], take);
      if (this.sCount[p] <= 0) {
        this.unlink(cell, p);
        this.release(p);
      }
      p = nx;
    }
    this.total -= drained;
    this.stats.removed += drained;
    return drained;
  }

  voidCell(cell: number): number {
    let lost = 0;
    let p = this.head.get(cell) ?? NIL;
    while (p !== NIL) {
      const nx = this.sNext[p];
      lost += this.sCount[p];
      this.unlink(cell, p);
      this.release(p);
      p = nx;
    }
    if (lost > 0) {
      this.total -= lost;
      this.stats.voided += lost;
      this.stats.removed += lost;
    }
    return lost;
  }

  moveCell(from: number, to: number, max: number): number {
    if (from === to || max <= 0) return 0;
    let moved = 0;
    while (moved < max) {
      const took = this.takeAnyFromCell(from, max - moved);
      if (took <= 0) break;
      this.addAtCell(to, this.out.id, this.out.count);
      moved += took;
    }
    if (moved > 0) this.stats.moved += moved;
    return moved;
  }

  forEachStackInCell(cell: number, cb: (id: number, count: number) => void): void {
    for (let p = this.head.get(cell) ?? NIL; p !== NIL; p = this.sNext[p]) {
      cb(this.sId[p], this.sCount[p]);
    }
  }

  forEachOccupiedNear(
    px: number,
    pz: number,
    blockRadius: number,
    cb: (cell: number, dx: number, dz: number, d2: number) => void,
  ): void {
    const cr = chunkRadiusFor(blockRadius);
    const pcx = wrapBlock(Math.floor(px)) >> CHUNK_LOG2;
    const pcz = wrapBlock(Math.floor(pz)) >> CHUNK_LOG2;
    const r2 = blockRadius * blockRadius;
    for (let dz = -cr; dz <= cr; dz++) {
      for (let dx = -cr; dx <= cr; dx++) {
        const set = this.byChunk.get(packChunk(pcx + dx, pcz + dz));
        if (!set) continue;
        for (const cell of set) {
          const ix = minImageF(cellX(cell) + 0.5 - px);
          const iz = minImageF(cellZ(cell) + 0.5 - pz);
          const d2 = ix * ix + iz * iz;
          if (d2 <= r2) cb(cell, ix, iz, d2);
        }
      }
    }
  }

  countsInRadius(
    px: number,
    py: number,
    pz: number,
    blockRadius: number,
    out: Map<number, number>,
  ): Map<number, number> {
    out.clear();
    this.forEachOccupiedNear(px, pz, blockRadius, (cell) => {
      if (Math.abs(cellY(cell) + 0.5 - py) > blockRadius) return;
      this.forEachStackInCell(cell, (id, n) => out.set(id, (out.get(id) ?? 0) + n));
    });
    return out;
  }

  clear(): void {
    this.head.clear();
    this.byChunk.clear();
    this.freeHead = NIL;
    this.top = 0;
    this.liveSlots = 0;
    this.total = 0;
  }

  serialize(): Uint8Array {
    const buf = new ArrayBuffer(12 + this.liveSlots * 14);
    const dv = new DataView(buf);
    dv.setUint32(0, LEDGER_MAGIC);
    dv.setUint16(4, LEDGER_VERSION);
    dv.setUint32(6, this.liveSlots);
    let o = 12;
    let written = 0;
    for (const [cell, h] of this.head) {
      for (let p = h; p !== NIL && written < this.liveSlots; p = this.sNext[p]) {
        dv.setUint32(o, cell >>> 0);
        dv.setUint16(o + 4, this.sId[p] & 0xffff);
        dv.setFloat64(o + 6, this.sCount[p]);
        o += 14;
        written++;
      }
    }
    return new Uint8Array(buf, 0, o);
  }

  static deserialize(bytes: Uint8Array | null | undefined): ItemLedger {
    const l = new ItemLedger();
    if (!bytes || bytes.byteLength < 12) return l;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0) !== LEDGER_MAGIC || dv.getUint16(4) !== LEDGER_VERSION) return l;
    const n = dv.getUint32(6);
    let o = 12;
    for (let i = 0; i < n; i++) {
      if (o + 14 > bytes.byteLength) break;
      const cell = dv.getUint32(o);
      const id = dv.getUint16(o + 4);
      const count = dv.getFloat64(o + 6);
      o += 14;
      if (id > 0 && count > 0) l.addAtCell(cell, id, count);
    }
    return l;
  }
}


export interface BeltBlockView {
  getBlock(x: number, y: number, z: number): number;
}

export interface BeltSource {
  forEachConveyor(cb: (key: number, dx: number, dz: number) => void): void;
}

interface Lane {
  cells: Int32Array;
  len: number;
  acc: number;
  exit: number;
  looped: boolean;
}

export class BeltNetwork {
  private lanes: Lane[] = [];
  private isBelt = new Map<number, number>();

  readonly stats = { lanes: 0, cells: 0, shifts: 0, moved: 0, jammed: 0, voided: 0 };

  rebuild(src: BeltSource, view: BeltBlockView): void {
    const dirs = new Map<number, [number, number]>();
    src.forEachConveyor((key, dx, dz) => {
      dirs.set(key, [dx, dz]);
      this.isBelt.set(key, 1);
    });

    const nextOf = (key: number): number => {
      const d = dirs.get(key);
      if (!d) return NIL;
      const nx = wrapBlock(cellX(key) + d[0]);
      const nz = wrapBlock(cellZ(key) + d[1]);
      const nk = packCell(nx, cellY(key), nz);
      return dirs.has(nk) ? nk : NIL;
    };

    const hasPred = new Set<number>();
    for (const key of dirs.keys()) {
      const n = nextOf(key);
      if (n !== NIL) hasPred.add(n);
    }

    this.lanes = [];
    const visited = new Set<number>();
    const walk = (start: number): void => {
      const cells: number[] = [];
      let k = start;
      while (k !== NIL && !visited.has(k)) {
        visited.add(k);
        cells.push(k);
        k = nextOf(k);
      }
      if (!cells.length) return;
      const last = cells[cells.length - 1];
      const d = dirs.get(last)!;
      const exit = packCell(wrapBlock(cellX(last) + d[0]), cellY(last), wrapBlock(cellZ(last) + d[1]));
      this.lanes.push({
        cells: Int32Array.from(cells),
        len: cells.length,
        acc: 0,
        exit,
        looped: k !== NIL && cells.includes(k),
      });
    };

    for (const key of dirs.keys()) if (!hasPred.has(key)) walk(key);
    for (const key of dirs.keys()) if (!visited.has(key)) walk(key);

    this.stats.lanes = this.lanes.length;
    this.stats.cells = dirs.size;
    void view;
  }

  step(dt: number, ledger: ItemLedger, view: BeltBlockView): void {
    const shiftsF = dt * BELT_SPEED;
    for (let i = 0; i < this.lanes.length; i++) {
      const lane = this.lanes[i];
      lane.acc += shiftsF;
      let guard = 4;
      while (lane.acc >= 1 && guard-- > 0) {
        lane.acc -= 1;
        this.shift(lane, ledger, view);
      }
      if (lane.acc > 1) lane.acc = 1;
    }
  }

  private shift(lane: Lane, ledger: ItemLedger, view: BeltBlockView): void {
    this.stats.shifts++;
    const n = lane.len;

    const lastBelt = lane.cells[n - 1];
    const lastItem = packCell(cellX(lastBelt), clampCellY(cellY(lastBelt) + 1), cellZ(lastBelt));
    const exitItem = this.settle(lane.exit, view);
    if (exitItem !== NIL) {
      const room = BELT_CELL_CAP * 4 - ledger.countAtCell(exitItem);
      if (room > 0) this.stats.moved += ledger.moveCell(lastItem, exitItem, Math.min(room, BELT_CELL_CAP));
      else this.stats.jammed++;
    } else {
      this.stats.voided += ledger.voidCell(lastItem);
    }

    for (let i = n - 2; i >= 0; i--) {
      const from = packCell(cellX(lane.cells[i]), clampCellY(cellY(lane.cells[i]) + 1), cellZ(lane.cells[i]));
      const toB = lane.cells[i + 1];
      const to = packCell(cellX(toB), clampCellY(cellY(toB) + 1), cellZ(toB));
      const room = BELT_CELL_CAP - ledger.countAtCell(to);
      if (room > 0) this.stats.moved += ledger.moveCell(from, to, room);
      else this.stats.jammed++;
    }
  }

  private settle(exitBelt: number, view: BeltBlockView): number {
    const x = cellX(exitBelt);
    const z = cellZ(exitBelt);
    let y = cellY(exitBelt) + 1;
    for (let i = 0; i < 4; i++) {
      if (y <= 0) return NIL;
      const below = view.getBlock(x, y - 1, z);
      if (below >= 0 && below !== 0 && (DEFS[below]?.solid || isConveyor(below))) {
        return packCell(x, clampCellY(y), z);
      }
      y--;
    }
    return NIL;
  }
}
