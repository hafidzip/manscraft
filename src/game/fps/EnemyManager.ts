import * as THREE from 'three';
import type { WorldLike } from './World';
import { WORLD_SIZE, WORLD_HEIGHT, wrapDelta } from '../core/constants';
import { B, isWaterId } from '../world/blocks';
import {
  Enemy,
  type EnemyDeps, type EnemyPlayer,
} from './Enemy';
import { EnemyGrid } from './EnemyGrid';
import {
  TIER_HOT, TIER_WARM, TIER_COLD, TIER_DORMANT,
  TIER_PERIOD_S, MAX_TICK_DT, MAX_SUBSTEPS,
  RENDER_BUDGET, HOT_BUDGET, WARM_BUDGET, COLD_BUDGET,
  RENDER_R, HOT_R, WARM_R, COLD_R,
  TIER_HYST, DORMANT_SPEED_SCALE, MAX_POP_R,
  type Tier,
} from './tiers';
import { EnemyInstancer, INSTANCED_ENEMIES } from './EnemyInstancer';

export interface EnemyHit { enemy: Enemy; point: THREE.Vector3; headshot: boolean; dist: number }

export const MAX_POP         = 96;
const WILD_RING_MIN          = 28;
const WILD_RING_MAX          = 88;
const DESPAWN_R_SQ           = 136 * 136;
const RELOCATE_R_SQ          = 96 * 96;
const SPAWN_RATE_BASE        = 2;
const SPAWN_RATE_MAX         = 20;

const BAND      = 4;
const INV_BAND  = 1 / BAND;
const N_BANDS   = Math.ceil(MAX_POP_R / BAND) + 2;

const L0_IN = 24 * 24, L0_OUT = 28 * 28;
const L1_IN = 52 * 52, L1_OUT = 58 * 58;

function pickLod(cur: 0 | 1 | 2, tier: Tier, d2: number): 0 | 1 | 2 {
  if (tier >= TIER_COLD) return 2;
  if (cur === 0) return d2 > L0_OUT ? (d2 > L1_OUT ? 2 : 1) : 0;
  if (cur === 1) return d2 < L0_IN ? 0 : (d2 > L1_OUT ? 2 : 1);
  return d2 < L1_IN ? (d2 < L0_IN ? 0 : 1) : 2;
}


const tmpV = new THREE.Vector3();

export class EnemyManager {
  enemies: Enemy[] = [];
  kills = 0;
  enabled = true;
  private activeScratch: Enemy[] = [];
  private primed = false;
  private wildTimer = 1.2;
  private night = true;
  private scene: THREE.Object3D | null = null;
  private instancer: EnemyInstancer | null = null;
  private deps: EnemyDeps;
  private player: EnemyPlayer;

  private bands        = new Int32Array(N_BANDS);
  private renderCutoff = Infinity;
  private hotCutoff    = 0;
  private warmCutoff   = 0;
  private coldCutoff   = 0;

  private grid            = new EnemyGrid();
  private _spawnCredit    = 0;
  private _recycleCursor  = 0;
  private _hostiles       = 0;

  get aliveCount(): number { return this._hostiles; }
  get hostileCount(): number { return this._hostiles; }
  get cap(): number { return MAX_POP; }

  constructor(
    player: EnemyPlayer,
    deps: EnemyDeps,
  ) {
    this.player = player;
    this.deps = deps;
  }

  private assignTiers(ppx: number, ppz: number): void {
    const list  = this.enemies;
    const bands = this.bands;
    bands.fill(0);

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) { e.distToPlayer = Infinity; continue; }
      const dx = wrapDelta(e.pos.x - ppx, WORLD_SIZE);
      const dz = wrapDelta(e.pos.z - ppz, WORLD_SIZE);
      const d  = Math.sqrt(dx * dx + dz * dz);
      e.distToPlayer = d;
      if (e.cfg.peaceful) continue;
      bands[Math.min(N_BANDS - 1, (d * INV_BAND) | 0)]++;
    }

    const rCap = RENDER_BUDGET, hCap = HOT_BUDGET;
    const wCap = hCap + WARM_BUDGET, cCap = wCap + COLD_BUDGET;
    let acc = 0;
    let rB = N_BANDS, hB = N_BANDS, wB = N_BANDS, cB = N_BANDS;
    for (let b = 0; b < N_BANDS; b++) {
      acc += bands[b];
      if (rB === N_BANDS && acc >= rCap) rB = b;
      if (hB === N_BANDS && acc >= hCap) hB = b;
      if (wB === N_BANDS && acc >= wCap) wB = b;
      if (cB === N_BANDS && acc >= cCap) cB = b;
    }
    this.renderCutoff = Math.min((rB + 1) * BAND, RENDER_R);
    this.hotCutoff    = Math.min((hB + 1) * BAND, HOT_R);
    this.warmCutoff   = Math.min((wB + 1) * BAND, WARM_R);
    this.coldCutoff   = Math.min((cB + 1) * BAND, COLD_R);

    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e.alive) continue;
      e.tier = this.tierFor(e);
      const shouldSleep = e.distToPlayer > this.renderCutoff;
      if (shouldSleep !== e.asleep) {
        e.asleep = shouldSleep;
        if (!INSTANCED_ENEMIES || e.cfg.peaceful) e.group.visible = !shouldSleep;
      }
    }
  }

  private tierFor(e: Enemy): Tier {
    const d = e.distToPlayer;
    if (e.cfg.peaceful) {
      return d < HOT_R ? TIER_HOT : d < COLD_R ? TIER_WARM : TIER_COLD;
    }
    const h = TIER_HYST;
    if (d < this.hotCutoff  || (e.tier === TIER_HOT  && d < this.hotCutoff  * h)) return TIER_HOT;
    if (d < this.warmCutoff || (e.tier === TIER_WARM && d < this.warmCutoff * h)) return TIER_WARM;
    if (d < this.coldCutoff || (e.tier === TIER_COLD && d < this.coldCutoff * h)) return TIER_COLD;
    return TIER_DORMANT;
  }

  private coarseAdvance(e: Enemy, dt: number, ppx: number, ppz: number): void {
    if (e.cfg.peaceful) return;
    const dx   = wrapDelta(ppx - e.pos.x, WORLD_SIZE);
    const dz   = wrapDelta(ppz - e.pos.z, WORLD_SIZE);
    const d    = Math.sqrt(dx * dx + dz * dz) || 1;
    const step = e.cfg.speed * DORMANT_SPEED_SCALE * dt;
    e.pos.x    = ((e.pos.x + (dx / d) * step) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE;
    e.pos.z    = ((e.pos.z + (dz / d) * step) % WORLD_SIZE + WORLD_SIZE) % WORLD_SIZE;
  }

  update(dt: number) {
    if (!this.enabled) return;
    if (!this.primed) this.primed = true;

    const ppx = this.player.pos.x;
    const ppz = this.player.pos.z;
    const active = this.activeScratch;
    active.length = 0;

    this.assignTiers(ppx, ppz);

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];

      e.tickAccum += dt;

      const period = TIER_PERIOD_S[e.tier];
      if (e.alive && e.tickAccum < period) continue;

      const budget = e.tickAccum;
      e.tickAccum  = 0;

      if (e.tier === TIER_DORMANT) {
        this.coarseAdvance(e, budget, ppx, ppz);
        continue;
      }

      const n    = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(budget / MAX_TICK_DT)));
      const sdt  = Math.min(budget / n, MAX_TICK_DT);
      let keep   = true;
      for (let s = 0; s < n && keep; s++) {
        keep = e.update(sdt, this.player);
      }

      if (!keep) {
        const g = e.group;
        g.parent?.remove(g);
        const last = this.enemies.length - 1;
        if (i !== last) this.enemies[i] = this.enemies[last];
        this.enemies.pop();
        if (!e.cfg.peaceful) this._hostiles = Math.max(0, this._hostiles - 1);
      } else if (e.alive) {
        active.push(e);
      }
    }

    this.grid.build(this.enemies, ppx, ppz);
    this.separateGrid(active, dt);

    this.wildTick(dt);

    if (INSTANCED_ENEMIES) this.syncInstances(ppx, ppz);
  }

  private separateGrid(active: Enemy[], dt: number): void {
    const SEP_R  = 0.95;
    const SEP_R2 = SEP_R * SEP_R;
    for (let i = 0; i < active.length; i++) {
      const a  = active[i];
      const n  = this.grid.query(a.pos.x, a.pos.y, a.pos.z, SEP_R + 0.1);
      for (let k = 0; k < n; k++) {
        const j = this.grid.qIdx[k];
        const b = this.enemies[j];
        if (b === a || !b || !b.alive) continue;
        const dy = a.pos.y - b.pos.y;
        if (Math.abs(dy) > 2) continue;
        const dx = this.grid.qDX[k];
        const dz = this.grid.qDZ[k];
        const r2 = dx * dx + dz * dz;
        if (r2 >= SEP_R2 || r2 < 1e-6) continue;
        const d    = Math.sqrt(r2);
        const push = (SEP_R - d) * 2.4 * dt / d;
        a.nudge(-dx * push, -dz * push);
        b.nudge(dx * push, dz * push);
      }
    }
  }

  private attach(e: Enemy) {
    const parent = this.scene ?? this.deps.world.group.parent;
    if (INSTANCED_ENEMIES && !e.cfg.peaceful) {
      e.detailed = false;
      e.group.parent?.remove(e.group);
      e.group.visible = false;
      return;
    }
    e.detailed = true;
    if (parent && !e.group.parent) parent.add(e.group);
  }

  private syncInstances(ppx: number, ppz: number): void {
    const inst = this.instancer;
    if (!inst) return;
    inst.begin();
    for (const e of this.enemies) {
      if (e.cfg.peaceful) continue;
      e.detailed = false;
      e.group.parent?.remove(e.group);
      e.group.visible = false;
      if (!e.alive || e.asleep) { e.rendered = false; continue; }
      const dx = wrapDelta(e.pos.x - ppx, WORLD_SIZE);
      const dz = wrapDelta(e.pos.z - ppz, WORLD_SIZE);
      const d2 = dx * dx + dz * dz;
      e.lod = pickLod(e.lod, e.tier, d2);
      e.rendered = true;
      if (!inst.push(e, ppx, ppz)) break;
    }
    inst.end();
  }

  private isValidGroundPos(w: WorldLike, fx: number, y: number, fz: number, hintY: number): boolean {
    if (y < 1 || y >= WORLD_HEIGHT - 2) return false;
    if (Math.abs(y - hintY) > 3) return false;
    if (w.solid(fx, y, fz) || w.solid(fx, y + 1, fz)) return false;
    if (!w.solid(fx, y - 1, fz)) return false;

    const floorId = w.get(fx, y - 1, fz);
    if (floorId === B.LEAVES || isWaterId(floorId) || floorId === B.AIR) return false;
    if (floorId === B.LOG && y > hintY + 1) return false;
    return true;
  }

  private standablePos(x: number, z: number, hintY: number): THREE.Vector3 | null {
    const w = this.deps.world;
    const fx = ((Math.floor(x) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    const fz = ((Math.floor(z) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

    const minY = Math.max(1, Math.floor(hintY) - 3);
    const maxY = Math.min(WORLD_HEIGHT - 2, Math.floor(hintY) + 3);

    for (let y = maxY; y >= minY; y--) {
      if (this.isValidGroundPos(w, fx, y, fz, hintY)) {
        return new THREE.Vector3(fx + 0.5, y, fz + 0.5);
      }
    }
    return null;
  }

  spawnWanderingMerchant(x: number, z: number, hintY: number): void {
    for (const e of this.enemies) {
      if (e.alive && e.cfg.id === 'merchant' && e.distToXZ(x, z) < 14) return;
    }
    const p = this.standablePos(x, z, hintY);
    if (!p) return;
    const e = new Enemy('merchant', p, this.deps, { behavior: 'idle' });
    e.home = { x: p.x, z: p.z };
    this.enemies.push(e);
    this.attach(e);
  }

  private wildTick(dt: number) {
    if (!this.night) return;

    const deficit = MAX_POP - this._hostiles;
    const rate    = deficit <= 0 ? 0 :
      SPAWN_RATE_BASE + (SPAWN_RATE_MAX - SPAWN_RATE_BASE) * (deficit / MAX_POP);
    this._spawnCredit += rate * dt;
    if (this._spawnCredit > 6) this._spawnCredit = 6;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      if (!e.alive || e.cfg.peaceful || e.home === null) continue;
      const d2 = e.distToPlayer * e.distToPlayer;
      if (d2 > DESPAWN_R_SQ) {
        e.group.parent?.remove(e.group);
        this.enemies.splice(i, 1);
        this._hostiles = Math.max(0, this._hostiles - 1);
      }
    }

    this.wildTimer -= dt;
    if (this.wildTimer > 0) return;
    this.wildTimer = 0.35 + Math.random() * 0.35;

    if (this._spawnCredit < 1) return;

    const w  = this.deps.world;
    const pp = this.player.pos;

    const fill    = Math.min(1, this._hostiles / Math.max(1, MAX_POP));
    const rMin    = WILD_RING_MIN + fill * 30;
    const rMax    = WILD_RING_MAX + fill * 30;

    for (let tries = 0; tries < 8; tries++) {
      const a  = Math.random() * Math.PI * 2;
      const r  = rMin + Math.random() * (rMax - rMin);
      const fx = ((Math.floor(pp.x + Math.cos(a) * r) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const fz = ((Math.floor(pp.z + Math.sin(a) * r) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const h  = w.highestY(fx, fz);
      if (h < 2 || h >= WORLD_HEIGHT - 3) continue;
      const floor = w.get(fx, h - 1, fz);
      if (isWaterId(floor) || floor === B.LEAVES || floor === B.AIR) continue;
      if (w.solid(fx, h, fz) || w.solid(fx, h + 1, fz)) continue;

      const roll   = Math.random();
      const preset = roll < 0.5 ? 'grunt' : roll < 0.82 ? 'runner' : 'heavy';

      if (this._hostiles >= MAX_POP) {
        const candidate = this.findRelocatable();
        if (candidate) {
          candidate.pos.set(fx + 0.5, h, fz + 0.5);
          candidate.home = { x: fx + 0.5, z: fz + 0.5 };
          candidate.alert(new THREE.Vector3(pp.x, pp.y, pp.z));
        }
      } else {
        const p = new THREE.Vector3(fx + 0.5, h, fz + 0.5);
        const e = new Enemy(preset, p, this.deps, { behavior: 'idle' });
        e.home = { x: p.x, z: p.z };
        this.enemies.push(e);
        this.attach(e);
        e.alert(new THREE.Vector3(pp.x, pp.y, pp.z));
        this._hostiles++;
      }
      this._spawnCredit -= 1;
      return;
    }
  }

  private findRelocatable(): Enemy | null {
    const n = this.enemies.length;
    if (n === 0) return null;
    for (let k = 0; k < n; k++) {
      const i = (this._recycleCursor + k) % n;
      const e = this.enemies[i];
      if (e.alive && !e.cfg.peaceful && e.home !== null && e.distToPlayer * e.distToPlayer > RELOCATE_R_SQ) {
        this._recycleCursor = (i + 1) % n;
        return e;
      }
    }
    return null;
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    let best: EnemyHit | null = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const iox = Math.round((origin.x - e.pos.x) / WORLD_SIZE) * WORLD_SIZE;
      const ioz = Math.round((origin.z - e.pos.z) / WORLD_SIZE) * WORLD_SIZE;
      const bc = e.pos.clone().add(tmpV.set(iox, 1.0, ioz));
      const tb = this.raySphere(origin, dir, bc, 0.52);
      const hc = e.pos.clone().add(tmpV.set(iox, 1.77, ioz));
      const th = this.raySphere(origin, dir, hc, 0.26);
      let t = -1, head = false;
      if (th >= 0 && (tb < 0 || th <= tb)) { t = th; head = true; }
      else if (tb >= 0) t = tb;
      if (t >= 0 && t < maxDist && (!best || t < best.dist)) {
        best = { enemy: e, point: origin.clone().addScaledVector(dir, t), headshot: head, dist: t };
      }
    }
    return best;
  }

  private raySphere(o: THREE.Vector3, d: THREE.Vector3, c: THREE.Vector3, r: number): number {
    tmpV.copy(c).sub(o);
    const tca = tmpV.dot(d);
    if (tca < 0) return -1;
    const d2 = tmpV.lengthSq() - tca * tca;
    if (d2 > r * r) return -1;
    return tca - Math.sqrt(r * r - d2);
  }

  alertNearby(soundPos: THREE.Vector3, hearRange = 45) {
    const r2 = hearRange * hearRange;
    for (const e of this.enemies) {
      if (!e.alive || !e.alerted) continue;
      const dx = wrapDelta(soundPos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(soundPos.z - e.pos.z, WORLD_SIZE);
      const dy = soundPos.y - e.pos.y;
      if (dx * dx + dy * dy + dz * dz < r2) {
        e.investigate(new THREE.Vector3(e.pos.x + dx, soundPos.y, e.pos.z + dz));
      }
    }
  }

  alertAlliesOf(hitEnemy: Enemy, radius = 18) {
    const pp = this.player.pos;
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e === hitEnemy) {
        e.alert(new THREE.Vector3(e.pos.x + wrapDelta(pp.x - e.pos.x, WORLD_SIZE), pp.y, e.pos.z + wrapDelta(pp.z - e.pos.z, WORLD_SIZE)));
        continue;
      }
      const dx = wrapDelta(hitEnemy.pos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(hitEnemy.pos.z - e.pos.z, WORLD_SIZE);
      if (dx * dx + dz * dz < r2) {
        e.alert(new THREE.Vector3(e.pos.x + wrapDelta(pp.x - e.pos.x, WORLD_SIZE), pp.y, e.pos.z + wrapDelta(pp.z - e.pos.z, WORLD_SIZE)));
      }
    }
  }

  alertInRadius(pos: THREE.Vector3, radius: number) {
    const r2 = (radius + 0.6) * (radius + 0.6);
    const pp = this.player.pos;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = wrapDelta(pos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(pos.z - e.pos.z, WORLD_SIZE);
      const dy = pos.y - (e.pos.y + 1);
      if (dx * dx + dy * dy + dz * dz < r2) {
        e.alert(new THREE.Vector3(e.pos.x + wrapDelta(pp.x - e.pos.x, WORLD_SIZE), pp.y, e.pos.z + wrapDelta(pp.z - e.pos.z, WORLD_SIZE)));
      }
    }
  }

  notifyWorldChanged(pos: THREE.Vector3, radius = 26) {
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = wrapDelta(pos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(pos.z - e.pos.z, WORLD_SIZE);
      const dy = pos.y - e.pos.y;
      if (dx * dx + dy * dy + dz * dz < r2) e.invalidatePath();
    }
  }

  damageInRadius(pos: THREE.Vector3, radius: number, dmg: number) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = wrapDelta(pos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(pos.z - e.pos.z, WORLD_SIZE);
      const dy = pos.y - (e.pos.y + 1);
      const d = Math.hypot(dx, dy, dz);
      if (d < radius + 0.6) e.takeDamage(dmg * (1 - d / (radius + 1)), pos, false);
    }
  }

  addScene(scene: THREE.Scene) {
    this.scene = scene;
    if (INSTANCED_ENEMIES && !this.instancer) this.instancer = new EnemyInstancer(scene);
    for (const e of this.enemies) {
      if (INSTANCED_ENEMIES && !e.cfg.peaceful) {
        e.detailed = false;
        e.group.parent?.remove(e.group);
        e.group.visible = false;
      } else {
        e.detailed = true;
        if (!e.group.parent) scene.add(e.group);
      }
    }
  }

  clearAll() {
    for (const e of this.enemies) if (e.group.parent) e.group.parent.remove(e.group);
    this.enemies = [];
    this._hostiles = 0;
    if (this.instancer) { this.instancer.begin(); this.instancer.end(); }
    this.primed = false;
  }

  setNight(night: boolean) {
    if (night === this.night) return;
    this.night = night;
    if (night) {
      this.wildTimer = 0.8;
    } else {
      for (const e of this.enemies) if (e.alive && !e.cfg.peaceful) e.dissolve();
    }
  }

  get isNight(): boolean { return this.night; }

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    if (!enabled) this.clearAll();
  }

  clear(scene: THREE.Scene) {
    void scene;
    this.clearAll();
  }

  onPlayerDeath(cooldownSec = 6): void {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const target = this.standablePos(
        e.respawnPoint.x,
        e.respawnPoint.z,
        e.respawnPoint.y,
      );
      e.standDown(cooldownSec, target ?? e.respawnPoint.clone());
    }
  }
}
