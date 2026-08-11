/* eslint-disable no-bitwise */
import { WORLD_HEIGHT as H, CHUNK_SIZE as S, wrapBlock, wrapChunk } from '../core/constants';
import { packCell, packChunk, cellX, cellY, cellZ } from '../core/cellKey';
import { B, DEFS, isConveyor, isWaterId, isOreBlock } from '../world/blocks';
import {
  MK_INSERTER, MK_LASER, MK_CONVEYOR, kindOf, dirXOf, dirZOf,
} from '../world/machineRegistry';
import { TO_FPS } from '../engine/constants';
import {
  tickFurnace, furnaceIdle, drainFurnaceOutput, newFurnaceTickResult,
  newFurnace, type FurnaceState,
} from '../crafting/smelting';
import { ItemLedger, BeltNetwork, clampCellY, type BeltBlockView } from './itemLedger';
import type { WorldDeltaStore } from '../persist/worldDelta';
import {
  MachineKind, acquireFrontTarget, feedMachine, harvestOutcome, machineKey,
  parseMachineKey, newCraftingTable, sanitizeCraftingState, spillCrafting, spillFurnace,
  type CraftingTableState, type MachineItemSink,
} from './machineProcessing';

export const INSERTER_DIP = 0.14;
export const INSERTER_CARRY = 0.46;
export const INSERTER_RELEASE = 0.12;
export const INSERTER_RETURN = 0.46;
export const INSERTER_CYCLE = INSERTER_DIP + INSERTER_CARRY + INSERTER_RELEASE + INSERTER_RETURN;
export const INSERTER_IDLE_POLL = 0.12;
export const LASER_MINE_TIME = 0.85;
export const LASER_AIM = 0.18;
export const LASER_RETARGET = 0.05;
export const MAX_STEP = 1.0;
export const MAX_BACKLOG = 8 * 3600;

export const LIVE_AGENT_RADIUS = 30;
const LIVE_AGENT_R2 = LIVE_AGENT_RADIUS * LIVE_AGENT_RADIUS;

const GROUND_CELL_CAP = 64;

const INPUT_Y_OFFSETS = [0, 1];

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export interface TerrainLike {
  populateChunk(data: Uint8Array, cx: number, cz: number): void;
}

export interface LiveWorldLike {
  peekBlock(x: number, y: number, z: number): number;
  getBlockRaw(x: number, y: number, z: number): number;
  setBlock(x: number, y: number, z: number, id: number): void;
}

export interface SimContext {
  planetKey: string;
  seed: number;
  deltas: WorldDeltaStore;
  ledger: ItemLedger;
  makeGenerator: () => TerrainLike;
}

export interface SimSnapshot {
  v: 1;
  simTimeSec: number;
  backlogSec: number;
  lastWallMs: number;
  machines: number[];
  produced: number;
  mined: number;
}

class HeadlessVoxelView implements BeltBlockView {
  private cache = new Map<number, Uint8Array>();
  private order: number[] = [];
  private gen: TerrainLike | null = null;
  live: LiveWorldLike | null = null;

  constructor(private ctx: SimContext, private capacity = 24) {}

  private chunk(cx: number, cz: number): Uint8Array {
    const k = packChunk(cx, cz);
    let d = this.cache.get(k);
    if (d) return d;
    if (!this.gen) this.gen = this.ctx.makeGenerator();
    d = new Uint8Array(S * H * S);
    this.gen.populateChunk(d, wrapChunk(cx), wrapChunk(cz));
    this.ctx.deltas.applyToChunk(wrapChunk(cx), wrapChunk(cz), d);
    this.cache.set(k, d);
    this.order.push(k);
    if (this.order.length > this.capacity) {
      const old = this.order.shift()!;
      this.cache.delete(old);
    }
    return d;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.BEDROCK;
    if (y >= H) return B.AIR;
    const px = wrapBlock(Math.floor(x));
    const pz = wrapBlock(Math.floor(z));
    if (this.live) {
      const id = this.live.peekBlock(px, y, pz);
      if (id >= 0) return id;
    }
    return this.chunk(px >> 4, pz >> 4)[((y | 0) * S + (pz & 15)) * S + (px & 15)];
  }

  poke(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= H) return;
    const px = wrapBlock(Math.floor(x));
    const pz = wrapBlock(Math.floor(z));
    const d = this.cache.get(packChunk(px >> 4, pz >> 4));
    if (d) d[((y | 0) * S + (pz & 15)) * S + (px & 15)] = id;
  }

  invalidateAll(): void {
    this.cache.clear();
    this.order.length = 0;
  }
}

interface SimMachine {
  key: number;
  x: number;
  y: number;
  z: number;
  id: number;
  kind: number;
  dx: number;
  dz: number;
  st: number;
  t: number;
  held: number;
  charge: number;
  aim: number;
  tx: number;
  ty: number;
  tz: number;
}

export class PlanetFactorySim {
  readonly key: string;
  readonly ledger: ItemLedger;
  readonly deltas: WorldDeltaStore;
  readonly furnaces = new Map<string, FurnaceState>();
  readonly craftingTables = new Map<string, CraftingTableState>();
  private readonly furnaceTickOut = newFurnaceTickResult();

  private readonly sink: MachineItemSink = {
    emitAbove: (x, y, z, itemId, count = 1) => {
      this.ledger.addAtCell(
        packCell(wrapBlock(x), clampCellY(y + 1), wrapBlock(z)),
        itemId,
        count,
      );
    },
  };

  private view: HeadlessVoxelView;
  private machines = new Map<number, SimMachine>();
  private pool: SimMachine[] = [];
  private belts = new BeltNetwork();
  private beltsDirty = true;

  private live: LiveWorldLike | null = null;
  private livePx = 0;
  private livePz = 0;
  private livePlayerValid = false;

  simTimeSec = 0;
  backlogSec = 0;
  lastWallMs = Date.now();

  readonly stats = {
    steps: 0, mined: 0, produced: 0, inserted: 0, smelted: 0,
    machines: 0, catchUpSec: 0,
  };

  constructor(private ctx: SimContext) {
    this.key = ctx.planetKey;
    this.ledger = ctx.ledger;
    this.deltas = ctx.deltas;
    this.view = new HeadlessVoxelView(ctx);
  }

  get isLive(): boolean {
    return this.live !== null;
  }

  retain = (key: number): boolean => this.machines.has(key);

  probeBlock(x: number, y: number, z: number): number {
    return this.view.getBlock(x, y, z);
  }

  ensureMachine(x: number, y: number, z: number, id: number): void {
    const kind = kindOf(id);
    if (kind === 0) return;
    const key = packCell(wrapBlock(x), clampCellY(y), wrapBlock(z));
    let m = this.machines.get(key);
    if (!m) {
      m = this.pool.pop() ?? {
        key: 0, x: 0, y: 0, z: 0, id: 0, kind: 0, dx: 0, dz: 0,
        st: 0, t: 0, held: 0, charge: 0, aim: 0, tx: -1, ty: -1, tz: -1,
      };
      m.key = key;
      m.st = 0;
      m.t = 0;
      m.held = 0;
      m.charge = 0;
      m.aim = 0;
      m.tx = -1;
      m.ty = -1;
      m.tz = -1;
      this.machines.set(key, m);
    }
    m.x = cellX(key);
    m.y = cellY(key);
    m.z = cellZ(key);
    m.id = id;
    m.kind = kind;
    m.dx = dirXOf(id);
    m.dz = dirZOf(id);
    if (kind & MK_CONVEYOR) this.beltsDirty = true;
    this.stats.machines = this.machines.size;
  }

  removeMachine(x: number, y: number, z: number): void {
    const key = packCell(wrapBlock(x), clampCellY(y), wrapBlock(z));
    const m = this.machines.get(key);
    if (!m) return;
    if (m.held > 0) this.ledger.addAtCell(key, m.held, 1);
    if (m.kind & MK_CONVEYOR) this.beltsDirty = true;
    this.machines.delete(key);
    this.pool.push(m);
    this.stats.machines = this.machines.size;
  }

  onBlock = (x: number, y: number, z: number, oldId: number, newId: number): void => {
    this.view.poke(x, y, z, newId);
    const ok = kindOf(oldId);
    const nk = kindOf(newId);
    if (ok === 0 && nk === 0) return;
    if (nk === 0) this.removeMachine(x, y, z);
    else this.ensureMachine(x, y, z, newId);
  };

  rebuildFromDeltas(): void {
    const seen = new Set<number>();
    this.deltas.forEachEdit((x, y, z, id) => {
      if (kindOf(id) === 0) return;
      seen.add(packCell(wrapBlock(x), clampCellY(y), wrapBlock(z)));
      this.ensureMachine(x, y, z, id);
    });
    for (const key of Array.from(this.machines.keys())) {
      if (!seen.has(key)) {
        const m = this.machines.get(key)!;
        this.machines.delete(key);
        this.pool.push(m);
      }
    }
    this.beltsDirty = true;
    this.stats.machines = this.machines.size;
  }

  private forEachConveyorCb = (cb: (key: number, dx: number, dz: number) => void): void => {
    for (const m of this.machines.values()) if (m.kind & MK_CONVEYOR) cb(m.key, m.dx, m.dz);
  };

  attachToLive(world: LiveWorldLike): void {
    this.live = world;
    this.view.live = world;
    this.view.invalidateAll();
    this.rebuildFromDeltas();
  }

  detachFromLive(): void {
    this.live = null;
    this.view.live = null;
    this.livePlayerValid = false;
    this.view.invalidateAll();
  }

  setLivePlayer(x: number, z: number): void {
    this.livePx = x;
    this.livePz = z;
    this.livePlayerValid = true;
  }

  mergeFromLive(): void {
    this.rebuildFromDeltas();
  }

  private nearLivePlayer(m: SimMachine): boolean {
    if (!this.live || !this.livePlayerValid) return false;
    let dx = m.x + 0.5 - this.livePx;
    let dz = m.z + 0.5 - this.livePz;
    dx -= 512 * Math.round(dx / 512);
    dz -= 512 * Math.round(dz / 512);
    return dx * dx + dz * dz < LIVE_AGENT_R2;
  }

  private setBlockAuthoritative(x: number, y: number, z: number, id: number): void {
    if (id === B.AIR && isOreBlock(this.view.getBlock(x, y, z))) return;
    if (this.live) {
      this.live.setBlock(x, y, z, id);
    } else {
      this.deltas.recordBlock(x, y, z, id);
      this.onBlock(x, y, z, this.view.getBlock(x, y, z), id);
    }
    this.view.poke(x, y, z, id);
  }

  private mineable(id: number): boolean {
    if (id === B.AIR || id < 0) return false;
    if (isWaterId(id)) return false;
    if (kindOf(id) !== 0) return false;
    if (isOreBlock(id)) return TO_FPS[id] !== undefined;
    const d = DEFS[id];
    if (!d || !d.solid || !isFinite(d.hardness)) return false;
    return TO_FPS[id] !== undefined;
  }

  private acquire(m: SimMachine): boolean {
    const found = acquireFrontTarget(
      { getBlock: (x, y, z) => this.view.getBlock(x, y, z) },
      m.x, m.y, m.z, m.dx, m.dz,
      (id) => this.mineable(id),
    );
    if (!found) {
      m.tx = -1;
      return false;
    }
    m.tx = found.cell.x;
    m.ty = found.cell.y;
    m.tz = found.cell.z;
    m.aim = LASER_AIM;
    return true;
  }

  private tickLaser(m: SimMachine, dt: number): void {
    if (m.tx < 0) {
      if (m.t > 0) m.t = Math.max(0, m.t - dt);
      else if (!this.acquire(m)) {
        m.t = LASER_RETARGET;
        return;
      }
    }
    const id = this.view.getBlock(m.tx, m.ty, m.tz);
    if (!this.mineable(id)) {
      m.tx = -1;
      m.charge = 0;
      m.t = LASER_RETARGET;
      return;
    }
    m.charge += dt / LASER_MINE_TIME;
    let guard = 4;
    while (m.charge >= 1 && guard-- > 0) {
      m.charge -= 1;
      const worldId = this.view.getBlock(m.tx, m.ty, m.tz);
      const outcome = harvestOutcome(worldId, TO_FPS);
      if (outcome) {
        if (outcome.destroy) this.setBlockAuthoritative(m.tx, m.ty, m.tz, B.AIR);
        const fx = wrapBlock(m.x + m.dx);
        const fz = wrapBlock(m.z + m.dz);
        const below = this.view.getBlock(fx, m.y, fz);
        const yOff = below !== B.AIR && (DEFS[below]?.solid || isConveyor(below)) ? 1 : 0;
        this.ledger.add(fx + 0.5, m.y + yOff, fz + 0.5, outcome.itemId, 1);
        this.stats.produced++;
        this.stats.mined++;
        if (outcome.destroy) {
          m.tx = -1;
          m.t = LASER_RETARGET;
          break;
        }
      } else {
        m.tx = -1;
        break;
      }
    }
  }

  private inserterInputCell(m: SimMachine, yOff: number): number {
    const bx = wrapBlock(m.x - m.dx);
    const bz = wrapBlock(m.z - m.dz);
    return packCell(bx, clampCellY(m.y + yOff), bz);
  }

  private inserterOutputCell(m: SimMachine): number {
    const fx = wrapBlock(m.x + m.dx);
    const fz = wrapBlock(m.z + m.dz);
    const below = this.view.getBlock(fx, m.y, fz);
    const yOff = below !== B.AIR && (DEFS[below]?.solid || isConveyor(below)) ? 1 : 0;
    return packCell(fx, clampCellY(m.y + yOff), fz);
  }

  private tickInserter(m: SimMachine, dt: number): void {
    m.t += dt;
    if (m.st === 0) {
      if (m.t < INSERTER_IDLE_POLL) return;
      m.t -= INSERTER_IDLE_POLL;
      if (m.held > 0) {
        m.st = 1;
        return;
      }
      for (let i = 0; i < INPUT_Y_OFFSETS.length; i++) {
        const cell = this.inserterInputCell(m, INPUT_Y_OFFSETS[i]);
        if (this.ledger.takeAnyFromCell(cell, 1) > 0) {
          m.held = this.ledger.out.id;
          m.st = 1;
          m.t = 0;
          return;
        }
      }
      return;
    }
    if (m.t < INSERTER_CYCLE) return;
    m.t -= INSERTER_CYCLE;
    if (m.held > 0) {
      const fx = wrapBlock(m.x + m.dx);
      const fz = wrapBlock(m.z + m.dz);
      const kind = this.machineKindAt(fx, m.y, fz);
      if (kind !== MachineKind.None) {
        const state = kind === MachineKind.Furnace
          ? this.furnaceAt(fx, m.y, fz)
          : this.craftingAt(fx, m.y, fz);
        if (!feedMachine(kind, state, fx, m.y, fz, m.held, this.sink)) {
          this.sink.emitAbove(fx, m.y, fz, m.held, 1);
        }
        this.stats.inserted++;
        m.held = 0;
      } else {
        const out = this.inserterOutputCell(m);
        const isBeltCell = isConveyor(this.view.getBlock(cellX(out), m.y, cellZ(out)));
        const cap = isBeltCell ? 64 : GROUND_CELL_CAP;
        if (this.ledger.countAtCell(out) < cap) {
          this.ledger.addAtCell(out, m.held, 1);
          this.stats.inserted++;
          m.held = 0;
        }
      }
    }
    m.st = 0;
  }

  private tickFurnaces(dt: number): void {
    for (const [k, st] of this.furnaces) {
      const at = parseMachineKey(k);
      if (!at) {
        this.furnaces.delete(k);
        continue;
      }
      const legacy = drainFurnaceOutput(st);
      if (legacy) this.sink.emitAbove(at[0], at[1], at[2], legacy.id, legacy.count);
      const out = this.furnaceTickOut;
      tickFurnace(st, dt, out);
      if (out.producedCount > 0) {
        this.sink.emitAbove(at[0], at[1], at[2], out.producedId, out.producedCount);
        this.stats.smelted += out.producedCount;
      }
      if (furnaceIdle(st)) this.furnaces.delete(k);
    }
  }

  private machineKindAt(x: number, y: number, z: number): MachineKind {
    const id = this.view.getBlock(x, y, z);
    if (id === B.FURNACE || id === B.FURNACE_LIT) return MachineKind.Furnace;
    if (id === B.CRAFTING_TABLE) return MachineKind.CraftingTable;
    return MachineKind.None;
  }

  furnaceAt(x: number, y: number, z: number): FurnaceState {
    const k = machineKey(x, y, z);
    let st = this.furnaces.get(k);
    if (!st) {
      st = newFurnace();
      this.furnaces.set(k, st);
    }
    return st;
  }

  craftingAt(x: number, y: number, z: number): CraftingTableState {
    const k = machineKey(x, y, z);
    let st = this.craftingTables.get(k);
    if (!st) {
      st = newCraftingTable();
      this.craftingTables.set(k, st);
    }
    return st;
  }

  restoreCraftingTables(m: Map<string, CraftingTableState>): void {
    this.craftingTables.clear();
    for (const [k, st] of m) this.craftingTables.set(k, sanitizeCraftingState(st));
  }

  spillMachineAt(x: number, y: number, z: number): void {
    const k = machineKey(x, y, z);
    const furnace = this.furnaces.get(k);
    if (furnace) {
      for (const item of spillFurnace(furnace)) this.sink.emitAbove(x, y, z, item.id, item.count);
      this.furnaces.delete(k);
    }
    const crafting = this.craftingTables.get(k);
    if (crafting) {
      for (const item of spillCrafting(crafting)) this.sink.emitAbove(x, y, z, item.id, item.count);
      this.craftingTables.delete(k);
    }
  }

  private rebuildBeltsIfDirty(): void {
    if (!this.beltsDirty) return;
    this.beltsDirty = false;
    this.belts.rebuild({ forEachConveyor: this.forEachConveyorCb }, this.view);
  }

  private step(dt: number): void {
    this.stats.steps++;
    for (const m of this.machines.values()) {
      if (m.kind & MK_LASER) {
        if (this.nearLivePlayer(m)) continue;
        this.tickLaser(m, dt);
      }
    }
    this.rebuildBeltsIfDirty();
    this.belts.step(dt, this.ledger, this.view);
    for (const m of this.machines.values()) {
      if (m.kind & MK_INSERTER) {
        if (this.nearLivePlayer(m)) continue;
        this.tickInserter(m, dt);
      }
    }
    if (!this.isLive) this.tickFurnaces(dt);
    this.simTimeSec += dt;
  }

  advance(elapsedSec: number): void {
    let e = Math.max(0, Math.min(elapsedSec, MAX_STEP * 4));
    while (e > 1e-6) {
      const s = Math.min(e, MAX_STEP);
      this.step(s);
      e -= s;
    }
    this.lastWallMs = Date.now();
  }

  advanceBudgeted(elapsedSec: number, budgetMs: number): void {
    this.backlogSec = Math.min(this.backlogSec + Math.max(0, elapsedSec), MAX_BACKLOG);
    const t0 = now();
    while (this.backlogSec > 1e-6) {
      const s = Math.min(this.backlogSec, MAX_STEP);
      this.step(s);
      this.backlogSec -= s;
      this.stats.catchUpSec += s;
      if (now() - t0 >= budgetMs) break;
    }
    this.lastWallMs = Date.now();
  }

  idlePrune(budgetMs = 4): number {
    if (!this.view) return 0;
    const gen = (this.view as HeadlessVoxelView);
    void gen;
    return this.deltas.pruneStep(this.ctx.makeGenerator(), budgetMs);
  }

  snapshot(): SimSnapshot {
    const machines: number[] = [];
    for (const m of this.machines.values()) {
      machines.push(m.key, m.st, m.t, m.held, m.charge, m.tx, m.ty, m.tz);
    }
    return {
      v: 1,
      simTimeSec: this.simTimeSec,
      backlogSec: 0,
      lastWallMs: Date.now(),
      machines,
      produced: this.stats.produced,
      mined: this.stats.mined,
    };
  }

  restore(snap: SimSnapshot | null | undefined): void {
    if (!snap || snap.v !== 1) return;
    this.simTimeSec = snap.simTimeSec || 0;
    this.stats.produced = snap.produced || 0;
    this.stats.mined = snap.mined || 0;
    const a = snap.machines;
    for (let i = 0; i + 7 < a.length + 1; i += 8) {
      const m = this.machines.get(a[i]);
      if (!m) continue;
      m.st = a[i + 1];
      m.t = a[i + 2];
      m.held = a[i + 3];
      m.charge = a[i + 4];
      m.tx = a[i + 5];
      m.ty = a[i + 6];
      m.tz = a[i + 7];
    }
    this.lastWallMs = snap.lastWallMs || Date.now();
  }

  restoreFurnaces(m: Map<string, FurnaceState>): void {
    this.furnaces.clear();
    for (const [k, st] of m) this.furnaces.set(k, st);
  }

  beltStats(): { lanes: number; cells: number; moved: number; jammed: number; voided: number } {
    this.rebuildBeltsIfDirty();
    const s = this.belts.stats;
    return { lanes: s.lanes, cells: s.cells, moved: s.moved, jammed: s.jammed, voided: s.voided };
  }
}
