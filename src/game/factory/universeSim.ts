import { PlanetFactorySim, MAX_BACKLOG, type TerrainLike } from './factorySim';
import { ItemLedger } from './itemLedger';
import { WorldDeltaStore } from '../persist/worldDelta';
import { hub, type PlanetSave } from '../persist/planetStore';
import { runMachineProcessingSelfTests } from './machineProcessing.selftest';

const TICK_MS = 500;
const CATCHUP_BUDGET_MS = 8;
const CAPTURE_EVERY_MS = 15_000;
const PRUNE_BUDGET_MS = 2;

export interface ClaimRequest {
  planetKey: string;
  seed: number;
  makeGenerator: () => TerrainLike;
  deltas: WorldDeltaStore;
  ledger: ItemLedger;
  save: PlanetSave | null;
}

export interface ClaimedPlanet {
  sim: PlanetFactorySim;
  deltas: WorldDeltaStore;
  ledger: ItemLedger;
}

class UniverseSim {
  readonly sims = new Map<string, PlanetFactorySim>();
  private activeKey: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickMs = 0;
  private lastCaptureMs = 0;
  private pruneCursor = 0;

  readonly stats = { backgroundTicks: 0, claims: 0, releases: 0, captures: 0, offlineSec: 0 };

  start(): void {
    if (this.timer !== null || typeof setInterval === 'undefined') return;
    this.lastTickMs = Date.now();
    this.lastCaptureMs = this.lastTickMs;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  tickActive(dt: number): void {
    const sim = this.activeKey ? this.sims.get(this.activeKey) : null;
    sim?.advance(dt);
  }

  private tick(): void {
    const nowMs = Date.now();
    const elapsed = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.lastTickMs = nowMs;
    this.stats.backgroundTicks++;

    for (const [key, sim] of this.sims) {
      if (key === this.activeKey) continue;
      sim.advanceBudgeted(elapsed, CATCHUP_BUDGET_MS);
    }

    const keys = Array.from(this.sims.keys());
    if (keys.length > 0) {
      this.pruneCursor %= keys.length;
      const sim = this.sims.get(keys[this.pruneCursor]);
      if (sim && keys[this.pruneCursor] !== this.activeKey) sim.idlePrune(PRUNE_BUDGET_MS);
      this.pruneCursor++;
    }

    if (nowMs - this.lastCaptureMs >= CAPTURE_EVERY_MS) {
      this.lastCaptureMs = nowMs;
      for (const [key, sim] of this.sims) {
        if (hub.has(key)) {
          hub.captureSim(key, sim);
          this.stats.captures++;
        }
      }
    }
  }

  claim(req: ClaimRequest): ClaimedPlanet {
    this.stats.claims++;
    this.start();
    const existing = this.sims.get(req.planetKey);
    if (existing) {
      this.activeKey = req.planetKey;
      return { sim: existing, deltas: existing.deltas, ledger: existing.ledger };
    }

    const sim = new PlanetFactorySim({
      planetKey: req.planetKey,
      seed: req.seed,
      deltas: req.deltas,
      ledger: req.ledger,
      makeGenerator: req.makeGenerator,
    });
    sim.rebuildFromDeltas();
    if (req.save?.sim) sim.restore(req.save.sim);
    sim.restoreFurnaces(hub.furnacesOf(req.planetKey));
    sim.restoreCraftingTables(hub.craftingTablesOf(req.planetKey));

    const awayMs = req.save ? Date.now() - req.save.savedAtMs : 0;
    const offline = Math.min(Math.max(0, awayMs / 1000), MAX_BACKLOG);
    if (offline > 0) {
      sim.backlogSec += offline;
      this.stats.offlineSec += offline;
    }

    this.sims.set(req.planetKey, sim);
    this.activeKey = req.planetKey;
    return { sim, deltas: req.deltas, ledger: req.ledger };
  }

  release(planetKey: string): void {
    const sim = this.sims.get(planetKey);
    if (!sim) return;
    this.stats.releases++;
    sim.mergeFromLive();
    sim.detachFromLive();
    if (this.activeKey === planetKey) this.activeKey = null;
    this.lastTickMs = Date.now();
  }

  debugStats(): Record<string, unknown> {
    const out: Record<string, unknown> = { active: this.activeKey, ...this.stats };
    for (const [key, sim] of this.sims) {
      out[key] = {
        ...sim.stats,
        simTimeSec: Math.round(sim.simTimeSec),
        backlogSec: Math.round(sim.backlogSec * 10) / 10,
        ledgerTotal: sim.ledger.total,
        ledgerStacks: sim.ledger.stackCount,
        ledgerBytes: sim.ledger.bytes,
        deltaRecords: sim.deltas.size,
        deltaStats: { ...sim.deltas.stats },
        furnaces: sim.furnaces.size,
        craftingTables: sim.craftingTables.size,
        belts: sim.beltStats(),
      };
    }
    return out;
  }
}

export const universeSim = new UniverseSim();
universeSim.start();

declare global {
  interface Window {
    __manscraftSim?: {
      hub: typeof hub;
      universeSim: UniverseSim;
      selfTest: typeof runMachineProcessingSelfTests;
    };
  }
}
if (typeof window !== 'undefined') {
  window.__manscraftSim = { hub, universeSim, selfTest: runMachineProcessingSelfTests };
}
