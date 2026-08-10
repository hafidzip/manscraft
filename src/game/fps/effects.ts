import * as THREE from 'three';
import { muzzleTexture, holeTexture, smokeTexture, pixelTexture } from './textures';
import { BLOCK_COLORS, B, type WorldLike } from './World';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

interface Particle {
  mesh: THREE.Mesh; vel: THREE.Vector3; rotVel: THREE.Vector3;
  life: number; maxLife: number; gravity: number; bounce: boolean; grow: number;
}

interface CasE { mesh: THREE.Mesh; vel: THREE.Vector3; rotVel: THREE.Vector3; life: number; grounded: boolean }

interface PooledDecal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }

interface Decal extends PooledDecal {
  life: number;
  age: number;
  size: number;
  bx: number; by: number; bz: number;
  nx: number; ny: number; nz: number;
  axis: number; sign: number;
  dying: boolean;
}

const MAX_DECALS = 140;
const DECAL_CULL_DIST = 72;
const DECAL_LIFE = 28;
const DECAL_FADE = 3.5;
const DECAL_DEATH_FADE = 0.16;

const DECAL_FORWARD = new THREE.Vector3(0, 0, 1);
const tmpQuatV = new THREE.Vector3();
const tmpColor = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

export class Effects {
  private scene: THREE.Scene;
  private world: WorldLike;

  private particles: Particle[] = [];
  private particlePool: THREE.Mesh[] = [];
  private particleMats = new Map<number, THREE.MeshBasicMaterial>();
  private particleGeo = new THREE.BoxGeometry(1, 1, 1);

  private casings: CasE[] = [];
  private casingPool: THREE.Mesh[] = [];
  private casingMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#d8b345', 30, 8, 21) });
  private casingGeo = new THREE.BoxGeometry(0.012, 0.012, 0.026);

  private tracers: { mesh: THREE.Mesh; life: number; anchor: THREE.Object3D | null; end: THREE.Vector3 }[] = [];
  private tracerPool: THREE.Mesh[] = [];
  private tracerMat = new THREE.MeshBasicMaterial({ color: '#ffe9a8', transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
  private tracerGeo = new THREE.BoxGeometry(0.014, 0.014, 1);

  private decals: Decal[] = [];
  private decalPool: PooledDecal[] = [];
  private decalGeo = new THREE.PlaneGeometry(1, 1);
  private holeTexes: THREE.Texture[] = [];
  private decalSeq = 0;

  private smokes: { sprite: THREE.Sprite; vel: THREE.Vector3; life: number; max: number; grow: number }[] = [];
  private smokePool: THREE.Sprite[] = [];
  private smokeMatBase: THREE.SpriteMaterial;

  private flashTex: THREE.Texture;
  flashLight: THREE.PointLight;
  private flashT = 0;
  private flashSprites: THREE.Sprite[] = [];
  private flashAnchor: THREE.Object3D | null = null;
  private flashIntensity = 3.2;

  private rocket: { mesh: THREE.Group; vel: THREE.Vector3; life: number } | null = null;
  private rocketTemplate: THREE.Group | null = null;
  private onExplode: (pos: THREE.Vector3) => void;
  private playerPos: THREE.Vector3;

  constructor(scene: THREE.Scene, world: WorldLike, playerPos: THREE.Vector3, onExplode: (pos: THREE.Vector3) => void) {
    this.scene = scene;
    this.world = world;
    this.playerPos = playerPos;
    this.onExplode = onExplode;
    this.flashTex = muzzleTexture();
    this.holeTexes = [holeTexture(3), holeTexture(17), holeTexture(41), holeTexture(88), holeTexture(131)];
    this.smokeMatBase = new THREE.SpriteMaterial({ map: smokeTexture(), transparent: true, opacity: 0.55, depthWrite: false });
    this.flashLight = new THREE.PointLight(0xffc36b, 0, 9, 2);
    scene.add(this.flashLight);
    for (let i = 0; i < 2; i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, rotation: Math.random() * 3 }));
      s.visible = false;
      s.renderOrder = 20;
      scene.add(s);
      this.flashSprites.push(s);
    }
  }

  prewarm(colors: Iterable<number>): void {
    for (const color of colors) this.particleMaterial(color);
    while (this.particlePool.length < 96) this.particlePool.push(new THREE.Mesh(this.particleGeo));
    while (this.casingPool.length < 24) this.casingPool.push(new THREE.Mesh(this.casingGeo, this.casingMat));
    while (this.tracerPool.length < 24) this.tracerPool.push(new THREE.Mesh(this.tracerGeo, this.tracerMat));
    while (this.smokePool.length < 32) this.smokePool.push(new THREE.Sprite(this.smokeMatBase.clone()));
    while (this.decalPool.length < 48) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, depthTest: true,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.decalGeo, mat);
      mesh.renderOrder = 6;
      this.decalPool.push({ mesh, mat });
    }
    this.rocketTemplate = this.makeRocketModel();
  }

  /**
   * Spawn one live instance of EVERY effect type so a full-pipeline render
   * during the loading screen compiles all their shader program variants
   * (tracer/casing/decal/smoke/muzzle/particle/flash-light). Otherwise those
   * programs compile mid-game on the first shot + subsequent weapon swap,
   * causing a multi-second freeze. Call `endWarmup()` after rendering.
   */
  beginWarmup(colors: Iterable<number>): void {
    const base = tmpV.set(0, -600, 0); // far below the world; never visible
    // Muzzle flash sprites + flash light
    this.muzzleFlash(base.clone(), 1);
    // Tracer
    this.tracer(base.clone(), base.clone().add(new THREE.Vector3(0, 0, 1)));
    // Casing
    this.casing(base.clone(), new THREE.Vector3(1, 0, 0), true);
    // Smoke puff
    this.puff(base.clone(), new THREE.Vector3(0, 1, 0), 0.4, 999, '#ffffff');
    // Particles (one per distinct color so every particle material compiles)
    for (const c of colors) {
      this.spawnParticle(base.clone(), new THREE.Vector3(0, 0, 0), c, 0.05, 999, false);
    }
    // Decal (force-create one bypassing the world air check)
    this.forceWarmDecal(base.clone());
    // Keep them alive through the warmup render(s)
    this.flashT = 999;
  }

  /** Force a decal into the scene for warmup, ignoring the world-air guard. */
  private forceWarmDecal(point: THREE.Vector3): void {
    let e = this.decalPool.pop();
    if (!e) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true, depthWrite: false, depthTest: true,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
        side: THREE.DoubleSide, toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.decalGeo, mat);
      mesh.renderOrder = 6;
      e = { mesh, mat };
    }
    e.mat.map = this.holeTexes[0];
    e.mat.color.set(0xffffff);
    e.mat.opacity = 1;
    e.mat.needsUpdate = true;
    e.mesh.position.copy(point);
    e.mesh.scale.set(0.125, 0.125, 1);
    e.mesh.visible = true;
    this.scene.add(e.mesh);
    this.decals.push({
      mesh: e.mesh, mat: e.mat,
      life: DECAL_LIFE, age: 0, size: 0.125,
      bx: 0, by: -600, bz: 0, nx: 0, ny: 1, nz: 0, axis: 1, sign: 1,
      dying: false,
    });
  }

  /** Remove every transient effect spawned by beginWarmup(). */
  endWarmup(): void {
    this.flashT = 0;
    for (const s of this.flashSprites) s.visible = false;
    this.flashLight.intensity = 0;
    this.flashAnchor = null;

    for (const p of this.particles) { this.scene.remove(p.mesh); this.particlePool.push(p.mesh); }
    this.particles.length = 0;
    for (const c of this.casings) { this.scene.remove(c.mesh); this.casingPool.push(c.mesh); }
    this.casings.length = 0;
    for (const t of this.tracers) { this.scene.remove(t.mesh); this.tracerPool.push(t.mesh); }
    this.tracers.length = 0;
    for (const s of this.smokes) { this.scene.remove(s.sprite); this.smokePool.push(s.sprite); }
    this.smokes.length = 0;
    this.clearDecals();
  }

  muzzleFlash(pos: THREE.Vector3, scale = 1, anchor?: THREE.Object3D) {
    this.flashT = 0.045;
    this.flashAnchor = anchor ?? null;
    this.flashIntensity = 3.2 * scale;

    // IMPORTANT: never re-parent the PointLight into a weapon rig. If the light
    // lives inside a rig that later gets hidden/stowed on weapon swap, three.js
    // sees the scene light count change and recompiles EVERY material's shader
    // program synchronously -> multi-second freeze. Keep it in the scene
    // permanently and just follow the anchor's world position instead.
    if (this.flashLight.parent !== this.scene) this.scene.add(this.flashLight);
    if (anchor) {
      anchor.updateWorldMatrix(true, false);
      this.flashLight.position.setFromMatrixPosition(anchor.matrixWorld);
    } else {
      this.flashLight.position.copy(pos);
    }
    this.flashLight.intensity = this.flashIntensity;

    for (const s of this.flashSprites) {
      if (anchor) {
        if (s.parent !== anchor) anchor.add(s);
        s.position.set((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, 0);
      } else {
        if (s.parent !== this.scene) this.scene.add(s);
        s.position.copy(pos).add(tmpV.set((Math.random() - 0.5) * 0.02, (Math.random() - 0.5) * 0.02, 0));
      }
      s.scale.setScalar((0.06 + Math.random() * 0.05) * scale);
      s.material.rotation = Math.random() * Math.PI * 2;
      s.material.opacity = 1;
      s.visible = true;
    }
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, anchor?: THREE.Object3D) {
    let m = this.tracerPool.pop();
    if (!m) m = new THREE.Mesh(this.tracerGeo, this.tracerMat);
    const len = from.distanceTo(to);
    m.position.lerpVectors(from, to, 0.5);
    m.scale.set(1, 1, Math.max(0.06, len));
    m.lookAt(to);
    (m.material as THREE.MeshBasicMaterial).opacity = 0.85;
    m.visible = true;
    this.scene.add(m);
    this.tracers.push({ mesh: m, life: 0.07, anchor: anchor ?? null, end: to.clone() });
  }

  casing(pos: THREE.Vector3, right: THREE.Vector3, big = false, inherit?: THREE.Vector3) {
    let m = this.casingPool.pop();
    if (!m) m = new THREE.Mesh(this.casingGeo, this.casingMat);
    m.scale.setScalar(big ? 2.4 : 1);
    m.position.copy(pos);
    m.visible = true;
    m.rotation.set(Math.random() * 3, Math.random() * 3, 0);
    this.scene.add(m);
    const vel = right.clone().multiplyScalar(1.2 + Math.random() * 0.8)
      .add(tmpV.set(0, 1.9 + Math.random() * 0.7, 0));
    if (inherit) vel.add(inherit);
    this.casings.push({
      mesh: m,
      vel,
      rotVel: new THREE.Vector3(Math.random() * 20 - 10, Math.random() * 20 - 10, Math.random() * 20 - 10),
      life: 1.6, grounded: false,
    });
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, blockId: number, voxel?: { x: number; y: number; z: number }) {
    const color = BLOCK_COLORS[blockId] ?? 0x888888;
    const n = 5 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) {
      this.spawnParticle(
        point,
        tmpV.set(normal.x + (Math.random() - 0.5) * 1.6, normal.y + Math.random() * 1.6 + 0.4, normal.z + (Math.random() - 0.5) * 1.6).normalize().multiplyScalar(2.4 + Math.random() * 2.6),
        color, 0.02 + Math.random() * 0.022, 0.5 + Math.random() * 0.35, true
      );
    }
    this.puff(point, normal, 0.35, 0.5);
    this.decal(point, normal, blockId, voxel);
  }

  private particleMaterial(color: number): THREE.MeshBasicMaterial {
    let m = this.particleMats.get(color);
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color });
      this.particleMats.set(color, m);
    }
    return m;
  }

  spawnParticle(pos: THREE.Vector3, vel: THREE.Vector3, color: number, size: number, life: number, bounce: boolean, grow = 0) {
    let mesh = this.particlePool.pop();
    if (!mesh) mesh = new THREE.Mesh(this.particleGeo, undefined);
    mesh.material = this.particleMaterial(color);
    mesh.position.copy(pos);
    mesh.scale.setScalar(size);
    mesh.visible = true;
    this.scene.add(mesh);
    this.particles.push({
      mesh, vel: vel.clone(),
      rotVel: new THREE.Vector3(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4),
      life, maxLife: life, gravity: 9.5, bounce, grow,
    });
  }

  puff(pos: THREE.Vector3, dir: THREE.Vector3, scale = 0.4, life = 0.9, color?: string) {
    let s = this.smokePool.pop();
    if (!s) s = new THREE.Sprite(this.smokeMatBase.clone());
    s.material.opacity = 0.5;
    s.material.color.set(color ?? '#cfc9bd');
    s.position.copy(pos).addScaledVector(dir, 0.05);
    s.scale.setScalar(scale);
    s.visible = true;
    this.scene.add(s);
    this.smokes.push({
      sprite: s,
      vel: dir.clone().multiplyScalar(0.5).add(tmpV2.set((Math.random() - 0.5) * 0.3, 0.5 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3)),
      life, max: life, grow: scale * 1.8,
    });
  }

  decal(point: THREE.Vector3, normal: THREE.Vector3, blockId: number = B.STONE, voxel?: { x: number; y: number; z: number }) {
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    if (ax + ay + az < 1e-4) return;
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const comp = axis === 0 ? normal.x : axis === 1 ? normal.y : normal.z;
    const sign = comp >= 0 ? 1 : -1;
    const nx = axis === 0 ? sign : 0;
    const ny = axis === 1 ? sign : 0;
    const nz = axis === 2 ? sign : 0;

    const rx = Math.floor(point.x - nx * 0.5);
    const ry = Math.floor(point.y - ny * 0.5);
    const rz = Math.floor(point.z - nz * 0.5);
    const bx = voxel ? voxel.x : rx;
    const by = voxel ? voxel.y : ry;
    const bz = voxel ? voxel.z : rz;

    if (by >= 0 && this.world.get(bx, by, bz) === B.AIR) return;

    const size = 0.125 + Math.random() * 0.055;
    const half = size * 0.5;

    const fit = (v: number, lo: number) => {
      const min = lo + half + 0.004, max = lo + 1 - half - 0.004;
      return max <= min ? lo + 0.5 : Math.min(max, Math.max(min, v));
    };
    const off = 0.011 + (this.decalSeq++ % 5) * 0.0013;

    const px = axis === 0 ? rx + (sign > 0 ? 1 : 0) + nx * off : fit(point.x, rx);
    const py = axis === 1 ? ry + (sign > 0 ? 1 : 0) + ny * off : fit(point.y, ry);
    const pz = axis === 2 ? rz + (sign > 0 ? 1 : 0) + nz * off : fit(point.z, rz);

    for (const d of this.decals) {
      if (d.axis !== axis || d.sign !== sign || d.dying) continue;
      if (Math.abs(d.mesh.position.x - px) > 0.05) continue;
      if (Math.abs(d.mesh.position.y - py) > 0.05) continue;
      if (Math.abs(d.mesh.position.z - pz) > 0.05) continue;
      d.life = DECAL_LIFE;
      d.age = 0;
      d.size = Math.min(0.2, d.size * 1.06);
      return;
    }

    while (this.decals.length >= MAX_DECALS) this.retireDecal(0);

    let e = this.decalPool.pop();
    if (!e) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.decalGeo, mat);
      mesh.renderOrder = 6;
      mesh.matrixAutoUpdate = true;
      e = { mesh, mat };
    }

    e.mat.map = this.holeTexes[(Math.random() * this.holeTexes.length) | 0];
    tmpColor.set(BLOCK_COLORS[blockId] ?? 0xffffff).lerp(WHITE, 0.45);
    e.mat.color.copy(tmpColor);
    e.mat.opacity = 1;
    e.mat.needsUpdate = true;

    e.mesh.position.set(px, py, pz);
    e.mesh.quaternion.setFromUnitVectors(DECAL_FORWARD, tmpQuatV.set(nx, ny, nz));
    e.mesh.rotateZ(Math.random() * Math.PI * 2);
    e.mesh.scale.set(size, size, 1);
    e.mesh.visible = true;
    this.scene.add(e.mesh);

    this.decals.push({
      mesh: e.mesh, mat: e.mat,
      life: DECAL_LIFE, age: 0, size,
      bx, by, bz, nx, ny, nz, axis, sign,
      dying: false,
    });
  }

  private retireDecal(i: number) {
    const d = this.decals[i];
    this.scene.remove(d.mesh);
    d.mesh.visible = false;
    d.mat.opacity = 1;
    this.decalPool.push({ mesh: d.mesh, mat: d.mat });
    this.decals.splice(i, 1);
  }

  clearDecals() {
    for (let i = this.decals.length - 1; i >= 0; i--) this.retireDecal(i);
  }

  decalsRemovedAt(x: number, y: number, z: number, radius = 0) {
    const r2 = (radius + 0.5) * (radius + 0.5);
    for (const d of this.decals) {
      const dx = d.bx - x, dy = d.by - y, dz = d.bz - z;
      if (dx * dx + dy * dy + dz * dz <= r2) d.dying = true;
    }
  }

  launchRocket(from: THREE.Vector3, dir: THREE.Vector3) {
    const g = (this.rocketTemplate ??= this.makeRocketModel()).clone(true);
    g.position.copy(from);
    g.lookAt(tmpV.copy(from).add(dir));
    this.scene.add(g);
    this.rocket = { mesh: g, vel: dir.clone().multiplyScalar(30), life: 6 };
  }

  private makeRocketModel(): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ map: pixelTexture('#5d6142', 16, 12, 30) });
    const tipMat = new THREE.MeshLambertMaterial({ map: pixelTexture('#33352a', 12, 12, 31) });
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.34), mat);
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.09), mat);
    head.position.z = -0.2;
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.08), tipMat);
    tip.position.z = -0.28;
    const fin1 = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.12, 0.08), tipMat);
    fin1.position.z = 0.16;
    const fin2 = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.014, 0.08), tipMat);
    fin2.position.z = 0.16;
    g.add(body, head, tip, fin1, fin2);
    return g;
  }

  get rocketActive() { return this.rocket !== null; }

  private explode(pos: THREE.Vector3) {
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI;
      tmpV.set(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)).multiplyScalar(3 + Math.random() * 6);
      this.spawnParticle(pos, tmpV, [0xffd23e, 0xff8b2b, 0xff5a1f, 0x3a3a3a, 0xd8cd9c][Math.floor(Math.random() * 5)], 0.05 + Math.random() * 0.09, 0.55 + Math.random() * 0.5, true, 0);
    }
    for (let i = 0; i < 18; i++) {
      tmpV.set((Math.random() - 0.5) * 8, 3 + Math.random() * 7, (Math.random() - 0.5) * 8);
      this.spawnParticle(pos, tmpV, 0x7a5a38, 0.05 + Math.random() * 0.05, 0.8 + Math.random() * 0.5, true);
    }
    for (let i = 0; i < 8; i++) {
      tmpV.set((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2);
      this.puff(pos.clone().add(tmpV), tmpV2.set(0, 1, 0), 0.8 + Math.random() * 0.8, 1.6 + Math.random(), '#8a8378');
    }
    this.flashAnchor = null;
    if (this.flashLight.parent !== this.scene) this.scene.add(this.flashLight);
    this.flashLight.position.copy(pos).y += 0.5;
    this.flashLight.intensity = 60;
    this.flashT = 0.18;
    this.onExplode(pos);
  }

  update(dt: number) {
    if (this.flashT > 0) {
      this.flashT -= dt;
      // Light stays parented to the scene; follow the muzzle in world space.
      if (this.flashAnchor) {
        this.flashAnchor.updateWorldMatrix(true, false);
        this.flashLight.position.setFromMatrixPosition(this.flashAnchor.matrixWorld);
      }
      for (const s of this.flashSprites) s.material.opacity = Math.max(0, this.flashT / 0.045);
      this.flashLight.intensity *= Math.max(0, 1 - dt * 26);
      if (this.flashT <= 0) {
        for (const s of this.flashSprites) {
          s.visible = false;
          // Detach sprites from the weapon rig so they don't ride into the
          // hidden stow group on the next weapon swap.
          if (s.parent !== this.scene) this.scene.add(s);
        }
        this.flashLight.intensity = 0;
        this.flashAnchor = null;
      }
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.scene.remove(p.mesh);
        this.particlePool.push(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.vel.y -= p.gravity * dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      p.mesh.rotation.x += p.rotVel.x * dt;
      p.mesh.rotation.y += p.rotVel.y * dt;
      p.mesh.rotation.z += p.rotVel.z * dt;
      if (p.grow) p.mesh.scale.addScalar(p.grow * dt);
      if (p.bounce) {
        const bx = Math.floor(p.mesh.position.x), by = Math.floor(p.mesh.position.y - 0.03), bz = Math.floor(p.mesh.position.z);
        if (this.world.solid(bx, by, bz) && p.vel.y < 0) {
          p.vel.y *= -0.4;
          p.vel.x *= 0.6; p.vel.z *= 0.6;
          p.mesh.position.y = by + 1.03;
        }
      }
      if (p.life < 0.2) p.mesh.scale.setScalar(Math.max(0.001, p.mesh.scale.x * (p.life / 0.2)));
    }

    for (let i = this.casings.length - 1; i >= 0; i--) {
      const c = this.casings[i];
      c.life -= dt;
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        this.casingPool.push(c.mesh);
        this.casings.splice(i, 1);
        continue;
      }
      if (!c.grounded) {
        c.vel.y -= 10.5 * dt;
        c.mesh.position.addScaledVector(c.vel, dt);
        c.mesh.rotation.x += c.rotVel.x * dt;
        c.mesh.rotation.z += c.rotVel.z * dt;
        const bx = Math.floor(c.mesh.position.x), by = Math.floor(c.mesh.position.y - 0.01), bz = Math.floor(c.mesh.position.z);
        if (this.world.solid(bx, by, bz)) {
          c.mesh.position.y = by + 1.012;
          if (Math.abs(c.vel.y) > 1.3) {
            c.vel.y *= -0.38;
            c.vel.x *= 0.5; c.vel.z *= 0.5;
          } else { c.grounded = true; }
        }
      }
      if (c.life < 0.3) c.mesh.scale.setScalar(Math.max(0.001, c.life / 0.3) * (c.grounded ? 1 : 1));
    }

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        this.tracerPool.push(t.mesh);
        this.tracers.splice(i, 1);
        continue;
      }
      if (t.anchor) {
        t.anchor.getWorldPosition(tmpV);
        const len = tmpV.distanceTo(t.end);
        t.mesh.position.lerpVectors(tmpV, t.end, 0.5);
        t.mesh.scale.set(1, 1, Math.max(0.06, len));
        t.mesh.lookAt(t.end);
      }
      (t.mesh.material as THREE.MeshBasicMaterial).opacity = t.life / 0.07;
    }

    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.life -= dt;
      if (s.life <= 0) {
        this.scene.remove(s.sprite);
        this.smokePool.push(s.sprite);
        this.smokes.splice(i, 1);
        continue;
      }
      s.sprite.position.addScaledVector(s.vel, dt);
      s.sprite.scale.addScalar(s.grow * dt);
      const f = s.life / s.max;
      s.sprite.material.opacity = 0.5 * f;
    }

    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;

      if (!d.dying) {
        const gone = d.by >= 0 && this.world.get(d.bx, d.by, d.bz) === B.AIR;
        const buried = this.world.get(d.bx + d.nx, d.by + d.ny, d.bz + d.nz) !== B.AIR;
        const far = d.mesh.position.distanceToSquared(this.playerPos) > DECAL_CULL_DIST * DECAL_CULL_DIST;
        if (gone || buried || far) {
          d.dying = true;
          d.life = Math.min(d.life, DECAL_DEATH_FADE);
        }
      }

      d.life -= dt;
      if (d.life <= 0) { this.retireDecal(i); continue; }

      const fade = d.dying
        ? d.life / DECAL_DEATH_FADE
        : Math.min(1, d.life / DECAL_FADE);
      d.mat.opacity = Math.max(0, Math.min(1, fade));

      const pop = d.age < 0.07 ? 1 + (1 - d.age / 0.07) * 0.55 : 1;
      const s = d.size * pop * (d.dying ? 0.75 + 0.25 * fade : 1);
      d.mesh.scale.set(s, s, 1);
    }

    if (this.rocket) {
      const r = this.rocket;
      const step = tmpV.copy(r.vel).multiplyScalar(dt);
      const from = r.mesh.position.clone();
      const hit = this.world.raycast(from, tmpV2.copy(r.vel).normalize(), step.length() + 0.3);
      if (hit || this.world.solid(Math.floor(from.x), Math.floor(from.y), Math.floor(from.z))) {
        const p = hit ? hit.point : from;
        this.scene.remove(r.mesh);
        this.rocket = null;
        this.explode(p);
      } else {
        r.mesh.position.add(step);
        r.life -= dt;
        if (r.life <= 0 || r.mesh.position.distanceTo(this.playerPos) > 150) {
          this.scene.remove(r.mesh);
          this.rocket = null;
          this.explode(r.mesh.position);
        } else {
          tmpV2.copy(r.mesh.position).addScaledVector(r.vel, -0.02);
          this.puff(tmpV2, new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.2, (Math.random() - 0.5) * 0.5), 0.22, 0.7, '#d8d3c8');
          if (Math.random() < 0.7) this.spawnParticle(tmpV2, new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)), 0xffb03a, 0.03, 0.2, false);
        }
      }
    }
  }

  static blockColor(id: number): number { return BLOCK_COLORS[id] ?? BLOCK_COLORS[B.STONE]; }
}
