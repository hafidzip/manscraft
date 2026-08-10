import * as THREE from 'three';
import { buildInstanced } from '../vfx/laserTool';
import { HULL_PARTS, GLOW_PARTS } from '../vehicle/hullParts';
import type { Particles } from './particles';
import type { Frame, Vec3d } from './rng';

export interface FlightInput {
  forward: boolean; back: boolean; left: boolean; right: boolean;
  up: boolean; down: boolean; boost: boolean;
}

export interface Collider { pos: Vec3d; radius: number }

const UP_AXIS = new THREE.Vector3(0, 1, 0);

const MAX_SPEED = 60;
const BOOST_SPEED = 160;
const ACCEL = 2.2;

function makeFlameTexture(): THREE.CanvasTexture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.3, 'rgba(140,200,255,0.75)');
  g.addColorStop(0.7, 'rgba(60,120,255,0.22)');
  g.addColorStop(1, 'rgba(40,80,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Spaceship {
  readonly group = new THREE.Group();
  pos: Vec3d = { x: 0, y: 0, z: 0 };
  vel: Vec3d = { x: 0, y: 0, z: 0 };
  readonly quat = new THREE.Quaternion();
  yaw = 0;
  pitch = 0;
  private bank = 0;
  private bobT = Math.random() * 10;
  private exhaustCd = 0;
  private load = 0;

  private glowMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  private flame: THREE.Sprite;
  private light: THREE.PointLight;
  private nozzle = new THREE.Object3D();

  private tmpA = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();
  private tmpQ2 = new THREE.Quaternion();

  constructor(scene: THREE.Scene, private particles: Particles) {
    this.group.add(buildInstanced(HULL_PARTS, new THREE.MeshLambertMaterial()));
    this.group.add(buildInstanced(GLOW_PARTS, this.glowMat));
    this.nozzle.position.set(0, 0.9, 3.6);
    this.group.add(this.nozzle);

    this.flame = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeFlameTexture(),
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.flame.position.set(0, 0.9, 3.8);
    this.group.add(this.flame);

    this.light = new THREE.PointLight(0x7fb2ff, 2, 26, 2);
    this.light.position.set(0, 1.2, 3.2);
    this.group.add(this.light);

    this.group.traverse((o) => (o.frustumCulled = false));
    scene.add(this.group);
  }

  place(x: number, y: number, z: number) {
    this.pos = { x, y, z };
    this.vel = { x: 0, y: 0, z: 0 };
  }

  syncRender(frame: Frame) {
    const [x, y, z] = frame.toRender(this.pos);
    this.group.position.set(x, y, z);
    this.group.quaternion.copy(this.quat);
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.quat);
  }

  speed(): number {
    return Math.hypot(this.vel.x, this.vel.y, this.vel.z);
  }

  resolveColliders(dt: number, colliders: Iterable<Collider>) {
    for (const c of colliders) {
      const dx = this.pos.x - c.pos.x;
      const dy = this.pos.y - c.pos.y;
      const dz = this.pos.z - c.pos.z;
      const d = Math.hypot(dx, dy, dz) || 1e-6;
      const minR = c.radius + 8;
      if (d > minR) continue;
      const nx = dx / d;
      const ny = dy / d;
      const nz = dz / d;
      const push = minR - d + 0.2;
      this.pos.x += nx * push;
      this.pos.y += ny * push;
      this.pos.z += nz * push;
      const vn =
        this.vel.x * nx + this.vel.y * ny + this.vel.z * nz;
      if (vn < 0) {
        const bounce = 0.2;
        this.vel.x -= (1 + bounce) * vn * nx;
        this.vel.y -= (1 + bounce) * vn * ny;
        this.vel.z -= (1 + bounce) * vn * nz;
        this.vel.x *= 0.9;
        this.vel.y *= 0.9;
        this.vel.z *= 0.9;
      }
      void dt;
    }
  }

  update(dt: number, inp: FlightInput) {
    this.bobT += dt;

    this.tmpQ.setFromAxisAngle(UP_AXIS, this.yaw);
    this.tmpQ2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.pitch);
    this.quat.copy(this.tmpQ).multiply(this.tmpQ2);
    const targetBank = (inp.left ? 0.5 : 0) - (inp.right ? 0.5 : 0);
    this.bank += (targetBank - this.bank) * Math.min(1, 6 * dt);
    this.tmpQ2.setFromAxisAngle(new THREE.Vector3(0, 0, 1), this.bank);
    this.quat.multiply(this.tmpQ2);

    const maxSpd = inp.boost ? BOOST_SPEED : MAX_SPEED;
    const cy = this.yaw, cp = this.pitch;
    const fx = -Math.sin(cy) * Math.cos(cp);
    const fy = Math.sin(cp);
    const fz = -Math.cos(cy) * Math.cos(cp);
    const rx = Math.cos(cy);
    const rz = -Math.sin(cy);

    let tx = 0, ty = 0, tz = 0;
    if (inp.forward) { tx += fx * maxSpd; ty += fy * maxSpd * 0.9; tz += fz * maxSpd; }
    if (inp.back) { tx -= fx * maxSpd * 0.5; ty -= fy * maxSpd * 0.5; tz -= fz * maxSpd * 0.5; }
    if (inp.right) { tx += rx * maxSpd * 0.5; tz += rz * maxSpd * 0.5; }
    if (inp.left) { tx -= rx * maxSpd * 0.5; tz -= rz * maxSpd * 0.5; }
    if (inp.up) ty += maxSpd * 0.7;
    if (inp.down) ty -= maxSpd * 0.7;

    const thrusting = inp.forward || inp.back || inp.left || inp.right || inp.up || inp.down;
    const k = Math.min(1, (thrusting ? ACCEL : 0.6) * dt);
    this.vel.x += (tx - this.vel.x) * k;
    this.vel.y += (ty - this.vel.y) * k;
    this.vel.z += (tz - this.vel.z) * k;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;

    const spd = this.speed();
    const loadTarget = Math.min(1, spd / MAX_SPEED + (inp.boost ? 0.4 : 0));
    this.load += (loadTarget - this.load) * Math.min(1, 4 * dt);

    this.glowMat.color.setRGB(
      0.35 + 0.65 * this.load + (inp.boost ? 0.3 : 0),
      0.62 + 0.3 * this.load,
      0.85 + (inp.boost ? 0.15 : 0)
    );
    this.light.intensity = 2 + this.load * 12 + Math.sin(this.bobT * 37) * this.load * 2;
    this.light.color.setHex(inp.boost ? 0xff8a5a : 0x7fb2ff);

    this.flame.material.opacity = 0.25 + this.load * 0.7 + Math.sin(this.bobT * 41) * 0.08;
    const fScale =
      0.6 + this.load * (inp.boost ? 5 : 2.6) + Math.sin(this.bobT * 33) * 0.15 * this.load;
    this.flame.scale.setScalar(Math.max(0.01, fScale));
    (this.flame.material as THREE.SpriteMaterial).color.setHex(inp.boost ? 0xffb070 : 0xffffff);

    this.exhaustCd -= dt;
    if (this.load > 0.12 && this.exhaustCd <= 0) {
      this.exhaustCd = 0.04;
      this.nozzle.getWorldPosition(this.tmpA);
      const cols = inp.boost
        ? [0xffd090, 0xff9a50, 0xffe8c0, 0xff7030]
        : [0x9fd4ff, 0x5e94e8, 0xd8ecff, 0x3f6fd0];
      this.particles.burst(
        this.tmpA.x,
        this.tmpA.y,
        this.tmpA.z,
        cols,
        2 + Math.floor(this.load * 4),
        1.0
      );
    }
  }
}
