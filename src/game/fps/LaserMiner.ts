/**
 * Laser Miner — an automated mining turret sitting on top of a placed machine
 * block.
 *
 * The block itself is part of the static chunk mesh (see world/mesher.ts); the
 * TURRET is a dynamic articulated rig managed here: a mount yoke, a pivoting
 * gun body with a dark vented top, and a barrel that fires an additive energy
 * beam (the same visual family as the hand-held LaserTool).
 *
 * Behaviour: the turret scans the cone of view IN FRONT (its facing direction,
 * widening with distance) for the nearest solid, breakable block. It swings its
 * barrel to aim, charges the beam, and when the block gives way it is mined —
 * the drop is sucked in and ejected right BEHIND the miner (where an inserter or
 * conveyor can carry it onward). It then re-targets the next block, chewing a
 * cone-shaped tunnel out of whatever it faces.
 *
 * Rigs are discovered by scanning the neighbourhood of the player (no engine
 * hooks needed: mined/blown-up machine blocks simply fail validation), and only
 * the nearest handful get live turrets + beams; the machine base keeps rendering
 * at any distance since it is part of the chunk geometry.
 */
import * as THREE from 'three';
import { laserMinerDir, isLaserMiner } from '../world/blocks';
import { wrapBlock, minImageF } from '../core/constants';

/** minimal window onto the voxel world */
type WorldView = { get(x: number, y: number, z: number): number };

export interface LaserMinerHooks {
  /** true when this block id is a solid, finite-hardness, mineable voxel */
  mineable(id: number): boolean;
  /** perform the actual break + effects; spawn the drop at dropPos (behind) */
  mine(wx: number, wy: number, wz: number, dropPos: THREE.Vector3): void;
}

// ---------------------------------------------------------------------------
// shared turret assets (voxel-style boxes)
// ---------------------------------------------------------------------------
const steelMat = new THREE.MeshLambertMaterial({ color: 0x9aa0a8 });
const darkMat = new THREE.MeshLambertMaterial({ color: 0x2c2f34 });
const yokeMat = new THREE.MeshLambertMaterial({ color: 0x54575c });
const ventMat = new THREE.MeshLambertMaterial({ color: 0x5c6068 });
const emitMat = new THREE.MeshBasicMaterial({ color: 0xff5a1e });

const UP = new THREE.Vector3(0, 1, 0);

/** small helper: box centred at (x,y,z) with size (w,h,d) */
function boxMesh(mat: THREE.Material, x: number, y: number, z: number, w: number, h: number, d: number): THREE.Mesh {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return new THREE.Mesh(g, mat);
}

// ---------------------------------------------------------------------------
// shared beam textures
// ---------------------------------------------------------------------------
let glowTex: THREE.CanvasTexture | null = null;
function getGlowTexture(): THREE.CanvasTexture {
  if (glowTex) return glowTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 1, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,224,190,0.8)');
  g.addColorStop(0.6, 'rgba(255,150,60,0.28)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  glowTex = new THREE.CanvasTexture(c);
  glowTex.colorSpace = THREE.SRGBColorSpace;
  return glowTex;
}

let beamTex: THREE.CanvasTexture | null = null;
function getBeamTexture(): THREE.CanvasTexture {
  if (beamTex) return beamTex;
  const w = 16, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const wave = 0.5 + 0.5 * Math.sin((y / h) * Math.PI * 8);
    const a = Math.floor((0.22 + 0.78 * wave * wave) * 255);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255; img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  beamTex = new THREE.CanvasTexture(c);
  beamTex.wrapS = beamTex.wrapT = THREE.RepeatWrapping;
  beamTex.repeat.set(1, 2.5);
  beamTex.colorSpace = THREE.SRGBColorSpace;
  return beamTex;
}

/** an additive energy beam (core + scrolling glow) plus an impact flare. */
class Beam {
  core: THREE.Mesh;
  glow: THREE.Mesh;
  impact: THREE.Sprite;
  private coreMat: THREE.MeshBasicMaterial;
  private glowMat: THREE.MeshBasicMaterial;
  private tex: THREE.CanvasTexture;
  private dir = new THREE.Vector3();
  private mid = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff3df, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.core = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 1, 6, 1, true), this.coreMat);
    this.tex = getBeamTexture();
    this.glowMat = new THREE.MeshBasicMaterial({
      map: this.tex, color: 0xff4416, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.glow = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 8, 1, true), this.glowMat);
    this.impact = new THREE.Sprite(new THREE.SpriteMaterial({
      map: getGlowTexture(), color: 0xff5a1e, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    for (const o of [this.core, this.glow, this.impact]) {
      o.visible = false;
      o.frustumCulled = false;
      o.renderOrder = 20;
      scene.add(o);
    }
  }

  setVisible(v: boolean): void {
    this.core.visible = this.glow.visible = this.impact.visible = v;
  }

  /** aim the beam from a to b; `charge` 0..1 drives glow intensity */
  aim(a: THREE.Vector3, b: THREE.Vector3, dt: number, charge: number, t: number): void {
    this.dir.copy(b).sub(a);
    const len = Math.max(0.001, this.dir.length());
    this.dir.divideScalar(len);
    this.mid.copy(a).add(b).multiplyScalar(0.5);
    this.q.setFromUnitVectors(UP, this.dir);
    const flick = 0.75 + 0.25 * Math.sin(t * 38);
    const w = 0.85 + 0.25 * flick;
    this.core.position.copy(this.mid); this.core.quaternion.copy(this.q);
    this.core.scale.set(w, len, w);
    this.glow.position.copy(this.mid); this.glow.quaternion.copy(this.q);
    this.glow.scale.set(w, len, w);
    this.tex.offset.y -= dt * 5;
    this.coreMat.opacity = 0.55 + 0.3 * flick + charge * 0.3;
    this.glowMat.opacity = 0.3 + 0.25 * flick;
    // impact flare grows with mining progress
    this.impact.position.copy(b);
    const s = 0.32 + charge * 0.5 + Math.sin(t * 29) * 0.05;
    this.impact.scale.setScalar(Math.max(0.02, s));
    this.impact.material.opacity = 0.55 + 0.35 * flick;
  }

  dispose(scene: THREE.Scene): void {
    for (const o of [this.core, this.glow, this.impact]) scene.remove(o);
  }
}

interface Turret {
  wx: number; y: number; wz: number;
  lastId: number;
  dir: [number, number];
  group: THREE.Group;
  yaw: THREE.Group;
  pitch: THREE.Group;
  tip: THREE.Object3D;
  beam: Beam;
  /** current target as block offsets from the miner block, or null */
  target: { ox: number; oy: number; oz: number } | null;
  charge: number;
  scanCd: number;
  curYaw: number;
  curPitch: number;
  fire: number; // 0..1 smoothed beam visibility
}

const SCAN_RADIUS = 26;
const PRUNE_RADIUS = 42;
const MAX_TURRETS = 12;
const RANGE = 6;         // blocks of reach in front
const MINE_TIME = 0.85;  // seconds to chew through one block

const tmpTip = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpDrop = new THREE.Vector3();

export class LaserMinerManager {
  private turrets = new Map<string, Turret>();
  private scanT = 0;
  private pruneT = 0;

  constructor(
    private scene: THREE.Scene,
    private world: WorldView,
    private hooks: LaserMinerHooks,
  ) {}

  /** local +X points forward; world dir for yaw θ is (cosθ, -sinθ) */
  private static yawFor(dx: number, dz: number): number {
    return Math.atan2(-dz, dx);
  }

  private buildTurret(wx: number, y: number, wz: number, id: number): Turret {
    const group = new THREE.Group();
    const yaw = new THREE.Group();
    const pitch = new THREE.Group();
    const tip = new THREE.Object3D();

    // mount yoke (two side cheeks) rising from the block top
    group.add(boxMesh(yokeMat, 0, 0.12, 0.14, 0.16, 0.24, 0.1));
    group.add(boxMesh(yokeMat, 0, 0.12, -0.14, 0.16, 0.24, 0.1));
    group.add(boxMesh(darkMat, 0, 0.05, 0, 0.24, 0.1, 0.34));

    // pivot lives at the top of the yoke
    yaw.position.set(0, 0.24, 0);
    yaw.add(pitch);
    group.add(yaw);

    // ---- gun assembly (forward = +X) ----
    pitch.add(boxMesh(steelMat, -0.02, 0, 0, 0.46, 0.28, 0.34)); // body
    pitch.add(boxMesh(darkMat, -0.05, 0.17, 0, 0.34, 0.08, 0.28)); // vented top
    pitch.add(boxMesh(ventMat, 0.0, 0.22, 0.07, 0.04, 0.03, 0.04)); // vents
    pitch.add(boxMesh(ventMat, 0.0, 0.22, 0.0, 0.04, 0.03, 0.04));
    pitch.add(boxMesh(ventMat, 0.0, 0.22, -0.07, 0.04, 0.03, 0.04));
    pitch.add(boxMesh(darkMat, -0.3, 0.08, 0, 0.16, 0.2, 0.24)); // rear cell
    pitch.add(boxMesh(steelMat, 0.28, 0.0, 0, 0.36, 0.16, 0.16)); // barrel
    pitch.add(boxMesh(darkMat, 0.52, 0.0, 0, 0.1, 0.2, 0.2)); // muzzle ring
    pitch.add(boxMesh(darkMat, 0.56, 0.0, 0, 0.08, 0.12, 0.12)); // inner barrel
    const emitter = boxMesh(emitMat, 0.6, 0.0, 0, 0.06, 0.1, 0.1); // glow tip
    pitch.add(emitter);
    tip.position.set(0.66, 0.0, 0);
    pitch.add(tip);

    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        o.frustumCulled = false;
      }
    });
    this.scene.add(group);

    const dir = laserMinerDir(id)!;
    const yawRest = LaserMinerManager.yawFor(dir[0], dir[1]);
    yaw.rotation.y = yawRest;
    return {
      wx, y, wz, lastId: id, dir,
      group, yaw, pitch, tip,
      beam: new Beam(this.scene),
      target: null, charge: 0, scanCd: 0,
      curYaw: yawRest, curPitch: 0, fire: 0,
    };
  }

  private destroyTurret(t: Turret): void {
    this.scene.remove(t.group);
    t.beam.dispose(this.scene);
  }

  /** scan the loaded cells around the player for un-tracked miners */
  private scan(px: number, py: number, pz: number): void {
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    for (let y = cy - 4; y <= cy + 4; y++) {
      for (let dx = -SCAN_RADIUS; dx <= SCAN_RADIUS; dx++) {
        for (let dz = -SCAN_RADIUS; dz <= SCAN_RADIUS; dz++) {
          if (dx * dx + dz * dz > SCAN_RADIUS * SCAN_RADIUS) continue;
          const wx = wrapBlock(cx + dx);
          const wz = wrapBlock(cz + dz);
          const id = this.world.get(wx, y, wz);
          if (id < 0 || !isLaserMiner(id)) continue;
          const key = `${wx},${y},${wz}`;
          if (!this.turrets.has(key)) this.turrets.set(key, this.buildTurret(wx, y, wz, id));
        }
      }
    }
  }

  /** find the nearest mineable block in the forward cone; store as offsets */
  private acquire(t: Turret): void {
    const [fx, fz] = t.dir;
    const lx = -fz, lz = fx; // lateral axis
    let best: { ox: number; oy: number; oz: number } | null = null;
    let bestScore = Infinity;
    for (let step = 1; step <= RANGE; step++) {
      const spread = Math.min(2, Math.round((step - 1) * 0.5));
      for (let lat = -spread; lat <= spread; lat++) {
        for (let vert = -spread; vert <= spread; vert++) {
          const ox = fx * step + lx * lat;
          const oz = fz * step + lz * lat;
          const oy = vert;
          const id = this.world.get(wrapBlock(t.wx + ox), t.y + oy, wrapBlock(t.wz + oz));
          if (id < 0 || !this.hooks.mineable(id)) continue;
          const score = step * 10 + Math.abs(lat) * 2 + Math.abs(vert) * 2;
          if (score < bestScore) { bestScore = score; best = { ox, oy, oz }; }
        }
      }
    }
    t.target = best;
    t.charge = 0;
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;

    this.scanT -= dt;
    if (this.scanT <= 0) { this.scanT = 0.5; this.scan(px, py, pz); }

    this.pruneT -= dt * this.turrets.size;
    const pruneNow = this.pruneT <= 0;
    if (pruneNow) this.pruneT = this.turrets.size;

    let live = 0;
    for (const [key, t] of this.turrets) {
      const ix = px + minImageF(t.wx - px);
      const iz = pz + minImageF(t.wz - pz);
      const id = this.world.get(t.wx, t.y, t.wz);

      // destroyed (mined / exploded) → drop the rig immediately
      if (id >= 0 && !isLaserMiner(id)) {
        this.destroyTurret(t);
        this.turrets.delete(key);
        continue;
      }
      if (id < 0 && pruneNow && Math.hypot(ix - px, iz - pz) > PRUNE_RADIUS) {
        this.destroyTurret(t);
        this.turrets.delete(key);
        continue;
      }

      const far = id < 0 || Math.hypot(ix - px, iz - pz) > SCAN_RADIUS || live >= MAX_TURRETS;
      if (far) {
        t.group.visible = false;
        t.beam.setVisible(false);
        continue;
      }
      live++;
      t.group.visible = true;

      // rotated with E → re-read facing, drop any target
      if (id >= 0 && id !== t.lastId) {
        t.lastId = id;
        const d = laserMinerDir(id);
        if (d) t.dir = d;
        t.target = null;
        t.charge = 0;
      }

      this.tickTurret(t, ix, iz, dt);
    }
  }

  private tickTurret(t: Turret, ix: number, iz: number, dt: number): void {
    t.group.position.set(ix + 0.5, t.y + 1.0, iz + 0.5);

    // validate / acquire a target
    if (t.target) {
      const id = this.world.get(
        wrapBlock(t.wx + t.target.ox), t.y + t.target.oy, wrapBlock(t.wz + t.target.oz));
      if (id < 0 || !this.hooks.mineable(id)) { t.target = null; t.charge = 0; }
    }
    if (!t.target) {
      t.scanCd -= dt;
      if (t.scanCd <= 0) { t.scanCd = 0.2; this.acquire(t); }
    }

    const time = performance.now() * 0.001;
    const pivotY = t.y + 1.24;

    if (t.target) {
      // aim at the target block centre
      const targetX = ix + 0.5 + t.target.ox;
      const targetY = t.y + 0.5 + t.target.oy;
      const targetZ = iz + 0.5 + t.target.oz;
      const dx = targetX - (ix + 0.5);
      const dz = targetZ - (iz + 0.5);
      const dy = targetY - pivotY;
      const horiz = Math.hypot(dx, dz);
      const yawWant = LaserMinerManager.yawFor(dx, dz);
      const pitchWant = Math.atan2(dy, Math.max(0.05, horiz));
      // shortest-path yaw lerp
      let dYaw = yawWant - t.curYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      t.curYaw += dYaw * Math.min(1, 10 * dt);
      t.curPitch += (pitchWant - t.curPitch) * Math.min(1, 10 * dt);

      // charge up once roughly aimed
      const aimed = Math.abs(dYaw) < 0.25;
      if (aimed) t.charge = Math.min(1, t.charge + dt / MINE_TIME);
      t.fire += ((aimed ? 1 : 0) - t.fire) * Math.min(1, 14 * dt);

      // beam from muzzle tip to the block
      t.yaw.rotation.y = t.curYaw;
      t.pitch.rotation.z = t.curPitch;
      t.tip.getWorldPosition(tmpTip);
      tmpTarget.set(
        targetX + Math.sin(time * 57) * 0.02,
        targetY + Math.cos(time * 49) * 0.02,
        targetZ,
      );
      const show = t.fire > 0.05;
      t.beam.setVisible(show);
      if (show) t.beam.aim(tmpTip, tmpTarget, dt, t.charge, time);

      // mined!
      if (t.charge >= 1) {
        const wx = wrapBlock(t.wx + t.target.ox);
        const wy = t.y + t.target.oy;
        const wz = wrapBlock(t.wz + t.target.oz);
        // eject the drop right behind the miner
        tmpDrop.set(ix + 0.5 - t.dir[0], t.y + 1.1, iz + 0.5 - t.dir[1]);
        this.hooks.mine(wx, wy, wz, tmpDrop);
        t.target = null;
        t.charge = 0;
        t.scanCd = 0.05;
      }
    } else {
      // idle: gentle scanning sweep, beam off
      const yawRest = LaserMinerManager.yawFor(t.dir[0], t.dir[1]) + Math.sin(time * 0.8) * 0.35;
      let dYaw = yawRest - t.curYaw;
      while (dYaw > Math.PI) dYaw -= Math.PI * 2;
      while (dYaw < -Math.PI) dYaw += Math.PI * 2;
      t.curYaw += dYaw * Math.min(1, 4 * dt);
      t.curPitch += (-0.05 + Math.sin(time * 1.3) * 0.06 - t.curPitch) * Math.min(1, 4 * dt);
      t.fire += (0 - t.fire) * Math.min(1, 14 * dt);
      t.yaw.rotation.y = t.curYaw;
      t.pitch.rotation.z = t.curPitch;
      t.beam.setVisible(false);
    }
  }

  clear(): void {
    for (const t of this.turrets.values()) this.destroyTurret(t);
    this.turrets.clear();
  }
}
