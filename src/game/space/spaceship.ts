import * as THREE from 'three';
import type { Particles } from './particles';
import type { Frame, Vec3d } from './rng';

export interface FlightInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  boost: boolean;
}

export interface Collider {
  pos: Vec3d;
  radius: number;
}

interface Part {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  c: number;
}

function buildInstanced(parts: Part[], material: THREE.Material): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, material, parts.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < parts.length; i++) {
    const b = parts[i];
    p.set(b.x, b.y, b.z);
    s.set(b.w, b.h, b.d);
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    col.setHex(b.c);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  return mesh;
}


const STEEL = 0x9aa4ae;
const STEEL_HI = 0xc9d1d9;
const HULL_DARK = 0x39404a;
const HAZARD = 0xe0a53c;
const CANOPY = 0x4fd8ec;
const GLOW = 0xffffff;

const UP_AXIS = new THREE.Vector3(0, 1, 0);

const HULL_PARTS: Part[] = [
  { x: 0, y: 1.0, z: -0.2, w: 1.6, h: 0.9, d: 5.2, c: STEEL },
  { x: 0, y: 1.05, z: -3.1, w: 1.4, h: 0.7, d: 1.1, c: STEEL_HI },
  { x: 0, y: 1.0, z: -3.9, w: 0.85, h: 0.55, d: 0.8, c: STEEL_HI },
  { x: 0, y: 0.55, z: 0.1, w: 1.1, h: 0.5, d: 3.6, c: HULL_DARK },
  { x: 0, y: 1.56, z: -1.35, w: 1.5, h: 0.45, d: 1.5, c: HULL_DARK },
  { x: -1.95, y: 0.92, z: 0.3, w: 2.4, h: 0.26, d: 1.7, c: STEEL },
  { x: -3.15, y: 0.92, z: 1.05, w: 1.5, h: 0.24, d: 1.0, c: STEEL_HI },
  { x: 1.95, y: 0.92, z: 0.3, w: 2.4, h: 0.26, d: 1.7, c: STEEL },
  { x: 3.15, y: 0.92, z: 1.05, w: 1.5, h: 0.24, d: 1.0, c: STEEL_HI },
  { x: -2.9, y: 1.08, z: 0.15, w: 0.9, h: 0.12, d: 0.9, c: HAZARD },
  { x: 2.9, y: 1.08, z: 0.15, w: 0.9, h: 0.12, d: 0.9, c: HAZARD },
  { x: 0, y: 1.85, z: 1.95, w: 0.24, h: 1.5, d: 1.1, c: STEEL },
  { x: 0, y: 2.4, z: 2.15, w: 0.24, h: 0.5, d: 0.6, c: HAZARD },
  { x: -1.15, y: 0.95, z: 2.35, w: 0.95, h: 0.85, d: 1.7, c: HULL_DARK },
  { x: 1.15, y: 0.95, z: 2.35, w: 0.95, h: 0.85, d: 1.7, c: HULL_DARK },
  { x: 0, y: 0.9, z: 2.85, w: 1.2, h: 0.95, d: 1.0, c: HULL_DARK },
  { x: -1.35, y: 0.25, z: -0.9, w: 0.18, h: 0.5, d: 0.18, c: HULL_DARK },
  { x: 1.35, y: 0.25, z: -0.9, w: 0.18, h: 0.5, d: 0.18, c: HULL_DARK },
  { x: -1.35, y: 0.25, z: 1.3, w: 0.18, h: 0.5, d: 0.18, c: HULL_DARK },
  { x: 1.35, y: 0.25, z: 1.3, w: 0.18, h: 0.5, d: 0.18, c: HULL_DARK },
  { x: -1.35, y: -0.02, z: -0.9, w: 0.34, h: 0.08, d: 0.34, c: STEEL_HI },
  { x: 1.35, y: -0.02, z: -0.9, w: 0.34, h: 0.08, d: 0.34, c: STEEL_HI },
  { x: -1.35, y: -0.02, z: 1.3, w: 0.34, h: 0.08, d: 0.34, c: STEEL_HI },
  { x: 1.35, y: -0.02, z: 1.3, w: 0.34, h: 0.08, d: 0.34, c: STEEL_HI },
];

const GLOW_PARTS: Part[] = [
  { x: 0, y: 1.62, z: -1.45, w: 1.1, h: 0.34, d: 1.0, c: CANOPY },
  { x: -1.15, y: 0.95, z: 3.25, w: 0.62, h: 0.5, d: 0.18, c: GLOW },
  { x: 1.15, y: 0.95, z: 3.25, w: 0.62, h: 0.5, d: 0.18, c: GLOW },
  { x: 0, y: 0.9, z: 3.42, w: 0.85, h: 0.6, d: 0.2, c: GLOW },
  { x: 0, y: 0.5, z: -2.2, w: 0.9, h: 0.12, d: 0.9, c: 0x6f8fd0 },
];

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
