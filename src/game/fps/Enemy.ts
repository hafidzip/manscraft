// Enemy system: Minecraft-style humanoid combatants with arms that aim and
// shoot, voxel-terrain physics, health bars, burst fire and death sequences.
// Behaviour is data-driven through EnemyConfig presets so new enemy types or
// AI tweaks can be added without touching the core loop. Subclass Enemy and
// override think() for fully custom behaviour.
import * as THREE from 'three';
import type { WorldLike } from './World';
import { WORLD_SIZE } from './World';
import { Effects } from './effects';
import { AudioSynth } from './audio';
import { box, MATS } from './models';
import { faceTexture, pixelTexture } from './textures';
import { findPath, canStand, snapToGround } from './Pathfinder';
import type { CampBuild, CampSite } from '../world/camps';
import { Biome } from '../world/biomes';
import { mulberry32 } from '../core/noise';
import { CAMP_CONFIG } from './camps';

/**
 * Shared per-frame pathfinding budget. The manager refills it each frame so
 * only a couple of A* searches ever run in a single frame, no matter how
 * many enemies are alive.
 */
const pathBudget = { tokens: 0 };

export type EnemyState = 'spawn' | 'patrol' | 'chase' | 'attack' | 'dead';

export interface EnemyConfig {
  id: string;
  name: string;
  hp: number;
  speed: number;          // walk speed (blocks/s)
  sightRange: number;     // max detection distance
  attackRange: number;    // max firing distance
  preferredRange: number; // tries to hold this distance
  attackCooldown: number; // seconds between bursts
  burst: number;          // shots per burst
  burstDelay: number;     // seconds between shots in a burst
  accuracy: number;       // 0..1 (1 = perfect)
  damage: number;         // damage per hit
  skin: string;
  shirt: string;
  pants: string;
  seed: number;
}

// ---------------------------------------------------------------------------
// FIRE RANGE TUNING
// ---------------------------------------------------------------------------
// Enemies only open fire when the player is within `attackRange` blocks AND
// line-of-sight is clear. Out of range they keep chasing/strafing but hold
// their fire. Adjust per-class ranges in ENEMY_PRESETS below — or flip the
// mode switch to 'distance' to use the single global constant for everyone.
// ---------------------------------------------------------------------------

/** 'config' = each class uses its own attackRange (see presets below). */
export const ENEMY_FIRE_MODE: 'config' | 'distance' = 'config';

/** Global fallback range used when ENEMY_FIRE_MODE === 'distance'. */
export const ENEMY_FIRE_RANGE = 28;

export const ENEMY_PRESETS: Record<string, EnemyConfig> = {
  grunt: {
    id: 'grunt', name: 'GRUNT', hp: 40, speed: 3.0, sightRange: 9999, attackRange: 26,
    preferredRange: 12, attackCooldown: 1.6, burst: 3, burstDelay: 0.16,
    accuracy: 0.72, damage: 7, skin: '#c98f5f', shirt: '#4a5d3a', pants: '#3a3f4a', seed: 12,
  },
  runner: {
    id: 'runner', name: 'RUNNER', hp: 26, speed: 4.4, sightRange: 9999, attackRange: 20,
    preferredRange: 7, attackCooldown: 1.1, burst: 4, burstDelay: 0.11,
    accuracy: 0.6, damage: 5, skin: '#a9764b', shirt: '#7a3030', pants: '#2c2c30', seed: 31,
  },
  heavy: {
    id: 'heavy', name: 'HEAVY', hp: 90, speed: 2.1, sightRange: 9999, attackRange: 34,
    preferredRange: 16, attackCooldown: 2.1, burst: 6, burstDelay: 0.13,
    accuracy: 0.8, damage: 10, skin: '#b9825a', shirt: '#2f3a4a', pants: '#23262c', seed: 55,
  },
};

/** minimal player surface enemies need (the unified engine Player satisfies it) */
export interface EnemyPlayer {
  pos: THREE.Vector3;
}

export interface EnemyDeps {
  world: WorldLike;
  effects: Effects;
  audio: AudioSynth;
  camera: THREE.Object3D;
  onPlayerHit(dmg: number, from: THREE.Vector3): void;
  onEnemyKilled(e: Enemy): void;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

export class Enemy {
  cfg: EnemyConfig;
  group = new THREE.Group();
  private bodyRoot = new THREE.Group();
  private legL = new THREE.Group();
  private legR = new THREE.Group();
  private armL = new THREE.Group();
  private armR = new THREE.Group();
  private weapon = new THREE.Group();
  private bolt = new THREE.Group();
  private hpFill!: THREE.Mesh;
  private hpBar!: THREE.Group;
  private muzzle = new THREE.Object3D();

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  hp: number;
  state: EnemyState = 'spawn';
  readonly halfW = 0.3;
  readonly height = 1.8;

  private walkPhase = 0;
  private speedN = 0;
  private losTimer = 0;
  private hasLos = false;
  private cooldown = 1.0;
  private burstLeft = 0;
  private burstTimer = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private stuckTimer = 0;
  private lastX = 0; private lastZ = 0;

  // ---- navigation
  private path: THREE.Vector3[] = [];
  private pathIdx = 0;
  private repathT = Math.random() * 0.6;
  private pathGoal = new THREE.Vector3();
  private lastKnown = new THREE.Vector3();
  private hasTarget = false;
  private searchT = 0;
  private grounded = false;
  private jumpCd = 0;
  private repathFails = 0;
  private wanderAngle = Math.random() * Math.PI * 2;
  private flashT = 0;
  private stateT = 0;
  private recoilT = 0;
  private weaponKick = 0;
  private aimPitch = 0;
  private bodyMats: THREE.MeshLambertMaterial[] = [];

  // ---- patrol / leash
  patrolPoints: { x: number; z: number }[] = [];
  patrolIdx = 0;
  home: { x: number; z: number } | null = null;
  maxLeash = 45;
  private leashT = 0;
  private returning = false;
  private dwellT = 0;

  private deps: EnemyDeps;

  constructor(preset: string, pos: THREE.Vector3, deps: EnemyDeps, overrides: Partial<EnemyConfig> = {}) {
    this.deps = deps;
    this.cfg = { ...ENEMY_PRESETS[preset], ...overrides };
    this.hp = this.cfg.hp;
    this.pos.copy(pos);
    this.lastX = pos.x; this.lastZ = pos.z;
    this.yaw = Math.random() * Math.PI * 2;
    this.build();
    this.group.position.copy(pos);
    this.deps.effects.puff(tmpV.set(pos.x, pos.y + 0.3, pos.z), tmpV2.set(0, 1, 0), 0.5, 0.7, '#b8b0a2');
  }

  // ------------------------------------------------------------ model
  private build() {
    const c = this.cfg;
    const skinMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.skin, 14, 16, c.seed) });
    const faceMat = new THREE.MeshLambertMaterial({ map: faceTexture(c.skin, c.seed) });
    const shirtMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.shirt, 16, 16, c.seed + 1) });
    const pantsMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.pants, 14, 16, c.seed + 2) });
    this.bodyMats = [skinMat, shirtMat, pantsMat];

    this.group.add(this.bodyRoot);

    // legs (model faces +Z)
    this.legL.position.set(-0.13, 0.78, 0);
    this.legR.position.set(0.13, 0.78, 0);
    box(this.legL, 0.2, 0.78, 0.22, 0, -0.39, 0, pantsMat);
    box(this.legR, 0.2, 0.78, 0.22, 0, -0.39, 0, pantsMat);
    box(this.legL, 0.21, 0.1, 0.3, 0, -0.75, 0.04, MATS.boot);
    box(this.legR, 0.21, 0.1, 0.3, 0, -0.75, 0.04, MATS.boot);
    this.bodyRoot.add(this.legL, this.legR);

    // torso
    box(this.bodyRoot, 0.46, 0.56, 0.24, 0, 1.06, 0, shirtMat);
    box(this.bodyRoot, 0.48, 0.14, 0.26, 0, 0.85, 0, MATS.black); // belt
    box(this.bodyRoot, 0.44, 0.2, 0.27, 0, 1.18, 0, MATS.vest);   // chest rig

    // Neck and head (face on +Z). The bottom of the head exactly meets the
    // top of the torso, so the NPC reads as one connected Minecraft body.
    box(this.bodyRoot, 0.16, 0.13, 0.16, 0, 1.38, 0, skinMat);
    const head = new THREE.Group();
    head.position.set(0, 1.34, 0);
    this.bodyRoot.add(head);
    const headMesh = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.42, 0.42),
      [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat]
    );
    headMesh.position.y = 0.21;
    head.add(headMesh);

    // Two independent Minecraft arms. In combat both rotate forward to grip
    // the rifle; when moving out of combat the support arm resumes a swing.
    this.armL.position.set(-0.28, 1.28, -0.015);
    box(this.armL, 0.18, 0.62, 0.18, 0, -0.28, 0, shirtMat);
    box(this.armL, 0.16, 0.16, 0.16, 0, -0.62, 0, skinMat);
    this.bodyRoot.add(this.armL);

    this.armR.position.set(0.28, 1.28, -0.015);
    box(this.armR, 0.18, 0.62, 0.18, 0, -0.28, 0, shirtMat);
    box(this.armR, 0.16, 0.16, 0.16, 0, -0.62, 0, skinMat);
    this.bodyRoot.add(this.armR);

    // Dedicated SMG rig. It is parented to the torso rather than a wrist so
    // both arms can visibly support it and recoil as a single firing pose.
    this.weapon.position.set(0, 1.16, 0.32);
    this.bodyRoot.add(this.weapon);
    box(this.weapon, 0.14, 0.115, 0.42, 0, 0, 0.12, MATS.gun);        // receiver
    box(this.weapon, 0.15, 0.028, 0.39, 0, 0.07, 0.12, MATS.black);    // top rail
    for (let i = 0; i < 5; i++) box(this.weapon, 0.16, 0.014, 0.022, 0, 0.09, -0.02 + i * 0.075, MATS.gun2);
    box(this.weapon, 0.125, 0.1, 0.28, 0, -0.005, 0.43, MATS.poly);    // handguard
    box(this.weapon, 0.065, 0.055, 0.25, 0, 0, 0.67, MATS.black);      // barrel
    box(this.weapon, 0.1, 0.09, 0.075, 0, 0, 0.81, MATS.black);        // muzzle brake
    box(this.weapon, 0.15, 0.13, 0.27, 0, -0.005, -0.28, MATS.poly);   // stock
    box(this.weapon, 0.16, 0.16, 0.04, 0, -0.005, -0.43, MATS.black);  // butt pad
    box(this.weapon, 0.1, 0.26, 0.11, 0, -0.16, 0.08, MATS.gun2, THREE.MathUtils.degToRad(-8)); // magazine
    box(this.weapon, 0.11, 0.19, 0.09, 0, -0.14, -0.09, MATS.poly, THREE.MathUtils.degToRad(-13)); // pistol grip
    box(this.weapon, 0.1, 0.15, 0.08, 0, -0.14, 0.4, MATS.gun2, THREE.MathUtils.degToRad(6)); // foregrip

    // Reflex sight and ejection port make the weapon readable at range.
    box(this.weapon, 0.1, 0.026, 0.11, 0, 0.115, 0.06, MATS.black);
    box(this.weapon, 0.014, 0.095, 0.022, -0.04, 0.16, 0.06, MATS.black);
    box(this.weapon, 0.014, 0.095, 0.022, 0.04, 0.16, 0.06, MATS.black);
    box(this.weapon, 0.1, 0.014, 0.022, 0, 0.205, 0.06, MATS.black);
    box(this.weapon, 0.018, 0.018, 0.008, 0, 0.16, 0.047, MATS.redGlow);
    box(this.weapon, 0.075, 0.055, 0.13, 0.078, 0.01, 0.02, MATS.black); // ejection port frame
    this.bolt.position.set(0.079, 0.01, 0.02);
    box(this.bolt, 0.02, 0.035, 0.1, 0, 0, 0, MATS.gun2);
    this.weapon.add(this.bolt);

    this.muzzle.position.set(0, 0.01, 0.86);
    this.weapon.add(this.muzzle);

    // health bar billboard
    this.hpBar = new THREE.Group();
    this.hpBar.position.set(0, 2.25, 0);
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.1), new THREE.MeshBasicMaterial({ color: '#14060f', transparent: true, opacity: 0.85, depthWrite: false }));
    this.hpFill = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.055), new THREE.MeshBasicMaterial({ color: '#e84fc0', depthWrite: false }));
    this.hpFill.position.z = 0.001;
    this.hpBar.add(bg, this.hpFill);
    this.group.add(this.hpBar);

    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; }
    });
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get center(): THREE.Vector3 { return tmpV3.copy(this.pos).add(tmpV.set(0, 1.0, 0)); }

  // ------------------------------------------------------------ damage
  takeDamage(amount: number, point: THREE.Vector3, headshot: boolean) {
    if (!this.alive) return;
    this.hp -= headshot ? amount * 2 : amount;
    this.flashT = 0.09;
    // knockback away from the hit
    tmpV.copy(this.pos).sub(point).setY(0);
    if (tmpV.lengthSq() < 0.001) tmpV.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    tmpV.normalize().multiplyScalar(headshot ? 2.2 : 1.2);
    this.vel.x += tmpV.x; this.vel.z += tmpV.z;
    // hit sparks
    for (let i = 0; i < 4; i++) {
      tmpV2.set((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3);
      this.deps.effects.spawnParticle(point, tmpV2, 0xd0342c, 0.035 + Math.random() * 0.02, 0.4, true);
    }
    if (this.hp <= 0) this.die(point);
  }

  private die(point: THREE.Vector3) {
    this.state = 'dead';
    this.stateT = 0;
    this.hpFill.visible = false;
    this.deps.audio.enemyDie();
    for (let i = 0; i < 14; i++) {
      tmpV.set((Math.random() - 0.5) * 5, Math.random() * 5 + 1, (Math.random() - 0.5) * 5);
      this.deps.effects.spawnParticle(
        point.clone().add(tmpV2.set((Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4)),
        tmpV, [0xd0342c, 0x6e1a14, 0x2a2a2e][i % 3], 0.05 + Math.random() * 0.05, 0.7 + Math.random() * 0.4, true
      );
    }
    this.deps.effects.puff(point, tmpV.set(0, 1, 0), 0.6, 1.0, '#9a948a');
    this.deps.onEnemyKilled(this);
  }

  // ------------------------------------------------------------ AI hooks
  /** Force the agent to recompute its route on the next update. */
  invalidatePath() {
    this.path.length = 0;
    this.pathIdx = 0;
    this.repathT = 0;
  }

  /** Give the agent a destination it hasn't directly seen (sound, orders…). */
  investigate(pos: THREE.Vector3) {
    this.lastKnown.copy(pos);
    this.hasTarget = true;
    this.searchT = 0;
    this.invalidatePath();
  }

  /** Debug/AI helper: is this agent currently following a route? */
  get navigating(): boolean { return this.pathIdx < this.path.length; }

  // ------------------------------------------------------------ patrol / camp
  assignCamp(build: CampBuild): void {
    this.patrolPoints = (build.patrolPoints.length ? build.patrolPoints : build.posts).slice();
    this.home = { x: build.site.cx, z: build.site.cz };
    this.maxLeash = Math.max(CAMP_CONFIG.maxLeash, build.site.radius * 3);
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.patrolPoints.length; i++) {
      const d = this.planarDist(this.patrolPoints[i].x, this.patrolPoints[i].z);
      if (d < bd) { bd = d; best = i; }
    }
    this.patrolIdx = best;
    this.returning = false;
    this.leashT = 0;
    if (this.state === 'spawn') this.state = 'patrol';
  }

  /** ground distance from this enemy to a point */
  private planarDist(x: number, z: number): number {
    return Math.hypot(x - this.pos.x, z - this.pos.z);
  }

  /** waypoint loop; returns the point to steer toward, or null = stand and idle */
  private patrolGoal(dt: number): { x: number; z: number } | null {
    if (this.returning && this.home) {
      if (this.planarDist(this.home.x, this.home.z) > Math.max(6, this.maxLeash * 0.3)) return this.home;
      this.returning = false;
    }
    if (!this.patrolPoints.length) return this.home;
    if (this.dwellT > 0) { this.dwellT -= dt; return null; }
    const wp = this.patrolPoints[this.patrolIdx % this.patrolPoints.length];
    if (this.planarDist(wp.x, wp.z) < 1.5) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
      this.dwellT = 0.4 + (this.patrolIdx % 3) * 0.25;
      return null;
    }
    return wp;
  }

  // ------------------------------------------------------------ update
  update(dt: number, player: EnemyPlayer) {
    const c = this.cfg;
    this.stateT += dt;

    if (this.state === 'dead') {
      // topple, then sink and flag removal
      this.bodyRoot.rotation.x = THREE.MathUtils.lerp(this.bodyRoot.rotation.x, -Math.PI / 2, Math.min(1, dt * 7));
      if (this.stateT > 1.1) this.group.position.y -= dt * 0.9;
      return this.stateT < 2.2;
    }

    if (this.state === 'spawn') {
      this.group.position.y = this.pos.y + Math.min(1, this.stateT / 0.5) * 0 - (1 - Math.min(1, this.stateT / 0.5)) * 1.2;
      if (this.stateT > 0.5) { this.state = this.patrolPoints.length ? 'patrol' : 'chase'; this.group.position.y = this.pos.y; }
      return true;
    }

    // ---- timers
    this.cooldown -= dt;
    this.losTimer -= dt;
    this.strafeTimer -= dt;
    this.recoilT = Math.max(0, this.recoilT - dt);
    this.weaponKick = Math.max(0, this.weaponKick - dt * 15);
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 1.4 + Math.random() * 2;
      this.strafeDir = Math.random() > 0.5 ? 1 : -1;
    }

    // ---- perception (multi-point LOS: check eyes-to-head, eyes-to-torso,
    // eyes-to-feet so the AI can spot a partially exposed player)
    const toPlayer = tmpV.copy(player.pos).sub(this.pos);
    const dist = Math.hypot(toPlayer.x, toPlayer.z);
    void toPlayer.length(); // used implicitly via dist
    if (this.losTimer <= 0) {
      this.losTimer = 0.2;
      const eye = tmpV2.copy(this.pos).add(tmpV3.set(0, 1.6, 0));
      this.hasLos = false;
      // check three heights: head (1.6), chest (1.1), feet (0.2)
      for (const tgtY of [1.6, 1.1, 0.2]) {
        const dir = tmpV3.copy(player.pos).add(tmpV.set(0, tgtY, 0)).sub(eye);
        const d = dir.length();
        dir.divideScalar(d || 1);
        const hit = this.deps.world.raycast(eye, dir, d);
        if (!hit || hit.dist > d - 0.3) { this.hasLos = true; break; }
      }
    }

    // ---- target memory
    let hasLos = this.hasLos;  // let so leash can suppress it
    if (hasLos) {
      this.lastKnown.copy(player.pos);
      this.hasTarget = true;
      this.searchT = 0;
    } else {
      this.searchT += dt;
    }

    // ── leash: player dragged us too far from camp ──
    if (this.home && this.state !== 'dead') {
      const pd = Math.hypot(player.pos.x - this.home.x, player.pos.z - this.home.z);
      if (this.hasTarget && pd > this.maxLeash) {
        this.leashT += dt;
        if (this.leashT > 3) {
          this.hasTarget = false; this.lastKnown.set(0, 0, 0); this.searchT = 0;
          this.returning = true; this.leashT = 0;
          hasLos = false;
        }
      } else if (pd <= this.maxLeash * 0.9) {
        this.leashT = 0;
      }
    }

    // ── patrol vs combat arbitration ──
    let patrolSteerGoal: { x: number; z: number } | null = null;
    const idle = !hasLos && (!this.hasTarget || this.searchT > 6);
    if (idle && this.state !== 'dead' && (this.patrolPoints.length > 0 || this.returning)) {
      if (this.searchT > 6) { this.hasTarget = false; this.lastKnown.set(0, 0, 0); }
      this.state = 'patrol';
      patrolSteerGoal = this.patrolGoal(dt);
    } else if (hasLos && this.state === 'patrol') {
      this.state = 'chase';
      this.returning = false; this.dwellT = 0; this.leashT = 0;
    }

    // ---- facing: look at the player when visible, patrol goal, else along the path
    let faceX = toPlayer.x, faceZ = toPlayer.z;
    if (this.state === 'patrol' && patrolSteerGoal) {
      faceX = patrolSteerGoal.x - this.pos.x;
      faceZ = patrolSteerGoal.z - this.pos.z;
    } else if (!hasLos && this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx];
      faceX = wp.x - this.pos.x;
      faceZ = wp.z - this.pos.z;
    }
    const targetYaw = Math.atan2(faceX, faceZ);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 8);

    // ---- steering (world space)
    this.repathT -= dt;
    this.jumpCd = Math.max(0, this.jumpCd - dt);
    let wx = 0, wz = 0;
    let wantJump = false;

    const inCombatRange = hasLos && dist < c.preferredRange * 1.15;

    if (this.state === 'patrol') {
      // ---- patrol steering: walk toward the current waypoint at reduced speed
      if (patrolSteerGoal) {
        const pdx = patrolSteerGoal.x - this.pos.x;
        const pdz = patrolSteerGoal.z - this.pos.z;
        const pd = Math.hypot(pdx, pdz) || 1;
        wx = (pdx / pd) * CAMP_CONFIG.patrolSpeedFactor;
        wz = (pdz / pd) * CAMP_CONFIG.patrolSpeedFactor;
      } else {
        // dwelling: damp velocity, idle arm sway
        wx = 0; wz = 0;
      }
    } else if (inCombatRange) {
      // Direct steering: hold preferred range and orbit. No pathfinding cost.
      this.path.length = 0;
      this.pathIdx = 0;
      const inv = 1 / (dist || 1);
      const fx = toPlayer.x * inv, fz = toPlayer.z * inv;
      const rx = fz, rz = -fx;
      if (dist > c.preferredRange) { wx += fx; wz += fz; }
      else if (dist < c.preferredRange * 0.55) { wx -= fx * 0.85; wz -= fz * 0.85; }
      wx += rx * this.strafeDir * 0.7;
      wz += rz * this.strafeDir * 0.7;
      // hop over small ledges while circling
      if (this.grounded && this.jumpCd <= 0) {
        const ax = Math.round(this.pos.x + wx * 0.7);
        const az = Math.round(this.pos.z + wz * 0.7);
        const fy = Math.floor(this.pos.y);
        if (this.deps.world.solid(ax, fy, az) && !this.deps.world.solid(ax, fy + 2, az)) wantJump = true;
      }
    } else if (this.hasTarget) {
      // ---- navigate to the last known position with A*
      const goalMoved = this.pathGoal.distanceToSquared(this.lastKnown) > 4;
      const needPath = this.path.length === 0 || this.pathIdx >= this.path.length;
      const nearGoal = this.pos.distanceToSquared(this.lastKnown) < 2.5;
      if ((this.repathT <= 0 || goalMoved || needPath) && pathBudget.tokens > 0 && !nearGoal) {
        pathBudget.tokens--;
        this.repathT = 0.4 + Math.random() * 0.45;
        this.pathGoal.copy(this.lastKnown);
        const ok = findPath(
          this.deps.world,
          Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z),
          Math.floor(this.lastKnown.x), Math.floor(this.lastKnown.y), Math.floor(this.lastKnown.z),
          this.path,
          { maxNodes: 1800, maxFall: 8, maxJump: 2, reachRadius: 1.5 }
        );
        this.pathIdx = 0;
        if (!ok && this.path.length === 0) {
          this.repathFails++;
          if (this.repathFails > 4) { this.hasTarget = false; this.repathFails = 0; }
        } else {
          this.repathFails = 0;
        }
      }

      // ---- follow the path
      if (this.pathIdx < this.path.length) {
        const wp = this.path[this.pathIdx];
        const dxw = wp.x - this.pos.x;
        const dzw = wp.z - this.pos.z;
        const dyw = wp.y - this.pos.y;
        const hd = Math.hypot(dxw, dzw);

        // advance when the waypoint is reached (generous vertical tolerance
        // so falling into a tunnel doesn't stall the agent)
        if (hd < 0.42 && dyw < 0.6 && dyw > -1.6) {
          this.pathIdx++;
        } else {
          const invd = 1 / (hd || 1);
          wx = dxw * invd;
          wz = dzw * invd;
          // jump up a step, or hop a gap when the next node is across a drop
          if (this.grounded && this.jumpCd <= 0 && dyw > 0.55 && hd < 1.6) wantJump = true;
        }

        // way off the path (knocked back / fell) -> repath sooner
        if (hd > 4.5) this.repathT = Math.min(this.repathT, 0.1);
      } else if (this.searchT > 5) {
        // lost the trail: slow wander so they don't freeze in place
        this.wanderAngle += (Math.random() - 0.5) * dt * 2;
        wx = Math.sin(this.wanderAngle) * 0.45;
        wz = Math.cos(this.wanderAngle) * 0.45;
      }
    }

    if (this.state === 'attack' && inCombatRange) { wx *= 0.3; wz *= 0.3; }

    const wlen = Math.hypot(wx, wz);
    if (wlen > 1) { wx /= wlen; wz /= wlen; }

    const accel = 26;
    this.vel.x += wx * accel * dt;
    this.vel.z += wz * accel * dt;
    const damp = Math.max(0, 1 - 8 * dt);
    this.vel.x *= damp; this.vel.z *= damp;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    const maxS = c.speed;
    if (hs > maxS) { this.vel.x *= maxS / hs; this.vel.z *= maxS / hs; }

    // ---- gravity, deliberate jumps and stuck recovery
    this.vel.y -= 26 * dt;
    this.vel.y = Math.max(this.vel.y, -40);

    if (wantJump && this.grounded && this.jumpCd <= 0) {
      this.vel.y = 8.6;
      this.jumpCd = 0.35;
      this.grounded = false;
    }

    const moveDelta = Math.abs(this.pos.x - this.lastX) + Math.abs(this.pos.z - this.lastZ);
    const wantsToMove = Math.hypot(wx, wz) > 0.1;
    if (this.stateT > 0.6 && wantsToMove && moveDelta < 0.02 && this.grounded) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.35) {
        // try hopping the obstruction, and rebuild the route
        if (this.jumpCd <= 0) { this.vel.y = 8.6; this.jumpCd = 0.35; }
        this.stuckTimer = 0;
        this.repathT = 0;
        this.path.length = 0;
        this.pathIdx = 0;
      }
    } else this.stuckTimer = 0;
    this.lastX = this.pos.x; this.lastZ = this.pos.z;

    // ---- physics (axis-separated AABB)
    this.moveAxis(0, this.vel.x * dt);
    this.moveAxis(2, this.vel.z * dt);
    const grounded = { v: false };
    this.moveAxisY(this.vel.y * dt, grounded);
    if (grounded.v) this.vel.y = 0;
    this.grounded = grounded.v;

    // ---- firing (no distance limit: fires whenever line of sight to player is clear)
    // ---- firing: only when the player is in line of sight AND within the
    // configured attack range. Out of range the enemy keeps chasing/strafing
    // but holds its fire, so it can't snipe you across the map.
    const fireRange = ENEMY_FIRE_MODE === 'distance' ? ENEMY_FIRE_RANGE : c.attackRange;
    const inFireRange = dist <= fireRange;
    if (this.state !== 'patrol' && hasLos && inFireRange) {
      this.state = 'attack';
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          this.fireOneShot(player, dist);
          this.burstLeft--;
          this.burstTimer = c.burstDelay;
        }
      } else if (this.cooldown <= 0) {
        this.burstLeft = c.burst;
        this.burstTimer = 0;
        this.cooldown = c.attackCooldown * (0.8 + Math.random() * 0.5);
      }
    } else if (this.state === 'attack') this.state = this.patrolPoints.length ? 'patrol' : 'chase';

    // ---- animate
    const moving = hs > 0.4;
    this.speedN += ((moving ? Math.min(1, hs / 4) : 0) - this.speedN) * Math.min(1, dt * 8);
    if (grounded.v && moving) this.walkPhase += dt * (5 + hs * 1.1);
    const sw = Math.sin(this.walkPhase) * 0.65 * this.speedN;
    this.legL.rotation.x = -sw;
    this.legR.rotation.x = sw;

    // Aim the two arms and weapon as one combat pose whenever there is line of sight.
    const shoulder = tmpV.set(this.pos.x + Math.sin(this.yaw) * 0.31, this.pos.y + 1.28, this.pos.z + Math.cos(this.yaw) * 0.31);
    const aim = tmpV2.copy(player.pos).add(tmpV3.set(0, 1.1, 0)).sub(shoulder);
    const horiz = Math.hypot(aim.x, aim.z);
    const pitch = Math.atan2(aim.y, horiz || 1);
    this.aimPitch = THREE.MathUtils.clamp(pitch, -0.38, 0.38);
    const combatPose = hasLos;
    if (combatPose) {
      const armPitch = Math.PI / 2 + this.aimPitch * 0.8;
      this.armL.rotation.set(armPitch + 0.05 - this.weaponKick * 0.12, 0, 0.13);
      this.armR.rotation.set(armPitch - 0.06 - this.weaponKick * 0.18, 0, -0.13);
    } else {
      this.armL.rotation.set(sw * 0.8, 0, 0);
      this.armR.rotation.set(-sw * 0.8, 0, 0);
    }

    // Weapon recoil includes a short rearward push, muzzle rise and bolt cycle.
    this.weapon.position.set(0, 1.16 - this.weaponKick * 0.014, 0.32 - this.weaponKick * 0.085);
    this.weapon.rotation.set(-this.aimPitch - this.weaponKick * 0.13, 0, Math.sin(this.walkPhase) * 0.015 * this.speedN);
    this.bolt.position.z = 0.02 - this.weaponKick * 0.1;

    this.bodyRoot.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.03 * this.speedN;

    // hit flash
    if (this.flashT > 0) {
      this.flashT -= dt;
      const e = Math.max(0, this.flashT / 0.09) * 0.9;
      for (const m of this.bodyMats) m.emissive.setRGB(e, e, e);
    }

    // ---- sync transform
    this.group.position.copy(this.pos);
    this.group.rotation.y = this.yaw;
    this.hpBar.lookAt(this.deps.camera.position.x, this.hpBar.getWorldPosition(tmpV).y, this.deps.camera.position.z);
    const f = Math.max(0, this.hp / c.hp);
    this.hpFill.scale.x = f;
    this.hpFill.position.x = -(1 - f) * 0.33;
    this.hpFill.visible = f < 1;
    return true;
  }

  private fireOneShot(player: EnemyPlayer, dist: number) {
    this.recoilT = 0.06;
    this.weaponKick = 1;
    const muzzle = this.muzzle.getWorldPosition(new THREE.Vector3());
    const target = player.pos.clone().add(tmpV.set(0, 1.0, 0));
    const dir = target.sub(muzzle).normalize();
    const spread = (1 - this.cfg.accuracy) * 0.09;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    this.deps.effects.muzzleFlash(muzzle, 0.45);
    this.deps.audio.shot({ freq: 1700, dur: 0.07, gain: 0.26 * THREE.MathUtils.clamp(1 - dist / 150, 0.15, 1), sub: 260 });

    // did the shot reach the player before terrain?
    const toP = player.pos.clone().add(tmpV.set(0, 0.95, 0)).sub(muzzle);
    const t = toP.dot(dir);
    let hitPlayer = false;
    if (t > 0) {
      const closest = muzzle.clone().addScaledVector(dir, t);
      if (closest.distanceTo(player.pos.clone().add(tmpV.set(0, 0.95, 0))) < 0.55) {
        const worldHit = this.deps.world.raycast(muzzle, dir, t);
        if (!worldHit || worldHit.dist > t - 0.1) hitPlayer = true;
      }
    }
    const end = muzzle.clone().addScaledVector(dir, 200);
    if (hitPlayer) {
      this.deps.effects.tracer(muzzle, player.pos.clone().add(tmpV.set(0, 1.0, 0)));
      this.deps.onPlayerHit(this.cfg.damage, muzzle);
    } else {
      const worldHit = this.deps.world.raycast(muzzle, dir, 200);
      const endPoint = worldHit ? worldHit.point : end;
      this.deps.effects.tracer(muzzle, endPoint);
      if (worldHit) this.deps.effects.impact(worldHit.point, worldHit.normal, worldHit.block);
    }
  }

  // ------------------------------------------------------------ physics
  private moveAxis(axis: 0 | 2, delta: number) {
    if (delta === 0) return;
    if (axis === 0) this.pos.x += delta; else this.pos.z += delta;
    const w = this.deps.world;
    const hw = this.halfW, h = this.height;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minY = Math.floor(this.pos.y), maxY = Math.floor(this.pos.y + h - 0.001);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      if (!w.solid(x, y, z)) continue;
      if (axis === 0) {
        if (delta > 0) this.pos.x = x - hw - 0.001; else this.pos.x = x + 1 + hw + 0.001;
        this.vel.x = 0;
      } else {
        if (delta > 0) this.pos.z = z - hw - 0.001; else this.pos.z = z + 1 + hw + 0.001;
        this.vel.z = 0;
      }
    }
  }

  private moveAxisY(delta: number, grounded: { v: boolean }) {
    if (delta === 0) return;
    this.pos.y += delta;
    const w = this.deps.world;
    const hw = this.halfW, h = this.height;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minY = Math.floor(this.pos.y), maxY = Math.floor(this.pos.y + h - 0.001);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);
    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      if (!w.solid(x, y, z)) continue;
      if (delta > 0) { this.pos.y = y - h - 0.001; this.vel.y = 0; }
      else { this.pos.y = y + 1 + 0.001; this.vel.y = 0; grounded.v = true; }
    }
  }
}

// ================================================================ camps
/** Seconds before a single dead squad member is replaced. */
export const CAMP_MEMBER_RESPAWN = CAMP_CONFIG.respawnDelay;
/**
 * Seconds before a fully-wiped camp repopulates its whole squad.
 * Rule (b): camps are NOT permanently cleared — `cleared` stays true for this
 * whole window (HUD readout), then the camp comes back for grindability.
 * Set to Infinity for rule (a) (clear-once) without touching anything else.
 */
export const CAMP_REPOPULATE_DELAY = CAMP_CONFIG.repopulateDelay;
/** Never pop a body in the player's face. */
const RESPAWN_SAFE_DIST = 12;

export interface CampState {
  site: CampSite;
  build: CampBuild;
  squad: Enemy[];        // living members only (pruned every tick)
  squadSize: number;     // 3–5, by biome / footprint
  roster: string[];      // deterministic preset per slot
  respawnTimer: number;
  cleared: boolean;      // full squad wiped, waiting on CAMP_REPOPULATE_DELAY
  spawnedEver: boolean;  // guards "cleared" before the first spawn lands
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

export class EnemyManager {
  enemies: Enemy[] = [];
  kills = 0;
  enabled = true;
  /** Stable read-out for Tasks 5/6: per-camp `cleared` + `site.cx/cz`. */
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
    this.primed = false;   // squads spawn on the first update tick
  }

  get aliveCount(): number {
    return this.enemies.filter((e) => e.alive).length;
  }

  update(dt: number) {
    if (!this.enabled) return;
    if (!this.primed) { this.primed = true; for (const c of this.camps) this.spawnCamp(c); }

    pathBudget.tokens = 2;

    // update + cull
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const keep = this.enemies[i].update(dt, this.player);
      if (!keep) {
        const g = this.enemies[i].group;
        g.parent?.remove(g);
        this.enemies.splice(i, 1);
      }
    }
    // separation
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

  // ---------------------------------------------------------- camp spawning
  private attach(e: Enemy) {
    const parent = this.scene ?? this.deps.world.group.parent;
    if (parent && !e.group.parent) parent.add(e.group);
  }

  /** nearest standable block column, biased to camp ground so nobody spawns on a tent roof */
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

  /** watchposts first, then the patrol ring, then a fallback inner circle */
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
    const e = new Enemy(camp.roster[slot % camp.roster.length], p, this.deps);
    e.assignCamp(camp.build);          // patrol route + leash (Task 3)
    this.enemies.push(e);
    this.attach(e);
    camp.squad.push(e);
    return true;
  }

  /** fill a camp to squadSize at its posts */
  spawnCamp(camp: CampState): void {
    for (let i = camp.squad.length; i < camp.squadSize; i++) this.spawnMember(camp, i, false);
    if (camp.squad.length) { camp.spawnedEver = true; camp.respawnTimer = CAMP_MEMBER_RESPAWN; }
    else camp.respawnTimer = 10;        // hostile terrain: retry, don't flag cleared
  }

  /** per-camp: trickle dead members back, or repopulate a wiped camp */
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
        camp.respawnTimer = 3;          // player too close / no footing: try again shortly
      } else {
        camp.spawnedEver = true;
        camp.respawnTimer = CAMP_MEMBER_RESPAWN;
      }
    }
  }

  /** Hitscan test from the player's weapon against all living enemies. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): EnemyHit | null {
    let best: EnemyHit | null = null;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      // body sphere
      const bc = e.pos.clone().add(tmpV.set(0, 1.0, 0));
      const tb = this.raySphere(origin, dir, bc, 0.52);
      // head sphere
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

  /** Alert nearby enemies to a sound (gunshot, explosion, etc.). */
  alertNearby(soundPos: THREE.Vector3, hearRange = 45) {
    const r2 = hearRange * hearRange;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      if (e.pos.distanceToSquared(soundPos) < r2) {
        e.investigate(soundPos);
      }
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

  /** Instantly remove every enemy, then re-arm camps to repopulate next tick. */
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

  /** Enable/disable spawning. */
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
