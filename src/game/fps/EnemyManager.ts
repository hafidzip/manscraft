import * as THREE from 'three';
import type { WorldLike } from './World';
import { WORLD_SIZE, WORLD_HEIGHT, wrapDelta } from '../core/constants';
import type { CampBuild, CampSite } from '../world/camps';
import { Biome } from '../world/biomes';
import { B, isWaterId } from '../world/blocks';
import { mulberry32 } from '../core/noise';
import {
  Enemy, CAMP_CONFIG, pathBudget,
  type EnemyBehavior, type EnemyDeps, type EnemyPlayer,
} from './Enemy';

export const CAMP_MEMBER_RESPAWN = CAMP_CONFIG.respawnDelay;
export const CAMP_REPOPULATE_DELAY = CAMP_CONFIG.repopulateDelay;
const RESPAWN_SAFE_DIST = 12;

export interface CampState {
  site: CampSite;
  build: CampBuild;
  squad: Enemy[];
  squadSize: number;
  roster: string[];
  respawnTimer: number;
  cleared: boolean;
  spawnedEver: boolean;
}

function campSquadSize(s: CampSite): number {
  const [minS, maxS] = CAMP_CONFIG.squadSize;
  const n = minS + (s.radius >= 15 ? 1 : 0) + (s.biome === Biome.MOUNTAINS ? 1 : 0);
  return Math.min(maxS, Math.max(minS, n));
}

function campRoster(s: CampSite, size: number): string[] {
  const rng = mulberry32((s.id * 0x9e3779b1 + s.cx * 73856093 + s.cz * 19349663) >>> 0);
  const out: string[] = [s.biome === Biome.MOUNTAINS || s.radius >= 16 ? 'heavy' : 'grunt'];
  for (let i = 1; i < size; i++) {
    const r = rng();
    out.push(r < 0.55 ? 'grunt' : r < 0.85 ? 'runner' : 'heavy');
  }
  return out;
}

export interface EnemyHit { enemy: Enemy; point: THREE.Vector3; headshot: boolean; dist: number }

const SIM_RADIUS = 112;

const WILD_CAP = 12;
const WILD_RING_MIN = 30;
const WILD_RING_MAX = 68;

const tmpV = new THREE.Vector3();

export class EnemyManager {
  enemies: Enemy[] = [];
  kills = 0;
  enabled = true;
  private activeScratch: Enemy[] = [];
  camps: CampState[] = [];
  campsTotal = 0;
  campsCleared = 0;
  private primed = false;
  private wildTimer = 2.5;
  private night = true;
  private scene: THREE.Object3D | null = null;
  private deps: EnemyDeps;
  private player: EnemyPlayer;

  constructor(
    player: EnemyPlayer,
    deps: EnemyDeps,
    camps: { site: CampSite; build: CampBuild }[] = [],
  ) {
    this.player = player;
    this.deps = deps;
    this.setCamps(camps);
  }

  setCamps(camps: { site: CampSite; build: CampBuild }[]) {
    this.camps = camps.map(({ site, build }) => {
      const squadSize = campSquadSize(site);
      return {
        site, build, squad: [], squadSize,
        roster: campRoster(site, squadSize),
        respawnTimer: 0,
        cleared: false, spawnedEver: false,
      };
    });
    this.campsTotal = this.camps.length;
    this.campsCleared = 0;
    this.primed = false;
  }

  get aliveCount(): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) if (this.enemies[i].alive) n++;
    return n;
  }

  update(dt: number) {
    if (!this.enabled) return;
    if (!this.primed) this.primed = true;

    pathBudget.tokens = 5;

    const ppx = this.player.pos.x;
    const ppz = this.player.pos.z;
    const active = this.activeScratch;
    active.length = 0;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const e = this.enemies[i];
      const dx = wrapDelta(e.pos.x - ppx, WORLD_SIZE);
      const dz = wrapDelta(e.pos.z - ppz, WORLD_SIZE);
      if (e.alive && dx * dx + dz * dz > SIM_RADIUS * SIM_RADIUS) {
        if (e.group.visible) e.group.visible = false;
        continue;
      }
      if (!e.group.visible) e.group.visible = true;
      const keep = e.update(dt, this.player);
      if (!keep) {
        const g = e.group;
        g.parent?.remove(g);
        this.enemies.splice(i, 1);
      } else if (e.alive) {
        active.push(e);
      }
    }
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        const a = active[i], b = active[j];
        if (Math.abs(a.pos.y - b.pos.y) > 2) continue;
        const rx = a.pos.x - b.pos.x, rz = a.pos.z - b.pos.z;
        if (rx * rx + rz * rz > 4 && Math.abs(rx) < WORLD_SIZE * 0.5) continue;
        const dx = wrapDelta(rx, WORLD_SIZE);
        const dz = wrapDelta(rz, WORLD_SIZE);
        const d = Math.hypot(dx, dz);
        if (d < 0.95 && d > 0.001) {
          const push = (0.95 - d) * 2.4 * dt;
          a.nudge((dx / d) * push, (dz / d) * push);
          b.nudge(-(dx / d) * push, -(dz / d) * push);
        }
      }
    }

    this.respawnTick(dt);
    this.wildTick(dt);

    for (const camp of this.camps) {
      if (camp.cleared || camp.squad.length === 0) continue;
      const cdx = wrapDelta(ppx - camp.site.cx, WORLD_SIZE);
      const cdz = wrapDelta(ppz - camp.site.cz, WORLD_SIZE);
      const dist = Math.hypot(cdx, cdz);
      if (dist <= camp.site.radius) {
        const pImg = new THREE.Vector3(
          camp.site.cx + cdx,
          this.player.pos.y,
          camp.site.cz + cdz,
        );
        for (const e of camp.squad) {
          if (e.alive) e.investigate(pImg.clone());
        }
      }
    }

    let cleared = 0;
    for (const c of this.camps) if (c.cleared) cleared++;
    this.campsCleared = cleared;
    this.campsTotal = this.camps.length;
  }

  private attach(e: Enemy) {
    const parent = this.scene ?? this.deps.world.group.parent;
    if (parent && !e.group.parent) parent.add(e.group);
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

  private campSpawnPos(camp: CampState, slot: number): THREE.Vector3 | null {
    const { build: b, site: s } = camp;
    const ring = b.posts.length ? b.posts : b.patrolPoints;
    for (let t = 0; t < 6; t++) {
      let x: number, z: number;
      if (ring.length) {
        const p = ring[(slot + t) % ring.length];
        const j = t ? 3 : 0;
        x = p.x + (Math.random() - 0.5) * j;
        z = p.z + (Math.random() - 0.5) * j;
      } else {
        const a = ((slot + t) / Math.max(1, camp.squadSize)) * Math.PI * 2;
        x = s.cx + Math.cos(a) * s.radius * 0.5;
        z = s.cz + Math.sin(a) * s.radius * 0.5;
      }
      const p = this.standablePos(x, z, s.y);
      if (p) return p;
    }

    for (let rad = 0; rad <= s.radius; rad += 2) {
      const steps = rad === 0 ? 1 : Math.max(8, Math.ceil(rad * 2.2));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2 + slot * 0.37;
        const p = this.standablePos(s.cx + Math.cos(a) * rad, s.cz + Math.sin(a) * rad, s.y);
        if (p) return p;
      }
    }
    return this.standablePos(s.cx, s.cz, s.y);
  }

  private spawnMember(camp: CampState, slot: number, guardPlayer: boolean): boolean {
    let p = this.campSpawnPos(camp, slot);

    if (!p) {
      const s = camp.site;
      const w = this.deps.world;
      const cx = ((Math.floor(s.cx) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const cz = ((Math.floor(s.cz) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      let y = Math.floor(s.y) + 1;
      if (w.solid(cx, y, cz)) y++;
      p = new THREE.Vector3(cx + 0.5, y, cz + 0.5);
    }
    if (guardPlayer) {
      const gdx = wrapDelta(this.player.pos.x - p.x, WORLD_SIZE);
      const gdz = wrapDelta(this.player.pos.z - p.z, WORLD_SIZE);
      const gdy = this.player.pos.y - p.y;
      if (gdx * gdx + gdy * gdy + gdz * gdz < RESPAWN_SAFE_DIST * RESPAWN_SAFE_DIST) return false;
    }
    const presetId = camp.roster[slot % camp.roster.length];
    const bRng = mulberry32(
      ((camp.site.id * 0x27d4eb2d) ^ (slot * 0x9e3779b1) ^ 0x5bf03635) >>> 0
    );
    const idleChance = presetId === 'heavy' ? 0.75 : slot === 0 ? 0.15 : 0.45;
    const behavior: EnemyBehavior = bRng() < idleChance ? 'idle' : 'patrol';
    const e = new Enemy(presetId, p, this.deps, { behavior });
    e.assignCamp(camp.build);
    this.enemies.push(e);
    this.attach(e);
    camp.squad.push(e);
    return true;
  }

  spawnCamp(camp: CampState): void {
    for (let i = camp.squad.length; i < camp.squadSize; i++) this.spawnMember(camp, i, false);
    if (camp.squad.length) { camp.spawnedEver = true; camp.respawnTimer = CAMP_MEMBER_RESPAWN; }
    else camp.respawnTimer = 2;
    this.spawnMerchantAt(camp);
  }

  private spawnMerchantAt(camp: CampState): void {
    const p = this.campSpawnPos(camp, Math.floor(camp.squadSize * 0.5));
    if (!p) return;
    const e = new Enemy('merchant', p, this.deps, { behavior: 'idle' });
    e.assignCamp(camp.build);
    this.enemies.push(e);
    this.attach(e);
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

  respawnTick(dt: number): void {
    const ppx = this.player.pos.x;
    const ppz = this.player.pos.z;
    for (const camp of this.camps) {
      const cdx = wrapDelta(camp.site.cx - ppx, WORLD_SIZE);
      const cdz = wrapDelta(camp.site.cz - ppz, WORLD_SIZE);
      if (cdx * cdx + cdz * cdz > SIM_RADIUS * SIM_RADIUS) continue;

      for (let i = camp.squad.length - 1; i >= 0; i--) if (!camp.squad[i].alive) camp.squad.splice(i, 1);

      if (!camp.spawnedEver && !camp.cleared && camp.squad.length === 0) {
        camp.respawnTimer -= dt;
        if (camp.respawnTimer <= 0) this.spawnCamp(camp);
        continue;
      }

      if (!camp.cleared && camp.spawnedEver && camp.squad.length === 0) {
        camp.cleared = true;
      }
    }
  }

  private wildTick(dt: number) {
    if (!this.night) return;
    this.wildTimer -= dt;
    if (this.wildTimer > 0) return;
    this.wildTimer = 1.4 + Math.random() * 1.4;

    let hostiles = 0;
    for (const e of this.enemies) if (e.alive && !e.cfg.peaceful) hostiles++;
    if (hostiles >= WILD_CAP) return;

    const w = this.deps.world;
    const pp = this.player.pos;
    for (let tries = 0; tries < 8; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = WILD_RING_MIN + Math.random() * (WILD_RING_MAX - WILD_RING_MIN);
      const fx = ((Math.floor(pp.x + Math.cos(a) * r) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const fz = ((Math.floor(pp.z + Math.sin(a) * r) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
      const h = w.highestY(fx, fz);
      if (h < 2 || h >= WORLD_HEIGHT - 3) continue;
      const floor = w.get(fx, h - 1, fz);
      if (isWaterId(floor) || floor === B.LEAVES || floor === B.AIR) continue;
      if (w.solid(fx, h, fz) || w.solid(fx, h + 1, fz)) continue;

      const roll = Math.random();
      const preset = roll < 0.5 ? 'grunt' : roll < 0.82 ? 'runner' : 'heavy';
      const p = new THREE.Vector3(fx + 0.5, h, fz + 0.5);
      const e = new Enemy(preset, p, this.deps, {
        behavior: Math.random() < 0.5 ? 'patrol' : 'idle',
      });
      e.home = { x: p.x, z: p.z };
      this.enemies.push(e);
      this.attach(e);
      e.alert(new THREE.Vector3(pp.x, pp.y, pp.z));
      return;
    }
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

  alertSquadOf(hitEnemy: Enemy) {
    const pp = this.player.pos;
    for (const camp of this.camps) {
      if (!camp.squad.includes(hitEnemy)) continue;
      for (const e of camp.squad) {
        if (e.alive) {
          const dx = wrapDelta(pp.x - e.pos.x, WORLD_SIZE);
          const dz = wrapDelta(pp.z - e.pos.z, WORLD_SIZE);
          e.alert(new THREE.Vector3(e.pos.x + dx, pp.y, e.pos.z + dz));
        }
      }
      return;
    }
    hitEnemy.alert(hitEnemy.pos.clone().add(new THREE.Vector3(
      wrapDelta(pp.x - hitEnemy.pos.x, WORLD_SIZE), 0,
      wrapDelta(pp.z - hitEnemy.pos.z, WORLD_SIZE),
    )));
  }

  alertCampsInRadius(pos: THREE.Vector3, radius: number) {
    const r2 = (radius + 0.6) * (radius + 0.6);
    for (const camp of this.camps) {
      let hit = false;
      for (const e of camp.squad) {
        if (!e.alive) continue;
        const dx = wrapDelta(pos.x - e.pos.x, WORLD_SIZE);
        const dz = wrapDelta(pos.z - e.pos.z, WORLD_SIZE);
        const dy = pos.y - (e.pos.y + 1);
        if (dx * dx + dy * dy + dz * dz < r2) { hit = true; break; }
      }
      if (hit) {
        const pp = this.player.pos;
        for (const e of camp.squad) {
          if (e.alive) {
            const edx = wrapDelta(pp.x - e.pos.x, WORLD_SIZE);
            const edz = wrapDelta(pp.z - e.pos.z, WORLD_SIZE);
            e.alert(new THREE.Vector3(e.pos.x + edx, pp.y, e.pos.z + edz));
          }
        }
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
    for (const e of this.enemies) if (!e.group.parent) scene.add(e.group);
  }

  clearAll() {
    for (const e of this.enemies) if (e.group.parent) e.group.parent.remove(e.group);
    this.enemies = [];
    for (const c of this.camps) {
      c.squad.length = 0;
      if (!c.cleared) {
        c.spawnedEver = false;
        c.respawnTimer = CAMP_MEMBER_RESPAWN;
      }
    }
    let cleared = 0;
    for (const c of this.camps) if (c.cleared) cleared++;
    this.campsCleared = cleared;
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

  assignCampToEnemy(e: Enemy, build: CampBuild): void {
    e.assignCamp(build);
  }

  getClearedCampIds(): number[] {
    return this.camps.filter((c) => c.cleared).map((c) => c.site.id);
  }

  markCampsCleared(ids: number[]): void {
    if (!ids.length) return;
    const set = new Set(ids);
    for (const c of this.camps) {
      if (set.has(c.site.id)) {
        c.cleared = true;
        c.spawnedEver = true;
      }
    }
    let cleared = 0;
    for (const c of this.camps) if (c.cleared) cleared++;
    this.campsCleared = cleared;
  }

  onPlayerDeath(cooldownSec = 6): void {
    const siteBySquad: Map<Enemy, CampState> = new Map();
    for (const camp of this.camps) {
      for (const m of camp.squad) {
        if (m.alive) siteBySquad.set(m, camp);
      }
    }
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const camp = siteBySquad.get(e) ?? null;

      let target = this.standablePos(
        e.respawnPoint.x,
        e.respawnPoint.z,
        e.respawnPoint.y,
      );
      if (!target && camp) {
        const slot = Math.max(0, camp.squad.indexOf(e));
        target = this.campSpawnPos(camp, slot);
      }
      if (!target) target = e.respawnPoint.clone();

      e.standDownToCamp(cooldownSec, target);
    }
  }
}
