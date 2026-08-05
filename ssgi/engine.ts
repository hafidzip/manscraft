import * as THREE from 'three';
import { makeAtlas } from './textures';
import {
  World, buildChunk, CHUNK, SEA, isSolid,
  GRASS, DIRT, STONE, SAND, PLANK, LOG, LEAVES, AIR, WATER,
} from './world';
import {
  skyVert, skyFrag, voxelVert, voxelFrag,
  shadowVert, shadowFrag, fsVert, ssgiFrag, blurFrag, ssrFrag,
} from './shaders';

export const HOTBAR = [GRASS, DIRT, STONE, SAND, PLANK, LOG, LEAVES];
export const HOTBAR_NAMES = ['Grass', 'Dirt', 'Stone', 'Sand', 'Planks', 'Log', 'Leaves'];
export const HOTBAR_COLORS = ['#5a9a3e', '#86603f', '#808085', '#dcca94', '#a07c4a', '#6d5334', '#3a6424'];

const RADIUS = 4;
const GRAVITY = -26;
const EYE = 1.62;
const SHADOW_SIZE = 1024;
const GI_SCALE = 0.5;

interface Callbacks {
  onLock: (locked: boolean) => void;
  onSlot: (slot: number) => void;
  onFps: (fps: number) => void;
}

interface ChunkEntry {
  solid?: THREE.Mesh;
  water?: THREE.Mesh;
  cx: number;
  cz: number;
}

export class Engine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private world = new World();
  private chunks = new Map<string, ChunkEntry>();
  private queue: [number, number, number][] = [];
  private queued = new Set<string>();
  private lastChunkX = 1e9;
  private lastChunkZ = 1e9;

  private sunDir = new THREE.Vector3(
    Math.cos(0.16) * 0.55, Math.sin(0.16), -Math.cos(0.16) * 0.83
  ).normalize();
  private sky: THREE.Mesh;
  private solidMat: THREE.ShaderMaterial;
  private waterMat: THREE.ShaderMaterial;
  private shadowMat: THREE.ShaderMaterial;

  private sceneRT: THREE.WebGLRenderTarget;
  private giRT: THREE.WebGLRenderTarget;
  private giBlurRT: THREE.WebGLRenderTarget;
  private shadowRT: THREE.WebGLRenderTarget;
  private shadowCam: THREE.OrthographicCamera;
  private shadowMatrix = new THREE.Matrix4();
  private biasMatrix = new THREE.Matrix4().set(
    0.5, 0, 0, 0.5,
    0, 0.5, 0, 0.5,
    0, 0, 0.5, 0.5,
    0, 0, 0, 1
  );

  private quadScene = new THREE.Scene();
  private quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private ssgiMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private ssrMat: THREE.ShaderMaterial;

  private frame = 0;
  private shadowDirty = true;
  private lastShadowTarget = new THREE.Vector3(1e9, 1e9, 1e9);
  private _target = new THREE.Vector3();

  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0.4;
  private pitch = -0.12;
  private onGround = false;
  private keys = new Set<string>();
  private locked = false;
  slot = 0;

  private raf = 0;
  private clock = new THREE.Clock();
  private fpsAcc = 0;
  private fpsFrames = 0;
  private cb: Callbacks;
  private canvas: HTMLCanvasElement;
  private disposed = false;
  private buildBudgetMs = 4;

  constructor(canvas: HTMLCanvasElement, cb: Callbacks) {
    this.cb = cb;
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = true;
    this.renderer.sortObjects = false;

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.12, 280);

    // Sky
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(250, 16, 10),
      new THREE.ShaderMaterial({
        vertexShader: skyVert,
        fragmentShader: skyFrag,
        uniforms: { uSunDir: { value: this.sunDir } },
        side: THREE.BackSide,
        depthWrite: false,
      })
    );
    this.sky.frustumCulled = false;
    this.scene.add(this.sky);

    // Shadow map
    const shadowDepth = new THREE.DepthTexture(SHADOW_SIZE, SHADOW_SIZE);
    shadowDepth.type = THREE.UnsignedIntType;
    shadowDepth.minFilter = THREE.NearestFilter;
    shadowDepth.magFilter = THREE.NearestFilter;
    this.shadowRT = new THREE.WebGLRenderTarget(SHADOW_SIZE, SHADOW_SIZE, {
      depthTexture: shadowDepth,
      magFilter: THREE.NearestFilter,
      minFilter: THREE.NearestFilter,
    });
    this.shadowCam = new THREE.OrthographicCamera(-56, 56, 56, -56, 2, 260);
    this.shadowMat = new THREE.ShaderMaterial({
      vertexShader: shadowVert,
      fragmentShader: shadowFrag,
      colorWrite: false,
    });

    // Materials
    const atlas = makeAtlas();
    const makeUniforms = () => ({
      uAtlas: { value: atlas },
      uShadowMap: { value: shadowDepth },
      uShadowTexel: { value: new THREE.Vector2(1 / SHADOW_SIZE, 1 / SHADOW_SIZE) },
      uShadowMatrix: { value: this.shadowMatrix },
      uSunDir: { value: this.sunDir },
      uSunColor: { value: new THREE.Color(2.5, 1.5, 0.7) },
      uSkyAmbient: { value: new THREE.Color(0.28, 0.30, 0.44) },
      uGroundAmbient: { value: new THREE.Color(0.22, 0.14, 0.09) },
      uFogColor: { value: new THREE.Color(0.85, 0.48, 0.26) },
      uSunGlow: { value: new THREE.Color(1.6, 0.9, 0.42) },
      uCameraPos: { value: this.camera.position },
      uFogDensity: { value: 0.00045 },
      uTime: { value: 0 },
    });

    this.solidMat = new THREE.ShaderMaterial({
      vertexShader: voxelVert,
      fragmentShader: voxelFrag,
      uniforms: makeUniforms(),
    });
    this.waterMat = new THREE.ShaderMaterial({
      vertexShader: voxelVert,
      fragmentShader: voxelFrag,
      uniforms: makeUniforms(),
      defines: { IS_WATER: 1 },
    });

    // Render targets
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    this.sceneRT = this.makeSceneRT(w, h);

    const gw = Math.max(1, (w * GI_SCALE) | 0);
    const gh = Math.max(1, (h * GI_SCALE) | 0);
    this.giRT = new THREE.WebGLRenderTarget(gw, gh, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    this.giBlurRT = new THREE.WebGLRenderTarget(gw, gh, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });

    const sceneDepth = this.sceneRT.depthTexture!;

    this.ssgiMat = new THREE.ShaderMaterial({
      vertexShader: fsVert,
      fragmentShader: ssgiFrag,
      uniforms: {
        tDiffuse: { value: this.sceneRT.texture },
        tDepth: { value: sceneDepth },
        uProj: { value: this.camera.projectionMatrix },
        uInvProj: { value: this.camera.projectionMatrixInverse },
        uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
        uTime: { value: 0 },
        uRadius: { value: 2.8 },
        uIntensity: { value: 1.25 },
        uAoStrength: { value: 0.8 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: fsVert,
      fragmentShader: blurFrag,
      uniforms: {
        tDiffuse: { value: this.giRT.texture },
        tDepth: { value: sceneDepth },
        uTexel: { value: new THREE.Vector2(1 / gw, 1 / gh) },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.ssrMat = new THREE.ShaderMaterial({
      vertexShader: fsVert,
      fragmentShader: ssrFrag,
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tGi: { value: this.giRT.texture },
        tDepth: { value: sceneDepth },
        uProj: { value: this.camera.projectionMatrix },
        uInvProj: { value: this.camera.projectionMatrixInverse },
        uInvView: { value: this.camera.matrixWorld },
        uView: { value: this.camera.matrixWorldInverse },
        uSunDirWorld: { value: this.sunDir },
        uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
        uTime: { value: 0 },
        uExposure: { value: 1.05 },
      },
      depthTest: false,
      depthWrite: false,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.ssgiMat);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);

    // Spawn
    let sx = 8, sz = 8;
    for (let r = 0; r < 80; r += 4) {
      if (this.world.height(8 + r, 8) > SEA + 1) {
        sx = 8 + r;
        sz = 8;
        break;
      }
    }
    this.pos.set(sx + 0.5, this.world.height(sx, sz) + 2.5, sz + 0.5);

    this.bindEvents();
    this.updateQueue(true);
    const t0 = performance.now();
    while (this.queue.length > 0 && performance.now() - t0 < 80) {
      const [, cx, cz] = this.queue.shift()!;
      this.buildChunkMesh(cx, cz);
    }
    this.loop();
  }

  private makeSceneRT(w: number, h: number) {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture: depth,
    });
  }

  // ------------------------------------------------------------- chunks
  private chunkKey(cx: number, cz: number) {
    return cx + ',' + cz;
  }

  private updateQueue(force = false) {
    const pcx = Math.floor(this.pos.x / CHUNK);
    const pcz = Math.floor(this.pos.z / CHUNK);
    if (!force && pcx === this.lastChunkX && pcz === this.lastChunkZ) return;
    this.lastChunkX = pcx;
    this.lastChunkZ = pcz;

    const unload = RADIUS + 1;
    for (const [key, entry] of this.chunks) {
      if (Math.abs(entry.cx - pcx) > unload || Math.abs(entry.cz - pcz) > unload) {
        this.removeChunk(key, entry);
      }
    }

    const list: [number, number, number][] = [];
    for (let dx = -RADIUS; dx <= RADIUS; dx++) {
      for (let dz = -RADIUS; dz <= RADIUS; dz++) {
        const cx = pcx + dx, cz = pcz + dz;
        const key = this.chunkKey(cx, cz);
        if (this.chunks.has(key) || this.queued.has(key)) continue;
        list.push([dx * dx + dz * dz, cx, cz]);
      }
    }
    list.sort((a, b) => a[0] - b[0]);
    // Keep any still-relevant queued work, replace the rest
    this.queue = list;
    this.queued.clear();
    for (const [, cx, cz] of list) this.queued.add(this.chunkKey(cx, cz));
  }

  private removeChunk(key: string, entry: ChunkEntry) {
    if (entry.solid) {
      this.scene.remove(entry.solid);
      entry.solid.geometry.dispose();
    }
    if (entry.water) {
      this.scene.remove(entry.water);
      entry.water.geometry.dispose();
    }
    this.chunks.delete(key);
  }

  private buildChunkMesh(cx: number, cz: number) {
    const key = this.chunkKey(cx, cz);
    const old = this.chunks.get(key);
    if (old) this.removeChunk(key, old);
    const { solid, water } = buildChunk(this.world, cx, cz);
    const entry: ChunkEntry = { cx, cz };
    if (solid) {
      entry.solid = new THREE.Mesh(solid, this.solidMat);
      entry.solid.matrixAutoUpdate = false;
      entry.solid.updateMatrix();
      this.scene.add(entry.solid);
    }
    if (water) {
      entry.water = new THREE.Mesh(water, this.waterMat);
      entry.water.matrixAutoUpdate = false;
      entry.water.updateMatrix();
      this.scene.add(entry.water);
    }
    this.chunks.set(key, entry);
    this.queued.delete(key);
    this.shadowDirty = true;
  }

  // ------------------------------------------------------------- input
  private bindEvents() {
    this.canvas.addEventListener('click', () => {
      if (!this.locked) {
        try {
          const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
          p?.catch?.(() => undefined);
        } catch { /* ignore */ }
      }
    });
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('resize', this.onResize);
  }

  private onLockChange = () => {
    this.locked = document.pointerLockElement === this.canvas;
    this.cb.onLock(this.locked);
    if (!this.locked) this.keys.clear();
  };

  private onMouseMove = (e: MouseEvent) => {
    if (!this.locked) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch -= e.movementY * 0.0022;
    if (this.pitch < -1.55) this.pitch = -1.55;
    else if (this.pitch > 1.55) this.pitch = 1.55;
  };

  private onMouseDown = (e: MouseEvent) => {
    if (!this.locked) return;
    const hit = this.raycast();
    if (!hit) return;
    if (e.button === 0) {
      this.world.setBlock(hit.x, hit.y, hit.z, AIR);
      this.rebuildAround(hit.x, hit.z);
    } else if (e.button === 2) {
      const [px, py, pz] = hit.prev;
      const hw = 0.35, hgt = 1.8;
      if (
        px + 1 > this.pos.x - hw && px < this.pos.x + hw &&
        py + 1 > this.pos.y && py < this.pos.y + hgt &&
        pz + 1 > this.pos.z - hw && pz < this.pos.z + hw
      ) return;
      this.world.setBlock(px, py, pz, HOTBAR[this.slot]);
      this.rebuildAround(px, pz);
    }
  };

  private onKeyDown = (e: KeyboardEvent) => {
    this.keys.add(e.code);
    const n = e.key.charCodeAt(0) - 48;
    if (n >= 1 && n <= HOTBAR.length) {
      this.slot = n - 1;
      this.cb.onSlot(this.slot);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);

  private onWheel = (e: WheelEvent) => {
    if (!this.locked) return;
    this.slot = (this.slot + (e.deltaY > 0 ? 1 : -1) + HOTBAR.length) % HOTBAR.length;
    this.cb.onSlot(this.slot);
  };

  private onResize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const bw = this.renderer.domElement.width;
    const bh = this.renderer.domElement.height;

    this.sceneRT.dispose();
    this.sceneRT = this.makeSceneRT(bw, bh);

    const gw = Math.max(1, (bw * GI_SCALE) | 0);
    const gh = Math.max(1, (bh * GI_SCALE) | 0);
    this.giRT.setSize(gw, gh);
    this.giBlurRT.setSize(gw, gh);

    const sceneDepth = this.sceneRT.depthTexture!;

    this.ssgiMat.uniforms.tDiffuse.value = this.sceneRT.texture;
    this.ssgiMat.uniforms.tDepth.value = sceneDepth;
    (this.ssgiMat.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);

    this.blurMat.uniforms.tDepth.value = sceneDepth;
    (this.blurMat.uniforms.uTexel.value as THREE.Vector2).set(1 / gw, 1 / gh);

    this.ssrMat.uniforms.tScene.value = this.sceneRT.texture;
    this.ssrMat.uniforms.tDepth.value = sceneDepth;
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).set(1 / bw, 1 / bh);
  };

  private rebuildAround(x: number, z: number) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const lx = ((x % CHUNK) + CHUNK) % CHUNK;
    const lz = ((z % CHUNK) + CHUNK) % CHUNK;
    this.buildChunkMesh(cx, cz);
    if (lx === 0) this.buildChunkMesh(cx - 1, cz);
    if (lx === CHUNK - 1) this.buildChunkMesh(cx + 1, cz);
    if (lz === 0) this.buildChunkMesh(cx, cz - 1);
    if (lz === CHUNK - 1) this.buildChunkMesh(cx, cz + 1);
  }

  // ------------------------------------------------------------- raycast
  private raycast(): { x: number; y: number; z: number; prev: [number, number, number] } | null {
    const cy = Math.cos(this.pitch);
    const dirX = -Math.sin(this.yaw) * cy;
    const dirY = Math.sin(this.pitch);
    const dirZ = -Math.cos(this.yaw) * cy;
    const ox = this.camera.position.x;
    const oy = this.camera.position.y;
    const oz = this.camera.position.z;
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dirX > 0 ? 1 : -1;
    const stepY = dirY > 0 ? 1 : -1;
    const stepZ = dirZ > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dirX || 1e-8));
    const tDeltaY = Math.abs(1 / (dirY || 1e-8));
    const tDeltaZ = Math.abs(1 / (dirZ || 1e-8));
    let tMaxX = (dirX > 0 ? x + 1 - ox : ox - x) * tDeltaX;
    let tMaxY = (dirY > 0 ? y + 1 - oy : oy - y) * tDeltaY;
    let tMaxZ = (dirZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ;
    let prev: [number, number, number] = [x, y, z];
    for (let i = 0; i < 90; i++) {
      prev = [x, y, z];
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          if (tMaxX > 6) return null;
          x += stepX; tMaxX += tDeltaX;
        } else {
          if (tMaxZ > 6) return null;
          z += stepZ; tMaxZ += tDeltaZ;
        }
      } else if (tMaxY < tMaxZ) {
        if (tMaxY > 6) return null;
        y += stepY; tMaxY += tDeltaY;
      } else {
        if (tMaxZ > 6) return null;
        z += stepZ; tMaxZ += tDeltaZ;
      }
      const b = this.world.getBlock(x, y, z);
      if (b !== AIR && b !== WATER) return { x, y, z, prev };
    }
    return null;
  }

  // ------------------------------------------------------------- physics
  private collide(axis: 0 | 1 | 2) {
    const hw = 0.32, hgt = 1.8;
    const minX = Math.floor(this.pos.x - hw), maxX = Math.floor(this.pos.x + hw);
    const minY = Math.floor(this.pos.y), maxY = Math.floor(this.pos.y + hgt);
    const minZ = Math.floor(this.pos.z - hw), maxZ = Math.floor(this.pos.z + hw);
    for (let bx = minX; bx <= maxX; bx++) {
      for (let by = minY; by <= maxY; by++) {
        for (let bz = minZ; bz <= maxZ; bz++) {
          if (!isSolid(this.world.getBlock(bx, by, bz))) continue;
          if (axis === 1) {
            if (this.vel.y < 0) {
              this.pos.y = by + 1;
              this.vel.y = 0;
              this.onGround = true;
            } else {
              this.pos.y = by - hgt - 0.001;
              this.vel.y = 0;
            }
          } else if (axis === 0) {
            this.pos.x = this.vel.x > 0 ? bx - hw - 0.001 : bx + 1 + hw + 0.001;
            this.vel.x = 0;
          } else {
            this.pos.z = this.vel.z > 0 ? bz - hw - 0.001 : bz + 1 + hw + 0.001;
            this.vel.z = 0;
          }
          return;
        }
      }
    }
  }

  private updatePlayer(dt: number) {
    const speed = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 7.2 : 4.5;
    let fw = 0, st = 0;
    if (this.keys.has('KeyW')) fw += 1;
    if (this.keys.has('KeyS')) fw -= 1;
    if (this.keys.has('KeyA')) st -= 1;
    if (this.keys.has('KeyD')) st += 1;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wishX = -sin * fw + cos * st;
    let wishZ = -cos * fw - sin * st;
    const len = Math.hypot(wishX, wishZ);
    if (len > 0) {
      wishX /= len;
      wishZ /= len;
      const accel = this.onGround ? 55 : 16;
      this.vel.x += wishX * speed * accel * dt * 0.12;
      this.vel.z += wishZ * speed * accel * dt * 0.12;
    }
    const fr = Math.exp(-(this.onGround ? 12 : 1.5) * dt);
    this.vel.x *= fr;
    this.vel.z *= fr;
    const hv = Math.hypot(this.vel.x, this.vel.z);
    if (hv > speed) {
      this.vel.x *= speed / hv;
      this.vel.z *= speed / hv;
    }

    const inWater = this.world.getBlock(
      Math.floor(this.pos.x), Math.floor(this.pos.y + 0.4), Math.floor(this.pos.z)
    ) === WATER;
    if (this.keys.has('Space')) {
      if (this.onGround) {
        this.vel.y = 8.6;
        this.onGround = false;
      } else if (inWater) {
        this.vel.y = Math.min(this.vel.y + 30 * dt, 4);
      }
    }
    this.vel.y += (inWater ? GRAVITY * 0.35 : GRAVITY) * dt;
    if (inWater) this.vel.y = Math.max(this.vel.y, -3.5);

    this.onGround = false;
    this.pos.y += this.vel.y * dt;
    this.collide(1);
    this.pos.x += this.vel.x * dt;
    this.collide(0);
    this.pos.z += this.vel.z * dt;
    this.collide(2);
    if (this.pos.y < -20) {
      this.pos.y = 60;
      this.vel.set(0, 0, 0);
    }

    this.camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  // ------------------------------------------------------------- render
  private updateShadowCam() {
    const snap = 8;
    this._target.set(
      Math.round(this.pos.x / snap) * snap,
      Math.round(this.pos.y / snap) * snap,
      Math.round(this.pos.z / snap) * snap
    );
    if (this._target.distanceToSquared(this.lastShadowTarget) < 0.01 && !this.shadowDirty) {
      return false;
    }
    this.lastShadowTarget.copy(this._target);
    this.shadowCam.position.copy(this._target).addScaledVector(this.sunDir, 140);
    this.shadowCam.up.set(0, 1, 0);
    this.shadowCam.lookAt(this._target);
    this.shadowCam.updateMatrixWorld();
    this.shadowMatrix.copy(this.biasMatrix)
      .multiply(this.shadowCam.projectionMatrix)
      .multiply(this.shadowCam.matrixWorldInverse);
    return true;
  }

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const t = this.clock.elapsedTime;
    this.frame++;

    if (this.locked) this.updatePlayer(dt);
    else {
      this.camera.position.set(this.pos.x, this.pos.y + EYE, this.pos.z);
      this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    }

    // Stream chunks with a time budget so builds don't hitch
    this.updateQueue();
    const buildStart = performance.now();
    while (this.queue.length > 0 && performance.now() - buildStart < this.buildBudgetMs) {
      const [, cx, cz] = this.queue.shift()!;
      this.buildChunkMesh(cx, cz);
    }

    this.solidMat.uniforms.uTime.value = t;
    this.waterMat.uniforms.uTime.value = t;
    this.ssgiMat.uniforms.uTime.value = t;
    this.ssrMat.uniforms.uTime.value = t;
    this.sky.position.copy(this.camera.position);
    this.camera.updateMatrixWorld();

    // Shadow every other frame (or when dirty)
    if (this.shadowDirty || (this.frame & 1) === 0) {
      const moved = this.updateShadowCam();
      if (moved || this.shadowDirty) {
        this.sky.visible = false;
        for (const entry of this.chunks.values()) {
          if (entry.water) entry.water.visible = false;
        }
        this.scene.overrideMaterial = this.shadowMat;
        this.renderer.setRenderTarget(this.shadowRT);
        this.renderer.clear();
        this.renderer.render(this.scene, this.shadowCam);
        this.scene.overrideMaterial = null;
        for (const entry of this.chunks.values()) {
          if (entry.water) entry.water.visible = true;
        }
        this.shadowDirty = false;
      }
    }

    // Forward color + depth (single geometry pass — normals from depth later)
    this.sky.visible = true;
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);

    // Half-res SSGI
    this.quad.material = this.ssgiMat;
    this.renderer.setRenderTarget(this.giRT);
    this.renderer.render(this.quadScene, this.quadCam);

    // Separable bilateral blur H then V
    this.blurMat.uniforms.tDiffuse.value = this.giRT.texture;
    (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(1, 0);
    this.quad.material = this.blurMat;
    this.renderer.setRenderTarget(this.giBlurRT);
    this.renderer.render(this.quadScene, this.quadCam);

    this.blurMat.uniforms.tDiffuse.value = this.giBlurRT.texture;
    (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(0, 1);
    this.renderer.setRenderTarget(this.giRT);
    this.renderer.render(this.quadScene, this.quadCam);

    this.ssrMat.uniforms.tGi.value = this.giRT.texture;

    // Full-res SSR (water only) + tonemap
    this.quad.material = this.ssrMat;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.quadScene, this.quadCam);

    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc >= 0.5) {
      this.cb.onFps(Math.round(this.fpsFrames / this.fpsAcc));
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('resize', this.onResize);
    for (const [key, entry] of this.chunks) this.removeChunk(key, entry);
    this.sceneRT.dispose();
    this.giRT.dispose();
    this.giBlurRT.dispose();
    this.shadowRT.dispose();
    this.solidMat.dispose();
    this.waterMat.dispose();
    this.shadowMat.dispose();
    this.ssgiMat.dispose();
    this.blurMat.dispose();
    this.ssrMat.dispose();
    this.renderer.dispose();
  }
}
