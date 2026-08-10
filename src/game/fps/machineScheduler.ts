import type * as THREE from 'three';
import { WORLD_HEIGHT, minImageF } from '../core/constants';
import { cellX, cellZ } from '../core/cellKey';
import type { MachineRecord, MachineRegistry } from '../world/machineRegistry';

export interface MachineView {
  ix: number; iz: number; d2: number;
  px: number; py: number; pz: number;
}

export interface MachineAgent {
  readonly kind: number;
  readonly maxLive: number;
  readonly scanRadius: number;
  readonly pruneRadius: number;
  readonly yLo: number;
  readonly yHi: number;
  readonly thinkPerFrame: number;
  has(key: number): boolean;
  create(rec: MachineRecord): void;
  destroy(key: number): void;
  setActive(key: number, active: boolean): void;
  tick(rec: MachineRecord, view: MachineView, dt: number): void;
  prepare?(dt: number, px: number, py: number, pz: number, anyLive: boolean): void;
  onIdChanged?(rec: MachineRecord, oldId: number): void;
  wantsThink?(rec: MachineRecord, view: MachineView): boolean;
  think?(rec: MachineRecord, view: MachineView): void;
  retain?(key: number): boolean;
}

interface Slot {
  agent: MachineAgent;
  kind: number;
  keys: Int32Array;
  d2: Float64Array;
  ix: Float64Array;
  iz: Float64Array;
  recs: (MachineRecord | null)[];
  n: number;
  prev: Set<number>;
  owned: number[];
  ownedSet: Set<number>;
  pruneCursor: number;
  thinkCursor: number;
  absYLo: number;
  absYHi: number;
  r2: number;
  pruneR2: number;
}

const CREATE_BUDGET = 3;
const PRUNE_CHECKS = 8;

export class MachineScheduler {
  readonly stats = { activeTotal: 0, created: 0, destroyed: 0, createDeferred: 0, ticks: 0, thinks: 0, reclaimed: 0 };
  private slots: Slot[] = [];
  private byKind: (Slot | null)[] = new Array(16).fill(null);
  private view: MachineView = { ix: 0, iz: 0, d2: 0, px: 0, py: 0, pz: 0 };
  private unionRadius = 0;
  private unionKinds = 0;
  private yLoRel = 0;
  private yHiRel = 0;
  private px = 0;
  private pz = 0;
  private dormantClock = 0;
  private detach: (() => void) | null = null;

  constructor(private registry: MachineRegistry, agents: MachineAgent[]) {
    for (const agent of agents) {
      const cap = agent.maxLive;
      const slot: Slot = {
        agent, kind: agent.kind,
        keys: new Int32Array(cap), d2: new Float64Array(cap),
        ix: new Float64Array(cap), iz: new Float64Array(cap),
        recs: new Array(cap).fill(null), n: 0,
        prev: new Set(), owned: [], ownedSet: new Set(),
        pruneCursor: 0, thinkCursor: 0, absYLo: 0, absYHi: 0,
        r2: agent.scanRadius ** 2, pruneR2: agent.pruneRadius ** 2,
      };
      this.slots.push(slot);
      this.byKind[agent.kind] = slot;
      this.unionKinds |= agent.kind;
      this.unionRadius = Math.max(this.unionRadius, agent.scanRadius);
      this.yLoRel = Math.min(this.yLoRel, agent.yLo);
      this.yHiRel = Math.max(this.yHiRel, agent.yHi);
    }
    this.detach = registry.addListener({
      onRemove: rec => this.forget(rec.key, rec.kind),
      onIdChanged: (rec, oldId) => this.byKind[rec.kind]?.agent.onIdChanged?.(rec, oldId),
    });
  }

  dispose(): void { this.detach?.(); this.detach = null; }

  private visit = (rec: MachineRecord, ix: number, iz: number, d2: number): void => {
    if (!rec.live) return;
    const slot = this.byKind[rec.kind];
    if (!slot || d2 > slot.r2 || rec.y < slot.absYLo || rec.y > slot.absYHi) return;
    let i: number;
    const cap = slot.keys.length;
    if (slot.n < cap) i = slot.n++;
    else { if (d2 >= slot.d2[cap - 1]) return; i = cap - 1; }
    while (i > 0 && slot.d2[i - 1] > d2) {
      slot.keys[i] = slot.keys[i - 1]; slot.d2[i] = slot.d2[i - 1];
      slot.ix[i] = slot.ix[i - 1]; slot.iz[i] = slot.iz[i - 1]; slot.recs[i] = slot.recs[i - 1]; i--;
    }
    slot.keys[i] = rec.key; slot.d2[i] = d2; slot.ix[i] = ix; slot.iz[i] = iz; slot.recs[i] = rec;
  };

  update(dt: number, player: THREE.Vector3): void {
    this.registry.tickClock(dt);
    this.px = player.x; this.pz = player.z;
    this.view.px = player.x; this.view.py = player.y; this.view.pz = player.z;
    const cy = Math.floor(player.y);
    for (const slot of this.slots) {
      slot.n = 0;
      slot.absYLo = Math.max(0, cy + slot.agent.yLo);
      slot.absYHi = Math.min(WORLD_HEIGHT - 1, cy + slot.agent.yHi);
    }
    this.registry.forEachNear(
      player.x, player.z, this.unionRadius,
      Math.max(0, cy + this.yLoRel), Math.min(WORLD_HEIGHT - 1, cy + this.yHiRel),
      this.unionKinds, this.visit,
    );

    let createBudget = CREATE_BUDGET;
    let activeTotal = 0;
    for (const slot of this.slots) {
      const agent = slot.agent;
      agent.prepare?.(dt, player.x, player.y, player.z, slot.n > 0);
      const current = new Set<number>();
      for (let i = 0; i < slot.n; i++) {
        const rec = slot.recs[i]!;
        const key = slot.keys[i];
        if (!agent.has(key)) {
          if (createBudget <= 0) { slot.recs[i] = null; this.stats.createDeferred++; continue; }
          agent.create(rec); createBudget--; this.stats.created++;
          if (!slot.ownedSet.has(key)) { slot.ownedSet.add(key); slot.owned.push(key); }
        }
        current.add(key);
        if (!slot.prev.has(key)) agent.setActive(key, true);
        this.view.ix = slot.ix[i]; this.view.iz = slot.iz[i]; this.view.d2 = slot.d2[i];
        agent.tick(rec, this.view, dt); this.stats.ticks++;
      }
      for (const key of slot.prev) if (!current.has(key) && agent.has(key)) agent.setActive(key, false);
      slot.prev = current;
      activeTotal += current.size;

      if (agent.think && agent.thinkPerFrame > 0 && slot.n > 0) {
        let done = 0;
        for (let a = 0; a < slot.n && done < agent.thinkPerFrame; a++) {
          const i = (slot.thinkCursor + a) % slot.n;
          const rec = slot.recs[i]; if (!rec) continue;
          this.view.ix = slot.ix[i]; this.view.iz = slot.iz[i]; this.view.d2 = slot.d2[i];
          if (agent.wantsThink && !agent.wantsThink(rec, this.view)) continue;
          agent.think(rec, this.view); done++; this.stats.thinks++;
        }
        slot.thinkCursor = (slot.thinkCursor + agent.thinkPerFrame) % slot.n;
      }
      this.pruneFar(slot);
      for (let i = 0; i < slot.n; i++) slot.recs[i] = null;
    }
    this.stats.activeTotal = activeTotal;
    this.dormantClock += dt;
    if (this.dormantClock >= 4) { this.dormantClock = 0; this.registry.pruneDormant(); }
  }

  private pruneFar(slot: Slot): void {
    const n = slot.owned.length;
    if (!n) return;
    const checks = Math.min(PRUNE_CHECKS, n);
    for (let c = 0; c < checks && slot.owned.length; c++) {
      if (slot.pruneCursor >= slot.owned.length) slot.pruneCursor = 0;
      const i = slot.pruneCursor++;
      const key = slot.owned[i];
      const dx = minImageF(cellX(key) - this.px);
      const dz = minImageF(cellZ(key) - this.pz);
      if (dx * dx + dz * dz <= slot.pruneR2 || slot.agent.retain?.(key)) continue;
      this.forget(key, slot.kind);
      this.stats.reclaimed++;
      slot.pruneCursor = i;
      break;
    }
  }

  private forget(key: number, kind: number): void {
    const slot = this.byKind[kind];
    if (!slot) return;
    if (slot.agent.has(key)) { slot.agent.destroy(key); this.stats.destroyed++; }
    if (slot.ownedSet.delete(key)) {
      const i = slot.owned.indexOf(key);
      if (i >= 0) { const last = slot.owned.pop()!; if (i < slot.owned.length) slot.owned[i] = last; }
    }
    slot.prev.delete(key);
  }

  snapshot() { return { scheduler: { ...this.stats }, registry: this.registry.snapshot() }; }
}