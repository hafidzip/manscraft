/**
 * Player — kinematic character controller with AABB-vs-voxel collision.
 * Axis-separated integration with cell-boundary snapping (never tunnels),
 * swimming physics, and coyote-free instant jumping.
 */

import * as THREE from 'three';
import * as C from '../core/constants';
import { B, DEFS, isWaterId } from '../world/blocks';
import type { World } from '../world/world';

export interface InputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
}

const EPS = 0.001;
const CROUCH_HEIGHT = 1.35;
const CROUCH_EYE = 1.12;

export class Player {
  readonly pos = new THREE.Vector3(8.5, 45, 8.5); // feet position
  readonly vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;
  onGround = false;
  inWater = false;
  headInWater = false;
  wasFalling = 0;

  // unified-game viewmodel state (consumed by the weapon system)
  movePhase = 0;
  speedSmooth = 0;
  sprintAmt = 0;
  recoilP = 0;
  recoilY = 0;
  shake = 0;

  // ---- crouch (ported from the voxel-fps controller) ----
  crouching = false;
  crouchAmt = 0; // 0 = standing, 1 = fully crouched
  /** current collider height (shrinks while crouching) */
  height = C.PLAYER_HEIGHT;

  // ---- death / collapse animation state (ported from the voxel-fps controller)
  dying = false;
  deathT = 0;
  private deathSide = 1;          // -1 topple left, +1 topple right
  private deathYaw0 = 0;
  private deathYawTarget = 0;
  private deathPitch0 = 0;
  private deathSeed = 0;
  private shakeT = 0;

  constructor(private world: World) {}

  setSpawn(x: number, y: number, z: number): void {
    this.pos.set(x, y, z);
    this.vel.set(0, 0, 0);
  }

  /** camera pitch/yaw kick from gunfire (decays each frame) */
  addRecoil(pitch: number, yawR: number): void {
    this.recoilP += pitch;
    this.recoilY += yawR;
  }

  addShake(amp: number): void {
    this.shake = Math.min(0.06, this.shake + amp);
  }

  /**
   * Begin the death collapse (ported from voxel-fps Player.startDeath).
   * `attackerPos` makes the body topple away from the incoming fire and
   * slowly turn the head toward the killer.
   */
  startDeath(attackerPos?: THREE.Vector3): void {
    if (this.dying) return;
    this.dying = true;
    this.deathT = 0;
    this.deathSeed = Math.random() * 100;
    this.vel.set(0, 0, 0);
    this.deathYaw0 = this.yaw;
    this.deathYawTarget = this.yaw;
    this.deathPitch0 = this.pitch;
    this.deathSide = Math.random() > 0.5 ? 1 : -1;
    this.shake = 0.05;

    if (attackerPos) {
      const dx = attackerPos.x - this.pos.x;
      const dz = attackerPos.z - this.pos.z;
      const len = Math.hypot(dx, dz) || 1;
      // camera right vector at the current yaw
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      const dotRight = (dx / len) * rx + (dz / len) * rz;
      this.deathSide = dotRight > 0 ? -1 : 1;   // topple away from the shot
      // turn the head toward whoever killed us
      const target = Math.atan2(-dx, -dz);
      let d = target - this.yaw;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      this.deathYawTarget = this.yaw + THREE.MathUtils.clamp(d, -1.2, 1.2);
    }
  }

  resetDeath(): void {
    this.dying = false;
    this.deathT = 0;
    this.shake = 0;
    this.shakeT = 0;
    this.recoilP = 0;
    this.recoilY = 0;
  }

  /** advance the collapse while dead (engine calls this each frame) */
  updateDeath(dt: number): void {
    this.deathT += dt;
    this.vel.set(0, 0, 0);
    this.shakeT += dt * 34;
    this.shake *= Math.max(0, 1 - dt * 4.2);
    if (this.shake < 0.0003) this.shake = 0;
    this.recoilP *= Math.max(0, 1 - 9 * dt);
    this.recoilY *= Math.max(0, 1 - 9 * dt);
  }

  /**
   * Death camera (ported verbatim from voxel-fps Player.applyDeathCamera):
   * an impact jolt, knees buckling, the body toppling onto its side with the
   * head arcing over, a hard ground impact with rebound, then a slow settle
   * with fading twitches.
   */
  applyDeathCamera(cam: THREE.PerspectiveCamera): void {
    const t = this.deathT;
    const S = this.deathSide;
    const ss = (a: number, b: number) => {
      const x = THREE.MathUtils.clamp((t - a) / (b - a), 0, 1);
      return x * x * (3 - 2 * x);
    };

    // --- collapse curve: slow buckle, accelerating fall, hard stop at ~0.85s
    const FALL_START = 0.09, FALL_END = 0.86;
    const p = THREE.MathUtils.clamp((t - FALL_START) / (FALL_END - FALL_START), 0, 1);
    const fall = Math.pow(p, 1.75);                       // gravity-like accel

    // --- ground impact rebound (head bouncing off the dirt)
    const since = t - FALL_END;
    const bounce = since > 0 ? Math.exp(-since * 8.5) * Math.sin(since * 21) : 0;

    // --- impact jolt from the killing shot
    const jolt = Math.exp(-t * 11);
    const joltP = jolt * Math.sin(t * 46) * 0.055;
    const joltY = jolt * Math.sin(t * 33 + 1.1) * 0.04;

    // --- height: eye level down to just above the ground
    const GROUND_EYE = 0.26;
    const eyeY = THREE.MathUtils.lerp(C.EYE_HEIGHT, GROUND_EYE, fall) + bounce * 0.055;

    // --- the head arcs sideways as the body pivots on its feet
    const lateral = Math.sin(fall * 1.5) * 0.62 * S;
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    const fwdX = -Math.sin(this.yaw), fwdZ = -Math.cos(this.yaw);
    const forwardSlump = fall * 0.18;

    cam.position.set(
      this.pos.x + rx * lateral + fwdX * forwardSlump,
      this.pos.y + eyeY,
      this.pos.z + rz * lateral + fwdZ * forwardSlump
    );

    // --- slowly turn the head toward the killer while going down
    const look = ss(0.05, 1.25);
    const yaw = THREE.MathUtils.lerp(this.deathYaw0, this.deathYawTarget, look) + joltY;

    // --- roll onto the side, pitch tips toward the ground
    const roll = fall * 1.52 * S + bounce * 0.085 * S;
    const pitch = THREE.MathUtils.lerp(this.deathPitch0, -0.22, fall) + joltP + bounce * 0.05;

    // --- fading death twitches once settled
    let twitchR = 0, twitchP = 0;
    if (t > 1.0) {
      const q = Math.exp(-(t - 1.0) * 1.1);
      const w = t * 2.2 + this.deathSeed;
      twitchR = Math.sin(w) * 0.012 * q;
      twitchP = Math.cos(w * 0.8) * 0.009 * q;
    }

    let shakeP = 0, shakeY = 0, shakeR = 0;
    if (this.shake > 0) {
      const st = this.shakeT + this.deathSeed;
      shakeP = Math.sin(st * 1.9) * this.shake;
      shakeY = Math.cos(st * 2.3) * this.shake;
      shakeR = Math.sin(st * 5.3) * this.shake * 0.8;
    }

    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch + twitchP + shakeP, yaw + shakeY, roll + twitchR + shakeR);
  }

  center(): THREE.Vector3 {
    return new THREE.Vector3(this.pos.x, this.pos.y + this.height / 2, this.pos.z);
  }

  eye(): THREE.Vector3 {
    const eyeH = C.EYE_HEIGHT + (CROUCH_EYE - C.EYE_HEIGHT) * this.crouchAmt;
    return new THREE.Vector3(this.pos.x, this.pos.y + eyeH, this.pos.z);
  }

  /** Is there enough headroom to return to full standing height? */
  private canStandUp(): boolean {
    const hw = C.PLAYER_HALF_WIDTH;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);
    const y0 = Math.floor(this.pos.y + CROUCH_HEIGHT);
    const y1 = Math.floor(this.pos.y + C.PLAYER_HEIGHT - 0.001);
    for (let x = minX; x <= maxX; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = minZ; z <= maxZ; z++)
          if (this.world.isSolid(x, y, z)) return false;
    return true;
  }

  private blockAt(x: number, y: number, z: number): number {
    return this.world.getBlockRaw(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  update(dt: number, inp: InputState): void {
    // --- sensing (any water state: source, flowing, falling) ---
    const feetId = this.blockAt(this.pos.x, this.pos.y + 0.3, this.pos.z);
    this.inWater = isWaterId(feetId) || isWaterId(this.blockAt(this.pos.x, this.pos.y + 0.9, this.pos.z));
    this.headInWater = isWaterId(this.blockAt(this.pos.x, this.pos.y + C.EYE_HEIGHT, this.pos.z));

    // --- desired horizontal velocity from yaw ---
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const rx = -fz;
    const rz = fx;
    let wx = 0;
    let wz = 0;
    if (inp.forward) { wx += fx; wz += fz; }
    if (inp.back) { wx -= fx; wz -= fz; }
    if (inp.right) { wx += rx; wz += rz; }
    if (inp.left) { wx -= rx; wz -= rz; }
    const len = Math.hypot(wx, wz);
    if (len > 0) { wx /= len; wz /= len; }

    // ---- crouch: hold to duck; can only stand back up with headroom ----
    if (!inp.crouch && this.crouching && !this.canStandUp()) {
      this.crouching = true; // blocked by a ceiling
    } else {
      this.crouching = inp.crouch && !this.inWater;
    }
    const crouchTarget = this.crouching ? 1 : 0;
    this.crouchAmt += (crouchTarget - this.crouchAmt) * Math.min(1, dt * 12);
    if (Math.abs(this.crouchAmt - crouchTarget) < 0.002) this.crouchAmt = crouchTarget;
    this.height = C.PLAYER_HEIGHT + (CROUCH_HEIGHT - C.PLAYER_HEIGHT) * this.crouchAmt;

    let speed = inp.sprint && !this.crouching ? C.SPRINT_SPEED : C.WALK_SPEED;
    speed *= 1 - this.crouchAmt * 0.62;
    if (this.inWater) speed = Math.min(speed, C.SWIM_SPEED);

    const accel = this.onGround ? 14 : 4;
    const k = Math.min(1, accel * dt);
    this.vel.x += (wx * speed - this.vel.x) * k;
    this.vel.z += (wz * speed - this.vel.z) * k;

    // --- vertical ---
    if (this.inWater) {
      this.vel.y -= C.GRAVITY * 0.24 * dt;
      if (inp.jump) this.vel.y += (3.9 - this.vel.y) * Math.min(1, 8 * dt);
      if (this.vel.y < -3.4) this.vel.y = -3.4;
    } else {
      this.wasFalling = this.vel.y;
      this.vel.y -= C.GRAVITY * dt;
      if (this.vel.y < -38) this.vel.y = -38;
      if (inp.jump && this.onGround && !this.crouching) {
        this.vel.y = C.JUMP_VELOCITY;
        this.onGround = false;
      }
    }

    // --- integrate with collision (axis separated) ---
    this.moveX(this.vel.x * dt);
    this.moveZ(this.vel.z * dt);
    this.onGround = false;
    this.moveY(this.vel.y * dt);

    // --- unified-game viewmodel signals ---
    const hs = Math.hypot(this.vel.x, this.vel.z);
    this.speedSmooth += (hs - this.speedSmooth) * Math.min(1, dt * 10);
    this.sprintAmt += ((inp.sprint && this.onGround && hs > 0.5 ? 1 : 0) - this.sprintAmt) * Math.min(1, dt * 8);
    if (this.onGround && hs > 0.5) this.movePhase += dt * (5.4 + hs * 0.85);
    this.recoilP *= Math.max(0, 1 - 10 * dt);
    this.recoilY *= Math.max(0, 1 - 10 * dt);
    this.shake *= Math.max(0, 1 - 5 * dt);
  }

  private collides(): boolean {
    const hw = C.PLAYER_HALF_WIDTH;
    const x0 = Math.floor(this.pos.x - hw);
    const x1 = Math.floor(this.pos.x + hw);
    const y0 = Math.floor(this.pos.y);
    const y1 = Math.floor(this.pos.y + this.height - 0.001);
    const z0 = Math.floor(this.pos.z - hw);
    const z1 = Math.floor(this.pos.z + hw);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          if (this.world.isSolid(x, y, z)) return true;
    return false;
  }

  private moveX(d: number): void {
    if (d === 0) return;
    this.pos.x += d;
    if (!this.collides()) return;
    const hw = C.PLAYER_HALF_WIDTH;
    if (d > 0) this.pos.x = Math.floor(this.pos.x + hw) - hw - EPS;
    else this.pos.x = Math.floor(this.pos.x - hw) + 1 + hw + EPS;
    this.vel.x = 0;
  }

  private moveZ(d: number): void {
    if (d === 0) return;
    this.pos.z += d;
    if (!this.collides()) return;
    const hw = C.PLAYER_HALF_WIDTH;
    if (d > 0) this.pos.z = Math.floor(this.pos.z + hw) - hw - EPS;
    else this.pos.z = Math.floor(this.pos.z - hw) + 1 + hw + EPS;
    this.vel.z = 0;
  }

  private moveY(d: number): void {
    if (d === 0) {
      // still register ground contact when standing still
      this.pos.y -= EPS;
      if (this.collides()) {
        this.pos.y += EPS;
        this.onGround = true;
      } else this.pos.y += EPS;
      return;
    }
    this.pos.y += d;
    if (!this.collides()) return;
    if (d < 0) {
      this.pos.y = Math.floor(this.pos.y) + 1;
      this.vel.y = 0;
      this.onGround = true;
    } else {
      this.pos.y = Math.floor(this.pos.y + this.height) - this.height - EPS;
      this.vel.y = 0;
    }
  }

  /** horizontal speed (for footsteps / bob / fov) */
  horizontalSpeed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  /** block id directly beneath the feet (for footstep sounds) */
  groundBlock(): number {
    const id = this.world.getBlockRaw(Math.floor(this.pos.x), Math.floor(this.pos.y - 0.01), Math.floor(this.pos.z));
    return id >= 0 ? id : B.STONE;
  }

  groundSound(): 'grass' | 'dirt' | 'sand' | 'stone' | 'wood' | 'glass' | 'plant' {
    return DEFS[this.groundBlock()].sound;
  }
}
