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
  /** Fine-grained hyperjump stage so the UI can animate charge -> flash -> arrive. */
  warpPhase: WarpPhase;
  /** 0..1 progress within the current warp phase. */
  warpProgress: number;
  /** What kind of body the jump is headed for, for HUD copy. */
  warpTargetKind: TargetKind | null;
  warpTargetName: string;
  target: TargetLock | null;
}

/**
 * Only stars closer than this get a full planet system built. Planets are by
 * far the most expensive objects, so constructing them for every streamed
 * star is what tanked the frame rate.
 */
const PLANET_BUILD_DIST = 2800;

/** Distance at which the HUD/target-lock considers you "inside" a system. */
const IN_SYSTEM_DIST = 1400;

/** Orbital spawn altitude, as a multiple of the planet's radius. */
const ORBIT_SPAWN_MUL = 4;

/**
 * Fixed (never random) unit axis for orbital insertion. Using a constant
 * direction is what makes "leave the voxel world, arrive in orbit" render
 * identically every single time — same planet face, same lighting, same
 * silhouette. Slightly above the orbital plane so the planet reads as a
 * sphere rather than an edge-on disc.
 */
const ORBIT_SPAWN_AXIS = (() => {
  const a = { x: 0.82, y: 0.34, z: 0.46 };
  const len = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / len, y: a.y / len, z: a.z / len };
})();

/**
 * How close (in planet radii above the surface) you must be for a planet to
 * count as the body you are exiting/landing onto when no lock is held.
 */
const EXIT_CAPTURE_MUL = 8;

/** Seconds to keep trying to re-snap onto a not-yet-built spawn planet. */
const ORBIT_SNAP_TIMEOUT = 5;

/**
 * Distance (in planet radii above the surface) at which the ship "lands":
 * the scene hands off to the voxel world for that planet. Inside this range
 * the atmosphere winks out and the planet becomes the world you walk on.
 */
const AUTO_LAND_MUL = 1.6;

/** Descriptor handed to the scene when arriving from the voxel world. */
export interface SpaceEntry {
  /** System to arrive in. Defaults to the deterministic home star. */
  star: StarSpec;
  /** Body to enter orbit around. Defaults to planet index 0 of `star`. */
  planet?: PlanetSpec;
  /** Set false to arrive at the star itself (classic free-space spawn). */
  orbit?: boolean;
}

/** Descriptor handed back to the app when leaving space (LAND / dispose). */
export interface SpaceExit {
  /** System the ship was in when it left. */
  star: StarSpec;
  /** The planet under the ship — locked target, else nearest captured body. */
  planet: PlanetSpec | null;
  /** True when that planet is the home world the voxel game launched from. */
  isHome: boolean;
}

/**
 * Anything that can be orbited: a live PlanetBody, or a plain descriptor
 * computed before the body exists.
 */
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

// ---------------------------------------------------------------------------
// LRU Cache: manages mesh assets so memory load stays flat and we don't
// instantiate duplicates during rapid streaming.
// ---------------------------------------------------------------------------

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
        if (e.obj.group.parent) continue; // skip if mounted in scene
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

// ---------------------------------------------------------------------------

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

  // Dynamic distance-based mounts for all streamed stars
  private streamedPlanets = new Map<string, PlanetBody[]>();
  private streamedStarBodies = new Map<string, StarBody>();

  private jumpCount = 0;

  // ---- home / entry / exit descriptors ------------------------------------
  /** The system this scene was entered through. */
  private entryStar: StarSpec;
  /** Planet index 0 of the entry star — the voxel world's home planet. */
  private homePlanetSpec: PlanetSpec;
  /**
   * Orbital spawn is computed before any PlanetBody exists, so we re-snap
   * onto the real body the first frame it is built. Guarantees the framing
   * is exact no matter what orbital phase the body initialises at.
   */
  private pendingOrbit: PlanetSpec | null = null;
  private pendingOrbitT = 0;
  /** Skip the chase-camera lerp for one frame after a teleport. */
  private camSnap = false;
  /** Nearest planet this frame, for exit capture when nothing is locked. */
  private nearPlanet: PlanetBody | null = null;
  private nearPlanetSurfaceD = Infinity;
  /** Last planet a target lock actually engaged on (for exit fallback). */
  private lastLockedPlanet: PlanetBody | null = null;
  private currentStar: StarSpec | null = null;
  private lastExit: SpaceExit | null = null;

  /** Fired once when the scene is torn down, carrying the body you left on. */
  onExit?: (exit: SpaceExit) => void;

  /** Fired when the ship lands on a planet (auto-close or F descend). */
  onDescend?: (planet: PlanetSpec) => void;

  private landed = false;

  // ---- hyperjump state machine -------------------------------------------
  // idle -> charge (engines flare, FOV tightens, controls freeze) ->
  // flash (screen whites out, the instant teleport happens here so the
  // position swap is fully hidden) -> arrive (FOV eases back, a burst of
  // fast sparks streaks past to sell "just exited hyperspace") -> idle.
  private warpPhase: WarpPhase = 'idle';
  private warpT = 0;
  private warpKind: TargetKind | null = null;
  private warpTargetName = '';
  private warpAction: (() => void) | null = null;
  private baseFov = 70;
  private static readonly WARP_CHARGE_DUR = 0.55;
  private static readonly WARP_FLASH_DUR = 0.16;
  private static readonly WARP_ARRIVE_DUR = 0.75;

  // target-lock state
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

  /** rolling snapshot of the last rendered frame (seamless scene handoff) */
  private snapCanvas: HTMLCanvasElement | null = null;
  private snapT = 0;

  onHud?: (s: HudState) => void;

  constructor(private canvas: HTMLCanvasElement, entry?: SpaceEntry) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    // Cap below 2x — this scene is fill-rate bound (additive atmospheres,
    // sprites, particles), so 4x the pixels of a retina buffer is the single
    // most expensive thing we can do for almost no visual gain.
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
    // Larger cache so re-visited planets don't rebuild every fly-by.
    this.cache = new BodyCache(48, this.scene);
    this.streamer = new SectorStreamer(this.scene);

    this.bindEvents();

    // ---- entry ------------------------------------------------------------
    // No descriptor? Fall back to the deterministic home star, which is
    // findNearestPopulated(galaxyCoreSector(0,0,0)) — the same system the
    // voxel world is carved out of, so the universe is consistent even when
    // space is opened cold.
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

  /** Shared placement: teleport, snap frame origin, warm the streamer. */
  private placeShip(x: number, y: number, z: number, yaw: number, pitch = 0, aim?: Vec3d) {
    this.ship.place(x, y, z);
    if (aim) {
      // aim AT the planet: forward = -(planet - ship), yaw from atan2(-dx,-dz)
      const dx = aim.x - x;
      const dy = aim.y - y;
      const dz = aim.z - z;
      const len = Math.hypot(dx, dy, dz) || 1;
      this.ship.yaw = Math.atan2(-dx, -dz);
      // pitch: positive = up (standard FPS/flight look convention used by
      // onMouse: pitch -= movementY). Clamp to the same ±1.3 as input.
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

  /**
   * Insert the ship into a stable orbit around a body — used when arriving
   * from the voxel world, so the planet you just left is the planet right in
   * front of you. The offset direction is a fixed deterministic axis (not
   * random), so the same voxel world always produces the same orbital view.
   */
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

  /** The planet index 0 of the entry star (the voxel world's home). */
  getHomePlanet(): PlanetSpec {
    return this.homePlanetSpec;
  }

  /** The star this scene was entered through (the home star by default). */
  getHomeStar(): StarSpec {
    return this.entryStar;
  }

  /** The planet currently locked / under the ship, or null in deep space. */
  getLockedPlanet(): PlanetBody | null {
    return this.lockPlanet;
  }

  /**
   * Land on a planet: hand off to the voxel world immediately. Used by the
   * F-descend action and the close-range auto-land.
   */
  private descendTo(p: PlanetBody) {
    if (this.landed) return;
    this.landed = true;
    this.onDescend?.(p.spec);
  }

  /**
   * Arms the hyperjump — or, when a planet is locked, DESCENDS onto it.
   * The actual teleport is deferred until the charge phase completes (see
   * updateWarp) so the position swap always happens behind the screen flash
   * — never a visible pop mid-flight.
   */
  private doJump() {
    if (this.warpPhase !== 'idle') return;
    if (this.lockStrength <= 0.55) return;

    if (this.lockPlanet) {
      // F on a locked planet = descend onto it (land), not orbit-drop
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
    // Cut thrust input immediately so the ship holds roughly still while
    // engines flare — mouse-look stays live, it just doesn't fly anywhere.
    this.input.forward = false;
    this.input.back = false;
    this.input.left = false;
    this.input.right = false;
    this.input.up = false;
    this.input.down = false;
  }

  /**
   * Drives the three-stage hyperjump sequence. Called once per frame from
   * the render loop, always — cheap no-op while idle.
   */
  private updateWarp(dt: number) {
    if (this.warpPhase === 'idle') return;
    this.warpT += dt;

    if (this.warpPhase === 'charge') {
      const t = Math.min(1, this.warpT / SpaceScene.WARP_CHARGE_DUR);
      // Ease-in dolly zoom — tightens the FOV to build tension.
      const ease = t * t;
      this.camera.fov = THREE.MathUtils.lerp(this.baseFov, this.baseFov - 20, ease);
      this.camera.updateProjectionMatrix();

      // Sparks drawing inward toward the ship, converging as the charge builds.
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
        // Teleport happens exactly at the moment the screen goes white —
        // the flash phase fully hides the position swap.
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
      // Snap wide for a burst of "speed", eased so the flash phase itself
      // still feels like part of one continuous motion.
      this.camera.fov = THREE.MathUtils.lerp(this.baseFov - 20, this.baseFov + 34, t);
      this.camera.updateProjectionMatrix();
      if (t >= 1) {
        this.warpPhase = 'arrive';
        this.warpT = 0;
      }
      return;
    }

    // arrive
    const t = Math.min(1, this.warpT / SpaceScene.WARP_ARRIVE_DUR);
    const ease = 1 - Math.pow(1 - t, 3); // ease-out cubic settle
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

  /**
   * Radial burst of fast, bright sparks streaking backward past the ship —
   * the visual "you just exited hyperspace" beat, fired the instant the
   * teleport lands.
   */
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

    // Is there a star within "system distance"? (reuses the loop's scan)
    const inSystem = near && near.dist < IN_SYSTEM_DIST;
    const curKey = inSystem ? near!.entry.key : '';

    let bestStar: StarSpec | null = null;
    let bestStarDot = -1;
    let bestStarDist = 0;

    for (const e of this.streamer.stars) {
      // Exclude the parent star if we are inside its captured system boundary
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

    // Only search current-system planets for lock when in-system
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

  /**
   * Pop build steps from every resident planet, sorted by distance so the
   * planets you can actually see finish first. Hard budget in milliseconds
   * keeps the frame from blowing out even on a huge back-log after warp.
   */
  private drainBuildQueue(budgetMs: number) {
    const deadline = performance.now() + budgetMs;
    // gather pending planets with distance-sqr for cheap sorting
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
    // round-robin one step per planet per pass, respecting the deadline
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

  /**
   * Blit the just-rendered frame into a small offscreen canvas every ~250 ms
   * (same task as the render, so the WebGL bitmap is guaranteed valid). The
   * app layer grabs this on descend/exit so the last frame stays on screen
   * while the voxel world boots — no black loading cut.
   */
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

  /** The last captured frame, for the seamless space → planet handoff. */
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

    // ---- pending orbital spawn: re-snap once the real PlanetBody exists ----
    if (this.pendingOrbit) {
      this.pendingOrbitT += dt;
      let done = false;
      for (const planets of this.streamedPlanets.values()) {
        for (const p of planets) {
          if (p.spec.seed === this.pendingOrbit!.seed) {
            this.pendingOrbit = null;
            // place BEFORE the frame rebase using the body's live universe,
            // so the frame origin is exact for this frame
            this.spawnInOrbit(p);
            done = true;
            break;
          }
        }
        if (done) break;
      }
      if (this.pendingOrbit && this.pendingOrbitT > ORBIT_SNAP_TIMEOUT) {
        this.pendingOrbit = null; // give up; ship stays wherever it is
      }
    }

    this.updateWarp(dt);

    // During charge/flash the ship holds still with engines forced to full
    // burn (reuses the existing boost VFX, now safely bounded to the ship —
    // see the PointLight fix in spaceship.ts) while ignoring any stray
    // thrust key the player is still holding.
    const flying = this.warpPhase === 'charge' || this.warpPhase === 'flash';
    const shipInput: FlightInput = flying
      ? { forward: false, back: false, left: false, right: false, up: false, down: false, boost: true }
      : this.input;
    this.ship.update(dt, shipInput);

    // ---- infinite streaming: new sectors materialise as you fly ----
    this.streamer.update(this.ship.pos);

    // Dynamic capture / release of voxel stars and planets based purely on distance
    const activeKeys = new Set<string>();
    for (const e of this.streamer.stars) {
      activeKeys.add(e.key);
      const dist = vdist(this.ship.pos, e.star.pos);

      // --- 1. Manage Star Voxel Mesh vs Sprite ---
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

      // --- 2. Manage Planets for this Star ---
      // Only build planet systems for stars we are actually near. Building
      // them for every streamed star (hundreds) is what made this heavy.
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

    // --- 3. Clean up unstreamed systems ---
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

    // rebase render frame onto the chase camera
    this.tmpV.set(0, 3.2, 12).applyQuaternion(this.ship.quat);
    const camU = v3(
      this.ship.pos.x + this.tmpV.x,
      this.ship.pos.y + this.tmpV.y,
      this.ship.pos.z + this.tmpV.z
    );
    this.frame.update(camU);

    // streamed star sprites
    for (const e of this.streamer.stars) {
      const [x, y, z] = this.frame.toRender(e.star.pos);
      e.sprite.position.set(x, y, z);
    }

    // primary light from the nearest star, captured or not
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

    // ---- update all active voxel star bodies ----
    for (const body of this.streamedStarBodies.values()) {
      const [x, y, z] = this.frame.toRender(body.spec.pos);
      body.group.position.set(x, y, z);
      body.update(dt);
    }

    // ---- update all active planets across all systems ----
    // Drawing-buffer height keeps the pixel-size LOD correct on HiDPI screens.
    const viewportH = this.renderer.domElement.height;
    const sunDirTmp = new THREE.Vector3();
    const colliders: Array<{ pos: Vec3d; radius: number }> = [];

    let nearestPlanet: PlanetBody | null = null;
    let minPlanetD = Infinity;
    // reset exit-capture tracking each frame
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
        // Visibility is now decided purely by projected pixel size inside
        // the planet's own LOD pass, so this only gates the spawn fade.
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
        // exit capture: closest planet within capture range
        if (dist - p.spec.radius < this.nearPlanetSurfaceD) {
          this.nearPlanetSurfaceD = dist - p.spec.radius;
          this.nearPlanet = p;
        }

        if (p.group.visible) {
          colliders.push({ pos: p.universe, radius: p.spec.radius });
        }
      }
    }

    // Include any close voxel stars as colliders
    for (const body of this.streamedStarBodies.values()) {
      colliders.push({ pos: body.spec.pos, radius: body.spec.radius });
    }
    this.ship.resolveColliders(dt, colliders);

    // ---- auto-land: inside the atmosphere band -> descend onto the planet ----
    if (
      !this.landed &&
      this.nearPlanet &&
      this.nearPlanetSurfaceD < AUTO_LAND_MUL * this.nearPlanet.spec.radius
    ) {
      this.descendTo(this.nearPlanet);
    }

    // ship + chase camera in render space
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
      // teleport frames skip the lerp so the view never smears
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

    // ---- amortized planet construction ---------------------------------
    // The scene drains each planet's build queue under a strict per-frame
    // time budget. This is the key optimization that eliminates freeze
    // frames on both arrival in a new sector and hyper-jumps: instead of
    // building 5 LODs + clouds + rings + moons synchronously in a
    // constructor spike, work is spread over the next several frames while
    // the coarsest LOD is drawn immediately.
    this.drainBuildQueue(4 /* ms */);

    // ---- target lock (needs the up-to-date camera projection) ----
    const target = this.computeTarget(dt, near);

    // ---- HUD ----
    const sec = this.streamer.sector;
    const gal = galaxyOfSector(sec.x, sec.y, sec.z);
    
    // Nearest body for telemetry
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

    // keep a fresh frame grab ready for the seamless planet handoff
    this.captureSnapshot(dt);
  };

  /**
   * The body the ship is under right now — used when leaving space:
   *  1. the locked planet target, else
   *  2. the nearest captured planet within EXIT_CAPTURE_MUL radii, else
   *  3. the last planet a target lock engaged on.
   * Returns null only in deep space far from everything.
   */
  getExitPlanet(): PlanetBody | null {
    if (this.lockPlanet) return this.lockPlanet;
    if (this.nearPlanet && this.nearPlanetSurfaceD < EXIT_CAPTURE_MUL * this.nearPlanet.spec.radius) {
      return this.nearPlanet;
    }
    return this.lastLockedPlanet;
  }

  /** Last exit descriptor (null until dispose/LAND). */
  getLastExit(): SpaceExit | null {
    return this.lastExit;
  }

  dispose() {
    // fire exit BEFORE tearing down so the app can read the planet
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
