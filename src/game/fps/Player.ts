// First-person player controller: AABB voxel collision, sprint/jump physics,
// camera rig with recoil springs, screen shake and landing dips.
import * as THREE from 'three';
import { World } from './World';

export interface MoveInput {
  fw: boolean; bk: boolean; lf: boolean; rt: boolean;
  jump: boolean; sprint: boolean; crouch: boolean;
}

class Spring {
  v = 0; vel = 0;
  constructor(public k = 180, public d = 16) {}
  update(dt: number, target = 0): number {
    const f = (target - this.v) * this.k - this.vel * this.d;
    this.vel += f * dt;
    this.v += this.vel * dt;
    return this.v;
  }
  impulse(i: number) { this.vel += i; }
}

export class Player {
  pos = new THREE.Vector3();
  vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  onGround = false;
  readonly halfW = 0.32;
  readonly standHeight = 1.8;
  readonly crouchHeight = 1.35;
  readonly eye = 1.62;
  readonly crouchEye = 1.12;

  /** Current collider height (shrinks while crouching). */
  height = 1.8;

  movePhase = 0;          // shared gait phase (viewmodel + legs)
  speedSmooth = 0;
  sprintAmt = 0;
  crouchAmt = 0;          // 0 = standing, 1 = fully crouched
  crouching = false;
  airT = 0;
  stepAcc = 0;
  onStep?: (alt: boolean) => void;
  onLand?: (impact: number) => void;
  private stepAlt = false;

  private recoilP = new Spring(220, 19);
  private recoilY = new Spring(210, 18);
  private landDip = new Spring(120, 12);
  private shakeAmp = 0;
  private shakeT = 0;
  private shakeSeed = Math.random() * 100;
  private wasGround = true;

  // ---- death / collapse animation state
  dying = false;
  deathT = 0;
  private deathSide = 1;          // -1 topple left, +1 topple right
  private deathYaw0 = 0;
  private deathYawTarget = 0;
  private deathPitch0 = 0;
  private deathSeed = 0;

  spawnAt(p: THREE.Vector3) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.yaw = 0; // camera forward is -Z at yaw 0 (toward the range)
    this.pitch = 0;
  }

  /**
   * Begin the death collapse. `attackerPos` makes the body topple away from
   * the incoming fire and slowly turn the head toward the killer.
   */
  startDeath(attackerPos?: THREE.Vector3) {
    if (this.dying) return;
    this.dying = true;
    this.deathT = 0;
    this.deathSeed = Math.random() * 100;
    this.vel.set(0, 0, 0);
    this.deathYaw0 = this.yaw;
    this.deathYawTarget = this.yaw;
    this.deathPitch0 = this.pitch;
    this.deathSide = Math.random() > 0.5 ? 1 : -1;
    this.shakeAmp = 0.05;

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

  resetDeath() {
    this.dying = false;
    this.deathT = 0;
    this.shakeAmp = 0;
  }

  addRecoil(pitch: number, yawR: number) {
    this.recoilP.impulse(pitch * 22);
    this.recoilY.impulse(yawR * 22);
  }

  addShake(amp: number) { this.shakeAmp = Math.min(0.06, this.shakeAmp + amp); }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  update(dt: number, input: MoveInput, world: World, allowControl: boolean) {
    // While dying the body is collapsing: no input, no locomotion.
    if (this.dying) {
      this.deathT += dt;
      this.landDip.update(dt);
      this.recoilP.update(dt);
      this.recoilY.update(dt);
      this.speedSmooth += (0 - this.speedSmooth) * Math.min(1, dt * 9);
      this.sprintAmt += (0 - this.sprintAmt) * Math.min(1, dt * 9);
      if (this.shakeAmp > 0.0003) {
        this.shakeT += dt * 34;
        this.shakeAmp *= Math.max(0, 1 - dt * 4.2);
      } else this.shakeAmp = 0;
      void world; void input; void allowControl;
      return;
    }

    const wishX = allowControl ? (input.rt ? 1 : 0) - (input.lf ? 1 : 0) : 0;
    const wishZ = allowControl ? (input.bk ? 1 : 0) - (input.fw ? 1 : 0) : 0;

    // ---- crouch: hold to duck. We can only stand back up when there is
    // room above, otherwise we stay crouched (prevents clipping into blocks).
    const wantCrouch = allowControl && input.crouch;
    if (!wantCrouch && this.crouching && !this.canStandUp(world)) {
      this.crouching = true;                 // blocked by a ceiling
    } else {
      this.crouching = wantCrouch;
    }
    const crouchTarget = this.crouching ? 1 : 0;
    this.crouchAmt += (crouchTarget - this.crouchAmt) * Math.min(1, dt * 12);
    if (Math.abs(this.crouchAmt - crouchTarget) < 0.002) this.crouchAmt = crouchTarget;
    this.height = this.standHeight + (this.crouchHeight - this.standHeight) * this.crouchAmt;

    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let ax = (wishX * cos + wishZ * sin);
    let az = (-wishX * sin + wishZ * cos);
    const len = Math.hypot(ax, az);
    if (len > 0) { ax /= len; az /= len; }

    // crouching disables sprinting and slows movement significantly
    const sprinting = allowControl && input.sprint && this.onGround && wishZ < 0 && !this.crouching;
    const baseSpeed = sprinting ? 7.0 : 4.6;
    const maxSpeed = baseSpeed * (1 - this.crouchAmt * 0.62);
    const accel = this.onGround ? 46 : 11;

    this.vel.x += ax * accel * dt;
    this.vel.z += az * accel * dt;

    // friction
    const fr = this.onGround ? (len === 0 ? 11 : 4.5) : 0.25;
    const damp = Math.max(0, 1 - fr * dt);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    if (hs > maxSpeed) {
      const s = Math.max(maxSpeed, hs * damp - (hs - maxSpeed) * 0.4 * dt * 10);
      this.vel.x *= (hs > 1e-5 ? s / hs : 0);
      this.vel.z *= (hs > 1e-5 ? s / hs : 0);
    } else if (len === 0) {
      this.vel.x *= damp; this.vel.z *= damp;
    }

    // gravity + jump (can't jump while crouching, like Minecraft)
    this.vel.y -= 26 * dt;
    if (allowControl && input.jump && this.onGround && !this.crouching) {
      this.vel.y = 8.6;
      this.onGround = false;
    }
    this.vel.y = Math.max(this.vel.y, -42);

    // integrate with axis-separated AABB collision
    this.moveAxis(world, 0, this.vel.x * dt);
    this.moveAxis(world, 2, this.vel.z * dt);
    const prevVy = this.vel.y;
    this.onGround = false;
    this.moveAxis(world, 1, this.vel.y * dt);
    if (!this.onGround) this.airT += dt; else this.airT = 0;

    if (!this.wasGround && this.onGround) {
      const impact = Math.max(0, -prevVy - 5) * 0.03;
      if (impact > 0.004) {
        this.landDip.impulse(-impact * 14);
        this.onLand?.(impact);
      }
    }
    this.wasGround = this.onGround;

    // springs
    this.landDip.update(dt);
    this.recoilP.update(dt);
    this.recoilY.update(dt);

    // gait phase drives viewmodel bob + leg swing
    this.speedSmooth += (hs - this.speedSmooth) * Math.min(1, dt * 10);
    const target = sprinting ? 1 : 0;
    this.sprintAmt += (target - this.sprintAmt) * Math.min(1, dt * 8);
    if (this.onGround && hs > 0.4) {
      this.movePhase += dt * (5.4 + hs * 0.85);
      this.stepAcc += hs * dt;
      if (this.stepAcc > 2.15) {
        this.stepAcc = 0;
        this.stepAlt = !this.stepAlt;
        this.onStep?.(this.stepAlt);
      }
    }

    // shake decay
    if (this.shakeAmp > 0.0003) {
      this.shakeT += dt * 34;
      this.shakeAmp *= Math.max(0, 1 - dt * 5.2);
    } else this.shakeAmp = 0;
  }

  private canStandUp(world: World): boolean {
    const hw = this.halfW;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);
    // check the band between the crouched top and the standing top
    const y0 = Math.floor(this.pos.y + this.crouchHeight);
    const y1 = Math.floor(this.pos.y + this.standHeight - 0.001);
    for (let x = minX; x <= maxX; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = minZ; z <= maxZ; z++)
          if (world.solid(x, y, z)) return false;
    return true;
  }

  private moveAxis(world: World, axis: 0 | 1 | 2, delta: number) {
    if (delta === 0) return;
    if (axis === 0) this.pos.x += delta;
    else if (axis === 1) this.pos.y += delta;
    else this.pos.z += delta;

    const hw = this.halfW, h = this.height;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minY = Math.floor(this.pos.y), maxY = Math.floor(this.pos.y + h - 0.001);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);

    for (let x = minX; x <= maxX; x++) for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) {
      if (!world.solid(x, y, z)) continue;
      if (axis === 0) {
        if (delta > 0) this.pos.x = x - hw - 0.001; else this.pos.x = x + 1 + hw + 0.001;
        this.vel.x = 0;
      } else if (axis === 2) {
        if (delta > 0) this.pos.z = z - hw - 0.001; else this.pos.z = z + 1 + hw + 0.001;
        this.vel.z = 0;
      } else {
        if (delta > 0) { this.pos.y = y - h - 0.001; this.vel.y = 0; }
        else { this.pos.y = y + 1 + 0.001; this.vel.y = 0; this.onGround = true; }
      }
    }
  }

  applyToCamera(cam: THREE.PerspectiveCamera, dt: number) {
    if (this.dying) { this.applyDeathCamera(cam); return; }
    // head bob
    const bobStrength = Math.min(1, this.speedSmooth / 5) * (this.onGround ? 1 : 0.2);
    const bobY = Math.sin(this.movePhase * 2) * 0.028 * bobStrength;
    const bobX = Math.cos(this.movePhase) * 0.015 * bobStrength;

    // eye height drops smoothly while crouching
    const eyeH = this.eye + (this.crouchEye - this.eye) * this.crouchAmt;
    cam.position.set(
      this.pos.x + Math.cos(this.yaw) * bobX,
      this.pos.y + eyeH + bobY + this.landDip.v,
      this.pos.z - Math.sin(this.yaw) * bobX
    );

    let shakeP = 0, shakeY = 0, shakeR = 0;
    if (this.shakeAmp > 0) {
      const t = this.shakeT + this.shakeSeed;
      shakeP = (Math.sin(t * 1.9) + Math.sin(t * 4.7) * 0.5) * this.shakeAmp;
      shakeY = (Math.cos(t * 2.3) + Math.sin(t * 3.9) * 0.5) * this.shakeAmp;
      shakeR = Math.sin(t * 5.3) * this.shakeAmp * 0.7;
    }

    cam.rotation.order = 'YXZ';
    cam.rotation.set(
      this.pitch + this.recoilP.v + shakeP,
      this.yaw + this.recoilY.v + shakeY,
      shakeR
    );

    // subtle strafe roll
    const strafe = THREE.MathUtils.clamp(this.vel.x * Math.cos(this.yaw) - this.vel.z * Math.sin(this.yaw), -7, 7);
    cam.rotation.z += -strafe * 0.004;
    void dt;
  }

  /**
   * Death camera: an impact jolt, knees buckling, the body toppling onto its
   * side with the head arcing over, a hard ground impact with rebound, then
   * a slow settle with fading twitches.
   */
  private applyDeathCamera(cam: THREE.PerspectiveCamera) {
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
    const eyeY = THREE.MathUtils.lerp(this.eye, GROUND_EYE, fall) + bounce * 0.055;

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
    if (this.shakeAmp > 0) {
      const st = this.shakeT + this.deathSeed;
      shakeP = Math.sin(st * 1.9) * this.shakeAmp;
      shakeY = Math.cos(st * 2.3) * this.shakeAmp;
      shakeR = Math.sin(st * 5.3) * this.shakeAmp * 0.8;
    }

    cam.rotation.order = 'YXZ';
    cam.rotation.set(pitch + twitchP + shakeP, yaw + shakeY, roll + twitchR + shakeR);
  }
}
