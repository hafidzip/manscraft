/* eslint-disable no-bitwise */
/**
 * src/game/factory/factorySim.ts
 *
 * Feature B core — PlanetFactorySim: a headless (zero direct three.js imports) per-planet
 * factory simulation. It replicates the §4.9 machine contracts (laser miners, inserters,
 * conveyors via BeltNetwork, furnaces via the shared tickFurnace) against a headless voxel
 * view = TerrainGenerator output + the WorldDeltaStore overlay, so production continues
 * while the player is in space or on another planet.
 *
 * Deliberately live-only (out of scope, see SNIPPETS §5):
 *  • water / fluid  -> live only (visual + expensive, no production value)
 *  • enemies / camps -> live only (clearedCamps already persists separately)
 * Only production machinery (laser miners, inserters, conveyors, furnaces) runs off-render.
 *
 * Tick order inside one step is load-bearing: miners → belts → inserters → furnaces
 * (mine first so fresh drops ride the belt the same step; inserters after belts so an item
 * that just arrived at a lane terminus is grabbable this step — mirroring the live frame
 * order itemDrops.update → machines.update → updateFurnaces).
 */
import { WORLD_HEIGHT as H, CHUNK_SIZE as S, wrapBlock, wrapChunk } from '../core/constants';
import { packCell, packChunk, cellX, cellY, cellZ } from '../core/cellKey';
import { B, DEFS, isConveyor, isWaterId } from '../world/blocks';
import {
  MK_INSERTER, MK_LASER, MK_CONVEYOR, kindOf, dirXOf, dirZOf,
} from '../world/machineRegistry';
import { TO_FPS } from '../engine/constants';
import {
  tickFurnace, furnaceIdle, furnaceKey, newFurnace, type FurnaceState,
} from '../crafting/smelting';
import { ItemLedger, BeltNetwork, clampCellY, type BeltBlockView } from './itemLedger';
import type { WorldDeltaStore } from '../persist/worldDelta';

/* ---- behaviour constants: mirrored 1:1 from §4.9 --------------------- */
export const INSERTER_DIP = 0.14;
export const INSERTER_CARRY = 0.46;
export const INSERTER_RELEASE = 0.12;
export const INSERTER_RETURN = 0.46;
export const INSERTER_CYCLE = INSERTER_DIP + INSERTER_CARRY + INSERTER_RELEASE + INSERTER_RETURN; // 1.18
export const INSERTER_IDLE_POLL = 0.12;
export const LASER_RANGE = 6;
export const LASER_MINE_TIME = 0.85;
export const LASER_AIM = 0.18;
export const LASER_RETARGET = 0.05;
export const MAX_STEP = 1.0; // quantum: production stays exact
export const MAX_BACKLOG = 8 * 3600; // never catch up more than 8h in one go

/** While live, the engine's own managers own machines nearer than this to the player. */
export const LIVE_AGENT_RADIUS = 30;
const LIVE_AGENT_R2 = LIVE_AGENT_RADIUS * LIVE_AGENT_RADIUS;

/** Max items a plain ground cell accepts from an inserter before back-pressure. */
const GROUND_CELL_CAP = 64;

/**
 * PARITY ASSUMPTION (verified against Inserter.ts): arms takeAt(..., arm.y, ...) while items
 * rest one cell ABOVE a belt; the ledger therefore probes the inserter's own level first
 * (ground geometry) then one above (belt geometry).
 */
const INPUT_Y_OFFSETS = [0, 1];

/** Inserters only move items between cells; feeding furnace slots stays live-only. */
const FEED_FURNACES = false;

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ---- interfaces ------------------------------------------------------ */
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
  makeGenerator: () => TerrainLike; // DI keeps this file free of generator imports
}

export interface SimSnapshot {
  v: 1;
  simTimeSec: number;
  backlogSec: number;
  lastWallMs: number;
  machines: number[]; // flat: key,st,t,held,charge,tx,ty,tz (8 per machine)
  produced: number;
  mined: number;
}

/* ---- headless voxel view --------------------------------------------- */
class HeadlessVoxelView implements BeltBlockView {
  private cache = new Map<number, Uint8Array>(); // chunkKey -> generated+delta data
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
    this.ctx.deltas.applyToChunk(wrapChunk(cx), wrapChunk(cz), d); // overlay! never raw gen
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
      if (id >= 0) return id; // live chunk wins; -1 = not meshed yet -> headless fallback
    }
    return this.chunk(px >> 4, pz >> 4)[((y | 0) * S + (pz & 15)) * S + (px & 15)];
  }

  /** Write-through so the LRU never serves a stale voxel. */
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

/* ---- machine state --------------------------------------------------- */
interface SimMachine {
  key: number;
  x: number;
  y: number;
  z: number;
  id: number;
  kind: number;
  dx: number;
  dz: number;
  st: number; // inserter: 0 idle | 1 swinging (deposit phase)
  t: number; // phase seconds
  held: number; // fps item id in the claw (0 = empty)
  charge: number; // laser progress 0..1
  aim: number; // laser aim/settle seconds
  tx: number;
  ty: number;
  tz: number; // laser target (-1 = none)
}

export class PlanetFactorySim {
  readonly key: string;
  readonly ledger: ItemLedger;
  readonly deltas: WorldDeltaStore;
  readonly furnaces = new Map<string, FurnaceState>();

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

  /** MachineRegistry.pruneDormant retain predicate — the sim owns these records. */
  retain = (key: number): boolean => this.machines.has(key);

  /** Headless block probe exposed for diagnostics. */
  probeBlock(x: number, y: number, z: number): number {
    return this.view.getBlock(x, y, z);
  }

  /* ---- machine bookkeeping ------------------------------------------ */
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
    // A machine holding an item must not eat it — Feature C invariant: nothing disappears.
    if (m.held > 0) this.ledger.addAtCell(key, m.held, 1);
    if (m.kind & MK_CONVEYOR) this.beltsDirty = true;
    this.machines.delete(key);
    this.pool.push(m);
    this.stats.machines = this.machines.size;
  }

  /** ChangeBus sink while live; also used after hydration. */
  onBlock = (x: number, y: number, z: number, oldId: number, newId: number): void => {
    this.view.poke(x, y, z, newId);
    const ok = kindOf(oldId);
    const nk = kindOf(newId);
    if (ok === 0 && nk === 0) return;
    if (nk === 0) this.removeMachine(x, y, z);
    else this.ensureMachine(x, y, z, newId);
  };

  /**
   * Rebuild the machine set from the delta overlay. All machine blocks are player edits
   * (TerrainGenerator never emits them — hence MachineRegistry's trustGenerator), so the
   * delta is a complete machine census even with the world unloaded.
   */
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

  /* ---- live attach / detach ------------------------------------------ */
  /**
   * Called after deltas have been installed into the fresh World. Live managers become a
   * VIEW of this sim: the sim keeps simulating machines beyond LIVE_AGENT_RADIUS of the
   * player; nearer machines are owned by the live agents (they act on the same ledger).
   */
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

  /** Per-frame player position so near machines can defer to live agents. */
  setLivePlayer(x: number, z: number): void {
    this.livePx = x;
    this.livePz = z;
    this.livePlayerValid = true;
  }

  /** Merge hook kept for API parity with the doc's leave-path. */
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

  /* ---- authoritative block writes ------------------------------------ */
  private setBlockAuthoritative(x: number, y: number, z: number, id: number): void {
    if (this.live) {
      this.live.setBlock(x, y, z, id); // fires ChangeBus -> delta recorder -> our onBlock
    } else {
      this.deltas.recordBlock(x, y, z, id);
      this.onBlock(x, y, z, this.view.getBlock(x, y, z), id);
    }
    this.view.poke(x, y, z, id);
  }

  /* ---- laser miners --------------------------------------------------- */
  private mineable(id: number): boolean {
    if (id === B.AIR || id < 0) return false;
    if (isWaterId(id)) return false;
    if (kindOf(id) !== 0) return false; // never eat machines
    const d = DEFS[id];
    if (!d || !d.solid || !isFinite(d.hardness)) return false;
    return TO_FPS[id] !== undefined;
  }

  /** LOS: sample along the ray; blocked by any solid cell other than the target cell. */
  private reachable(m: SimMachine, tx: number, ty: number, tz: number): boolean {
    const ox = m.x + 0.5;
    const oy = m.y + 1.2;
    const oz = m.z + 0.5;
    const gx = tx + 0.5;
    const gy = ty + 0.5;
    const gz = tz + 0.5;
    let dx = gx - ox;
    let dz = gz - oz;
    dx -= 512 * Math.round(dx / 512);
    dz -= 512 * Math.round(dz / 512);
    const dy = gy - oy;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const steps = Math.max(1, Math.ceil(dist * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const bx = wrapBlock(Math.floor(ox + dx * t));
      const by = Math.floor(oy + dy * t);
      const bz = wrapBlock(Math.floor(oz + dz * t));
      if (by < 0 || by >= H) return false;
      if (bx === tx && by === ty && bz === tz) continue;
      if (bx === m.x && (by === m.y || by === m.y + 1) && bz === m.z) continue;
      const id = this.view.getBlock(bx, by, bz);
      if (id !== B.AIR && DEFS[id]?.solid) return false;
    }
    return true;
  }

  /** §4.9 acquire(): forward cone, dir × RANGE, lateral ≤2, vertical ±2, min score wins. */
  private acquire(m: SimMachine): boolean {
    const rx = -m.dz; // lateral axis (right of facing)
    const rz = m.dx;
    let bestScore = Infinity;
    let bx = -1;
    let by = -1;
    let bz = -1;
    for (let step = 1; step <= LASER_RANGE; step++) {
      for (let lat = -2; lat <= 2; lat++) {
        for (let vert = -2; vert <= 2; vert++) {
          const px = wrapBlock(m.x + m.dx * step + rx * lat);
          const py = m.y + vert;
          const pz = wrapBlock(m.z + m.dz * step + rz * lat);
          if (py < 0 || py >= H) continue;
          const id = this.view.getBlock(px, py, pz);
          if (!this.mineable(id)) continue;
          const score = step * 10 + Math.abs(lat) * 2 + Math.abs(vert) * 2;
          if (score < bestScore && this.reachable(m, px, py, pz)) {
            bestScore = score;
            bx = px;
            by = py;
            bz = pz;
          }
        }
      }
    }
    if (bx < 0) return false;
    m.tx = bx;
    m.ty = by;
    m.tz = bz;
    m.aim = 0;
    return true;
  }

  private tickLaser(m: SimMachine, dt: number): void {
    if (m.tx < 0) {
      if (m.t > 0) m.t = Math.max(0, m.t - dt); // retarget cooldown
      else if (!this.acquire(m)) m.t = LASER_RETARGET;
      return;
    }
    // Validate the target is still there (may have been mined by live agents).
    const id = this.view.getBlock(m.tx, m.ty, m.tz);
    if (!this.mineable(id)) {
      m.tx = -1;
      m.charge = 0;
      m.t = LASER_RETARGET;
      return;
    }
    if (m.aim < LASER_AIM) {
      m.aim += dt;
      return;
    }
    m.charge += dt / LASER_MINE_TIME;
    if (m.charge >= 1) {
      m.charge -= 1; // parity decision 5: fractional remainders survive catch-up quanta
      const worldId = this.view.getBlock(m.tx, m.ty, m.tz);
      const itemId = TO_FPS[worldId];
      this.setBlockAuthoritative(m.tx, m.ty, m.tz, B.AIR);
      if (itemId !== undefined) {
        const fx = wrapBlock(m.x + m.dx);
        const fz = wrapBlock(m.z + m.dz);
        // drop cell: one above own level in front (belt geometry), else at own level
        const below = this.view.getBlock(fx, m.y, fz);
        const yOff = below !== B.AIR && (DEFS[below]?.solid || isConveyor(below)) ? 1 : 0;
        this.ledger.add(fx + 0.5, m.y + yOff, fz + 0.5, itemId, 1);
        this.stats.produced++;
      }
      this.stats.mined++;
      m.tx = -1;
      m.t = LASER_RETARGET;
    }
  }

  /* ---- inserters ------------------------------------------------------ */
  private inserterInputCell(m: SimMachine, yOff: number): number {
    const bx = wrapBlock(m.x - m.dx); // input = BEHIND cell
    const bz = wrapBlock(m.z - m.dz);
    return packCell(bx, clampCellY(m.y + yOff), bz);
  }

  private inserterOutputCell(m: SimMachine): number {
    const fx = wrapBlock(m.x + m.dx); // output = FRONT cell
    const fz = wrapBlock(m.z + m.dz);
    const below = this.view.getBlock(fx, m.y, fz);
    const yOff = below !== B.AIR && (DEFS[below]?.solid || isConveyor(below)) ? 1 : 0;
    return packCell(fx, clampCellY(m.y + yOff), fz);
  }

  private tickInserter(m: SimMachine, dt: number): void {
    m.t += dt;
    if (m.st === 0) {
      if (m.t < INSERTER_IDLE_POLL) return;
      m.t -= INSERTER_IDLE_POLL; // keep the fractional remainder
      if (m.held > 0) {
        m.st = 1; // still carrying something — swing to deposit
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
      if (FEED_FURNACES) {
        /* parity only once InserterManager feeds furnaces in the live scene too */
      }
      return;
    }
    // swinging: one full cycle moves ONE item (1.18 s)
    if (m.t < INSERTER_CYCLE) return;
    m.t -= INSERTER_CYCLE;
    if (m.held > 0) {
      const out = this.inserterOutputCell(m);
      const isBeltCell = isConveyor(this.view.getBlock(cellX(out), m.y, cellZ(out)));
      const cap = isBeltCell ? 64 : GROUND_CELL_CAP;
      if (this.ledger.countAtCell(out) < cap) {
        this.ledger.addAtCell(out, m.held, 1);
        this.stats.inserted++;
        m.held = 0;
      }
      // else: back-pressure — claw stays full, retries next cycle
    }
    m.st = 0;
  }

  /* ---- furnaces -------------------------------------------------------- */
  private tickFurnaces(dt: number): void {
    for (const [k, st] of this.furnaces) {
      const before = st.output && st.output.kind === 'block' ? st.output.count : 0;
      tickFurnace(st, dt);
      const after = st.output && st.output.kind === 'block' ? st.output.count : 0;
      if (after > before) this.stats.smelted++;
      if (furnaceIdle(st)) this.furnaces.delete(k);
    }
  }

  furnaceAt(x: number, y: number, z: number): FurnaceState {
    const k = furnaceKey(x, y, z);
    let st = this.furnaces.get(k);
    if (!st) {
      st = newFurnace();
      this.furnaces.set(k, st);
    }
    return st;
  }

  /* ---- ticking --------------------------------------------------------- */
  private rebuildBeltsIfDirty(): void {
    if (!this.beltsDirty) return;
    this.beltsDirty = false;
    this.belts.rebuild({ forEachConveyor: this.forEachConveyorCb }, this.view);
  }

  /** One quantized step (dt ≤ MAX_STEP). Fixed order: miners → belts → inserters → furnaces. */
  private step(dt: number): void {
    this.stats.steps++;
    for (const m of this.machines.values()) {
      if (m.kind & MK_LASER) {
        if (this.nearLivePlayer(m)) continue; // live LaserMinerManager owns it
        this.tickLaser(m, dt);
      }
    }
    this.rebuildBeltsIfDirty();
    this.belts.step(dt, this.ledger, this.view);
    for (const m of this.machines.values()) {
      if (m.kind & MK_INSERTER) {
        if (this.nearLivePlayer(m)) continue; // live InserterManager owns it
        this.tickInserter(m, dt);
      }
    }
    // While live, the engine's updateFurnaces ticks this same map — never double-tick.
    if (!this.isLive) this.tickFurnaces(dt);
    this.simTimeSec += dt;
  }

  /** Full-rate advance for the ACTIVE planet (called from the engine frame). */
  advance(elapsedSec: number): void {
    let e = Math.max(0, Math.min(elapsedSec, MAX_STEP * 4));
    while (e > 1e-6) {
      const s = Math.min(e, MAX_STEP);
      this.step(s);
      e -= s;
    }
    this.lastWallMs = Date.now();
  }

  /**
   * Budgeted catch-up for inactive planets (called from UniverseSim). Consumes wall-clock
   * backlog in MAX_STEP quanta until the time budget is spent; the remainder stays banked
   * and resumes next frame — same cost-accounting style as World.update/prepareAllData.
   */
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

  /** Idle maintenance: prune delta edits that match regenerated terrain. */
  idlePrune(budgetMs = 4): number {
    if (!this.view) return 0;
    const gen = (this.view as HeadlessVoxelView);
    void gen;
    return this.deltas.pruneStep(this.ctx.makeGenerator(), budgetMs);
  }

  /* ---- snapshot / restore ---------------------------------------------- */
  snapshot(): SimSnapshot {
    const machines: number[] = [];
    for (const m of this.machines.values()) {
      machines.push(m.key, m.st, m.t, m.held, m.charge, m.tx, m.ty, m.tz);
    }
    return {
      v: 1,
      simTimeSec: this.simTimeSec,
      backlogSec: 0, // backlog is recomputed from wall-clock on claim
      lastWallMs: Date.now(),
      machines,
      produced: this.stats.produced,
      mined: this.stats.mined,
    };
  }

  /**
   * Restore runtime machine phases onto the delta census. Call AFTER rebuildFromDeltas()
   * (which establishes id/kind/dir per machine from edits); unknown keys are skipped.
   */
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
