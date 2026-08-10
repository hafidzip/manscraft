import * as THREE from 'three';
import type { WorldLike } from './World';
import { WORLD_SIZE, wrapDelta } from '../core/constants';
import { Effects } from './effects';
import { AudioSynth } from './audio';
import { box, MATS } from './models';
import { pixelTexture } from './textures';
import type { CampBuild } from '../world/camps';
import type { Tier } from './tiers';
import type { FlowField, FlowSample } from './FlowField';

export const CAMP_CONFIG = {
  squadSize: [3, 5] as [number, number],
  respawnDelay: 20,
  repopulateDelay: 90,
  patrolSpeedFactor: 0.55,
  maxLeash: 70,
};

export type EnemyState = 'spawn' | 'idle' | 'patrol' | 'chase' | 'attack' | 'dead';

export type EnemyBehavior = 'patrol' | 'idle';

export interface EnemyConfig {
  id: string;
  name: string;
  hp: number;
  speed: number;
  sightRange: number;
  attackRange: number;
  preferredRange: number;
  attackCooldown: number;
  burst: number;
  burstDelay: number;
  accuracy: number;
  damage: number;
  skin: string;
  shirt: string;
  pants: string;
  seed: number;
  behavior: EnemyBehavior;
  peaceful?: boolean;
}


export const ENEMY_FIRE_MODE: 'config' | 'distance' = 'config';

export const ENEMY_FIRE_RANGE = 28;

export const ENEMY_PRESETS: Record<string, EnemyConfig> = {
  grunt: {
    id: 'grunt', name: 'GRUNT', hp: 40, speed: 4.6, sightRange: 9999, attackRange: 26,
    preferredRange: 10, attackCooldown: 1.6, burst: 3, burstDelay: 0.16,
    accuracy: 0.72, damage: 7, skin: '#86a08e', shirt: '#33463c', pants: '#26313b', seed: 12,
    behavior: 'patrol',
  },
  runner: {
    id: 'runner', name: 'RUNNER', hp: 26, speed: 6.2, sightRange: 9999, attackRange: 20,
    preferredRange: 6, attackCooldown: 1.1, burst: 4, burstDelay: 0.11,
    accuracy: 0.6, damage: 5, skin: '#b0766a', shirt: '#54302e', pants: '#2e2327', seed: 31,
    behavior: 'patrol',
  },
  heavy: {
    id: 'heavy', name: 'HEAVY', hp: 90, speed: 3.6, sightRange: 9999, attackRange: 34,
    preferredRange: 14, attackCooldown: 2.1, burst: 6, burstDelay: 0.13,
    accuracy: 0.8, damage: 10, skin: '#8b98bd', shirt: '#313a58', pants: '#232838', seed: 55,
    behavior: 'idle',
  },
  merchant: {
    id: 'merchant', name: 'MERCHANT', hp: 60, speed: 3.4, sightRange: 0, attackRange: 0,
    preferredRange: 0, attackCooldown: 99, burst: 0, burstDelay: 1,
    accuracy: 0, damage: 0, skin: '#c98f5f', shirt: '#8a5a2e', pants: '#46403a', seed: 77,
    behavior: 'idle', peaceful: true,
  },
};

const EYE_COLORS: Record<string, number> = {
  grunt: 0x62ffa8, runner: 0xffb03a, heavy: 0x54d8ff, merchant: 0xffe08a,
};

const CHASE_SPRINT = 1.3;


const STEER_DIRS = 8;
const STEER_COS = new Float32Array(STEER_DIRS);
const STEER_SIN = new Float32Array(STEER_DIRS);
for (let i = 0; i < STEER_DIRS; i++) {
  const a = (i / STEER_DIRS) * Math.PI * 2;
  STEER_COS[i] = Math.cos(a);
  STEER_SIN[i] = Math.sin(a);
}

const PROBE_DIST = 1.15;
const MAX_STEP = 1;
const MAX_JUMP_UP = 2;
const MAX_SAFE_DROP = 4;

const LOS_HEIGHTS = [1.6, 1.1, 0.2];
const LOS_HEIGHTS_FAR = [1.1];

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
  flowField?: FlowField;
}

const FLOW: FlowSample = { x: 0, z: 0, targetY: -1, climb: 0, cost: 0 };

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();
const tmpPlayerImg = new THREE.Vector3();
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
  private weaponDrawT = 0;
  private bolt = new THREE.Group();
  private hpFill!: THREE.Mesh;
  private hpBar!: THREE.Group;
  private muzzle = new THREE.Object3D();

  pos = new THREE.Vector3();
  readonly respawnPoint = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  hp: number;
  state: EnemyState = 'spawn';
  readonly halfW = 0.3;
  readonly height = 1.8;

  distToPlayer = Infinity;
  tier: Tier = 0;
  tickAccum = 0;
  asleep = false;
  rendered = false;
  detailed = true;
  lod: 0 | 1 | 2 = 2;
  instGait = 0;
  instGaitGain = 0;
  hitFlash = 0;

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

  private lastKnown = new THREE.Vector3();
  private hasTarget = false;
  alerted = false;
  private alertT = 0;
  private idleGoalPt: { x: number; z: number } | null = null;
  private searchT = 0;
  private grounded = false;
  private jumpCd = 0;
  private lastSteerIdx = -1;
  private steerT = Math.random() * 0.1;
  private steerX = 0;
  private steerZ = 0;
  private steerJump = false;
  private steerBoxed = false;
  private steerInterval = 0.08;
  private wanderAngle = Math.random() * Math.PI * 2;
  private flashT = 0;
  private stateT = 0;
  private recoilT = 0;
  private weaponKick = 0;
  private aimPitch = 0;
  private bodyMats: THREE.MeshLambertMaterial[] = [];
  private eyeMat: THREE.MeshBasicMaterial | null = null;
  private eyeBase = new THREE.Color();
  private eyeSeed = Math.random() * Math.PI * 2;

  patrolPoints: { x: number; z: number }[] = [];
  patrolIdx = 0;
  home: { x: number; z: number } | null = null;
  maxLeash = 45;
  private leashT = 0;
  private returning = false;
  private dwellT = 0;

  cooldownUntil = 0;

  private idleFaceYaw = 0;
  private idleScanT = 1.2 + Math.random() * 2.5;
  private lastMoveYaw = 0;
  tradeFaceT = 0;
  private coinBadge: THREE.Group | null = null;

  private deps: EnemyDeps;

  constructor(preset: string, pos: THREE.Vector3, deps: EnemyDeps, overrides: Partial<EnemyConfig> = {}) {
    this.deps = deps;
    this.cfg = { ...ENEMY_PRESETS[preset], ...overrides };
    this.hp = this.cfg.hp;
    this.pos.copy(pos);
    this.respawnPoint.copy(pos);
    this.lastX = pos.x; this.lastZ = pos.z;
    this.yaw = Math.random() * Math.PI * 2;
    this.idleFaceYaw = this.yaw;
    this.build();
    this.group.position.copy(pos);
    this.deps.effects.puff(tmpV.set(pos.x, pos.y + 0.3, pos.z), tmpV2.set(0, 1, 0), 0.5, 0.7, '#b8b0a2');
  }

  private build() {
    const c = this.cfg;
    const skinMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.skin, 14, 16, c.seed) });
    const shirtMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.shirt, 16, 16, c.seed + 1) });
    const pantsMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.pants, 14, 16, c.seed + 2) });
    this.bodyMats = [skinMat, shirtMat, pantsMat];

    this.eyeBase.set(EYE_COLORS[c.id] ?? 0x7dffb8);
    this.eyeMat = new THREE.MeshBasicMaterial({
      color: this.eyeBase.clone().multiplyScalar(1.8),
      toneMapped: false,
    });

    this.group.add(this.bodyRoot);

    this.legL.position.set(-0.12, 0.8, 0);
    this.legR.position.set(0.12, 0.8, 0);
    box(this.legL, 0.16, 0.8, 0.18, 0, -0.4, 0, pantsMat);
    box(this.legR, 0.16, 0.8, 0.18, 0, -0.4, 0, pantsMat);
    box(this.legL, 0.18, 0.09, 0.36, 0, -0.76, 0.07, MATS.boot);
    box(this.legR, 0.18, 0.09, 0.36, 0, -0.76, 0.07, MATS.boot);
    this.bodyRoot.add(this.legL, this.legR);

    box(this.bodyRoot, 0.4, 0.52, 0.22, 0, 1.08, 0, shirtMat);
    box(this.bodyRoot, 0.3, 0.18, 0.2, 0, 0.86, 0, skinMat);
    box(this.bodyRoot, 0.34, 0.1, 0.16, 0, 1.32, -0.02, shirtMat);
    box(this.bodyRoot, 0.1, 0.44, 0.08, 0, 1.08, -0.14, pantsMat);
    box(this.bodyRoot, 0.08, 0.08, 0.02, 0, 1.12, 0.12, this.eyeMat);

    box(this.bodyRoot, 0.12, 0.1, 0.12, 0, 1.39, 0, skinMat);
    const head = new THREE.Group();
    head.position.set(0, 1.34, 0);
    this.bodyRoot.add(head);
    box(head, 0.28, 0.18, 0.3, 0, 0.11, 0.01, skinMat);
    box(head, 0.46, 0.26, 0.44, 0, 0.34, 0, skinMat);
    box(head, 0.36, 0.14, 0.34, 0, 0.52, -0.02, skinMat);

    const eyeL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.055, 0.03), this.eyeMat);
    eyeL.position.set(-0.1, 0.3, 0.225);
    eyeL.rotation.z = 0.42;
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.1;
    eyeR.rotation.z = -0.42;
    head.add(eyeL, eyeR);

    const antL = new THREE.Group();
    antL.position.set(-0.09, 0.58, 0);
    antL.rotation.z = 0.28;
    box(antL, 0.022, 0.2, 0.022, 0, 0.1, 0, pantsMat);
    const tipL = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.05), this.eyeMat);
    tipL.position.y = 0.22;
    antL.add(tipL);
    const antR = antL.clone();
    antR.position.x = 0.09;
    antR.rotation.z = -0.28;
    head.add(antL, antR);

    this.armL.position.set(-0.26, 1.28, -0.015);
    box(this.armL, 0.13, 0.66, 0.13, 0, -0.3, 0, shirtMat);
    box(this.armL, 0.11, 0.18, 0.1, 0, -0.68, 0.02, skinMat);
    this.bodyRoot.add(this.armL);

    this.armR.position.set(0.26, 1.28, -0.015);
    box(this.armR, 0.13, 0.66, 0.13, 0, -0.3, 0, shirtMat);
    box(this.armR, 0.11, 0.18, 0.1, 0, -0.68, 0.02, skinMat);
    this.bodyRoot.add(this.armR);

    this.weapon.position.set(0, 1.16, 0.32);
    this.weapon.visible = false;
    this.bodyRoot.add(this.weapon);
    box(this.weapon, 0.14, 0.115, 0.42, 0, 0, 0.12, MATS.gun);
    box(this.weapon, 0.15, 0.028, 0.39, 0, 0.07, 0.12, MATS.black);
    for (let i = 0; i < 5; i++) box(this.weapon, 0.16, 0.014, 0.022, 0, 0.09, -0.02 + i * 0.075, MATS.gun2);
    box(this.weapon, 0.125, 0.1, 0.28, 0, -0.005, 0.43, MATS.poly);
    box(this.weapon, 0.065, 0.055, 0.25, 0, 0, 0.67, MATS.black);
    box(this.weapon, 0.1, 0.09, 0.075, 0, 0, 0.81, MATS.black);
    box(this.weapon, 0.15, 0.13, 0.27, 0, -0.005, -0.28, MATS.poly);
    box(this.weapon, 0.16, 0.16, 0.04, 0, -0.005, -0.43, MATS.black);
    box(this.weapon, 0.1, 0.26, 0.11, 0, -0.16, 0.08, MATS.gun2, THREE.MathUtils.degToRad(-8));
    box(this.weapon, 0.11, 0.19, 0.09, 0, -0.14, -0.09, MATS.poly, THREE.MathUtils.degToRad(-13));
    box(this.weapon, 0.1, 0.15, 0.08, 0, -0.14, 0.4, MATS.gun2, THREE.MathUtils.degToRad(6));

    box(this.weapon, 0.1, 0.026, 0.11, 0, 0.115, 0.06, MATS.black);
    box(this.weapon, 0.014, 0.095, 0.022, -0.04, 0.16, 0.06, MATS.black);
    box(this.weapon, 0.014, 0.095, 0.022, 0.04, 0.16, 0.06, MATS.black);
    box(this.weapon, 0.1, 0.014, 0.022, 0, 0.205, 0.06, MATS.black);
    box(this.weapon, 0.018, 0.018, 0.008, 0, 0.16, 0.047, MATS.redGlow);
    box(this.weapon, 0.075, 0.055, 0.13, 0.078, 0.01, 0.02, MATS.black);
    this.bolt.position.set(0.079, 0.01, 0.02);
    box(this.bolt, 0.02, 0.035, 0.1, 0, 0, 0, MATS.gun2);
    this.weapon.add(this.bolt);

    this.muzzle.position.set(0, 0.01, 0.86);
    this.weapon.add(this.muzzle);

    if (c.id === 'heavy') this.bodyRoot.scale.setScalar(1.12);

    this.hpBar = new THREE.Group();
    this.hpBar.position.set(0, 2.38, 0);
    const bg = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.1), new THREE.MeshBasicMaterial({ color: '#14060f', transparent: true, opacity: 0.85, depthWrite: false }));
    this.hpFill = new THREE.Mesh(new THREE.PlaneGeometry(0.66, 0.055), new THREE.MeshBasicMaterial({ color: '#e84fc0', depthWrite: false }));
    this.hpFill.position.z = 0.001;
    this.hpBar.add(bg, this.hpFill);
    this.group.add(this.hpBar);

    if (c.peaceful) {
      this.hpBar.visible = false;
      const strawMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#d8b345', 12, 12, c.seed + 3) });
      const bandMat = new THREE.MeshLambertMaterial({ color: '#a33b2e' });
      const packMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#7a5a34', 10, 10, c.seed + 4) });
      const crateMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#8a6a3f', 8, 8, c.seed + 5) });
      box(this.bodyRoot, 0.62, 0.05, 0.62, 0, 1.98, 0, strawMat);
      box(this.bodyRoot, 0.34, 0.16, 0.34, 0, 2.08, 0, strawMat);
      box(this.bodyRoot, 0.36, 0.045, 0.36, 0, 2.02, 0, bandMat);
      box(this.bodyRoot, 0.4, 0.5, 0.22, 0, 1.08, -0.24, packMat);
      box(this.bodyRoot, 0.3, 0.22, 0.24, 0, 1.42, -0.25, crateMat);
      box(this.bodyRoot, 0.42, 0.05, 0.06, 0, 1.22, -0.1, MATS.black);

      const badge = new THREE.Group();
      badge.position.set(0, 2.5, 0);
      const coinMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#f2c14e', 6, 6, c.seed + 6) });
      const rimMat = new THREE.MeshLambertMaterial({ color: '#b8860b' });
      const coin = new THREE.Group();
      const face = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.045), coinMat);
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.02), rimMat);
      rim.position.z = -0.014;
      coin.add(rim, face);
      badge.add(coin);
      this.coinBadge = badge;
      this.group.add(badge);
    }

    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; }
    });
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get center(): THREE.Vector3 { return tmpV3.copy(this.pos).add(tmpV.set(0, 1.0, 0)); }

  takeDamage(amount: number, point: THREE.Vector3, headshot: boolean) {
    if (!this.alive) return;
    if (!this.cfg.peaceful) this.alert(point);
    this.hp -= headshot ? amount * 2 : amount;
    this.flashT = 0.09;
    this.hitFlash = 0.12;
    tmpV.copy(this.pos).sub(point).setY(0);
    if (tmpV.lengthSq() < 0.001) tmpV.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    tmpV.normalize().multiplyScalar(headshot ? 2.2 : 1.2);
    this.vel.x += tmpV.x; this.vel.z += tmpV.z;
    const ichor = this.cfg.peaceful ? 0xd0342c : 0x56e08a;
    for (let i = 0; i < 4; i++) {
      tmpV2.set((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3);
      this.deps.effects.spawnParticle(point, tmpV2, ichor, 0.035 + Math.random() * 0.02, 0.4, true);
    }
    if (this.hp <= 0) this.die(point);
  }

  dissolve() {
    if (!this.alive) return;
    this.state = 'dead';
    this.stateT = 1.15;
    this.hpFill.visible = false;
    this.hpBar.visible = false;
    if (this.coinBadge) this.coinBadge.visible = false;
    if (this.eyeMat) this.eyeMat.color.setRGB(0.04, 0.07, 0.05);
    const base = this.pos;
    for (let i = 0; i < 18; i++) {
      tmpV.set((Math.random() - 0.5) * 0.9, 1.4 + Math.random() * 2.2, (Math.random() - 0.5) * 0.9);
      this.deps.effects.spawnParticle(
        tmpV2.set(
          base.x + (Math.random() - 0.5) * 0.5,
          base.y + Math.random() * 1.8,
          base.z + (Math.random() - 0.5) * 0.5,
        ),
        tmpV, [0x7dffb8, 0x2fae7a, 0xcfffe6][i % 3],
        0.03 + Math.random() * 0.04, 0.6 + Math.random() * 0.5, true,
      );
    }
    this.deps.effects.puff(
      tmpV2.set(base.x, base.y + 0.9, base.z), tmpV.set(0, 1, 0), 0.7, 0.9, '#8ff0c0',
    );
  }

  private die(point: THREE.Vector3) {
    this.state = 'dead';
    this.stateT = 0;
    this.hpFill.visible = false;
    if (this.coinBadge) this.coinBadge.visible = false;
    this.deps.audio.enemyDie();
    for (let i = 0; i < 14; i++) {
      tmpV.set((Math.random() - 0.5) * 5, Math.random() * 5 + 1, (Math.random() - 0.5) * 5);
      this.deps.effects.spawnParticle(
        point.clone().add(tmpV2.set((Math.random() - 0.5) * 0.4, 0.3 + Math.random() * 0.8, (Math.random() - 0.5) * 0.4)),
        tmpV,
        this.cfg.peaceful
          ? [0xd0342c, 0x6e1a14, 0x2a2a2e][i % 3]
          : [0x56e08a, 0x1f7a4a, 0x2a3a2e][i % 3],
        0.05 + Math.random() * 0.05, 0.7 + Math.random() * 0.4, true
      );
    }
    this.deps.effects.puff(point, tmpV.set(0, 1, 0), 0.6, 1.0, '#9a948a');
    this.deps.onEnemyKilled(this);
  }

  invalidatePath() {
  }

  alert(pos: THREE.Vector3) {
    this.alerted = true;
    this.alertT = 0;
    this.investigate(pos);
  }

  investigate(pos: THREE.Vector3) {
    this.lastKnown.copy(pos);
    this.hasTarget = true;
    this.searchT = 0;
    this.invalidatePath();
  }

  standDown() {
    this.alerted = false;
    this.alertT = 0;
    this.weaponDrawT = 0;
    this.hasTarget = false;
    this.lastKnown.set(0, 0, 0);
    this.searchT = 0;
    this.returning = true;
    this.burstLeft = 0;
    this.invalidatePath();
  }

  standDownToCamp(cooldownSec = 0, teleport?: THREE.Vector3) {
    this.cooldownUntil = Math.max(this.cooldownUntil, cooldownSec);
    this.alerted = false;
    this.alertT = 0;
    this.weaponDrawT = 0;
    this.hasTarget = false;
    this.lastKnown.set(0, 0, 0);
    this.searchT = 0;
    this.burstLeft = 0;
    this.cooldown = Math.max(this.cooldown, this.cfg.attackCooldown);
    this.invalidatePath();
    this.returning = false;
    this.leashT = 0;
    this.dwellT = 0;
    this.state = this.cfg.behavior;
    if (teleport) {
      this.pos.copy(teleport);
      this.vel.set(0, 0, 0);
      this.lastX = teleport.x; this.lastZ = teleport.z;
      const cam = this.deps.camera.position;
      this.group.position.set(
        teleport.x + Math.round((cam.x - teleport.x) / WORLD_SIZE) * WORLD_SIZE,
        teleport.y,
        teleport.z + Math.round((cam.z - teleport.z) / WORLD_SIZE) * WORLD_SIZE,
      );
    }
  }

  get navigating(): boolean { return this.hasTarget; }

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
    if (this.cfg.behavior === 'idle' && this.patrolPoints.length) {
      this.home = { ...this.patrolPoints[best] };
    }
    if (this.state === 'spawn') this.state = this.cfg.behavior;
  }

  private planarDist(x: number, z: number): number {
    return Math.hypot(x - this.pos.x, z - this.pos.z);
  }

  distToXZ(x: number, z: number): number {
    return this.planarDist(x, z);
  }

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

  private idleGoal(dt: number): { x: number; z: number } | null {
    const post = this.home;
    if (!post) return null;
    const away = this.planarDist(post.x, post.z);
    if (away > 4.5) { this.idleGoalPt = post; return post; }
    if (this.idleGoalPt) {
      if (this.planarDist(this.idleGoalPt.x, this.idleGoalPt.z) < 0.9) {
        this.idleGoalPt = null;
        this.dwellT = 2.5 + Math.random() * 4;
      }
      return this.idleGoalPt;
    }
    if (this.dwellT > 0) { this.dwellT -= dt; return null; }
    const a = Math.random() * Math.PI * 2;
    const r = 0.8 + Math.random() * 2.2;
    this.idleGoalPt = { x: post.x + Math.cos(a) * r, z: post.z + Math.sin(a) * r };
    return this.idleGoalPt;
  }

  update(dt: number, player: EnemyPlayer) {
    const c = this.cfg;
    this.stateT += dt;

    if (this.state === 'dead') {
      if (this.eyeMat) this.eyeMat.color.setRGB(0.04, 0.07, 0.05);
      this.bodyRoot.rotation.x = THREE.MathUtils.lerp(this.bodyRoot.rotation.x, -Math.PI / 2, Math.min(1, dt * 7));
      if (this.stateT > 1.1) this.group.position.y -= dt * 0.9;
      return this.stateT < 2.2;
    }

    if (this.state === 'spawn') {
      const camS = this.deps.camera.position;
      this.group.position.x = this.pos.x + Math.round((camS.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE;
      this.group.position.z = this.pos.z + Math.round((camS.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE;
      this.group.position.y = this.pos.y + Math.min(1, this.stateT / 0.5) * 0 - (1 - Math.min(1, this.stateT / 0.5)) * 1.2;
      if (this.stateT > 0.5) { this.state = this.cfg.behavior; this.group.position.y = this.pos.y; }
      return true;
    }

    this.cooldown -= dt;
    this.losTimer -= dt;
    this.strafeTimer -= dt;
    this.recoilT = Math.max(0, this.recoilT - dt);
    this.weaponKick = Math.max(0, this.weaponKick - dt * 15);
    if (this.eyeMat) {
      const pulse = 1.5 + Math.sin(this.stateT * 4.5 + this.eyeSeed) * 0.45 + (this.alerted ? 0.6 : 0);
      this.eyeMat.color.copy(this.eyeBase).multiplyScalar(pulse);
    }
    if (this.strafeTimer <= 0) {
      this.strafeTimer = 1.4 + Math.random() * 2;
      this.strafeDir = Math.random() > 0.5 ? 1 : -1;
    }

    const pp = tmpPlayerImg.set(
      this.pos.x + wrapDelta(player.pos.x - this.pos.x, WORLD_SIZE),
      player.pos.y,
      this.pos.z + wrapDelta(player.pos.z - this.pos.z, WORLD_SIZE),
    );

    const toPlayer = tmpV.copy(pp).sub(this.pos);
    const dist = Math.hypot(toPlayer.x, toPlayer.z);
    void toPlayer.length();
    if (this.losTimer <= 0) {
      this.losTimer = dist < 30 ? 0.2 : dist < 70 ? 0.5 : 1.0;
      const eye = tmpV2.copy(this.pos).add(tmpV3.set(0, 1.6, 0));
      this.hasLos = false;
      const rays = dist <= c.attackRange ? LOS_HEIGHTS : LOS_HEIGHTS_FAR;
      for (const tgtY of rays) {
        const dir = tmpV3.copy(pp).add(tmpV.set(0, tgtY, 0)).sub(eye);
        const d = dir.length();
        dir.divideScalar(d || 1);
        const hit = this.deps.world.raycast(eye, dir, d);
        if (!hit || hit.dist > d - 0.3) { this.hasLos = true; break; }
      }
    }

    if (!c.peaceful && !this.alerted && this.cooldownUntil <= 0) {
      this.alerted = true;
      this.alertT = 0;
    }
    if (!c.peaceful && this.cooldownUntil <= 0) {
      this.lastKnown.copy(pp);
      this.hasTarget = true;
      this.searchT = 0;
      this.alertT = 0;
    }

    let hasLos = this.hasLos;
    if (!this.alerted) {
      hasLos = false;
      this.hasTarget = false;
      this.searchT = 0;
    } else if (this.hasLos) {
      this.lastKnown.copy(pp);
      this.hasTarget = true;
      this.searchT = 0;
      this.alertT = 0;
    } else {
      this.searchT += dt;
      this.alertT += dt;
      if (this.alertT > 12) { this.standDown(); hasLos = false; }
    }

    if (this.home && c.peaceful) {
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

    this.cooldownUntil = Math.max(0, this.cooldownUntil - dt);
    const inCooldown = this.cooldownUntil > 0;
    let patrolSteerGoal: { x: number; z: number } | null = null;
    const passive = inCooldown || !this.alerted || (!hasLos && (!this.hasTarget || this.searchT > 6));
    if (passive) {
      if (this.searchT > 6) { this.hasTarget = false; this.lastKnown.set(0, 0, 0); }
      this.state = this.cfg.behavior;
      patrolSteerGoal = this.cfg.behavior === 'idle' ? this.idleGoal(dt) : this.patrolGoal(dt);
    } else if ((hasLos || this.hasTarget) && (this.state === 'patrol' || this.state === 'idle')) {
      this.state = 'chase';
      this.returning = false; this.dwellT = 0; this.leashT = 0;
      this.idleGoalPt = null;
    }

    const hSpeed = Math.hypot(this.vel.x, this.vel.z);
    if (hSpeed > 0.55) this.lastMoveYaw = Math.atan2(this.vel.x, this.vel.z);
    const passiveStance = this.state === 'patrol' || this.state === 'idle';

    let faceX = 0, faceZ = 0, haveFace = false;
    if (passiveStance && this.tradeFaceT > 0) {
      this.tradeFaceT -= dt;
      faceX = toPlayer.x; faceZ = toPlayer.z; haveFace = true;
    } else if (passiveStance && patrolSteerGoal) {
      faceX = patrolSteerGoal.x - this.pos.x;
      faceZ = patrolSteerGoal.z - this.pos.z;
      haveFace = true;
    } else if (!passiveStance) {
      if (hasLos) { faceX = toPlayer.x; faceZ = toPlayer.z; haveFace = true; }
      else if (this.hasTarget) {
        faceX = this.lastKnown.x - this.pos.x;
        faceZ = this.lastKnown.z - this.pos.z;
        haveFace = true;
      }
    }
    if (!haveFace && hSpeed > 0.8) {
      faceX = this.vel.x; faceZ = this.vel.z; haveFace = true;
    }
    if (!haveFace) {
      if (this.state === 'idle') {
        this.idleScanT -= dt;
        if (this.idleScanT <= 0) {
          this.idleScanT = 2.6 + Math.random() * 3.6;
          this.idleFaceYaw += Math.random() < 0.22
            ? Math.PI * (0.6 + Math.random() * 0.9) * (Math.random() < 0.5 ? -1 : 1)
            : (Math.random() - 0.5) * 1.7;
        }
      } else {
        this.idleFaceYaw = this.lastMoveYaw;
      }
      faceX = Math.sin(this.idleFaceYaw);
      faceZ = Math.cos(this.idleFaceYaw);
    } else if (passiveStance) {
      this.idleFaceYaw = Math.atan2(faceX, faceZ);
    }

    const targetYaw = Math.atan2(faceX, faceZ);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    const turnRate = this.state === 'chase' || this.state === 'attack' ? 10
      : this.state === 'patrol' ? 5.5 : 2.3;
    if (Math.abs(dy) > 0.012) {
      this.yaw += Math.sign(dy) * Math.min(Math.abs(dy), turnRate * dt);
    }

    this.steerInterval = dist < 24 ? 0.08 : dist < 60 ? 0.2 : 0.45;
    this.steerT -= dt;
    this.jumpCd = Math.max(0, this.jumpCd - dt);
    let wx = 0, wz = 0;
    let wantJump = false;

    const inCombatRange = hasLos && dist < c.preferredRange * 1.15;

    if (this.state === 'patrol' || this.state === 'idle') {
      if (patrolSteerGoal) {
        const pdx = patrolSteerGoal.x - this.pos.x;
        const pdz = patrolSteerGoal.z - this.pos.z;
        this.steerContext(pdx, pdz, steerOut);
        const paceF = this.state === 'idle'
          ? CAMP_CONFIG.patrolSpeedFactor * 0.55
          : CAMP_CONFIG.patrolSpeedFactor;
        wx = steerOut.x * paceF;
        wz = steerOut.z * paceF;
        if (steerOut.jump) wantJump = true;
        if (steerOut.x === 0 && steerOut.z === 0) {
          if (this.state === 'idle') { this.idleGoalPt = null; this.dwellT = 2; }
          else this.patrolIdx = (this.patrolIdx + 1) % Math.max(1, this.patrolPoints.length);
        }
      } else {
        wx = 0; wz = 0;
      }
    } else if (this.hasTarget) {

      if (hasLos && dist < c.preferredRange * 1.35) {
        const inv = 1 / (dist || 1);
        const fx = toPlayer.x * inv, fz = toPlayer.z * inv;
        const rx = fz, rz = -fx;
        const want = c.preferredRange;
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
          if (this.deps.flowField?.sample(this.pos.x, this.pos.y, this.pos.z, FLOW)) {
            this.steerContext(FLOW.x, FLOW.z, steerOut);
          }
        }
        if (steerOut.x !== 0 || steerOut.z !== 0) {
          wx = steerOut.x; wz = steerOut.z;
          if (steerOut.jump) wantJump = true;
          if (steerOut.x * dX + steerOut.z * dZ < 0.25 && this.strafeTimer > 0.6) {
            this.strafeDir = -this.strafeDir;
            this.strafeTimer = 0.5;
          }
        }
      } else if (this.deps.flowField?.sample(this.pos.x, this.pos.y, this.pos.z, FLOW)) {
        this.steerContext(FLOW.x, FLOW.z, steerOut);
        if (steerOut.x !== 0 || steerOut.z !== 0) {
          wx = steerOut.x; wz = steerOut.z;
          if (steerOut.jump) wantJump = true;
          if (FLOW.climb > 0 && this.grounded && this.jumpCd <= 0) wantJump = true;
        } else {
          this.steerContext(
            this.lastKnown.x - this.pos.x,
            this.lastKnown.z - this.pos.z,
            steerOut,
          );
          wx = steerOut.x; wz = steerOut.z;
          if (steerOut.jump) wantJump = true;
        }
      } else {
        const dxw = this.lastKnown.x - this.pos.x;
        const dzw = this.lastKnown.z - this.pos.z;
        const hd = Math.hypot(dxw, dzw);
        if (hd > 1.1) {
          this.steerContext(dxw, dzw, steerOut);
          wx = steerOut.x; wz = steerOut.z;
          if (steerOut.jump) wantJump = true;
        } else if (this.searchT > 3) {
          this.wanderAngle += (Math.random() - 0.5) * dt * 2;
          this.steerContext(Math.sin(this.wanderAngle), Math.cos(this.wanderAngle), steerOut);
          if (steerOut.x === 0 && steerOut.z === 0) {
            this.wanderAngle += Math.PI * (0.5 + Math.random());
          } else {
            wx = steerOut.x * 0.5; wz = steerOut.z * 0.5;
          }
        }
      }
    }

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
    const sprinting = this.state !== 'patrol' && dist > c.preferredRange * 1.1;
    const maxS = c.speed * (sprinting ? CHASE_SPRINT : 1);
    if (hs > maxS) { this.vel.x *= maxS / hs; this.vel.z *= maxS / hs; }

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
        let escX = 0, escZ = 0, bestCost = Infinity;
        for (let i = 0; i < STEER_DIRS; i++) {
          const cost = this.probeStep(STEER_COS[i], STEER_SIN[i]);
          if (cost >= 0 && cost < bestCost) {
            bestCost = cost; escX = STEER_COS[i]; escZ = STEER_SIN[i];
          }
        }
        if (bestCost === Infinity) {
          if (this.jumpCd <= 0) { this.vel.y = 8.6; this.jumpCd = 0.35; }
        } else {
          this.vel.x += escX * 3.6;
          this.vel.z += escZ * 3.6;
          if (bestCost >= 1.6 && this.jumpCd <= 0) { this.vel.y = 8.6; this.jumpCd = 0.35; }
        }
        this.lastSteerIdx = -1;
        this.strafeDir = -this.strafeDir;
        if (this.alerted && hasLos) { this.lastKnown.copy(pp); this.hasTarget = true; this.searchT = 0; }
        this.stuckTimer = 0;
      }
    } else this.stuckTimer = 0;
    this.lastX = this.pos.x; this.lastZ = this.pos.z;

    this.moveAxis(0, this.vel.x * dt);
    this.moveAxis(2, this.vel.z * dt);
    const grounded = { v: false };
    this.moveAxisY(this.vel.y * dt, grounded);
    if (grounded.v) this.vel.y = 0;
    this.grounded = grounded.v;

    const fireRange = ENEMY_FIRE_MODE === 'distance' ? ENEMY_FIRE_RANGE : c.attackRange;
    const inFireRange = dist <= fireRange;
    if (this.alerted && this.state !== 'patrol' && this.state !== 'idle' && hasLos && inFireRange && this.cooldownUntil <= 0) {
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
    } else if (this.state === 'attack') this.state = (this.alerted && this.cooldownUntil <= 0) ? 'chase' : this.cfg.behavior;

    const moving = hs > 0.4;
    this.speedN += ((moving ? Math.min(1, hs / 4) : 0) - this.speedN) * Math.min(1, dt * 8);
    if (grounded.v && moving) this.walkPhase += dt * (5 + hs * 1.1);
    if (this.walkPhase > Math.PI * 2) this.walkPhase -= Math.PI * 2;
    this.instGait = this.walkPhase;
    this.instGaitGain = this.speedN;
    if (this.hitFlash > 0) this.hitFlash = Math.max(0, this.hitFlash - dt);

    if (!this.detailed) return true;

    const sw = Math.sin(this.walkPhase) * 0.65 * this.speedN;
    this.legL.rotation.x = -sw;
    this.legR.rotation.x = sw;

    const shoulder = tmpV.set(this.pos.x + Math.sin(this.yaw) * 0.31, this.pos.y + 1.28, this.pos.z + Math.cos(this.yaw) * 0.31);
    const aim = tmpV2.copy(pp).add(tmpV3.set(0, 1.1, 0)).sub(shoulder);
    const horiz = Math.hypot(aim.x, aim.z);
    const pitch = Math.atan2(aim.y, horiz || 1);
    this.aimPitch = THREE.MathUtils.clamp(pitch, -0.38, 0.38);

    const combatPose = this.alerted && hasLos;
    if (combatPose) this.weaponDrawT = 1.2;
    else this.weaponDrawT = Math.max(0, this.weaponDrawT - dt);
    const armed = this.weaponDrawT > 0;
    this.weapon.visible = armed;

    if (armed) {
      const armPitch = -Math.PI / 2 - this.aimPitch * 0.8;
      this.armL.rotation.set(armPitch - 0.05 + this.weaponKick * 0.12, 0, 0.13);
      this.armR.rotation.set(armPitch + 0.06 + this.weaponKick * 0.18, 0, -0.13);
    } else {
      this.armL.rotation.set(sw * 0.8, 0, 0);
      this.armR.rotation.set(-sw * 0.8, 0, 0);
    }

    if (armed) {
      this.weapon.position.set(0, 1.16 - this.weaponKick * 0.014, 0.32 - this.weaponKick * 0.085);
      this.weapon.rotation.set(-this.aimPitch - this.weaponKick * 0.13, 0, Math.sin(this.walkPhase) * 0.015 * this.speedN);
      this.bolt.position.z = 0.02 - this.weaponKick * 0.1;
    }

    this.bodyRoot.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.03 * this.speedN;

    if (this.flashT > 0) {
      this.flashT -= dt;
      const e = Math.max(0, this.flashT / 0.09) * 0.9;
      for (const m of this.bodyMats) m.emissive.setRGB(e, e, e);
    }

    const camPos = this.deps.camera.position;
    this.group.position.set(
      this.pos.x + Math.round((camPos.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE,
      this.pos.y,
      this.pos.z + Math.round((camPos.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE,
    );
    if (this.coinBadge) {
      this.coinBadge.rotation.y += dt * 2.6;
      this.coinBadge.position.y = 2.24 + Math.sin(this.stateT * 2.1) * 0.055;
    }

    this.group.rotation.y = this.yaw;
    const f = Math.max(0, this.hp / c.hp);
    this.hpBar.visible = f < 1;
    if (f < 1) {
      this.hpBar.lookAt(this.deps.camera.position.x, this.hpBar.getWorldPosition(tmpV).y, this.deps.camera.position.z);
      this.hpFill.scale.x = f;
      this.hpFill.position.x = -(1 - f) * 0.33;
    }
    this.hpFill.visible = f < 1;
    return true;
  }

  private fireOneShot(playerPos: THREE.Vector3, dist: number) {
    this.recoilT = 0.06;
    this.weaponKick = 1;
    const muzzle = this.detailed
      ? this.muzzle.getWorldPosition(new THREE.Vector3())
      : new THREE.Vector3(
        this.pos.x + Math.sin(this.yaw) * 0.78,
        this.pos.y + 1.12,
        this.pos.z + Math.cos(this.yaw) * 0.78,
      );
    muzzle.x = this.pos.x + wrapDelta(muzzle.x - this.pos.x, WORLD_SIZE);
    muzzle.z = this.pos.z + wrapDelta(muzzle.z - this.pos.z, WORLD_SIZE);
    const target = playerPos.clone().add(tmpV.set(0, 1.0, 0));
    const dir = target.sub(muzzle).normalize();
    const spread = (1 - this.cfg.accuracy) * 0.09;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    const cam = this.deps.camera.position;
    const vX = Math.round((cam.x - this.pos.x) / WORLD_SIZE) * WORLD_SIZE;
    const vZ = Math.round((cam.z - this.pos.z) / WORLD_SIZE) * WORLD_SIZE;
    const vis = (v: THREE.Vector3) => new THREE.Vector3(v.x + vX, v.y, v.z + vZ);

    this.deps.effects.muzzleFlash(vis(muzzle), 0.45);
    this.deps.audio.shot({ freq: 1700, dur: 0.07, gain: 0.26 * THREE.MathUtils.clamp(1 - dist / 150, 0.15, 1), sub: 260 });

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
      this.deps.effects.tracer(vis(muzzle), vis(playerPos).add(tmpV.set(0, 1.0, 0)), undefined, true);
      this.deps.onPlayerHit(this.cfg.damage, muzzle);
    } else {
      const worldHit = this.deps.world.raycast(muzzle, dir, 200);
      const endPoint = worldHit ? worldHit.point : end;
      this.deps.effects.tracer(vis(muzzle), vis(endPoint), undefined, true);
      if (worldHit) this.deps.effects.impact(vis(worldHit.point), worldHit.normal, worldHit.block, worldHit);
    }
  }


  nudge(dx: number, dz: number): void {
    this.moveAxis(0, dx);
    this.moveAxis(2, dz);
  }


  private groundNear(x: number, z: number, fromY: number): number {
    const w = this.deps.world;
    const hw = this.halfW;
    const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
    const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
    const twoX = x1 !== x0, twoZ = z1 !== z0;

    const top = Math.floor(fromY) + MAX_JUMP_UP;
    const bottom = Math.floor(fromY) - MAX_SAFE_DROP;

    let upperFree = this.rowFree(w, x0, x1, z0, z1, twoX, twoZ, top + 1);
    for (let y = top; y >= bottom; y--) {
      if (y < 1) break;
      const midFree = this.rowFree(w, x0, x1, z0, z1, twoX, twoZ, y);
      if (midFree && upperFree && this.rowSolidAny(w, x0, x1, z0, z1, twoX, twoZ, y - 1)) return y;
      upperFree = midFree;
    }
    return -1;
  }

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

  private probeStep(dx: number, dz: number): number {
    const px = this.pos.x + dx * PROBE_DIST;
    const pz = this.pos.z + dz * PROBE_DIST;

    const gy = this.groundNear(px, pz, this.pos.y);
    if (gy < 0) return -1;

    const rise = gy - Math.floor(this.pos.y);
    if (rise > MAX_JUMP_UP) return -1;

    const mx = this.pos.x + dx * PROBE_DIST * 0.5;
    const mz = this.pos.z + dz * PROBE_DIST * 0.5;
    if (this.groundNear(mx, mz, this.pos.y) < 0) return -1;

    let cost = 0;
    if (rise > MAX_STEP) cost += 1.6;
    else if (rise > 0) cost += 0.25;
    const drop = Math.floor(this.pos.y) - gy;
    if (drop > 1) cost += drop * 0.4;
    return cost;
  }

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
      if (align < -0.2) continue;
      const cost = this.probeStep(cx, cz);
      if (cost < 0) continue;
      let s = align - cost * 0.55;
      if (i === this.lastSteerIdx) s += 0.18;
      if (s > bestScore) { bestScore = s; bestIdx = i; bestCost = cost; }
    }

    if (bestIdx < 0) return;
    this.lastSteerIdx = bestIdx;
    out.x = STEER_COS[bestIdx];
    out.z = STEER_SIN[bestIdx];
    out.jump = bestCost >= 1.6;
  }

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


