// Pooled visual effects: muzzle flashes, tracers, ejected brass, impact
// particles, bullet-hole decals, voxel smoke, rockets and explosions.
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

/** A pooled decal keeps its own material so opacity is never shared. */
interface PooledDecal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }

interface Decal extends PooledDecal {
  /** seconds of life remaining */
  life: number;
  /** seconds since spawn (drives the pop-in) */
  age: number;
  /** rendered size in world units */
  size: number;
  /** voxel the decal is stuck to, in *world* (not render) space */
  bx: number; by: number; bz: number;
  /** outward face normal, rounded to the voxel axis */
  nx: number; ny: number; nz: number;
  /** which axis the face lies on (0=x,1=y,2=z) and its sign */
  axis: number; sign: number;
  /** true once the surface vanished / went out of range: fast fade-out */
  dying: boolean;
}

/** Hard cap so a long firefight can never tank the frame rate. */
const MAX_DECALS = 140;
/** Decals further than this from the player are recycled. */
const DECAL_CULL_DIST = 72;
/** Normal lifetime, and the tail of it spent fading. */
const DECAL_LIFE = 28;
const DECAL_FADE = 3.5;
/** Fade used when the block a decal sits on is destroyed or covered. */
const DECAL_DEATH_FADE = 0.16;

const DECAL_FORWARD = new THREE.Vector3(0, 0, 1);
const tmpQuatV = new THREE.Vector3();
const tmpColor = new THREE.Color();
const WHITE = new THREE.Color(0xffffff);

export class Effects {
  private scene: THREE.Scene;
  private world: WorldLike;

  // pools
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
  /** Unit quad shared by every decal — only the mesh scale differs. */
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

  // rocket
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
    // Several procedural variants keep a peppered wall from looking stamped.
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

  /** Reserve the maximum common combat burst before gameplay to avoid first
   * shot/explosion geometry, sprite and material allocation stalls. */
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

  // ------------------------------------------------------------ muzzle flash
  /**
   * `anchor` (the weapon's muzzle bone) makes the flash a child of the gun so
   * it stays glued to the barrel while the player moves/turns. Without it the
   * flash is placed in world space (used for enemy weapons).
   */
  muzzleFlash(pos: THREE.Vector3, scale = 1, anchor?: THREE.Object3D) {
    this.flashT = 0.045;
    this.flashAnchor = anchor ?? null;
    this.flashIntensity = 3.2 * scale;

    if (anchor) {
      // parent the light + sprites to the muzzle, positioned at its origin
      if (this.flashLight.parent !== anchor) anchor.add(this.flashLight);
      this.flashLight.position.set(0, 0, 0);
    } else {
      if (this.flashLight.parent !== this.scene) this.scene.add(this.flashLight);
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

  // ------------------------------------------------------------ tracer
  /**
   * `anchor` keeps the tracer's near end locked to the muzzle for its whole
   * (very short) lifetime, so it never visually detaches from the barrel
   * while strafing or turning. The far end stays fixed in world space.
   */
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

  // ------------------------------------------------------------ casing
  /** `inherit` is the shooter's velocity so brass arcs naturally when moving. */
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

  // ------------------------------------------------------------ impact burst
  /**
   * `voxel` is the world-space block coordinate from the ray hit. Passing it
   * lets the bullet hole stay bound to that block so it disappears with it.
   */
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

  /**
   * Stick a bullet hole onto a voxel face.
   *
   * `voxel` is the block that was hit *in world coordinates*. It is kept
   * separate from `point` because enemies render their hits through a
   * wrap-around `vis()` transform, so the render-space position and the
   * world-space voxel can differ by whole world widths.
   *
   * The decal is snapped flush onto the exact face plane and clamped so it can
   * never hang over the edge of the block into thin air, then it is tracked
   * every frame: the moment the block is mined, blown up, or covered by a
   * newly placed block, the hole fades out instead of floating in the void.
   */
  decal(point: THREE.Vector3, normal: THREE.Vector3, blockId: number = B.STONE, voxel?: { x: number; y: number; z: number }) {
    // --- resolve the face axis. Voxel normals are axis aligned; pick the
    // dominant component so a slightly denormalised input still works.
    const ax = Math.abs(normal.x), ay = Math.abs(normal.y), az = Math.abs(normal.z);
    if (ax + ay + az < 1e-4) return;                       // degenerate normal
    const axis = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const comp = axis === 0 ? normal.x : axis === 1 ? normal.y : normal.z;
    const sign = comp >= 0 ? 1 : -1;
    const nx = axis === 0 ? sign : 0;
    const ny = axis === 1 ? sign : 0;
    const nz = axis === 2 ? sign : 0;

    // --- the voxel in render space (used for geometry) ...
    const rx = Math.floor(point.x - nx * 0.5);
    const ry = Math.floor(point.y - ny * 0.5);
    const rz = Math.floor(point.z - nz * 0.5);
    // ... and in world space (used to query whether the block still exists)
    const bx = voxel ? voxel.x : rx;
    const by = voxel ? voxel.y : ry;
    const bz = voxel ? voxel.z : rz;

    // Never place a hole on something that is already gone (a stale hit from
    // the same frame the block was destroyed) — this was the main cause of
    // holes hanging in mid-air.
    if (by >= 0 && this.world.get(bx, by, bz) === B.AIR) return;

    const size = 0.125 + Math.random() * 0.055;
    const half = size * 0.5;

    // Keep the quad inside the face: clamp the two tangential axes to the
    // block bounds shrunk by half the decal, so it never overhangs into air.
    const fit = (v: number, lo: number) => {
      const min = lo + half + 0.004, max = lo + 1 - half - 0.004;
      return max <= min ? lo + 0.5 : Math.min(max, Math.max(min, v));
    };
    // Stagger the depth offset so overlapping holes cannot z-fight/flicker.
    const off = 0.011 + (this.decalSeq++ % 5) * 0.0013;

    const px = axis === 0 ? rx + (sign > 0 ? 1 : 0) + nx * off : fit(point.x, rx);
    const py = axis === 1 ? ry + (sign > 0 ? 1 : 0) + ny * off : fit(point.y, ry);
    const pz = axis === 2 ? rz + (sign > 0 ? 1 : 0) + nz * off : fit(point.z, rz);

    // --- merge near-duplicates instead of stacking coplanar quads
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

    // --- recycle the oldest once we hit the cap
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

    // pick a random variant + tint it toward the block colour so the dust ring
    // reads as pulverised sand / stone / wood rather than generic grey
    e.mat.map = this.holeTexes[(Math.random() * this.holeTexes.length) | 0];
    tmpColor.set(BLOCK_COLORS[blockId] ?? 0xffffff).lerp(WHITE, 0.45);
    e.mat.color.copy(tmpColor);
    e.mat.opacity = 1;
    e.mat.needsUpdate = true;

    e.mesh.position.set(px, py, pz);
    // setFromUnitVectors instead of lookAt(): lookAt() is degenerate for floor
    // and ceiling hits (normal parallel to up), which made those decals render
    // edge-on i.e. invisible.
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

  /** Drop every bullet hole (used when the world is rebuilt / player respawns). */
  clearDecals() {
    for (let i = this.decals.length - 1; i >= 0; i--) this.retireDecal(i);
  }

  /**
   * Called when a region of blocks is destroyed so holes on them vanish on the
   * same frame rather than a tick later.
   */
  decalsRemovedAt(x: number, y: number, z: number, radius = 0) {
    const r2 = (radius + 0.5) * (radius + 0.5);
    for (const d of this.decals) {
      const dx = d.bx - x, dy = d.by - y, dz = d.bz - z;
      if (dx * dx + dy * dy + dz * dz <= r2) d.dying = true;
    }
  }

  // ------------------------------------------------------------ rocket + explosion
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
    // fire core
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI;
      tmpV.set(Math.sin(b) * Math.cos(a), Math.cos(b), Math.sin(b) * Math.sin(a)).multiplyScalar(3 + Math.random() * 6);
      this.spawnParticle(pos, tmpV, [0xffd23e, 0xff8b2b, 0xff5a1f, 0x3a3a3a, 0xd8cd9c][Math.floor(Math.random() * 5)], 0.05 + Math.random() * 0.09, 0.55 + Math.random() * 0.5, true, 0);
    }
    // dirt / voxel debris
    for (let i = 0; i < 18; i++) {
      tmpV.set((Math.random() - 0.5) * 8, 3 + Math.random() * 7, (Math.random() - 0.5) * 8);
      this.spawnParticle(pos, tmpV, 0x7a5a38, 0.05 + Math.random() * 0.05, 0.8 + Math.random() * 0.5, true);
    }
    for (let i = 0; i < 8; i++) {
      tmpV.set((Math.random() - 0.5) * 2, Math.random() * 1.2, (Math.random() - 0.5) * 2);
      this.puff(pos.clone().add(tmpV), tmpV2.set(0, 1, 0), 0.8 + Math.random() * 0.8, 1.6 + Math.random(), '#8a8378');
    }
    // detach the light from the weapon muzzle before placing it in the world
    if (this.flashAnchor) {
      this.scene.add(this.flashLight);
      this.flashAnchor = null;
    }
    this.flashLight.position.copy(pos).y += 0.5;
    this.flashLight.intensity = 60;
    this.flashT = 0.18;
    this.onExplode(pos);
  }

  // ------------------------------------------------------------ update
  update(dt: number) {
    // flash decay (anchored sprites keep their local offset; the parent
    // transform does the tracking, so nothing needs repositioning here)
    if (this.flashT > 0) {
      this.flashT -= dt;
      for (const s of this.flashSprites) s.material.opacity = Math.max(0, this.flashT / 0.045);
      this.flashLight.intensity *= Math.max(0, 1 - dt * 26);
      if (this.flashT <= 0) {
        for (const s of this.flashSprites) s.visible = false;
        this.flashLight.intensity = 0;
        this.flashAnchor = null;
      }
    }

    // particles
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

    // casings
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

    // tracers — anchored ones re-solve their near end against the live muzzle
    // so the beam stays welded to the barrel while the player moves.
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

    // smoke
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

    // ---------------------------------------------------------------- decals
    // Every hole is validated against the voxel grid each frame, so a hole can
    // never outlive the surface it was shot into. Each decal owns its material,
    // so fading one no longer fades (or hides) all the others.
    for (let i = this.decals.length - 1; i >= 0; i--) {
      const d = this.decals[i];
      d.age += dt;

      if (!d.dying) {
        // 1) the block itself was mined / exploded away
        //    (y < 0 is the implicit bedrock plane, which always exists)
        const gone = d.by >= 0 && this.world.get(d.bx, d.by, d.bz) === B.AIR;
        // 2) the face got covered by a newly placed block — the hole would be
        //    buried inside geometry and z-fight, so retire it
        const buried = this.world.get(d.bx + d.nx, d.by + d.ny, d.bz + d.nz) !== B.AIR;
        // 3) too far away to matter; free the slot for holes near the player
        const far = d.mesh.position.distanceToSquared(this.playerPos) > DECAL_CULL_DIST * DECAL_CULL_DIST;
        if (gone || buried || far) {
          d.dying = true;
          d.life = Math.min(d.life, DECAL_DEATH_FADE);
        }
      }

      d.life -= dt;
      if (d.life <= 0) { this.retireDecal(i); continue; }

      // fade: fast when the surface vanished, slow at end of natural life
      const fade = d.dying
        ? d.life / DECAL_DEATH_FADE
        : Math.min(1, d.life / DECAL_FADE);
      d.mat.opacity = Math.max(0, Math.min(1, fade));

      // brief punch-in so a fresh hole reads as an event, and shrink away as
      // it dies so it never just blinks out
      const pop = d.age < 0.07 ? 1 + (1 - d.age / 0.07) * 0.55 : 1;
      const s = d.size * pop * (d.dying ? 0.75 + 0.25 * fade : 1);
      d.mesh.scale.set(s, s, 1);
    }

    // rocket flight
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
          // exhaust trail
          tmpV2.copy(r.mesh.position).addScaledVector(r.vel, -0.02);
          this.puff(tmpV2, new THREE.Vector3((Math.random() - 0.5) * 0.5, 0.2, (Math.random() - 0.5) * 0.5), 0.22, 0.7, '#d8d3c8');
          if (Math.random() < 0.7) this.spawnParticle(tmpV2, new THREE.Vector3((Math.random() - 0.5), (Math.random() - 0.5), (Math.random() - 0.5)), 0xffb03a, 0.03, 0.2, false);
        }
      }
    }
  }

  /** Solid color query helper for other systems. */
  static blockColor(id: number): number { return BLOCK_COLORS[id] ?? BLOCK_COLORS[B.STONE]; }
}
