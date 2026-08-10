import * as THREE from 'three';
import { Frame, v3, vdist, derive, Rng, type Vec3d } from './rng';
import {
  planetSpec,
  planetPositionAt,
  galaxyOfSector,
  homeStar,
  sectorDensity,
  type StarSpec,
  type PlanetSpec,
} from './galaxy';
import { PlanetBody } from './planet';
import { StarBody } from './sun';
import { Spaceship, type FlightInput } from './spaceship';
import { Particles } from './particles';
import { createStarfield } from './starfield';
import { SectorStreamer } from './streamer';
import { PLANET_PALETTES } from './palettes';

export type WarpPhase = 'idle' | 'charge' | 'flash' | 'arrive';

export interface HudState {
  speed: number;
  boost: boolean;
  galaxy: string;
  galaxyType: string;
  sector: string;
  density: number;
  streamed: number;
  star: string;
  spectral: string;
  bodies: number;
  nearest: string;
  distance: number;
  inSystem: boolean;
  warp: boolean;
  warpPhase: WarpPhase;
  warpProgress: number;
  warpTargetKind: TargetKind | null;
  warpTargetName: string;
  target: TargetLock | null;
}

const PLANET_BUILD_DIST = 2800;

const IN_SYSTEM_DIST = 1400;

const ORBIT_SPAWN_MUL = 4;

const ORBIT_SPAWN_AXIS = (() => {
  const a = { x: 0.82, y: 0.34, z: 0.46 };
  const len = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / len, y: a.y / len, z: a.z / len };
})();

const EXIT_CAPTURE_MUL = 8;

const ORBIT_SNAP_TIMEOUT = 5;

const AUTO_LAND_MUL = 1.6;

export interface SpaceEntry {
  star: StarSpec;
  planet?: PlanetSpec;
  orbit?: boolean;
}

export interface SpaceExit {
  star: StarSpec;
  planet: PlanetSpec | null;
  isHome: boolean;
}

export interface OrbitTarget {
  universe: Vec3d;
  radius?: number;
  spec?: PlanetSpec;
}

export type TargetKind = 'star' | 'planet';

export interface TargetLock {
  kind: TargetKind;
  name: string;
  spectral: string;
  distance: number;
  bodies: number;
  color: string;
  sx: number;
  sy: number;
  onScreen: boolean;
  locked: boolean;
}


interface CachedBody {
  obj: { group: THREE.Group; dispose?: () => void };
  key: string;
  last: number;
}

class BodyCache {
  private map = new Map<string, CachedBody>();
  constructor(private max: number, private scene: THREE.Scene) {}

  get<T extends { group: THREE.Group; dispose?: () => void }>(
    key: string,
    factory: () => T
  ): T {
    const hit = this.map.get(key);
    if (hit) {
      hit.last = performance.now();
      return hit.obj as T;
    }
    const obj = factory();
    this.map.set(key, { obj, key, last: performance.now() });
    this.evict();
    return obj;
  }

  private evict() {
    while (this.map.size > this.max) {
      let oldest: CachedBody | null = null;
      for (const e of this.map.values()) {
        if (e.obj.group.parent) continue;
        if (!oldest || e.last < oldest.last) oldest = e;
      }
      if (!oldest) return;
      this.map.delete(oldest.key);
      oldest.obj.dispose?.();
    }
  }

  clear() {
    for (const e of this.map.values()) {
      this.scene.remove(e.obj.group);
      e.obj.dispose?.();
    }
    this.map.clear();
  }
}


export class SpaceScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private frame = new Frame();
  private ship: Spaceship;
  private particles: Particles;
  private cache: BodyCache;
  private streamer: SectorStreamer;
  private starfield: THREE.Points;
  private starLight = new THREE.PointLight(0xfff4e8, 0, 0, 0);

  private streamedPlanets = new Map<string, PlanetBody[]>();
  private streamedStarBodies = new Map<string, StarBody>();

  private jumpCount = 0;

  private entryStar: StarSpec;
  private homePlanetSpec: PlanetSpec;
  private pendingOrbit: PlanetSpec | null = null;
  private pendingOrbitT = 0;
  private camSnap = false;
  private nearPlanet: PlanetBody | null = null;
  private nearPlanetSurfaceD = Infinity;
  private lastLockedPlanet: PlanetBody | null = null;
  private currentStar: StarSpec | null = null;
  private lastExit: SpaceExit | null = null;

  onExit?: (exit: SpaceExit) => void;

  onDescend?: (planet: PlanetSpec) => void;

  private landed = false;

  private warpPhase: WarpPhase = 'idle';
  private warpT = 0;
  private warpKind: TargetKind | null = null;
  private warpTargetName = '';
  private warpAction: (() => void) | null = null;
  private baseFov = 70;
  private static readonly WARP_CHARGE_DUR = 0.55;
  private static readonly WARP_FLASH_DUR = 0.16;
  private static readonly WARP_ARRIVE_DUR = 0.75;

  private lockStar: StarSpec | null = null;
  private lockPlanet: PlanetBody | null = null;
  private lockStrength = 0;

  private input: FlightInput = {
    forward: false,
    back: false,
    left: false,
    right: false,
    up: false,
    down: false,
    boost: false,
  };
  private pointerLocked = false;
  private mouseSens = 0.0022;

  private camPos = new THREE.Vector3();
  private camLook = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpV2 = new THREE.Vector3();

  private clock = new THREE.Clock();
  private raf = 0;

  private snapCanvas: HTMLCanvasElement | null = null;
  private snapT = 0;

  onHud?: (s: HudState) => void;

  isWarm(): boolean {
    if (this.pendingOrbit) return false;
    for (const planets of this.streamedPlanets.values()) {
      for (const planet of planets) if (planet.hasPending()) return false;
    }
    return this.streamedPlanets.size > 0 || this.entryStar.planetCount === 0;
  }

  constructor(private canvas: HTMLCanvasElement, entry?: SpaceEntry) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setClearColor(0x03040c, 1);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.camera = new THREE.PerspectiveCamera(
      70,
      window.innerWidth / window.innerHeight,
      0.5,
      1e12
    );
    this.baseFov = this.camera.fov;

    this.scene.add(new THREE.AmbientLight(0x39425c, 0.45));
    const fill = new THREE.DirectionalLight(0x7a88b8, 0.22);
    fill.position.set(-1, 0.5, 1);
    this.scene.add(fill);
    this.scene.add(this.starLight);

    this.starfield = createStarfield();
    this.scene.add(this.starfield);

    this.particles = new Particles(this.scene);
    this.ship = new Spaceship(this.scene, this.particles);
    this.cache = new BodyCache(48, this.scene);
    this.streamer = new SectorStreamer(this.scene);

    this.bindEvents();

    this.entryStar = entry?.star ?? homeStar();
    this.homePlanetSpec = entry?.planet ?? planetSpec(this.entryStar.seed, 0);

    const wantOrbit = entry?.orbit !== false && this.entryStar.planetCount > 0;
    if (wantOrbit) {
      this.spawnInOrbit({
        universe: planetPositionAt(this.entryStar.pos, this.homePlanetSpec),
        spec: this.homePlanetSpec,
      });
      this.pendingOrbit = this.homePlanetSpec;
      this.pendingOrbitT = 0;
    } else {
      this.spawnAt(this.entryStar);
    }
  }

  private bindEvents() {
    window.addEventListener('resize', this.onResize);
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
    this.canvas.addEventListener('click', this.requestLock);
    document.addEventListener('pointerlockchange', this.onLockChange);
    document.addEventListener('mousemove', this.onMouse);
  }

  private onResize = () => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  private requestLock = () => this.canvas.requestPointerLock();
  private onLockChange = () => {
    this.pointerLocked = document.pointerLockElement === this.canvas;
  };

  private onMouse = (e: MouseEvent) => {
    if (!this.pointerLocked) return;
    this.ship.yaw -= e.movementX * this.mouseSens;
    this.ship.pitch -= e.movementY * this.mouseSens;
    this.ship.pitch = Math.max(-1.3, Math.min(1.3, this.ship.pitch));
  };

  private onKey = (e: KeyboardEvent) => {
    const down = e.type === 'keydown';
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': this.input.forward = down; break;
      case 'KeyS': case 'ArrowDown': this.input.back = down; break;
      case 'KeyA': case 'ArrowLeft': this.input.left = down; break;
      case 'KeyD': case 'ArrowRight': this.input.right = down; break;
      case 'Space': this.input.up = down; break;
      case 'KeyC': case 'ControlLeft': this.input.down = down; break;
      case 'ShiftLeft': case 'ShiftRight': this.input.boost = down; break;
      case 'KeyF': case 'KeyJ': if (down) this.doJump(); break;
    }
  };

  private placeShip(x: number, y: number, z: number, yaw: number, pitch = 0, aim?: Vec3d) {
    this.ship.place(x, y, z);
    if (aim) {
      const dx = aim.x - x;
      const dy = aim.y - y;
      const dz = aim.z - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.ship.yaw = Math.atan2(-dx, -dz);
      this.ship.pitch = THREE.MathUtils.clamp(Math.asin(-dy / len), -1.3, 1.3);
    } else {
      this.ship.yaw = yaw;
      this.ship.pitch = pitch;
    }
    this.frame.origin = { ...this.ship.pos };
    this.streamer.update(this.ship.pos, true);
    this.camSnap = true;
  }

  private spawnAt(star: StarSpec) {
    this.landed = false;
    const r = new Rng(derive(star.seed, 0x5a17));
    const dist = star.radius * 6 + 260;
    const a = r.range(0, Math.PI * 2);
    const px = star.pos.x + Math.cos(a) * dist;
    const py = star.pos.y + r.range(-0.25, 0.25) * dist;
    const pz = star.pos.z + Math.sin(a) * dist;
    this.placeShip(
      px, py, pz,
      Math.atan2(-(star.pos.x - px), -(star.pos.z - pz)),
      0
    );
  }

  private spawnInOrbit(target: OrbitTarget) {
    this.landed = false;
    const cx = target.universe.x;
    const cy = target.universe.y;
    const cz = target.universe.z;
    const radius = target.radius ?? target.spec?.radius ?? 12;
    const dist = radius * ORBIT_SPAWN_MUL + 60;
    const ax = ORBIT_SPAWN_AXIS;
    this.placeShip(
      cx + ax.x * dist,
      cy + ax.y * dist,
      cz + ax.z * dist,
      0, 0,
      { x: cx, y: cy, z: cz }
    );
  }

  getHomePlanet(): PlanetSpec {
    return this.homePlanetSpec;
  }

  getHomeStar(): StarSpec {
    return this.entryStar;
  }

  getLockedPlanet(): PlanetBody | null {
    return this.lockPlanet;
  }

  private descendTo(p: PlanetBody) {
    if (this.landed) return;
    this.landed = true;
    this.onDescend?.(p.spec);
  }

  private doJump() {
    if (this.warpPhase !== 'idle') return;
    if (this.lockStrength <= 0.55) return;

    if (this.lockPlanet) {
      const p = this.lockPlanet;
      this.descendTo(p);
      this.lockPlanet = null;
      this.lockStrength = 0;
      return;
    }

    if (this.lockStar) {
      const dest = this.lockStar;
      this.warpKind = 'star';
      this.warpTargetName = dest.name;
      this.warpAction = () => {
        this.jumpCount++;
        for (const planets of this.streamedPlanets.values()) {
          for (const p of planets) this.scene.remove(p.group);
        }
        for (const s of this.streamedStarBodies.values()) {
          this.scene.remove(s.group);
        }
        this.streamedPlanets.clear();
        this.streamedStarBodies.clear();
        this.streamer.clear();
        this.spawnAt(dest);
      };
      this.lockStar = null;
      this.lockStrength = 0;
      this.beginWarp();
    }
  }

  private beginWarp() {
    this.warpPhase = 'charge';
    this.warpT = 0;
    this.input.forward = false;
    this.input.back = false;
    this.input.left = false;
    this.input.right = false;
    this.input.up = false;
    this.input.down = false;
  }

  private updateWarp(dt: number) {
    if (this.warpPhase === 'idle') return;
    this.warpT += dt;

    if (this.warpPhase === 'charge') {
      const t = Math.min(1, this.warpT / SpaceScene.WARP_CHARGE_DUR);
      const ease = t * t;
      this.camera.fov = THREE.MathUtils.lerp(this.baseFov, this.baseFov - 20, ease);
      this.camera.updateProjectionMatrix();

      if (Math.random() < 0.5 + t * 0.4) {
        const a = Math.random() * Math.PI * 2;
        const r = 5 + Math.random() * 5;
        const [rx, ry, rz] = this.frame.toRender(this.ship.pos);
        const ox = Math.cos(a) * r;
        const oy = (Math.random() - 0.5) * r;
        const oz = Math.sin(a) * r;
        const dir = this.tmpV2.set(-ox, -oy, -oz).normalize();
        this.particles.burst(
          rx + ox, ry + oy, rz + oz,
          [0x9fd4ff, 0xffffff, 0x5e94e8],
          2,
          0.45,
          10 + t * 14,
          dir,
          0.3
        );
      }

      if (t >= 1) {
        this.warpAction?.();
        this.warpAction = null;
        this.warpPhase = 'flash';
        this.warpT = 0;
        this.spawnWarpBurst();
      }
      return;
    }

    if (this.warpPhase === 'flash') {
      const t = Math.min(1, this.warpT / SpaceScene.WARP_FLASH_DUR);
      this.camera.fov = THREE.MathUtils.lerp(this.baseFov - 20, this.baseFov + 34, t);
      this.camera.updateProjectionMatrix();
      if (t >= 1) {
        this.warpPhase = 'arrive';
        this.warpT = 0;
      }
      return;
    }

    const t = Math.min(1, this.warpT / SpaceScene.WARP_ARRIVE_DUR);
    const ease = 1 - Math.pow(1 - t, 3);
    this.camera.fov = THREE.MathUtils.lerp(this.baseFov + 34, this.baseFov, ease);
    this.camera.updateProjectionMatrix();
    if (t >= 1) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
      this.warpPhase = 'idle';
      this.warpT = 0;
      this.warpKind = null;
    }
  }

  private spawnWarpBurst() {
    const [rx, ry, rz] = this.frame.toRender(this.ship.pos);
    this.ship.forward(this.tmpV);
    const back = this.tmpV2.set(-this.tmpV.x, -this.tmpV.y, -this.tmpV.z);
    for (let ring = 0; ring < 4; ring++) {
      const spread = 2 + ring * 1.5;
      this.particles.burst(
        rx, ry, rz,
        [0xd8f0ff, 0xffffff, 0x8fd0ff, 0x5e94e8],
        16,
        0.55 + ring * 0.05,
        34 + ring * 10,
        back,
        spread
      );
    }
  }

  private computeTarget(
    dt: number,
    near: { entry: { key: string; star: StarSpec }; dist: number } | null
  ): TargetLock | null {
    this.ship.forward(this.tmpV);
    const fx = this.tmpV.x, fy = this.tmpV.y, fz = this.tmpV.z;
    const CONE = 0.985;

    const inSystem = near && near.dist < IN_SYSTEM_DIST;
    const curKey = inSystem ? near!.entry.key : '';

    let bestStar: StarSpec | null = null;
    let bestStarDot = -1;
    let bestStarDist = 0;

    for (const e of this.streamer.stars) {
      if (inSystem && e.key === curKey) continue;
      const dx = e.star.pos.x - this.ship.pos.x;
      const dy = e.star.pos.y - this.ship.pos.y;
      const dz = e.star.pos.z - this.ship.pos.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      const dot = (dx * fx + dy * fy + dz * fz) / len;
      if (dot < CONE) continue;
      if (dot > bestStarDot) {
        bestStarDot = dot;
        bestStar = e.star;
        bestStarDist = len;
      }
    }

    let bestPlanet: PlanetBody | null = null;
    let bestPlanetDot = -1;
    let bestPlanetDist = 0;

    if (inSystem && curKey) {
      const planets = this.streamedPlanets.get(curKey);
      if (planets) {
        for (const p of planets) {
          const dx = p.universe.x - this.ship.pos.x;
          const dy = p.universe.y - this.ship.pos.y;
          const dz = p.universe.z - this.ship.pos.z;
          const len = Math.hypot(dx, dy, dz) || 1;
          const dot = (dx * fx + dy * fy + dz * fz) / len;
          if (dot < CONE) continue;
          if (dot > bestPlanetDot) {
            bestPlanetDot = dot;
            bestPlanet = p;
            bestPlanetDist = len;
          }
        }
      }
    }

    let kind: TargetKind = 'star';
    let dotWin = bestStarDot;
    if (bestPlanet && bestPlanetDot > 0.9) {
      kind = 'planet';
      dotWin = bestPlanetDot;
    } else if (!bestStar && bestPlanet) {
      kind = 'planet';
      dotWin = bestPlanetDot;
    }

    const rawStrength = dotWin > CONE ? (dotWin - CONE) / (1 - CONE) : 0;
    this.lockStrength += (rawStrength - this.lockStrength) * Math.min(1, 8 * dt);

    if (kind === 'planet' && bestPlanet) {
      this.lockPlanet = bestPlanet;
      this.lockStar = null;
      if (this.lockStrength > 0.55) this.lastLockedPlanet = bestPlanet;
      return this.projectTarget(
        'planet',
        bestPlanet.universe,
        bestPlanet.spec.name,
        titleCase(bestPlanet.spec.type),
        bestPlanetDist,
        0,
        this.palettePreviewColor(bestPlanet)
      );
    }
    if (bestStar) {
      this.lockStar = bestStar;
      this.lockPlanet = null;
      return this.projectTarget(
        'star',
        bestStar.pos,
        bestStar.name,
        bestStar.spectral,
        bestStarDist,
        bestStar.planetCount,
        '#' + bestStar.color.toString(16).padStart(6, '0')
      );
    }

    this.lockStar = null;
    this.lockPlanet = null;
    return null;
  }

  private projectTarget(
    kind: TargetKind,
    posU: { x: number; y: number; z: number },
    name: string,
    spectral: string,
    distance: number,
    bodies: number,
    color: string
  ): TargetLock {
    const [rx, ry, rz] = this.frame.toRender(posU);
    this.tmpV2.set(rx, ry, rz).project(this.camera);
    const onScreen = this.tmpV2.z < 1;
    const sx = this.tmpV2.x * 0.5 + 0.5;
    const sy = -this.tmpV2.y * 0.5 + 0.5;
    return {
      kind,
      name,
      spectral,
      distance,
      bodies,
      color,
      sx,
      sy,
      onScreen,
      locked: this.lockStrength > 0.55,
    };
  }

  private drainBuildQueue(budgetMs: number) {
    const deadline = performance.now() + budgetMs;
    const pending: Array<{ p: PlanetBody; d: number }> = [];
    for (const planets of this.streamedPlanets.values()) {
      for (const p of planets) {
        if (!p.hasPending()) continue;
        const dx = p.universe.x - this.ship.pos.x;
        const dy = p.universe.y - this.ship.pos.y;
        const dz = p.universe.z - this.ship.pos.z;
        pending.push({ p, d: dx * dx + dy * dy + dz * dz });
      }
    }
    if (pending.length === 0) return;
    pending.sort((a, b) => a.d - b.d);
    while (performance.now() < deadline) {
      let progress = false;
      for (const item of pending) {
        if (!item.p.hasPending()) continue;
        item.p.runBuildStep();
        progress = true;
        if (performance.now() >= deadline) break;
      }
      if (!progress) break;
    }
  }

  private palettePreviewColor(p: PlanetBody): string {
    const stops = p.spec ? PLANET_PALETTES[p.spec.type].stops : null;
    if (!stops) return '#a5f3fc';
    const s = stops[Math.floor(stops.length * 0.6)][1];
    const r = Math.round(Math.min(1, s[0]) * 255);
    const g = Math.round(Math.min(1, s[1]) * 255);
    const b = Math.round(Math.min(1, s[2]) * 255);
    return '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
  }

  private captureSnapshot(dt: number): void {
    this.snapT -= dt;
    if (this.snapT > 0) return;
    this.snapT = 0.25;
    const src = this.canvas;
    if (!src.width || !src.height) return;
    if (!this.snapCanvas) this.snapCanvas = document.createElement('canvas');
    const scale = Math.min(1, 1150 / src.width);
    const w = Math.max(2, Math.round(src.width * scale));
    const h = Math.max(2, Math.round(src.height * scale));
    if (this.snapCanvas.width !== w || this.snapCanvas.height !== h) {
      this.snapCanvas.width = w;
      this.snapCanvas.height = h;
    }
    this.snapCanvas.getContext('2d')?.drawImage(src, 0, 0, w, h);
  }

  getSnapshot(): HTMLCanvasElement | null {
    return this.snapCanvas;
  }

  start() {
    this.clock.start();
    this.loop();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.pendingOrbit) {
      this.pendingOrbitT += dt;
      let done = false;
      for (const planets of this.streamedPlanets.values()) {
        for (const p of planets) {
          if (p.spec.seed === this.pendingOrbit!.seed) {
            this.pendingOrbit = null;
            this.spawnInOrbit(p);
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (this.pendingOrbit && this.pendingOrbitT > ORBIT_SNAP_TIMEOUT) {
        this.pendingOrbit = null;
      }
    }

    this.updateWarp(dt);

    const flying = this.warpPhase === 'charge' || this.warpPhase === 'flash';
    const shipInput: FlightInput = flying
      ? { forward: false, back: false, left: false, right: false, up: false, down: false, boost: true }
      : this.input;
    this.ship.update(dt, shipInput);

    this.streamer.update(this.ship.pos);

    const activeKeys = new Set<string>();
    for (const e of this.streamer.stars) {
      activeKeys.add(e.key);
      const dist = vdist(this.ship.pos, e.star.pos);

      const starVoxelRange = e.star.radius * 40;
      const isStarVoxel = dist < starVoxelRange;
      const hasStarBody = this.streamedStarBodies.has(e.key);

      if (isStarVoxel && !hasStarBody) {
        const body = this.cache.get('star:' + e.star.seed.toString(16), () => new StarBody(e.star));
        this.scene.add(body.group);
        this.streamedStarBodies.set(e.key, body);
        e.sprite.visible = false;
      } else if (!isStarVoxel && hasStarBody) {
        const body = this.streamedStarBodies.get(e.key);
        if (body) {
          this.scene.remove(body.group);
          this.streamedStarBodies.delete(e.key);
        }
        e.sprite.visible = true;
      }

      const wantPlanets = dist < PLANET_BUILD_DIST;
      const hasPlanets = this.streamedPlanets.has(e.key);
      if (wantPlanets && !hasPlanets) {
        const planets: PlanetBody[] = [];
        for (let i = 0; i < e.star.planetCount; i++) {
          const spec = planetSpec(e.star.seed, i);
          const pb = this.cache.get('planet:' + spec.seed.toString(16), () => new PlanetBody(spec));
          this.scene.add(pb.group);
          planets.push(pb);
        }
        this.streamedPlanets.set(e.key, planets);
      } else if (!wantPlanets && hasPlanets) {
        const planets = this.streamedPlanets.get(e.key);
        if (planets) {
          for (const p of planets) {
            this.scene.remove(p.group);
            p.setVoxelVisible(false);
          }
        }
        this.streamedPlanets.delete(e.key);
      }
    }

    for (const key of this.streamedPlanets.keys()) {
      if (!activeKeys.has(key)) {
        const planets = this.streamedPlanets.get(key);
        if (planets) {
          for (const p of planets) {
            this.scene.remove(p.group);
            p.setVoxelVisible(false);
          }
        }
        this.streamedPlanets.delete(key);
      }
    }
    for (const key of this.streamedStarBodies.keys()) {
      if (!activeKeys.has(key)) {
        const body = this.streamedStarBodies.get(key);
        if (body) this.scene.remove(body.group);
        this.streamedStarBodies.delete(key);
        const e = this.streamer.get(key);
        if (e) e.sprite.visible = true;
      }
    }

    this.tmpV.set(0, 3.2, 12).applyQuaternion(this.ship.quat);
    const camU = v3(
      this.ship.pos.x + this.tmpV.x,
      this.ship.pos.y + this.tmpV.y,
      this.ship.pos.z + this.tmpV.z
    );
    this.frame.update(camU);

    for (const e of this.streamer.stars) {
      const [x, y, z] = this.frame.toRender(e.star.pos);
      e.sprite.position.set(x, y, z);
    }

    const near = this.streamer.nearest(this.ship.pos);
    this.currentStar = near && near.dist < IN_SYSTEM_DIST ? near.entry.star : null;
    if (near) {
      const [lx, ly, lz] = this.frame.toRender(near.entry.star.pos);
      this.starLight.position.set(lx, ly, lz);
      this.starLight.color.setHex(near.entry.star.color);
      const falloff = Math.min(1, 1800 / Math.max(near.dist, 1));
      this.starLight.intensity = 1.7 * falloff * (near.entry.star.radius / 12);
    } else {
      this.starLight.intensity = 0;
    }

    for (const body of this.streamedStarBodies.values()) {
      const [x, y, z] = this.frame.toRender(body.spec.pos);
      body.group.position.set(x, y, z);
      body.update(dt);
    }

    const viewportH = this.renderer.domElement.height;
    const sunDirTmp = new THREE.Vector3();
    const colliders: Array<{ pos: Vec3d; radius: number }> = [];

    let nearestPlanet: PlanetBody | null = null;
    let minPlanetD = Infinity;
    this.nearPlanet = null;
    this.nearPlanetSurfaceD = Infinity;

    for (const [starKey, planets] of this.streamedPlanets) {
      const e = this.streamer.get(starKey);
      if (!e) continue;
      const starPos = e.star.pos;

      for (const p of planets) {
        p.angle += p.spec.orbitSpeed * dt;
        p.universe = planetPositionAt(starPos, p.spec, p.angle);
        const [x, y, z] = this.frame.toRender(p.universe);
        p.group.position.set(x, y, z);

        const dist = vdist(this.ship.pos, p.universe);
        p.setVoxelVisible(true);
        p.updateFade(dt);

        sunDirTmp.set(
          starPos.x - p.universe.x,
          starPos.y - p.universe.y,
          starPos.z - p.universe.z
        );
        p.animate(dt, sunDirTmp, dist, viewportH, this.camera.fov);

        if (dist - p.spec.radius < minPlanetD) {
          minPlanetD = dist - p.spec.radius;
          nearestPlanet = p;
        }
        if (dist - p.spec.radius < this.nearPlanetSurfaceD) {
          this.nearPlanetSurfaceD = dist - p.spec.radius;
          this.nearPlanet = p;
        }

        if (p.group.visible) {
          colliders.push({ pos: p.universe, radius: p.spec.radius });
        }
      }
    }

    for (const body of this.streamedStarBodies.values()) {
      colliders.push({ pos: body.spec.pos, radius: body.spec.radius });
    }
    this.ship.resolveColliders(dt, colliders);

    if (
      !this.landed &&
      this.nearPlanet &&
      this.nearPlanetSurfaceD < AUTO_LAND_MUL * this.nearPlanet.spec.radius
    ) {
      this.descendTo(this.nearPlanet);
    }

    this.ship.syncRender(this.frame);
    const [crx, cry, crz] = this.frame.toRender(camU);
    this.ship.forward(this.tmpV);
    const lookU = v3(
      this.ship.pos.x + this.tmpV.x * 25,
      this.ship.pos.y + this.tmpV.y * 25,
      this.ship.pos.z + this.tmpV.z * 25
    );
    const [lx2, ly2, lz2] = this.frame.toRender(lookU);
    if (this.camSnap) {
      this.camPos.set(crx, cry, crz);
      this.camLook.set(lx2, ly2, lz2);
      this.camSnap = false;
    } else {
      this.camPos.lerp(this.tmpV2.set(crx, cry, crz), Math.min(1, 6 * dt));
      this.camLook.lerp(this.tmpV2.set(lx2, ly2, lz2), Math.min(1, 8 * dt));
    }
    this.camera.position.copy(this.camPos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camLook);
    this.starfield.position.copy(this.camera.position);

    this.particles.update(dt);

    this.drainBuildQueue(4);

    const target = this.computeTarget(dt, near);

    const sec = this.streamer.sector;
    const gal = galaxyOfSector(sec.x, sec.y, sec.z);
    
    const inSystem = near && near.dist < IN_SYSTEM_DIST;
    const activeStar = inSystem ? near.entry.star : null;
    
    let nearest = activeStar ? activeStar.name : 'Deep Space';
    let minD = near ? near.dist - near.entry.star.radius : Infinity;
    
    if (nearestPlanet && minPlanetD < minD) {
      minD = minPlanetD;
      nearest = nearestPlanet.spec.name;
    }

    const warpDur =
      this.warpPhase === 'charge' ? SpaceScene.WARP_CHARGE_DUR :
      this.warpPhase === 'flash' ? SpaceScene.WARP_FLASH_DUR :
      this.warpPhase === 'arrive' ? SpaceScene.WARP_ARRIVE_DUR : 1;
    const warpProgress = this.warpPhase === 'idle' ? 0 : Math.min(1, this.warpT / warpDur);

    this.onHud?.({
      speed: this.ship.speed(),
      boost: this.input.boost,
      galaxy: gal.name,
      galaxyType: gal.type,
      sector: `${sec.x}, ${sec.y}, ${sec.z}`,
      density: sectorDensity(sec.x, sec.y, sec.z),
      streamed: this.streamer.count,
      star: activeStar ? activeStar.name : '—',
      spectral: activeStar ? activeStar.spectral : '—',
      bodies: activeStar ? activeStar.planetCount : 0,
      nearest,
      distance: Math.max(0, minD),
      inSystem: !!activeStar,
      warp: this.warpPhase !== 'idle',
      warpPhase: this.warpPhase,
      warpProgress,
      warpTargetKind: this.warpKind,
      warpTargetName: this.warpTargetName,
      target,
    });

    this.renderer.render(this.scene, this.camera);

    this.captureSnapshot(dt);
  };

  getExitPlanet(): PlanetBody | null {
    if (this.lockPlanet) return this.lockPlanet;
    if (this.nearPlanet && this.nearPlanetSurfaceD < EXIT_CAPTURE_MUL * this.nearPlanet.spec.radius) {
      return this.nearPlanet;
    }
    return this.lastLockedPlanet;
  }

  getLastExit(): SpaceExit | null {
    return this.lastExit;
  }

  dispose() {
    const exitPlanet = this.getExitPlanet();
    if (exitPlanet) {
      this.lastExit = {
        star: this.currentStar ?? this.entryStar,
        planet: exitPlanet.spec,
        isHome: exitPlanet.spec.seed === this.homePlanetSpec.seed,
      };
    } else {
      this.lastExit = {
        star: this.currentStar ?? this.entryStar,
        planet: null,
        isHome: false,
      };
    }
    this.onExit?.(this.lastExit);

    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    this.canvas.removeEventListener('click', this.requestLock);
    document.removeEventListener('pointerlockchange', this.onLockChange);
    document.removeEventListener('mousemove', this.onMouse);
    for (const planets of this.streamedPlanets.values()) {
      for (const p of planets) this.scene.remove(p.group);
    }
    for (const s of this.streamedStarBodies.values()) {
      this.scene.remove(s.group);
    }
    this.streamedPlanets.clear();
    this.streamedStarBodies.clear();
    this.streamer.clear();
    this.cache.clear();
    this.renderer.dispose();
  }
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
