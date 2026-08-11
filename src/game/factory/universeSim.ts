/**
 * src/game/factory/universeSim.ts
 *
 * Feature B clock — UniverseSim singleton. Owns one PlanetFactorySim per planet and keeps
 * them all advancing on wall-clock time, whether the player is on the surface, in space,
 * or on another planet entirely:
 *
 *  • The ACTIVE planet's sim is ticked at full rate from the GameEngine frame
 *    (`tickActive(dt)`, called next to machines.update).
 *  • INACTIVE sims are ticked from a setInterval that survives scene switches, consuming
 *    wall-clock backlog with budgeted catch-up (≤8 ms per pass; the remainder resumes next
 *    pass — same cost-accounting style as World.update / prepareAllData).
 *
 * Deliberately live-only (documented decision, SNIPPETS §5):
 *  • water / fluid   -> live only (visual + expensive, no production value)
 *  • enemies / camps -> live only (clearedCamps already persists separately)
 *
 * NO three.js imports.
 */
import { PlanetFactorySim, MAX_BACKLOG, type TerrainLike } from './factorySim';
import { ItemLedger } from './itemLedger';
import { WorldDeltaStore } from '../persist/worldDelta';
import { hub, type PlanetSave } from '../persist/planetStore';

const TICK_MS = 500; // background pass cadence
const CATCHUP_BUDGET_MS = 8; // per inactive planet per pass
const CAPTURE_EVERY_MS = 15_000; // periodic off-planet persistence
const PRUNE_BUDGET_MS = 2;

export interface ClaimRequest {
  planetKey: string;
  seed: number;
  makeGenerator: () => TerrainLike;
  /** Fresh containers from hub.install() — used only if no live sim exists for the key. */
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

  /** Idempotent — called at module scope (like session.ts) and safe to re-call. */
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

  /** The engine calls this once per frame, next to machines.update. */
  tickActive(dt: number): void {
    const sim = this.activeKey ? this.sims.get(this.activeKey) : null;
    sim?.advance(dt);
  }

  /** Background pass: advance every non-active sim on wall-clock time. */
  private tick(): void {
    const nowMs = Date.now();
    const elapsed = Math.max(0, (nowMs - this.lastTickMs) / 1000);
    this.lastTickMs = nowMs;
    this.stats.backgroundTicks++;

    for (const [key, sim] of this.sims) {
      if (key === this.activeKey) continue;
      sim.advanceBudgeted(elapsed, CATCHUP_BUDGET_MS);
    }

    // Idle maintenance, one sim per pass: drop delta edits that match regenerated terrain.
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

  /**
   * Landing path: find-or-create the sim for a planet. If the sim object is still alive in
   * memory (the player only left minutes ago), ITS deltas/ledger are newer than the last
   * flush — they win. Otherwise we hydrate from the planet save and bank the time that
   * passed while the game was closed (capped at MAX_BACKLOG).
   */
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
    sim.rebuildFromDeltas(); // census first — restore only fills runtime phases
    if (req.save?.sim) sim.restore(req.save.sim);
    sim.restoreFurnaces(hub.furnacesOf(req.planetKey));

    // Offline production: the factory kept running while the page was closed.
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

  /** Leaving path: detach the live view; the sim keeps producing in the background. */
  release(planetKey: string): void {
    const sim = this.sims.get(planetKey);
    if (!sim) return;
    this.stats.releases++;
    sim.mergeFromLive();
    sim.detachFromLive();
    if (this.activeKey === planetKey) this.activeKey = null;
    this.lastTickMs = Date.now();
  }

  /** Console-verifiable parity stats (ledger conservation, monotonic deltas). */
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
        belts: sim.beltStats(),
      };
    }
    return out;
  }
}

/** Singleton — module scope so the clock survives scene switches, mirroring session.ts. */
export const universeSim = new UniverseSim();
universeSim.start();

/* Self-test hooks (deliverable 7): verifiable from the console without UI work. */
declare global {
  interface Window {
    __manscraftSim?: { hub: typeof hub; universeSim: UniverseSim };
  }
}
if (typeof window !== 'undefined') {
  window.__manscraftSim = { hub, universeSim };
}
