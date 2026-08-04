import * as THREE from 'three';
import type { CampBuild, CampSite } from '../../../world/camps';
import { Biome } from '../../../world/biomes';
import { mulberry32 } from '../../../core/noise';
import { canStand, snapToGround } from '../../Pathfinder';
import { CAMP_CONFIG } from '../../camps';
import { Enemy } from './enemyAgent';
import {
  pathBudget, type EnemyPlayer, type EnemyDeps, type EnemyHit, ENEMY_PRESETS,
} from './enemyTypes';

const tmpV = new THREE.Vector3();

/** Seconds before a single dead squad member is replaced. */
export const CAMP_MEMBER_RESPAWN = CAMP_CONFIG.respawnDelay;
/** Seconds before a fully-wiped camp repopulates its whole squad. */
export const CAMP_REPOPULATE_DELAY = CAMP_CONFIG.repopulateDelay;
/** Never pop a body in the player's face. */
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

export class EnemyManager {
  enemies: Enemy[] = [];
  kills = 0;
  enabled = true;
  camps: CampState[] = [];
  campsTotal = 0;
  campsCleared = 0;
  private primed = false;
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
        respawnTimer: CAMP_MEMBER_RESPAWN,
        cleared: false, spawnedEver: false,
      };
    });
    this.campsTotal = this.camps.length;
    this.campsCleared = 0;
    this.primed = false;
  }

  get aliveCount(): number {
    return this.enemies.filter((e) => e.alive).length;
  }

  update(dt: number) {
    if (!this.enabled) return;
    if (!this.primed) { this.primed = true; for (const c of this.camps) this.spawnCamp(c); }

    pathBudget.tokens = 2;

    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const keep = this.enemies[i].update(dt, this.player);
      if (!keep) {
        const g = this.enemies[i].group;
        g.parent?.remove(g);
        this.enemies.splice(i, 1);
      }
    }
    for (let i = 0; i < this.enemies.length; i++) {
      for (let j = i + 1; j < this.enemies.length; j++) {
        const a = this.enemies[i], b = this.enemies[j];
        if (!a.alive || !b.alive) continue;
        const dx = a.pos.x - b.pos.x, dz = a.pos.z - b.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.9 && d > 0.001) {
          const push = (0.9 - d) * 2 * dt;
          a.pos.x += (dx / d) * push; a.pos.z += (dz / d) * push;
          b.pos.x -= (dx / d) * push; b.pos.z -= (dz / d) * push;
        }
      }
    }

    this.respawnTick(dt);
    let cleared = 0;
    for (const c of this.camps) if (c.cleared) cleared++;
    this.campsCleared = cleared;
    this.campsTotal = this.camps.length;
  }

  private attach(e: Enemy) {
    const parent = this.scene ?? this.deps.world.group.parent;
    if (parent && !e.group.parent) parent.add(e.group);
  }

  private standablePos(x: number, z: number, hintY: number): THREE.Vector3 | null {
    const w = this.deps.world;
    const fx = Math.floor(x), fz = Math.floor(z);
    const top = w.highestY(fx, fz) + 1;
    let y = Math.min(top, hintY + 4);
    if (!canStand(w, fx, y, fz)) {
      y = snapToGround(w, fx, y, fz, 12);
      if (y < 0) { y = top; if (!canStand(w, fx, y, fz)) return null; }
    }
    return new THREE.Vector3(fx + 0.5, y, fz + 0.5);
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
    return this.standablePos(s.cx, s.cz, s.y);
  }

  private spawnMember(camp: CampState, slot: number, guardPlayer: boolean): boolean {
    const p = this.campSpawnPos(camp, slot);
    if (!p) return false;
    if (guardPlayer && p.distanceTo(this.player.pos) < RESPAWN_SAFE_DIST) return false;
    // Randomly assign behavior: 60% patrol, 40% idle (unless overridden by preset)
    const presetId = camp.roster[slot % camp.roster.length];
    const baseCfg = { ...ENEMY_PRESETS[presetId] };
    // Override behavior based on slot position for variety (first enemy usually patrols)
    if (baseCfg.behavior === 'patrol') {
      // Mix it up: even slots more likely to patrol, odd slots more likely to idle
      baseCfg.behavior = slot % 2 === 0 ? 'patrol' : (Math.random() < 0.5 ? 'patrol' : 'idle');
    }
    const e = new Enemy(presetId, p, this.deps, { behavior: baseCfg.behavior });
    e.assignCamp(camp.build);
    this.enemies.push(e);
    this.attach(e);
    camp.squad.push(e);
    return true;
  }

  spawnCamp(camp: CampState): void {
    for (let i = camp.squad.length; i < camp.squadSize; i++) this.spawnMember(camp, i, false);
    if (camp.squad.length) { camp.spawnedEver = true; camp.respawnTimer = CAMP_MEMBER_RESPAWN; }
    else camp.respawnTimer = 10;
  }

  respawnTick(dt: number): void {
    for (const camp of this.camps) {
      for (let i = camp.squad.length - 1; i >= 0; i--) if (!camp.squad[i].alive) camp.squad.splice(i, 1);
      if (!camp.cleared && camp.spawnedEver && camp.squad.length === 0) {
        camp.cleared = true;
        camp.respawnTimer = CAMP_REPOPULATE_DELAY;
        continue;
      }
      if (!camp.cleared && camp.squad.length >= camp.squadSize) {
        camp.respawnTimer = CAMP_MEMBER_RESPAWN;
        continue;
      }
      camp.respawnTimer -= dt;
      if (camp.respawnTimer > 0) continue;
      if (camp.cleared) {
        camp.cleared = false;
        camp.squad.length = 0;
        this.spawnCamp(camp);
      } else if (!this.spawnMember(camp, camp.squad.length, true)) {
        camp.respawnTimer = 3;
      } else {
        camp.spawnedEver = true;
        camp.respawnTimer = CAMP_MEMBER_RESPAWN;
      }
    }
  }

  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    let best: EnemyHit | null = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const bc = e.pos.clone().add(tmpV.set(0, 1.0, 0));
      const tb = this.raySphere(origin, dir, bc, 0.52);
      const hc = e.pos.clone().add(tmpV.set(0, 1.77, 0));
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
      if (!e.alive) continue;
      if (e.pos.distanceToSquared(soundPos) < r2) e.investigate(soundPos);
    }
  }

  notifyWorldChanged(pos: THREE.Vector3, radius = 26) {
    const r2 = radius * radius;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.pos.distanceToSquared(pos) < r2) e.invalidatePath();
    }
  }

  damageInRadius(pos: THREE.Vector3, radius: number, dmg: number) {
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const d = e.pos.clone().add(tmpV.set(0, 1, 0)).distanceTo(pos);
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
      c.cleared = false;
      c.spawnedEver = false;
      c.respawnTimer = CAMP_MEMBER_RESPAWN;
    }
    this.campsCleared = 0;
    this.primed = false;
  }

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
}

