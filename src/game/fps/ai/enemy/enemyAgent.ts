import * as THREE from 'three';
import type { CampBuild } from '../../world/camps';
import { findPath } from '../../Pathfinder';
import { CAMP_CONFIG } from '../../camps';
import { buildEnemyModel } from './enemyModel';
import { moveEnemyAxis, moveEnemyAxisY } from './enemyPhysics';
import { checkEnemyLos, fireEnemyShot } from './enemyCombat';
import {
  EnemyState, EnemyConfig, ENEMY_PRESETS, ENEMY_FIRE_MODE, ENEMY_FIRE_RANGE,
  pathBudget, type EnemyPlayer, type EnemyDeps,
} from './enemyTypes';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpV3 = new THREE.Vector3();

export class Enemy {
  cfg: EnemyConfig;
  group = new THREE.Group();
  bodyRoot: THREE.Group;
  legL: THREE.Group; legR: THREE.Group;
  armL: THREE.Group; armR: THREE.Group;
  weapon: THREE.Group; bolt: THREE.Group;
  hpFill: THREE.Mesh; hpBar: THREE.Group;
  muzzle: THREE.Object3D;
  bodyMats: THREE.MeshLambertMaterial[];

  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0;
  hp: number;
  state: EnemyState = 'spawn';
  readonly halfW = 0.3;
  readonly height = 1.8;

  private walkPhase = 0; private speedN = 0;
  private losTimer = 0; private hasLos = false;
  private cooldown = 1.0; private burstLeft = 0; private burstTimer = 0;
  private strafeDir = 1; private strafeTimer = 0; private stuckTimer = 0;
  private lastX = 0; private lastZ = 0;

  private path: THREE.Vector3[] = []; private pathIdx = 0;
  private repathT = Math.random() * 0.6;
  private pathGoal = new THREE.Vector3();
  private lastKnown = new THREE.Vector3();
  private hasTarget = false; private searchT = 0;
  private grounded = false; private jumpCd = 0; private repathFails = 0;
  private wanderAngle = Math.random() * Math.PI * 2;
  private flashT = 0; private stateT = 0; private recoilT = 0;
  weaponKick = 0;
  private aimPitch = 0;

  patrolPoints: { x: number; z: number }[] = [];
  patrolIdx = 0;
  home: { x: number; z: number } | null = null;
  maxLeash = 45;
  private leashT = 0; private returning = false; private dwellT = 0;

  constructor(preset: string, pos: THREE.Vector3, public deps: EnemyDeps, overrides: Partial<EnemyConfig> = {}) {
    this.cfg = { ...ENEMY_PRESETS[preset], ...overrides };
    this.hp = this.cfg.hp;
    this.pos.copy(pos);
    this.lastX = pos.x; this.lastZ = pos.z;
    this.yaw = Math.random() * Math.PI * 2;

    const m = buildEnemyModel(this.group, this.cfg);
    this.bodyRoot = m.bodyRoot; this.legL = m.legL; this.legR = m.legR;
    this.armL = m.armL; this.armR = m.armR; this.weapon = m.weapon;
    this.bolt = m.bolt; this.muzzle = m.muzzle; this.hpBar = m.hpBar;
    this.hpFill = m.hpFill; this.bodyMats = m.bodyMats;

    this.group.position.copy(pos);
    this.deps.effects.puff(tmpV.set(pos.x, pos.y + 0.3, pos.z), tmpV2.set(0, 1, 0), 0.5, 0.7, '#b8b0a2');
  }

  get alive(): boolean { return this.state !== 'dead'; }
  get center(): THREE.Vector3 { return tmpV3.copy(this.pos).add(tmpV.set(0, 1.0, 0)); }
  get navigating(): boolean { return this.pathIdx < this.path.length; }

  takeDamage(amount: number, point: THREE.Vector3, headshot: boolean) {
    if (!this.alive) return;
    this.hp -= headshot ? amount * 2 : amount;
    this.flashT = 0.09;
    tmpV.copy(this.pos).sub(point).setY(0);
    if (tmpV.lengthSq() < 0.001) tmpV.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    tmpV.normalize().multiplyScalar(headshot ? 2.2 : 1.2);
    this.vel.x += tmpV.x; this.vel.z += tmpV.z;
    for (let i = 0; i < 4; i++) {
      tmpV2.set((Math.random() - 0.5) * 3, Math.random() * 3, (Math.random() - 0.5) * 3);
      this.deps.effects.spawnParticle(point, tmpV2, 0xd0342c, 0.035 + Math.random() * 0.02, 0.4, true);
    }
    if (this.hp <= 0) this.die(point);
  }

  private die(point: THREE.Vector3) {
    this.state = 'dead'; this.stateT = 0; this.hpFill.visible = false;
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

  invalidatePath() { this.path.length = 0; this.pathIdx = 0; this.repathT = 0; }
  investigate(pos: THREE.Vector3) { this.lastKnown.copy(pos); this.hasTarget = true; this.searchT = 0; this.invalidatePath(); }

  assignCamp(build: CampBuild): void {
    this.patrolPoints = (build.patrolPoints.length ? build.patrolPoints : build.posts).slice();
    this.home = { x: build.site.cx, z: build.site.cz };
    this.maxLeash = Math.max(CAMP_CONFIG.maxLeash, build.site.radius * 3);
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.patrolPoints.length; i++) {
      const d = Math.hypot(this.patrolPoints[i].x - this.pos.x, this.patrolPoints[i].z - this.pos.z);
      if (d < bd) { bd = d; best = i; }
    }
    this.patrolIdx = best; this.returning = false; this.leashT = 0;
    if (this.state === 'spawn') this.state = 'patrol';
  }

  private patrolGoal(dt: number): { x: number; z: number } | null {
    if (this.returning && this.home) {
      if (Math.hypot(this.home.x - this.pos.x, this.home.z - this.pos.z) > Math.max(6, this.maxLeash * 0.3)) return this.home;
      this.returning = false;
    }
    if (!this.patrolPoints.length) return this.home;
    if (this.dwellT > 0) { this.dwellT -= dt; return null; }
    const wp = this.patrolPoints[this.patrolIdx % this.patrolPoints.length];
    if (Math.hypot(wp.x - this.pos.x, wp.z - this.pos.z) < 1.5) {
      this.patrolIdx = (this.patrolIdx + 1) % this.patrolPoints.length;
      this.dwellT = 0.4 + (this.patrolIdx % 3) * 0.25;
      return null;
    }
    return wp;
  }

  update(dt: number, player: EnemyPlayer): boolean {
    const c = this.cfg;
    this.stateT += dt;
    if (this.state === 'dead') {
      this.bodyRoot.rotation.x = THREE.MathUtils.lerp(this.bodyRoot.rotation.x, -Math.PI / 2, Math.min(1, dt * 7));
      if (this.stateT > 1.1) this.group.position.y -= dt * 0.9;
      return this.stateT < 2.2;
    }
    if (this.state === 'spawn') {
      if (this.stateT > 0.5) { this.state = this.patrolPoints.length ? 'patrol' : 'chase'; this.group.position.y = this.pos.y; }
      return true;
    }

    this.cooldown -= dt; this.losTimer -= dt; this.strafeTimer -= dt;
    this.recoilT = Math.max(0, this.recoilT - dt);
    this.weaponKick = Math.max(0, this.weaponKick - dt * 15);
    if (this.strafeTimer <= 0) { this.strafeTimer = 1.4 + Math.random() * 2; this.strafeDir = Math.random() > 0.5 ? 1 : -1; }

    const toPlayer = tmpV.copy(player.pos).sub(this.pos);
    const dist = Math.hypot(toPlayer.x, toPlayer.z);
    if (this.losTimer <= 0) { this.losTimer = 0.2; this.hasLos = checkEnemyLos(this.pos, player, this.deps.world); }

    let hasLos = this.hasLos;
    if (hasLos) { this.lastKnown.copy(player.pos); this.hasTarget = true; this.searchT = 0; } else this.searchT += dt;

    if (this.home && this.state !== 'dead') {
      const pd = Math.hypot(player.pos.x - this.home.x, player.pos.z - this.home.z);
      if (this.hasTarget && pd > this.maxLeash) {
        this.leashT += dt;
        if (this.leashT > 3) {
          this.hasTarget = false; this.lastKnown.set(0, 0, 0); this.searchT = 0;
          this.returning = true; this.leashT = 0; hasLos = false;
        }
      } else if (pd <= this.maxLeash * 0.9) this.leashT = 0;
    }

    let patrolSteerGoal: { x: number; z: number } | null = null;
    const idle = !hasLos && (!this.hasTarget || this.searchT > 6);
    if (idle && this.state !== 'dead' && (this.patrolPoints.length > 0 || this.returning)) {
      if (this.searchT > 6) { this.hasTarget = false; this.lastKnown.set(0, 0, 0); }
      this.state = 'patrol'; patrolSteerGoal = this.patrolGoal(dt);
    } else if (hasLos && this.state === 'patrol') {
      this.state = 'chase'; this.returning = false; this.dwellT = 0; this.leashT = 0;
    }

    let faceX = toPlayer.x, faceZ = toPlayer.z;
    if (this.state === 'patrol' && patrolSteerGoal) {
      faceX = patrolSteerGoal.x - this.pos.x; faceZ = patrolSteerGoal.z - this.pos.z;
    } else if (!hasLos && this.pathIdx < this.path.length) {
      const wp = this.path[this.pathIdx]; faceX = wp.x - this.pos.x; faceZ = wp.z - this.pos.z;
    }
    const targetYaw = Math.atan2(faceX, faceZ);
    let dy = targetYaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
    this.yaw += dy * Math.min(1, dt * 8);

    this.repathT -= dt; this.jumpCd = Math.max(0, this.jumpCd - dt);
    let wx = 0, wz = 0; let wantJump = false;
    const inCombatRange = hasLos && dist < c.preferredRange * 1.15;

    if (this.state === 'patrol') {
      if (patrolSteerGoal) {
        const pdx = patrolSteerGoal.x - this.pos.x, pdz = patrolSteerGoal.z - this.pos.z;
        const pd = Math.hypot(pdx, pdz) || 1;
        wx = (pdx / pd) * CAMP_CONFIG.patrolSpeedFactor; wz = (pdz / pd) * CAMP_CONFIG.patrolSpeedFactor;
      }
    } else if (inCombatRange) {
      this.path.length = 0; this.pathIdx = 0;
      const inv = 1 / (dist || 1); const fx = toPlayer.x * inv, fz = toPlayer.z * inv;
      if (dist > c.preferredRange) { wx += fx; wz += fz; }
      else if (dist < c.preferredRange * 0.55) { wx -= fx * 0.85; wz -= fz * 0.85; }
      wx += fz * this.strafeDir * 0.7; wz += -fx * this.strafeDir * 0.7;
    } else if (this.hasTarget) {
      const needPath = this.path.length === 0 || this.pathIdx >= this.path.length;
      if ((this.repathT <= 0 || needPath) && pathBudget.tokens > 0) {
        pathBudget.tokens--; this.repathT = 0.4 + Math.random() * 0.45;
        this.pathGoal.copy(this.lastKnown);
        findPath(this.deps.world, Math.floor(this.pos.x), Math.floor(this.pos.y), Math.floor(this.pos.z), Math.floor(this.lastKnown.x), Math.floor(this.lastKnown.y), Math.floor(this.lastKnown.z), this.path, { maxNodes: 1800, maxFall: 8, maxJump: 2, reachRadius: 1.5 });
        this.pathIdx = 0;
      }
      if (this.pathIdx < this.path.length) {
        const wp = this.path[this.pathIdx]; const dxw = wp.x - this.pos.x, dzw = wp.z - this.pos.z;
        const hd = Math.hypot(dxw, dzw);
        if (hd < 0.42) this.pathIdx++; else { wx = dxw / (hd || 1); wz = dzw / (hd || 1); }
      }
    }

    if (this.state === 'attack' && inCombatRange) { wx *= 0.3; wz *= 0.3; }
    const wlen = Math.hypot(wx, wz); if (wlen > 1) { wx /= wlen; wz /= wlen; }

    this.vel.x += wx * 26 * dt; this.vel.z += wz * 26 * dt;
    const damp = Math.max(0, 1 - 8 * dt); this.vel.x *= damp; this.vel.z *= damp;
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > c.speed) { this.vel.x *= c.speed / hs; this.vel.z *= c.speed / hs; }

    this.vel.y -= 26 * dt; this.vel.y = Math.max(this.vel.y, -40);
    moveEnemyAxis(this.pos, this.vel, this.halfW, this.height, 0, this.vel.x * dt, this.deps.world);
    moveEnemyAxis(this.pos, this.vel, this.halfW, this.height, 2, this.vel.z * dt, this.deps.world);
    const grounded = { v: false };
    moveEnemyAxisY(this.pos, this.vel, this.halfW, this.height, this.vel.y * dt, grounded, this.deps.world);
    if (grounded.v) this.vel.y = 0;
    this.grounded = grounded.v;

    const fireRange = ENEMY_FIRE_MODE === 'distance' ? ENEMY_FIRE_RANGE : c.attackRange;
    if (this.state !== 'patrol' && hasLos && dist <= fireRange) {
      this.state = 'attack';
      if (this.burstLeft > 0) {
        this.burstTimer -= dt;
        if (this.burstTimer <= 0) { fireEnemyShot(this, player, dist); this.burstLeft--; this.burstTimer = c.burstDelay; }
      } else if (this.cooldown <= 0) {
        this.burstLeft = c.burst; this.burstTimer = 0; this.cooldown = c.attackCooldown * (0.8 + Math.random() * 0.5);
      }
    } else if (this.state === 'attack') this.state = this.patrolPoints.length ? 'patrol' : 'chase';

    const moving = hs > 0.4;
    this.speedN += ((moving ? Math.min(1, hs / 4) : 0) - this.speedN) * Math.min(1, dt * 8);
    if (grounded.v && moving) this.walkPhase += dt * (5 + hs * 1.1);
    const sw = Math.sin(this.walkPhase) * 0.65 * this.speedN;
    this.legL.rotation.x = -sw; this.legR.rotation.x = sw;

    const shoulder = tmpV.set(this.pos.x + Math.sin(this.yaw) * 0.31, this.pos.y + 1.28, this.pos.z + Math.cos(this.yaw) * 0.31);
    const aim = tmpV2.copy(player.pos).add(tmpV3.set(0, 1.1, 0)).sub(shoulder);
    const pitch = Math.atan2(aim.y, Math.hypot(aim.x, aim.z) || 1);
    this.aimPitch = THREE.MathUtils.clamp(pitch, -0.38, 0.38);
    if (hasLos) {
      // Arms pivot at the shoulder and hang along -Y by default. The weapon
      // rig is built along +Z (muzzle at +0.86, grip near +0.3), so the hand
      // must swing to +Z to grip it — that's a NEGATIVE rotation.x (right-hand
      // rule: rotating -Y around X by -π/2 lands on +Z). Positive aimPitch
      // means aiming up, which requires a more-negative arm pitch to lift the
      // hand. Recoil (weaponKick) pushes the arms back toward the body, i.e.
      // rotation.x toward 0 from -π/2.
      const armPitch = -Math.PI / 2 - this.aimPitch * 0.8;
      this.armL.rotation.set(armPitch - 0.05 + this.weaponKick * 0.12, 0, 0.13);
      this.armR.rotation.set(armPitch + 0.06 + this.weaponKick * 0.18, 0, -0.13);
    } else {
      this.armL.rotation.set(sw * 0.8, 0, 0); this.armR.rotation.set(-sw * 0.8, 0, 0);
    }

    this.weapon.position.set(0, 1.16 - this.weaponKick * 0.014, 0.32 - this.weaponKick * 0.085);
    this.weapon.rotation.set(-this.aimPitch - this.weaponKick * 0.13, 0, Math.sin(this.walkPhase) * 0.015 * this.speedN);
    this.bolt.position.z = 0.02 - this.weaponKick * 0.1;
    this.bodyRoot.position.y = Math.abs(Math.sin(this.walkPhase)) * 0.03 * this.speedN;

    if (this.flashT > 0) {
      this.flashT -= dt; const e = Math.max(0, this.flashT / 0.09) * 0.9;
      for (const m of this.bodyMats) m.emissive.setRGB(e, e, e);
    }

    this.group.position.copy(this.pos); this.group.rotation.y = this.yaw;
    this.hpBar.lookAt(this.deps.camera.position.x, this.hpBar.getWorldPosition(tmpV).y, this.deps.camera.position.z);
    const f = Math.max(0, this.hp / c.hp);
    this.hpFill.scale.x = f; this.hpFill.position.x = -(1 - f) * 0.33; this.hpFill.visible = f < 1;
    return true;
  }
}

