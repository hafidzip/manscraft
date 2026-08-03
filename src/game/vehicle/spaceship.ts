/**
 * Spaceship — a fully working, driveable voxel vehicle.
 *
 * Lives in TRIP SPACE (unbounded continuous coordinates), like the camera:
 * terrain collision queries wrap internally, so it flies over the torus
 * seam with zero special cases.
 *
 * Model: instanced voxel boxes (steel hull, canopy, nacelles, hazard stripe)
 * with emissive engine cells, a point light, a trailing flame sprite and
 * blue exhaust particles fed from the shared particle pool.
 *
 * Flight model: look-steered thrust with inertia + damping, vertical
 * lift/descent, visual banking, soft hover bob when parked, and
 * axis-separated AABB collision against the voxel world.
 */

import * as THREE from 'three';
import { buildInstanced, type Part } from '../vfx/laserTool';
import type { Particles } from '../vfx/particles';
import type { World } from '../world/world';
import type { TerrainGenerator } from '../world/generator';
import type { SoundEngine } from '../audio/sound';

export interface FlightInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

// ---------------------------------------------------------------------------
// voxel model (local units = blocks; nose faces -z)
// ---------------------------------------------------------------------------

const STEEL = 0x9aa4ae;
const STEEL_HI = 0xc9d1d9;
const HULL_DARK = 0x39404a;
const HAZARD = 0xe0a53c;
const CANOPY = 0x4fd8ec;
const GLOW = 0xffffff;

const UP_AXIS = new THREE.Vector3(0, 1, 0);

const HULL_PARTS: Part[] = [
  // fuselage spine
  { x: 0, y: 1.0, z: -0.2, w: 1.6, h: 0.9, d: 5.2, c: STEEL },
  { x: 0, y: 1.05, z: -3.1, w: 1.4, h: 0.7, d: 1.1, c: STEEL_HI }, // nose step
  { x: 0, y: 1.0, z: -3.9, w: 0.85, h: 0.55, d: 0.8, c: STEEL_HI }, // cone tip
  { x: 0, y: 0.55, z: 0.1, w: 1.1, h: 0.5, d: 3.6, c: HULL_DARK }, // keel
  // cockpit
  { x: 0, y: 1.56, z: -1.35, w: 1.5, h: 0.45, d: 1.5, c: HULL_DARK }, // canopy frame
  // wings (sweep via staggered plates)
  { x: -1.95, y: 0.92, z: 0.3, w: 2.4, h: 0.26, d: 1.7, c: STEEL },
  { x: -3.15, y: 0.92, z: 1.05, w: 1.5, h: 0.24, d: 1.0, c: STEEL_HI },
  { x: 1.95, y: 0.92, z: 0.3, w: 2.4, h: 0.26, d: 1.7, c: STEEL },
  { x: 3.15, y: 0.92, z: 1.05, w: 1.5, h: 0.24, d: 1.0, c: STEEL_HI },
  { x: -2.9, y: 1.08, z: 0.15, w: 0.9, h: 0.12, d: 0.9, c: HAZARD }, // hazard stripes
  { x: 2.9, y: 1.08, z: 0.15, w: 0.9, h: 0.12, d: 0.9, c: HAZARD },
  // tail fin
  { x: 0, y: 1.85, z: 1.95, w: 0.24, h: 1.5, d: 1.1, c: STEEL },
  { x: 0, y: 2.4, z: 2.15, w: 0.24, h: 0.5, d: 0.6, c: HAZARD },
  // engine nacelles
  { x: -1.15, y: 0.95, z: 2.35, w: 0.95, h: 0.85, d: 1.7, c: HULL_DARK },
  { x: 1.15, y: 0.95, z: 2.35, w: 0.95, h: 0.85, d: 1.7, c: HULL_DARK },
  { x: 0, y: 0.9, z: 2.85, w: 1.2, h: 0.95, d: 1.0, c: HULL_DARK }, // center block
  // landing skids
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
  { x: 0, y: 1.62, z: -1.45, w: 1.1, h: 0.34, d: 1.0, c: CANOPY }, // canopy glass
  { x: -1.15, y: 0.95, z: 3.25, w: 0.62, h: 0.5, d: 0.18, c: GLOW }, // L nozzle
  { x: 1.15, y: 0.95, z: 3.25, w: 0.62, h: 0.5, d: 0.18, c: GLOW }, // R nozzle
  { x: 0, y: 0.9, z: 3.42, w: 0.85, h: 0.6, d: 0.2, c: GLOW }, // center nozzle
  { x: 0, y: 0.5, z: -2.2, w: 0.9, h: 0.12, d: 0.9, c: 0x6f8fd0 }, // belly lamp
];

const MAX_SPEED = 28;
const MAX_VSPEED = 13;
const ACCEL = 26; // throttle response rate
const VACCEL = 18;
const HX = 3.2, HY = 1.15, HZ = 3.5; // collision half extents (forgiving)

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
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0;
  private bank = 0;
  private pitchVis = 0; // smoothed visual nose pitch
  private flyPitch = 0; // smoothed thrust pitch (chases orbit pitch)
  private bobT = Math.random() * 10;
  private baseY = 0; // parked hover altitude (set by placeNear)
  private exhaustCd = 0;
  private load = 0; // smoothed engine load 0..1

  private glowMat = new THREE.MeshBasicMaterial();
  private flame: THREE.Sprite;
  private light: THREE.PointLight;
  private nozzle = new THREE.Object3D();

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private world: World,
    private particles: Particles
  ) {
    this.group.add(buildInstanced(HULL_PARTS, new THREE.MeshLambertMaterial()));
    this.group.add(buildInstanced(GLOW_PARTS, this.glowMat));
    this.nozzle.position.set(0, 0.9, 3.6);
    this.group.add(this.nozzle);

    this.flame = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeFlameTexture(), transparent: true, opacity: 0, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }));
    this.flame.position.set(0, 0.9, 3.8);
    this.group.add(this.flame);

    this.light = new THREE.PointLight(0x7fb2ff, 0, 14, 2);
    this.light.position.set(0, 1.2, 3.2);
    this.group.add(this.light);

    this.group.traverse((o) => (o.frustumCulled = false));
    scene.add(this.group);
  }

  /** finds a flat, dry pad near a point and parks the ship there */
  placeNear(gen: TerrainGenerator, cx: number, cz: number): void {
    let bx = cx + 7;
    let bz = cz + 3;
    let best = Infinity;
    for (let r = 5; r <= 26; r += 4) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const x = cx + Math.cos(a) * r;
        const z = cz + Math.sin(a) * r;
        const h00 = gen.heightAt(x - 2, z - 2);
        const h11 = gen.heightAt(x + 2, z + 2);
        const h10 = gen.heightAt(x - 2, z + 2);
        const h01 = gen.heightAt(x + 2, z - 2);
        const maxH = Math.max(h00, h11, h10, h01);
        const minH = Math.min(h00, h11, h10, h01);
        if (minH <= 31) continue; // water or beach
        const cost = (maxH - minH) * 4 + Math.abs(r - 10);
        if (cost < best) {
          best = cost;
          bx = x;
          bz = z;
          // collision-box floor is pos.y - 0.1; park ABOVE the tallest block
          // so the hull never starts embedded in terrain
          this.pos.set(bx, maxH + 1.25, bz);
          if (maxH - minH === 0) r = 99; // flat spot found
        }
      }
    }
    if (!isFinite(best)) {
      this.pos.set(cx + 7, gen.heightAt(cx + 7, cz + 3) + 1.25, cz + 3);
    }
    this.baseY = this.pos.y;
    this.yaw = Math.random() * Math.PI * 2;
    this.sync();
  }

  distanceTo(p: THREE.Vector3): number {
    return this.pos.distanceTo(p);
  }

  seatWorld(out: THREE.Vector3, lookPitch: number): THREE.Vector3 {
    out.set(0, 1.78, -0.8).applyAxisAngle(UP_AXIS, this.yaw);
    out.add(this.pos);
    out.y += Math.sin(-lookPitch) * 0.1; // tiny cockpit feel
    return out;
  }

  private sync(): void {
    this.group.position.copy(this.pos);
    this.group.rotation.set(this.pitchVis, this.yaw, this.bank, 'YXZ');
    // nudge flame along ship frame
    this.flame.scale.setScalar(0.6 + this.load * 2.6 + Math.sin(this.bobT * 31) * 0.12 * this.load);
  }

  /** parked: gentle hover bob + idle glow */
  updateParked(dt: number): void {
    this.bobT += dt;
    this.vel.set(0, 0, 0);
    this.pos.y = this.baseY + Math.sin(this.bobT * 1.05) * 0.09; // anchored hover
    this.load += (0.12 - this.load) * Math.min(1, dt * 2);
    const pulse = 0.5 + 0.12 * Math.sin(this.bobT * 3);
    this.glowMat.color.setRGB(0.4 * pulse + 0.2, 0.55 * pulse + 0.2, 0.7 * pulse + 0.25);
    this.light.intensity = 1.5 + Math.sin(this.bobT * 6) * 0.4;
    this.flame.material.opacity = 0.16 + 0.06 * Math.sin(this.bobT * 9);
    this.flame.scale.setScalar(0.5 + Math.sin(this.bobT * 7) * 0.05);
    this.group.position.copy(this.pos);
    this.group.rotation.set(0, this.yaw, 0);
  }

  /** piloted flight step: heading chases the orbit view (chase-cam friendly) */
  updatePilot(
    dt: number,
    orbitYaw: number,
    orbitPitch: number,
    inp: FlightInput,
    sound: SoundEngine
  ): void {
    this.bobT += dt;

    // ship heading chases camera orbit with lag -> weighty turns, visible banking
    let dyaw = orbitYaw - this.yaw;
    dyaw = ((dyaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    this.yaw += dyaw * Math.min(1, 5 * dt);
    this.flyPitch += (orbitPitch - this.flyPitch) * Math.min(1, 6 * dt);
    const targetPitchVis = this.flyPitch * 0.35;
    this.pitchVis += (targetPitchVis - this.pitchVis) * Math.min(1, 6 * dt);

    // thrust follows the SHIP heading (motion matches the hull)
    const cy = this.yaw;
    const cp = this.flyPitch;
    const fy = Math.sin(cp);
    const fx = -Math.sin(cy) * Math.cos(cp);
    const fz = -Math.cos(cy) * Math.cos(cp);
    const rx = Math.cos(cy);
    const rz = -Math.sin(cy);

    let ax = 0, ay = 0, az = 0;
    if (inp.forward) { ax += fx; ay += fy * 0.55; az += fz; }
    if (inp.back) { ax -= fx * 0.6; az -= fz * 0.6; }
    if (inp.right) { ax += rx * 0.55; az += rz * 0.55; }
    if (inp.left) { ax -= rx * 0.55; az -= rz * 0.55; }
    if (inp.up) ay += 1;
    if (inp.down) ay -= 1;

    const hLen = Math.hypot(ax, az);
    if (hLen > 1) { ax /= hLen; az /= hLen; }

    // inertia: exponential approach, with damping when no input
    this.vel.x += (ax * MAX_SPEED - this.vel.x) * Math.min(1, (ax === 0 ? 2.2 : ACCEL / MAX_SPEED * 4) * dt);
    this.vel.z += (az * MAX_SPEED - this.vel.z) * Math.min(1, (az === 0 ? 2.2 : ACCEL / MAX_SPEED * 4) * dt);
    this.vel.y += (ay * MAX_VSPEED - this.vel.y) * Math.min(1, (ay === 0 ? 3.2 : VACCEL / MAX_VSPEED * 5) * dt);

    // banking from lateral speed
    const lat = this.vel.x * rx + this.vel.z * rz;
    const targetBank = THREE.MathUtils.clamp(-lat * 0.02, -0.45, 0.45);
    this.bank += (targetBank - this.bank) * Math.min(1, 5 * dt);

    // axis-separated collision (never clip terrain)
    this.moveAxis(0, this.vel.x * dt);
    this.moveAxis(1, this.vel.y * dt);
    this.moveAxis(2, this.vel.z * dt);
    if (this.pos.y < 2) { this.pos.y = 2; this.vel.y = Math.max(0, this.vel.y); }
    if (this.pos.y > 420) { this.pos.y = 420; this.vel.y = Math.min(0, this.vel.y); } // climb into orbit

    // engine load + FX
    const spd = this.speed();
    const loadTarget = Math.min(1, spd / MAX_SPEED + (ay !== 0 ? 0.15 : 0));
    this.load += (loadTarget - this.load) * Math.min(1, 4 * dt);
    sound.setShip(this.load, spd);

    this.glowMat.color.setRGB(0.35 + 0.65 * this.load, 0.62 + 0.3 * this.load, 0.85);
    this.light.intensity = 2 + this.load * 10 + Math.sin(this.bobT * 37) * this.load * 2;

    this.flame.material.opacity = 0.25 + this.load * 0.7 + Math.sin(this.bobT * 41) * 0.08;
    const fScale = 0.5 + this.load * 2.4 + Math.sin(this.bobT * 33) * 0.15 * this.load;
    this.flame.scale.setScalar(Math.max(0.01, fScale));

    // exhaust particles out the nozzle
    this.exhaustCd -= dt;
    if (this.load > 0.15 && this.exhaustCd <= 0) {
      this.exhaustCd = 0.06;
      this.nozzle.getWorldPosition(this.tmpA);
      this.tmpB.set(Math.sin(this.yaw), 0, Math.cos(this.yaw)); // rearward drift
      this.particles.burst(
        this.tmpA.x + this.tmpB.x * 0.4, this.tmpA.y, this.tmpA.z + this.tmpB.z * 0.4,
        [0x9fd4ff, 0x5e94e8, 0xd8ecff, 0x3f6fd0],
        2 + Math.floor(this.load * 3), 1.4
      );
    }

    this.sync();
  }

  private collides(): boolean {
    const x0 = Math.floor(this.pos.x - HX);
    const x1 = Math.floor(this.pos.x + HX);
    const y0 = Math.floor(this.pos.y - 0.1);
    const y1 = Math.floor(this.pos.y + HY);
    const z0 = Math.floor(this.pos.z - HZ);
    const z1 = Math.floor(this.pos.z + HZ);
    for (let x = x0; x <= x1; x++)
      for (let y = y0; y <= y1; y++)
        for (let z = z0; z <= z1; z++)
          if (this.world.isSolid(x, y, z)) return true;
    return false;
  }

  private moveAxis(axis: 0 | 1 | 2, d: number): void {
    if (d === 0) return;
    const EPS = 0.02;
    if (axis === 0) {
      this.pos.x += d;
      if (this.collides()) {
        // flush-snap to the face we hit — never wedges, shake-free stops
        this.pos.x = d > 0
          ? Math.floor(this.pos.x + HX) - HX - EPS
          : Math.floor(this.pos.x - HX) + 1 + HX + EPS;
        this.vel.x = 0;
      }
      return;
    }
    if (axis === 2) {
      this.pos.z += d;
      if (this.collides()) {
        this.pos.z = d > 0
          ? Math.floor(this.pos.z + HZ) - HZ - EPS
          : Math.floor(this.pos.z - HZ) + 1 + HZ + EPS;
        this.vel.z = 0;
      }
      return;
    }
    // y axis: box spans [pos.y - 0.1, pos.y + HY]
    this.pos.y += d;
    if (!this.collides()) return;
    this.pos.y = d > 0
      ? Math.floor(this.pos.y + HY) - HY - EPS
      : Math.floor(this.pos.y - 0.1) + 1 + 0.1 + EPS;
    this.vel.y = 0;
    if (d < 0) {
      // landing: remember the touch-down plane (harmless if airborne)
      this.baseY = this.pos.y;
    }
  }

  speed(): number {
    return this.vel.length();
  }

  get bankAngle(): number {
    return this.bank;
  }
}
