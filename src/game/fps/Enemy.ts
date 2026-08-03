// Enemy system: Minecraft-style humanoid combatants with arms that aim and
// shoot, voxel-terrain physics, health bars, burst fire and death sequences.
// Behaviour is data-driven through EnemyConfig presets so new enemy types or
// AI tweaks can be added without touching the core loop. Subclass Enemy and
// override think() for fully custom behaviour.
import * as THREE from 'three';
import type { WorldLike } from './World';
import { WORLD_SIZE, WORLD_HEIGHT, wrapDelta } from '../core/constants';
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

/**
 * Walk speeds are tuned against the player controller (walk 4.4, sprint 6.6).
 * Anything slower than a sprint means the AI can never close a gap, so the
 * squad reads as harmless — grunts keep pace with a walk and runners can
 * actually run a fleeing player down.
 */
export const ENEMY_PRESETS: Record<string, EnemyConfig> = {
  grunt: {
    id: 'grunt', name: 'GRUNT', hp: 40, speed: 4.6, sightRange: 9999, attackRange: 26,
    preferredRange: 10, attackCooldown: 1.6, burst: 3, burstDelay: 0.16,
    accuracy: 0.72, damage: 7, skin: '#c98f5f', shirt: '#4a5d3a', pants: '#3a3f4a', seed: 12,
  },
  runner: {
    id: 'runner', name: 'RUNNER', hp: 26, speed: 6.2, sightRange: 9999, attackRange: 20,
    preferredRange: 6, attackCooldown: 1.1, burst: 4, burstDelay: 0.11,
    accuracy: 0.6, damage: 5, skin: '#a9764b', shirt: '#7a3030', pants: '#2c2c30', seed: 31,
  },
  heavy: {
    id: 'heavy', name: 'HEAVY', hp: 90, speed: 3.6, sightRange: 9999, attackRange: 34,
    preferredRange: 14, attackCooldown: 2.1, burst: 6, burstDelay: 0.13,
    accuracy: 0.8, damage: 10, skin: '#b9825a', shirt: '#2f3a4a', pants: '#23262c', seed: 55,
  },
};

/** Extra speed while sprinting after a player who is out of firing position. */
const CHASE_SPRINT = 1.3;

// ---------------------------------------------------------------------------
// CONTEXT STEERING
// ---------------------------------------------------------------------------
// Rather than shoving the agent straight at its goal and hoping collision
// resolves the rest (which reads as "walks into walls until it gives up"),
// every frame we score a fan of candidate directions against the voxel world:
//
//   interest  how well the direction serves the goal (dot product)
//   danger    walls taller than a step, lethal drops, corner clipping
//
// The best-scoring direction wins. This is the standard context-steering /
// steering-behaviour approach and it gives smooth wall sliding, doorway
// threading and ledge avoidance for free, with A* reserved for real routing.
// ---------------------------------------------------------------------------

/** candidate directions in the context map (45° apart) */
const STEER_DIRS = 8;
const STEER_COS = new Float32Array(STEER_DIRS);
const STEER_SIN = new Float32Array(STEER_DIRS);
for (let i = 0; i < STEER_DIRS; i++) {
  const a = (i / STEER_DIRS) * Math.PI * 2;
  STEER_COS[i] = Math.cos(a);
  STEER_SIN[i] = Math.sin(a);
}

/** how far ahead each probe looks (blocks) */
const PROBE_DIST = 1.15;
/** tallest ledge the agent walks up without jumping */
const MAX_STEP = 1;
/** tallest ledge the agent will jump onto */
const MAX_JUMP_UP = 2;
/** deepest drop the agent is willing to walk off */
const MAX_SAFE_DROP = 4;

/** line-of-sight sample heights: head, chest, feet (module-level: no per-frame array alloc) */
const LOS_HEIGHTS = [1.6, 1.1, 0.2];
/** out of firing range a single torso ray keeps awareness at 1/3 the cost */
const LOS_HEIGHTS_FAR = [1.1];

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
/** per-frame minimum-image copy of the player position (toroidal world) */
const tmpPlayerImg = new THREE.Vector3();
/** scratch result for the context-steering solver (single-threaded) */
const steerOut = { x: 0, z: 0, jump: false };

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
  /** while > 0 a wall beat direct pursuit, so route around it with A* */
  private directBlockT = 0;
  /** last context-steering direction index (commitment / anti-jitter) */
  private lastSteerIdx = -1;
  /** consecutive frames the context map found no way forward */
  private boxedT = 0;
  // ---- steering throttle: the context map is resolved a few times a second
  // (staggered per agent), not every frame. Velocity integration keeps the
  // motion smooth in between, and re-solving faster than the agent can cross
  // a voxel is wasted work.
  private steerT = Math.random() * 0.1;
  private steerX = 0;
  private steerZ = 0;
  private steerJump = false;
  private steerBoxed = false;
  /** cached corridor test (same cadence as steering) */
  private corridorT = Math.random() * 0.15;
  private corridorOk = false;
  /** LOD: solve cadence, widened for agents far from the camera */
  private steerInterval = 0.08;
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
      // keep the rise-from-the-ground intro on the camera's render image
      const camS = this.deps.camera.position;
      this.group.position.x = this.pos.x + Math.round((camS.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE;
      this.group.position.z = this.pos.z + Math.round((camS.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE;
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

    // ---- toroidal minimum-image: the player rides unbounded trip space
    // while enemies live in wrapped torus space. Every perception/aim
    // computation below uses the player IMAGE nearest to this agent, so
    // aggro, LOS and shooting keep working after the ship crosses the world
    // seam (the "camps look deserted after landing from space" bug).
    const pp = tmpPlayerImg.set(
      this.pos.x + wrapDelta(player.pos.x - this.pos.x, WORLD_SIZE),
      player.pos.y,
      this.pos.z + wrapDelta(player.pos.z - this.pos.z, WORLD_SIZE),
    );

    // ---- perception (multi-point LOS: check eyes-to-head, eyes-to-torso,
    // eyes-to-feet so the AI can spot a partially exposed player)
    const toPlayer = tmpV.copy(pp).sub(this.pos);
    const dist = Math.hypot(toPlayer.x, toPlayer.z);
    void toPlayer.length(); // used implicitly via dist
    if (this.losTimer <= 0) {
      // distant agents re-check line of sight far less often; each check is
      // up to three voxel raycasts
      this.losTimer = dist < 30 ? 0.2 : dist < 70 ? 0.5 : 1.0;
      const eye = tmpV2.copy(this.pos).add(tmpV3.set(0, 1.6, 0));
      this.hasLos = false;
      // check three heights: head (1.6), chest (1.1), feet (0.2). Beyond
      // firing range a single torso ray is enough to maintain awareness.
      const rays = dist <= c.attackRange ? LOS_HEIGHTS : LOS_HEIGHTS_FAR;
      for (const tgtY of rays) {
        const dir = tmpV3.copy(pp).add(tmpV.set(0, tgtY, 0)).sub(eye);
        const d = dir.length();
        dir.divideScalar(d || 1);
        const hit = this.deps.world.raycast(eye, dir, d);
        if (!hit || hit.dist > d - 0.3) { this.hasLos = true; break; }
      }
    }

    // ---- target memory
    let hasLos = this.hasLos;  // let so leash can suppress it
    if (hasLos) {
      this.lastKnown.copy(pp);
      this.hasTarget = true;
      this.searchT = 0;
    } else {
      this.searchT += dt;
    }

    // ── leash: player dragged us too far from camp ──
    if (this.home && this.state !== 'dead') {
      const pd = Math.hypot(pp.x - this.home.x, pp.z - this.home.z);
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
    // While moving without a clear shot, face where we are actually walking —
    // otherwise the model moon-walks around obstacles while staring ahead.
    if (!hasLos && (Math.abs(this.vel.x) + Math.abs(this.vel.z)) > 0.8) {
      faceX = this.vel.x; faceZ = this.vel.z;
    }
    const targetYaw = Math.atan2(faceX, faceZ);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 8);

    // ---- steering (world space)
    // LOD: agents the player can't scrutinise re-solve their context map far
    // less often. Combat-range agents stay responsive; a distant camp costs
    // almost nothing.
    this.steerInterval = dist < 24 ? 0.08 : dist < 60 ? 0.2 : 0.45;
    this.steerT -= dt;
    this.corridorT -= dt;
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
        this.steerContext(pdx, pdz, steerOut);
        wx = steerOut.x * CAMP_CONFIG.patrolSpeedFactor;
        wz = steerOut.z * CAMP_CONFIG.patrolSpeedFactor;
        if (steerOut.jump) wantJump = true;
        // fully boxed in on patrol: turn around at the next waypoint
        if (steerOut.x === 0 && steerOut.z === 0) {
          this.patrolIdx = (this.patrolIdx + 1) % Math.max(1, this.patrolPoints.length);
        }
      } else {
        // dwelling: damp velocity, idle arm sway
        wx = 0; wz = 0;
      }
    } else if (hasLos && this.directBlockT <= 0 && this.corridorCached(pp.x, pp.z)) {
      // ---- direct pursuit: the player is visible, so run them down at ANY
      // distance. Previously this branch only ran inside preferredRange and
      // everything further away fell through to A*, where a starved path
      // budget left the agent standing still — the "enemies never catch you"
      // bug. Pathfinding is now reserved for broken line of sight.
      this.path.length = 0;
      this.pathIdx = 0;
      const inv = 1 / (dist || 1);
      const fx = toPlayer.x * inv, fz = toPlayer.z * inv;
      const rx = fz, rz = -fx;
      const want = c.preferredRange;

      // build the DESIRED heading (tactics), then let the context map find a
      // walkable direction closest to it (navigation)
      let dX = 0, dZ = 0;
      if (dist > want) {
        const urgency = Math.min(1, (dist - want) / 7);
        dX += fx; dZ += fz;
        const orbit = 0.6 * (1 - urgency);
        dX += rx * this.strafeDir * orbit;
        dZ += rz * this.strafeDir * orbit;
      } else if (dist < want * 0.55) {
        dX -= fx * 0.85; dZ -= fz * 0.85;
        dX += rx * this.strafeDir * 0.7;
        dZ += rz * this.strafeDir * 0.7;
      } else {
        dX += fx * 0.3; dZ += fz * 0.3;
        dX += rx * this.strafeDir * 0.7;
        dZ += rz * this.strafeDir * 0.7;
      }

      this.steerContext(dX, dZ, steerOut);
      if (steerOut.x === 0 && steerOut.z === 0) {
        // nowhere to go locally — hand this over to A* immediately instead of
        // grinding into the wall until the stuck timer notices
        this.boxedT += dt;
        this.directBlockT = 0.9;
        this.lastKnown.copy(pp);
        this.hasTarget = true;
        this.repathT = 0;
      } else {
        this.boxedT = 0;
        wx = steerOut.x; wz = steerOut.z;
        if (steerOut.jump) wantJump = true;
        // flip the orbit direction when the chosen path fights the desired
        // one badly (we are sliding along a wall) so we round corners
        if (steerOut.x * dX + steerOut.z * dZ < 0.25 && this.strafeTimer > 0.6) {
          this.strafeDir = -this.strafeDir;
          this.strafeTimer = 0.5;
        }
      }
    } else if (this.hasTarget) {
      // ---- navigate to the last known position with A*
      const goalMoved = this.pathGoal.distanceToSquared(this.lastKnown) > 4;
      const needPath = this.path.length === 0 || this.pathIdx >= this.path.length;
      const nearGoal = this.pos.distanceToSquared(this.lastKnown) < 2.5;
      if ((this.repathT <= 0 || goalMoved || needPath) && pathBudget.tokens > 0 && !nearGoal) {
        pathBudget.tokens--;
        this.repathT = 0.26 + Math.random() * 0.3;
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
        // string-pulling: skip ahead to the furthest waypoint we can still
        // walk to in a straight line. Raw A* output is a blocky staircase;
        // this turns it into natural diagonal movement.
        // only re-evaluate on a steer tick: the smoothing result is stable
        // between solves and this used to run up to 4 corridor scans a frame
        if (this.steerT <= 0) {
          let look = this.pathIdx;
          const maxLook = Math.min(this.path.length - 1, this.pathIdx + 3);
          for (let k = maxLook; k > this.pathIdx; k--) {
            const cand = this.path[k];
            if (Math.abs(cand.y - this.pos.y) <= MAX_JUMP_UP &&
                this.corridorClear(cand.x, cand.z, 6)) { look = k; break; }
          }
          this.pathIdx = look;
        }

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
          // steer through the voxels toward the waypoint rather than at it
          this.steerContext(dxw, dzw, steerOut);
          if (steerOut.x === 0 && steerOut.z === 0) {
            // the route is stale (world changed / bad node) — force a rebuild
            this.repathT = 0;
            this.path.length = 0;
            this.pathIdx = 0;
          } else {
            wx = steerOut.x; wz = steerOut.z;
            if (steerOut.jump) wantJump = true;
          }
          // jump up a step, or hop a gap when the next node is across a drop
          if (this.grounded && this.jumpCd <= 0 && dyw > 0.55 && hd < 1.6) wantJump = true;
        }

        // way off the path (knocked back / fell) -> repath sooner
        if (hd > 4.5) this.repathT = Math.min(this.repathT, 0.1);
      } else {
        // No usable route this frame (budget spent, search failed, or the
        // goal is unreachable). Standing still here is what made the squad
        // look asleep — instead walk the straight line to the memory and let
        // collision step-up / stuck recovery deal with the geometry.
        const dxw = this.lastKnown.x - this.pos.x;
        const dzw = this.lastKnown.z - this.pos.z;
        const hd = Math.hypot(dxw, dzw);
        if (hd > 1.1) {
          this.steerContext(dxw, dzw, steerOut);
          wx = steerOut.x; wz = steerOut.z;
          if (steerOut.jump) wantJump = true;
        } else if (this.searchT > 3) {
          // arrived at the memory and found nothing: sweep the area
          this.wanderAngle += (Math.random() - 0.5) * dt * 2;
          this.steerContext(Math.sin(this.wanderAngle), Math.cos(this.wanderAngle), steerOut);
          if (steerOut.x === 0 && steerOut.z === 0) {
            // cornered while searching — spin to a fresh heading
            this.wanderAngle += Math.PI * (0.5 + Math.random());
          } else {
            wx = steerOut.x * 0.5; wz = steerOut.z * 0.5;
          }
        }
      }
    }

    // Plant the feet to shoot only once actually at the preferred range —
    // damping while still closing the gap is what let players walk away from
    // a firing squad.
    if (this.state === 'attack' && inCombatRange && dist < c.preferredRange * 0.95) {
      wx *= 0.35; wz *= 0.35;
    }

    const wlen = Math.hypot(wx, wz);
    if (wlen > 1) { wx /= wlen; wz /= wlen; }

    const accel = 32;
    this.vel.x += wx * accel * dt;
    this.vel.z += wz * accel * dt;
    const damp = Math.max(0, 1 - 8 * dt);
    this.vel.x *= damp; this.vel.z *= damp;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    // sprint while running a fleeing player down; walk while holding a firing
    // position or patrolling
    const sprinting = this.state !== 'patrol' && dist > c.preferredRange * 1.1;
    const maxS = c.speed * (sprinting ? CHASE_SPRINT : 1);
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
      if (this.stuckTimer > 0.3) {
        // Context steering should have prevented this, so a stall here means
        // something unusual: a closing door, another agent, or a freshly
        // placed block. Escape along the widest opening rather than blindly
        // strafing, then rebuild the route.
        let escX = 0, escZ = 0, bestCost = Infinity;
        for (let i = 0; i < STEER_DIRS; i++) {
          const cost = this.probeStep(STEER_COS[i], STEER_SIN[i]);
          if (cost >= 0 && cost < bestCost) {
            bestCost = cost; escX = STEER_COS[i]; escZ = STEER_SIN[i];
          }
        }
        if (bestCost === Infinity) {
          // truly entombed: jump straight up, it is the only axis left
          if (this.jumpCd <= 0) { this.vel.y = 8.6; this.jumpCd = 0.35; }
        } else {
          this.vel.x += escX * 3.6;
          this.vel.z += escZ * 3.6;
          if (bestCost >= 1.6 && this.jumpCd <= 0) { this.vel.y = 8.6; this.jumpCd = 0.35; }
        }
        this.lastSteerIdx = -1;
        this.strafeDir = -this.strafeDir;
        this.directBlockT = 1.1;
        if (hasLos) { this.lastKnown.copy(pp); this.hasTarget = true; this.searchT = 0; }
        this.stuckTimer = 0;
        this.repathT = 0;
        this.path.length = 0;
        this.pathIdx = 0;
      }
    } else this.stuckTimer = 0;
    this.directBlockT = Math.max(0, this.directBlockT - dt);
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
    // Camps keep shooting at a piloting player too — the ship is invulnerable
    // (damagePlayer ignores hits in flight) but the firefight reads correctly.
    // Tracers can't pile up because the FX pool advances in tickPilot as well.
    if (this.state !== 'patrol' && hasLos && inFireRange) {
      this.state = 'attack';
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) {
          this.fireOneShot(pp, dist);
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
    const aim = tmpV2.copy(pp).add(tmpV3.set(0, 1.1, 0)).sub(shoulder);
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

    // ---- sync transform: render at the nearest-image copy toward the
    // camera, exactly like World.syncChunkOffsets does for terrain. Without
    // this the camp mesh and its defenders drift a full world length apart
    // once the player crosses the torus seam.
    const camPos = this.deps.camera.position;
    this.group.position.set(
      this.pos.x + Math.round((camPos.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE,
      this.pos.y,
      this.pos.z + Math.round((camPos.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE,
    );
    this.group.rotation.y = this.yaw;
    const f = Math.max(0, this.hp / c.hp);
    // health bar only exists once damaged — skip the billboard matrix work
    // (getWorldPosition forces a matrix update) for untouched agents
    this.hpBar.visible = f < 1;
    if (f < 1) {
      this.hpBar.lookAt(this.deps.camera.position.x, this.hpBar.getWorldPosition(tmpV).y, this.deps.camera.position.z);
      this.hpFill.scale.x = f;
      this.hpFill.position.x = -(1 - f) * 0.33;
    }
    this.hpFill.visible = f < 1;
    return true;
  }

  /** `playerPos` must already be the minimum-image copy near this agent. */
  private fireOneShot(playerPos: THREE.Vector3, dist: number) {
    this.recoilT = 0.06;
    this.weaponKick = 1;
    const muzzle = this.muzzle.getWorldPosition(new THREE.Vector3());
    // the muzzle world position carries the render image offset; shots must
    // be computed in the agent's own (wrapped) space
    muzzle.x = this.pos.x + wrapDelta(muzzle.x - this.pos.x, WORLD_SIZE);
    muzzle.z = this.pos.z + wrapDelta(muzzle.z - this.pos.z, WORLD_SIZE);
    const target = playerPos.clone().add(tmpV.set(0, 1.0, 0));
    const dir = target.sub(muzzle).normalize();
    const spread = (1 - this.cfg.accuracy) * 0.09;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    // visuals render in camera space: shift by the camera's image offset so
    // tracers/flashes stay visible on whichever side of the seam we render
    const cam = this.deps.camera.position;
    const vX = Math.round((cam.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE;
    const vZ = Math.round((cam.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE;
    const vis = (v: THREE.Vector3) => new THREE.Vector3(v.x + vX, v.y, v.z + vZ);

    this.deps.effects.muzzleFlash(vis(muzzle), 0.45);
    this.deps.audio.shot({ freq: 1700, dur: 0.07, gain: 0.26 * THREE.MathUtils.clamp(1 - dist / 150, 0.15, 1), sub: 260 });

    // did the shot reach the player before terrain?
    const toP = playerPos.clone().add(tmpV.set(0, 0.95, 0)).sub(muzzle);
    const t = toP.dot(dir);
    let hitPlayer = false;
    if (t > 0) {
      const closest = muzzle.clone().addScaledVector(dir, t);
      if (closest.distanceTo(playerPos.clone().add(tmpV.set(0, 0.95, 0))) < 0.55) {
        const worldHit = this.deps.world.raycast(muzzle, dir, t);
        if (!worldHit || worldHit.dist > t - 0.1) hitPlayer = true;
      }
    }
    const end = muzzle.clone().addScaledVector(dir, 200);
    if (hitPlayer) {
      this.deps.effects.tracer(vis(muzzle), vis(playerPos).add(tmpV.set(0, 1.0, 0)));
      this.deps.onPlayerHit(this.cfg.damage, muzzle);
    } else {
      const worldHit = this.deps.world.raycast(muzzle, dir, 200);
      const endPoint = worldHit ? worldHit.point : end;
      this.deps.effects.tracer(vis(muzzle), vis(endPoint));
      if (worldHit) this.deps.effects.impact(vis(worldHit.point), worldHit.normal, worldHit.block);
    }
  }

  // ------------------------------------------------------------ physics

  /** collision-safe lateral shove (used by squad separation) */
  nudge(dx: number, dz: number): void {
    this.moveAxis(0, dx);
    this.moveAxis(2, dz);
  }

  // ---------------------------------------------------- navigation sensing

  /**
   * Ground level the agent would stand on near (x, z), searching from
   * `fromY + MAX_JUMP_UP` downward. Returns the feet Y, or -1 when there is
   * no footing within MAX_SAFE_DROP (a cliff, water pit or the void).
   */
  private groundNear(x: number, z: number, fromY: number): number {
    const w = this.deps.world;
    const hw = this.halfW;
    // Footprint columns: the 0.6-wide body spans at most 2 cells per axis, so
    // resolve them once instead of re-deriving them for every Y (the old code
    // called fits() per level = up to 8 voxel reads each).
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    const twoX = x1 !== x0, twoZ = z1 !== z0;

    const top = Math.floor(fromY) + MAX_JUMP_UP;
    const bottom = Math.floor(fromY) - MAX_SAFE_DROP;

    // Walk down one level at a time reusing the "body clear" test from the
    // level above: clear(y) needs y and y+1 free, so cache the upper row.
    let upperFree = this.rowFree(w, x0, x1, z0, z1, twoX, twoZ, top + 1);
    for (let y = top; y >= bottom; y--) {
      if (y < 1) break;
      const midFree = this.rowFree(w, x0, x1, z0, z1, twoX, twoZ, y);
      if (midFree && upperFree && this.rowSolidAny(w, x0, x1, z0, z1, twoX, twoZ, y - 1)) return y;
      upperFree = midFree;
    }
    return -1;
  }

  /** every footprint cell on this level is non-solid */
  private rowFree(
    w: WorldLike, x0: number, x1: number, z0: number, z1: number,
    twoX: boolean, twoZ: boolean, y: number,
  ): boolean {
    if (w.solid(x0, y, z0)) return false;
    if (twoX && w.solid(x1, y, z0)) return false;
    if (twoZ && w.solid(x0, y, z1)) return false;
    if (twoX && twoZ && w.solid(x1, y, z1)) return false;
    return true;
  }

  /** at least one footprint cell on this level is solid (a floor exists) */
  private rowSolidAny(
    w: WorldLike, x0: number, x1: number, z0: number, z1: number,
    twoX: boolean, twoZ: boolean, y: number,
  ): boolean {
    if (w.solid(x0, y, z0)) return true;
    if (twoX && w.solid(x1, y, z0)) return true;
    if (twoZ && w.solid(x0, y, z1)) return true;
    if (twoX && twoZ && w.solid(x1, y, z1)) return true;
    return false;
  }

  /**
   * Cost of stepping one probe-length along (dx, dz).
   *   -1  impassable: wall above jump height, cliff, or a clipped corner
   *    0  flat and clear
   *   >0  climbing / dropping penalty
   */
  private probeStep(dx: number, dz: number): number {
    const px = this.pos.x + dx * PROBE_DIST;
    const pz = this.pos.z + dz * PROBE_DIST;

    const gy = this.groundNear(px, pz, this.pos.y);
    if (gy < 0) return -1;                        // cliff or blocked column

    const rise = gy - Math.floor(this.pos.y);
    if (rise > MAX_JUMP_UP) return -1;            // wall we cannot mount

    // corner guard: the halfway cell must also admit the body, otherwise the
    // agent scrapes a block edge and stalls
    const mx = this.pos.x + dx * PROBE_DIST * 0.5;
    const mz = this.pos.z + dz * PROBE_DIST * 0.5;
    if (this.groundNear(mx, mz, this.pos.y) < 0) return -1;

    let cost = 0;
    if (rise > MAX_STEP) cost += 1.6;             // needs a jump
    else if (rise > 0) cost += 0.25;              // step up
    const drop = Math.floor(this.pos.y) - gy;
    if (drop > 1) cost += drop * 0.4;             // discourage tumbling down
    return cost;
  }

  /**
   * Throttled front-end for the context map. Re-solves at `steerHz` and
   * replays the cached direction in between, which is what keeps a full
   * squad off the frame budget. `steerT` is seeded randomly per agent so
   * the solves spread across frames instead of spiking together.
   */
  private steerContext(desX: number, desZ: number, out: { x: number; z: number; jump: boolean }): void {
    if (this.steerT > 0) {
      out.x = this.steerX; out.z = this.steerZ; out.jump = this.steerJump;
      if (this.steerBoxed) { out.x = 0; out.z = 0; }
      return;
    }
    this.steerT = this.steerInterval;
    this.solveContext(desX, desZ, out);
    this.steerX = out.x; this.steerZ = out.z; this.steerJump = out.jump;
    this.steerBoxed = out.x === 0 && out.z === 0;
  }

  /**
   * Context steering: score every candidate direction against the desired
   * heading and the surrounding voxels, then return the best one in
   * (outX, outZ). Falls back to zero when fully boxed in.
   */
  private solveContext(desX: number, desZ: number, out: { x: number; z: number; jump: boolean }): void {
    out.x = 0; out.z = 0; out.jump = false;
    const dl = Math.hypot(desX, desZ);
    if (dl < 1e-4) return;
    desX /= dl; desZ /= dl;

    let bestScore = -Infinity;
    let bestIdx = -1;
    let bestCost = 0;
    for (let i = 0; i < STEER_DIRS; i++) {
      const cx = STEER_COS[i], cz = STEER_SIN[i];
      const align = cx * desX + cz * desZ;
      if (align < -0.2) continue;                 // never reverse into the goal
      const cost = this.probeStep(cx, cz);
      if (cost < 0) continue;                     // impassable
      // interest minus danger, with a nudge toward last frame's pick so the
      // agent commits to a detour instead of oscillating at a corner
      let s = align - cost * 0.55;
      if (i === this.lastSteerIdx) s += 0.18;
      if (s > bestScore) { bestScore = s; bestIdx = i; bestCost = cost; }
    }

    if (bestIdx < 0) return;                      // boxed in — caller repaths
    this.lastSteerIdx = bestIdx;
    out.x = STEER_COS[bestIdx];
    out.z = STEER_SIN[bestIdx];
    out.jump = bestCost >= 1.6;                   // chosen route needs a hop
  }

  /**
   * Is there a straight, walkable corridor from here to (tx, tz)? Used to
   * decide whether direct pursuit is honest or whether we owe the agent a
   * real A* route around the geometry.
   */
  private corridorCached(tx: number, tz: number): boolean {
    if (this.corridorT > 0) return this.corridorOk;
    this.corridorT = this.steerInterval * 1.5;
    this.corridorOk = this.corridorClear(tx, tz);
    return this.corridorOk;
  }

  private corridorClear(tx: number, tz: number, maxLen = 14): boolean {
    const dx = tx - this.pos.x, dz = tz - this.pos.z;
    const len = Math.hypot(dx, dz);
    if (len < 0.001) return true;
    if (len > maxLen) return false;
    const nx = dx / len, nz = dz / len;
    // 1.6-block stride: fine enough to catch a 1-block pillar, half the
    // samples of the original 0.9 stride
    const steps = Math.ceil(len / 1.6);
    let y = this.pos.y;
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * len;
      const sx = this.pos.x + nx * t;
      const sz = this.pos.z + nz * t;
      const gy = this.groundNear(sx, sz, y);
      if (gy < 0) return false;
      if (Math.abs(gy - y) > MAX_JUMP_UP) return false;
      y = gy;
    }
    return true;
  }

  /** true when the agent's full-height AABB is clear at this position */
  private fits(x: number, y: number, z: number): boolean {
    const w = this.deps.world;
    const hw = this.halfW, h = this.height;
    const minX = Math.floor(x - hw), maxX = Math.floor(x + hw);
    const minY = Math.floor(y), maxY = Math.floor(y + h - 0.001);
    const minZ = Math.floor(z - hw), maxZ = Math.floor(z + hw);
    for (let bx = minX; bx <= maxX; bx++)
      for (let by = minY; by <= maxY; by++)
        for (let bz = minZ; bz <= maxZ; bz++)
          if (w.solid(bx, by, bz)) return false;
    return true;
  }

  private moveAxis(axis: 0 | 2, delta: number) {
    if (delta === 0) return;

    // Auto step-up: single-block ledges, stairs, camp thresholds and rough
    // terrain are walked over instead of body-blocking the chase.
    const tx = axis === 0 ? this.pos.x + delta : this.pos.x;
    const tz = axis === 2 ? this.pos.z + delta : this.pos.z;
    if (this.fits(tx, this.pos.y, tz)) {
      this.pos.x = tx; this.pos.z = tz;
      return;
    }
    if (this.grounded && this.fits(tx, this.pos.y + 1.02, tz)) {
      this.pos.y += 1.02;
      this.pos.x = tx; this.pos.z = tz;
      this.stuckTimer = 0;
      return;
    }

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

    // A* is only used when line of sight is broken now, so a bigger budget
    // costs little and keeps blind pursuers moving on fresh routes.
    pathBudget.tokens = 5;

    // update + cull
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const keep = this.enemies[i].update(dt, this.player);
      if (!keep) {
        const g = this.enemies[i].group;
        g.parent?.remove(g);
        this.enemies.splice(i, 1);
      }
    }
    // separation — squadmates push apart so they never merge into one body,
    // but the shove is routed through collision so it can't force anyone
    // inside a wall (the old direct pos writes did exactly that)
    for (let i = 0; i < this.enemies.length; i++) {
      for (let j = i + 1; j < this.enemies.length; j++) {
        const a = this.enemies[i], b = this.enemies[j];
        if (!a.alive || !b.alive) continue;
        if (Math.abs(a.pos.y - b.pos.y) > 2) continue;   // different floors
        // cheap reject before the wrap math: squadmates that are nowhere
        // near each other dominate this O(n^2) pass
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
    const fx = ((Math.floor(x) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    const fz = ((Math.floor(z) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;
    const top = w.highestY(fx, fz);

    // highestY can point at a flower/tall-grass voxel, which is not a floor.
    // Search from the real column top down first, then use the normal snapper
    // as a bounded fallback. This makes every valid camp column spawnable.
    for (let y = Math.min(WORLD_HEIGHT - 2, top + 1); y >= 1; y--) {
      if (canStand(w, fx, y, fz)) return new THREE.Vector3(fx + 0.5, y, fz + 0.5);
      if (top - y > 18) break;
    }
    const baseY = Math.max(1, Math.min(hintY + 4, WORLD_HEIGHT - 2));
    const snapped = snapToGround(w, fx, baseY, fz, 24);
    return snapped >= 0 ? new THREE.Vector3(fx + 0.5, snapped, fz + 0.5) : null;
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

    // Structures can occupy every post on steep or snow-heavy worlds. Scan
    // inward in a deterministic spiral before giving up on the camp.
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

    // Last resort: the site center was verified dry at generation time, so
    // drop the member on top of whatever the column holds and let physics
    // settle them. Without this, exotic planets could leave a fully built
    // camp with zero defenders because every probe happened to fail.
    if (!p) {
      const s = camp.site;
      const w = this.deps.world;
      const fy = w.highestY(
        ((Math.floor(s.cx) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
        ((Math.floor(s.cz) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE,
      );
      p = new THREE.Vector3(
        ((Math.floor(s.cx) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE + 0.5,
        fy + 1,
        ((Math.floor(s.cz) % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE + 0.5,
      );
    }
    if (guardPlayer) {
      // minimum-image distance: the player may be many world-lengths away
      // in trip space while standing right on top of the camp
      const gdx = wrapDelta(this.player.pos.x - p.x, WORLD_SIZE);
      const gdz = wrapDelta(this.player.pos.z - p.z, WORLD_SIZE);
      const gdy = this.player.pos.y - p.y;
      if (gdx * gdx + gdy * gdy + gdz * gdz < RESPAWN_SAFE_DIST * RESPAWN_SAFE_DIST) return false;
    }
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
    else camp.respawnTimer = 2;         // hostile terrain: retry fast, don't flag cleared
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
      // hit-test against the enemy image nearest the shooter (torus seam)
      const iox = Math.round((origin.x - e.pos.x) / WORLD_SIZE) * WORLD_SIZE;
      const ioz = Math.round((origin.z - e.pos.z) / WORLD_SIZE) * WORLD_SIZE;
      // body sphere
      const bc = e.pos.clone().add(tmpV.set(iox, 1.0, ioz));
      const tb = this.raySphere(origin, dir, bc, 0.52);
      // head sphere
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

  /** Alert nearby enemies to a sound (gunshot, explosion, etc.). */
  alertNearby(soundPos: THREE.Vector3, hearRange = 45) {
    const r2 = hearRange * hearRange;
    for (const e of this.enemies) {
      if (!e.alive) continue;
      const dx = wrapDelta(soundPos.x - e.pos.x, WORLD_SIZE);
      const dz = wrapDelta(soundPos.z - e.pos.z, WORLD_SIZE);
      const dy = soundPos.y - e.pos.y;
      if (dx * dx + dy * dy + dz * dz < r2) {
        // hand the agent the sound's image in its own wrapped neighborhood
        e.investigate(new THREE.Vector3(e.pos.x + dx, soundPos.y, e.pos.z + dz));
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
