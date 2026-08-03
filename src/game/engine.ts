/**
 * GameEngine — the unified orchestrator.
 *
 * Merges the voxel-craft sandbox (toroidal world, mining laser, dynamic
 * water, day/night, spaceship) with the voxel-FPS combat systems (five
 * weapons, enemy AI with pathfinding, hit effects, health / waves).
 *
 * Hotbar (9 slots):
 *   1-5   handgun / smg / rifle / sniper / bazooka
 *   6     laser mining tool
 *   7-9   placeable blocks (mined blocks stack into these slots)
 */

import * as THREE from 'three';
import * as C from './core/constants';
import { createTextures, tileUV, type TextureSet } from './core/textures';
import { B, DEFS, isWaterId, applyThemeToBlockColors } from './world/blocks';
import { World } from './world/world';
import { generateCamps, buildCamp, type CampSite, type CampBuild } from './world/camps';
import { setActivePlanetTheme, planetSeedToWorldSeed } from './world/generator';
import type { PlanetTheme } from './space/theme';
import { FluidSim } from './world/fluid';
import { WATER_TIME } from './world/mesher';
import { Player, type InputState } from './player/player';
import { raycastVoxel, type RayHit } from './player/raycast';
import { Particles } from './vfx/particles';
import { Sky } from './vfx/sky';
import { LaserTool } from './vfx/laserTool';
import { SoundEngine } from './audio/sound';
import { Spaceship } from './vehicle/spaceship';
import { WeaponSystem, type GameBridge } from './fps/WeaponSystem';
import { EnemyManager } from './fps/Enemy';
import { Effects } from './fps/effects';
import { AudioSynth } from './fps/audio';
import { HeldBlockTool } from './fps/HeldBlockTool';
import { WEAPONS, WEAPON_ORDER, buildBody, MATS, box } from './fps/models';
import { Inventory, BLOCK_NAMES, FOODS } from './fps/Inventory';
import { ItemDropManager } from './fps/ItemDrop';
import { buildExtrudedItem, paintDrumstick, targetTexture } from './fps/textures';
import { Spring1 } from './fps/anim';
import type { BodyRig } from './fps/models';

interface Target {
  group: THREE.Group;
  board: THREE.Mesh;
  boardMat: THREE.MeshLambertMaterial;
  wobbleX: Spring1;
  wobbleZ: Spring1;
  flash: number;
}

export interface HotbarItem {
  id: number | string;
  name: string;
  icon: string;
  count?: number;
}

export interface HudStats {
  fps: number;
  x: number;
  y: number;
  z: number;
  biome: string;
  time: number;
  underwater: boolean;
  muted: boolean;
  isDay: boolean;
  piloting: boolean;
  shipSpeed: number;
  shipAlt: number;
  shipNear: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  campsTotal: number;
  campsCleared: number;
  enemiesAlive: number;
  dead: boolean;
  respawnIn: number;
  toolMode: 'weapon' | 'laser' | 'block' | 'food';
  weaponId: string;
  weaponName: string;
  ammo: number;
  mag: number;
  reloading: boolean;
  reloadT: number;
  inventoryOpen: boolean;
  slot: number;
  enemiesEnabled: boolean;
  mineCharge: number;
  heldBlockId: number | null;
  scoped: boolean;
  ads: number;
  hitSeq: number;
  damageSeq: number;
  demolition: number;
  blocksMined: number;
  targetsHit: number;
  session: number;
  switchAt: number;
  spread: number;
}

export interface EngineEvents {
  onProgress: (p: number, label: string) => void;
  onReady: (items: HotbarItem[], seed: number) => void;
  onLock: (locked: boolean) => void;
  onSelect: (index: number) => void;
  onStats: (s: HudStats) => void;
  /** the spaceship climbed past the atmosphere — hand off to the space scene */
  onEnterSpace?: (theme: PlanetTheme | null) => void;
}

/** altitude (blocks) where the ship breaks atmosphere and enters open space */
const SPACE_ALTITUDE = 170;

const LOAD_LABELS = [
  'Baking pixel textures',
  'Carving mountains',
  'Growing forests',
  'Filling oceans',
  'Placing torches of the sun',
];

const UNDERWATER_FOG = new THREE.Color(0x0a2a5e);

const LASER_NAME = "MK-7 'PROSPECTOR'";
const DEATH_DURATION = 4;

/** map our world block ids to voxel-fps inventory ids (they diverge after SAND) */
const TO_FPS: Record<number, number> = {
  [B.GRASS]: 1, [B.DIRT]: 2, [B.STONE]: 3, [B.SAND]: 4,
  [B.LOG]: 6, [B.LEAVES]: 7, [B.CACTUS]: 8, [B.PLANKS]: 9,
};
const FROM_FPS: Record<number, number> = Object.fromEntries(
  Object.entries(TO_FPS).map(([k, v]) => [v, Number(k)])
);

/** weapon hotbar icon palette (index -> accent color) */
const GUN_ICON_COLORS = ['#9aa4ae', '#565b3c', '#3f4650', '#6b5136', '#5d6142', '#ff8a3c'];

export class GameEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private theme: PlanetTheme | null = null;

  private textures!: TextureSet;
  private world!: World;
  private fluid!: FluidSim;
  private player!: Player;
  private sky!: Sky;
  private particles!: Particles;
  private laser!: LaserTool;
  private ship!: Spaceship;
  private sound = new SoundEngine();

  // ---- unified fps systems ----
  private fpsAudio = new AudioSynth();
  private weapons!: WeaponSystem;
  private enemies!: EnemyManager;
  camps: { site: CampSite; build: CampBuild }[] = [];
  private fx!: Effects;
  private heldBlock!: HeldBlockTool;
  private toolMode: 'weapon' | 'laser' | 'block' | 'food' = 'weapon';
  /** unified inventory (voxel-fps): 6-slot hotbar + 3x9 storage */
  public inventory = new Inventory();
  private enemiesEnabled = true;
  private triggerDown = false;
  private prevLeft = false;
  private placeCd = 0;
  private inventoryOpen = false;
  private hitSeq = 0;
  private damageSeq = 0;
  private demolition = 0;
  private blocksMined = 0;
  private mineCharge = 0;
  private switchAt = 0;
  private itemDrops!: ItemDropManager;
  private heldFood!: THREE.Group;
  private droppedGun: { mesh: THREE.Object3D; vel: THREE.Vector3; spin: THREE.Vector3; settled: boolean } | null = null;
  private targets: Target[] = [];
  private raycaster = new THREE.Raycaster();
  private body!: BodyRig;
  private bodyGroup!: THREE.Group;
  private targetsHit = 0;
  private eating = false;
  private eatT = 0;
  private biteAcc = 0;
  private readT = 0;
  private hp = 100;
  private maxHp = 100;
  private invulnT = 0;
  private dead = false;
  private deadTimer = 0;
  private kills = 0;
  private time = 0;
  private spaceExited = false;

  private piloting = false;
  private flyCam = new THREE.Vector3();
  private tmpSeat = new THREE.Vector3();
  private tmpCam = new THREE.Vector3();

  private aimPoint = new THREE.Vector3();
  private aimDir = new THREE.Vector3();
  private sparkCd = 0;

  private input: InputState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, crouch: false };
  private mouse = { left: false, right: false };
  private locked = false;
  private everLocked = false;
  private menuYaw = 0;

  private sel = 0;
  private target: RayHit | null = null;
  private breakT = 0;
  private digSoundT = 0;

  private highlight!: THREE.LineSegments;
  private crack!: THREE.Mesh;
  private crackMats: THREE.MeshBasicMaterial[] = [];

  private spawn = new THREE.Vector3();
  private bob = 0;
  private walkAcc = 0;
  private fov = 75;
  private fps = 60;
  private statT = 0;
  private wasOnGround = false;
  private prevVelY = 0;
  private wasInWater = false;
  private disposed = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: EngineEvents,
    theme?: PlanetTheme | null,
  ) {
    this.theme = theme ?? null;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 900);
    this.camera.rotation.order = 'YXZ';
    this.resize();
    window.addEventListener('resize', this.resize);
  }

  // ------------------------------------------------------------------- init

  /** the planet this world instance represents (null = legacy random world) */
  get planetTheme(): PlanetTheme | null { return this.theme; }

  async init(theme?: PlanetTheme | null): Promise<void> {
    if (theme !== undefined) this.theme = theme;
    setActivePlanetTheme(this.theme);   // TerrainGenerator picks this up inside World
    this.textures = createTextures(this.theme);
    applyThemeToBlockColors(this.theme); // tint particle/minimap colours too

    const mats = {
      opaque: new THREE.MeshLambertMaterial({ map: this.textures.atlas, vertexColors: true }),
      cutout: new THREE.MeshLambertMaterial({
        map: this.textures.atlas, vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide,
      }),
      water: new THREE.MeshLambertMaterial({
        map: this.textures.water, vertexColors: true, transparent: true, opacity: 0.78,
        side: THREE.DoubleSide,
      }),
    };
    // shader injection: per-cell flow vectors scroll the water texture,
    // so streams visibly flow, waterfalls rush down, and pools stay still
    mats.water.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = WATER_TIME;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec2 aFlow;\nvarying vec2 vFlow;'
        )
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\nvFlow = aFlow;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec2 vFlow;'
        )
        .replace(
          '#include <map_fragment>',
          `vec4 sampledDiffuseColor = texture2D( map, vMapUv + vFlow * uTime );
           diffuseColor *= sampledDiffuseColor;`
        );
    };

    // deterministic per-planet seed; only fall back to random with no theme
    const seed = this.theme
      ? planetSeedToWorldSeed(this.theme.seed)
      : (Math.random() * 0x7fffffff) | 0;
    this.world = new World(seed, mats);
    this.scene.add(this.world.group);

    // generate and build camps on terrain before chunk meshing starts (skip if ocean theme)
    if (this.theme?.id !== 'ocean') {
      const sites = generateCamps(this.world.gen, seed);
      this.camps = sites.map((site) => ({ site, build: buildCamp(this.world, site, seed) }));
    } else {
      this.camps = [];
    }

    // dynamic water: revalidate flow whenever blocks change near water
    this.fluid = new FluidSim(this.world);
    this.world.onChanged = (x, y, z, oldId, newId) => {
      if (isWaterId(oldId) || isWaterId(newId)) {
        this.fluid.pokeAround(x, y, z);
        return;
      }
      const offsets = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (const [ox, oy, oz] of offsets) {
        if (isWaterId(this.world.getBlockRaw(x + ox, y + oy, z + oz))) {
          this.fluid.pokeAround(x, y, z);
          return;
        }
      }
    };

    // re-entrant: re-tint the existing sky instead of rebuilding it
    if (this.sky) this.sky.applyTheme(this.theme?.skyHex ?? null);
    else this.sky = new Sky(this.scene, this.theme?.skyHex ?? null);
    this.particles = new Particles(this.scene);
    this.laser = new LaserTool(this.scene, this.camera);
    // ship is placed after the world exists (needed for ground sampling);
    // parked below + fully initialized once we know the spawn

    // block selection highlight + crack overlay
    this.highlight = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
      new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.75 })
    );
    this.highlight.visible = false;
    this.scene.add(this.highlight);

    this.crackMats = this.textures.cracks.map(
      (t) => new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })
    );
    this.crack = new THREE.Mesh(new THREE.BoxGeometry(1.004, 1.004, 1.004), this.crackMats[0]);
    this.crack.visible = false;
    this.crack.renderOrder = 10;
    this.scene.add(this.crack);

    // player + spawn (terrain-scanned for a pleasant, dry location)
    this.player = new Player(this.world);
    const [sx, sz] = this.world.gen.findSpawn();
    const spawnH = this.world.gen.heightAt(sx, sz);
    this.spawn.set(sx + 0.5, spawnH + 1.01, sz + 0.5);
    this.player.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);
    this.player.yaw = Math.PI / 4;
    this.menuYaw = this.player.yaw;
    // seed the world's nearest-image camera before preloading chunks
    this.world.syncChunkOffsets(this.spawn.x, this.spawn.z);
    this.world.spawn.copy(this.spawn);

    // park a ready-to-fly spaceship on nearby flat ground
    this.ship = new Spaceship(this.scene, this.world, this.particles);
    this.ship.placeNear(this.world.gen, sx, sz);

    // ---- budgeted world preload with progress ----
    const total = World.cellsInRadius(C.VIEW_DISTANCE);
    let loaded = 0;
    let labelIdx = -1;
    while (true) {
      loaded += this.world.update(this.player.pos.x, this.player.pos.z, 32);
      if (!this.world.pendingWork) break;
      const p = Math.min(0.99, loaded / total);
      const idx = Math.min(LOAD_LABELS.length - 1, Math.floor(p * LOAD_LABELS.length));
      if (idx !== labelIdx) {
        labelIdx = idx;
        this.events.onProgress(p, LOAD_LABELS[idx]);
      } else this.events.onProgress(p, LOAD_LABELS[labelIdx]);
      await this.nextFrame();
      if (this.disposed) return;
    }
    this.events.onProgress(1, 'World ready');

    // ---- unified combat systems ----
    this.fx = new Effects(this.scene, this.world, this.player.pos, (pos) => this.handleExplosion(pos));
    const bridge: GameBridge = {
      fireShot: (m, d, def) => this.fireShot(m, d, def.id),
      launchRocket: (m, d) => this.launchRocket(m, d),
      casing: (p, r, big) => this.fx.casing(p, r, big, this.player.vel),
    };
    this.weapons = new WeaponSystem(this.camera, this.player, this.fpsAudio, bridge, () => { /* HUD via stats */ });
    this.enemies = new EnemyManager(this.player, {
      world: this.world,
      effects: this.fx,
      audio: this.fpsAudio,
      camera: this.camera,
      onPlayerHit: (dmg, from) => this.damagePlayer(dmg, from),
      onEnemyKilled: () => { this.kills++; },
    }, this.camps);
    this.enemies.addScene(this.scene);
    this.heldBlock = new HeldBlockTool(this.scene, this.camera, new THREE.MeshLambertMaterial({ map: this.textures.atlas }));
    this.heldBlock.setGeometry(this.blockGeometry(B.GRASS));

    // floating voxel item drops (mined blocks magnetize back to the player)
    this.itemDrops = new ItemDropManager(this.scene, this.world, this.inventory, this.fpsAudio, () => {
      this.syncHotbarMode();
    });

    // held food — Minecraft-style extruded drumstick (each pixel = a voxel)
    this.heldFood = buildExtrudedItem(paintDrumstick, 0.017, 0.034);
    this.heldFood.position.set(0.38, -0.32, -0.52);
    this.heldFood.rotation.set(0.35, -0.55, 0.25);
    this.heldFood.scale.setScalar(1.15);
    this.heldFood.visible = false;
    this.camera.add(this.heldFood);

    // look-down shadow body (layer 2: visible only in shadows, never in FP)
    this.body = buildBody();
    this.bodyGroup = this.body.group;
    this.bodyGroup.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = false;
      }
      child.layers.set(2);
    });
    this.scene.add(this.bodyGroup);

    this.buildTargets();

    this.addListeners();

    const items: HotbarItem[] = [];
    for (let i = 0; i < 5; i++) {
      const wid = WEAPON_ORDER[i];
      items.push({ id: wid, name: WEAPONS[wid].name, icon: this.makeGunIcon(i) });
    }
    items.push({ id: 'laser', name: LASER_NAME, icon: this.makeGunIcon(5) });
    this.events.onReady(items, seed);
    this.selectSlot(2, true);
    this.events.onSelect(this.sel);

    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  private nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  // ------------------------------------------------------- unified hotbar

  private blockGeometry(id: number): THREE.BufferGeometry {
    const d = DEFS[id];
    const g = new THREE.BoxGeometry(0.19, 0.19, 0.19);
    const uv = g.attributes.uv as THREE.BufferAttribute;
    const faceTiles = [d.side, d.side, d.top, d.bottom, d.side, d.side];
    const corners: [number, number][] = [[0, 1], [1, 1], [0, 0], [1, 0]];
    for (let f = 0; f < 6; f++) {
      const [u0, v0, u1, v1] = tileUV(faceTiles[f]);
      for (let i = 0; i < 4; i++) {
        const [cu, cv] = corners[i];
        uv.setXY(f * 4 + i, u0 + (u1 - u0) * cu, v0 + (v1 - v0) * cv);
      }
    }
    uv.needsUpdate = true;
    return g;
  }

  private makeGunIcon(i: number): string {
    const size = 44;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const dark = '#22242a';
    const accent = GUN_ICON_COLORS[i];
    // body
    ctx.fillStyle = dark;
    ctx.fillRect(10, 18, 24, 9);
    // barrel
    ctx.fillRect(22, 10, 14, 6);
    // grip
    ctx.fillRect(13, 27, 8, 11);
    // accent stripe / emitter
    ctx.fillStyle = accent;
    ctx.fillRect(10, 20, 24, 3);
    if (i === 5) {
      ctx.fillRect(34, 10, 4, 6); // laser emitter tip
    } else {
      ctx.fillRect(26, 10, 4, 6); // muzzle
    }
    return c.toDataURL();
  }

  /** mine/explode a block → spawn a floating voxel item drop (magnetizes in) */
  private dropBlock(id: number, pos: THREE.Vector3): void {
    const fpsId = TO_FPS[id];
    if (fpsId === undefined) return; // not representable in the fps inventory
    this.itemDrops.spawn(fpsId, pos);
    this.blocksMined++;
  }

  /** Tab inventory — opening frees the cursor, closing re-locks it. */
  toggleInventory(open?: boolean): void {
    const want = open !== undefined ? open : !this.inventoryOpen;
    this.inventoryOpen = want;
    if (want) {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else {
      this.requestLock();
    }
  }

  toggleEnemies(enabled?: boolean): void {
    this.enemiesEnabled = enabled !== undefined ? enabled : !this.enemiesEnabled;
    this.enemies.setEnabled(this.enemiesEnabled);
  }

  /** re-run slot selection (used after inventory edits) */
  syncHotbarMode(): void {
    this.selectSlot(this.sel, true);
  }

  private selectSlot(i: number, force = false): void {
    if (i < 0 || i >= 6 || this.dead) return;
    if (i === this.sel && !force) return;
    this.sel = i;
    this.sound.playClick();
    this.events.onSelect(i);
    this.switchAt = Date.now();
    this.eating = false;
    this.eatT = 0;

    const item = this.inventory.hotbar[i];
    if (item && item.kind === 'weapon' && item.weaponId === 'laser') {
      this.toolMode = 'laser';
      this.weapons.setHolstered(true);
    } else if (item && item.kind === 'weapon') {
      this.toolMode = 'weapon';
      this.weapons.setHolstered(false);
      this.weapons.switchTo(item.weaponId);
    } else if (item && item.kind === 'block') {
      this.toolMode = 'block';
      this.weapons.setHolstered(true);
      this.heldBlock.setGeometry(this.blockGeometry(FROM_FPS[item.blockId] ?? B.STONE));
    } else if (item && item.kind === 'food') {
      this.toolMode = 'food';
      this.weapons.setHolstered(true);
    } else {
      // empty slot: sidearm
      this.toolMode = 'weapon';
      this.weapons.setHolstered(false);
      this.weapons.switchTo('handgun');
    }
    this.target = null;
    this.breakT = 0;
    this.crack.visible = false;
  }

  // ------------------------------------------------------------ practice range

  /** Shooting-range targets near spawn (wobble boards, from the voxel-fps). */
  private buildTargets(): void {
    const tex = targetTexture();
    const cx = this.spawn.x - 0.5;
    const cz = this.spawn.z - 0.5;
    const spots: [number, number, number][] = [ // dx, dz, scale
      [-5, -16, 1], [0, -17.5, 1], [5, -16, 1],
      [-9, -26, 1.15], [3, -29, 1.15],
      [-2, -40, 1.3], [12, -34, 1.3],
      [-14, -34, 1.3],
    ];
    for (const [dx, dz, s] of spots) {
      const x = Math.floor(cx + dx), z = Math.floor(cz + dz);
      const gy = this.world.gen.heightAt(x, z) + 1;
      const group = new THREE.Group();
      group.position.set(x + 0.5, gy, z + 0.5);
      // post
      box(group, 0.14, 1.7, 0.14, 0, 0.85, 0, MATS.wood);
      // board (raycastable)
      const boardMat = new THREE.MeshLambertMaterial({ map: tex });
      const woolMat = new THREE.MeshLambertMaterial({ map: MATS.skin.map });
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(0.95 * s, 1.25 * s, 0.12),
        [woolMat, woolMat, woolMat, woolMat, boardMat, boardMat]
      );
      board.position.y = 1.75 + s * 0.4;
      group.add(board);
      // cap
      box(group, 0.2, 0.1, 0.2, 0, 1.72, 0, MATS.wood);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });
      this.scene.add(group);
      this.targets.push({
        group, board, boardMat,
        wobbleX: new Spring1(140, 6), wobbleZ: new Spring1(140, 6),
        flash: 0,
      });
    }
  }

  private hitTarget(t: Target, dir: THREE.Vector3) {
    t.wobbleX.impulse(THREE.MathUtils.clamp(-dir.y * 30, -8, 8) + THREE.MathUtils.randFloatSpread(4));
    t.wobbleZ.impulse(THREE.MathUtils.randFloatSpread(9));
    t.flash = 1;
    this.fpsAudio.ding();
    this.targetsHit++;
    this.hitSeq++;
  }

  // ------------------------------------------------------------------ input

  requestLock(): void {
    this.sound.ensure();
    this.fpsAudio.unlock();
    if (document.pointerLockElement !== this.canvas) {
      try {
        const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
        if (p && typeof p.catch === 'function') p.catch(() => undefined);
      } catch {
        /* browser rejected – user can click again */
      }
    }
  }

  private addListeners(): void {
    document.addEventListener('pointerlockchange', this.onLockChange);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  private removeListeners(): void {
    document.removeEventListener('pointerlockchange', this.onLockChange);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  private onContextMenu = (e: Event): void => e.preventDefault();

  private onLockChange = (): void => {
    this.locked = document.pointerLockElement === this.canvas;
    if (this.locked) {
      this.everLocked = true;
      if (this.toolMode === 'weapon') this.weapons.setHolstered(false);
    } else {
      this.input = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, crouch: false };
      this.mouse.left = false;
      this.mouse.right = false;
      this.breakT = 0;
      this.crack.visible = false;
      this.weapons.setAllVisible(false);
      if (this.piloting) this.sound.setShip(0, 0); // idle the hum while paused
    }
    this.events.onLock(this.locked);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') {
      e.preventDefault();
      this.toggleInventory();
      return;
    }
    if (!this.locked) return;
    switch (e.code) {
      case 'KeyW': this.input.forward = true; break;
      case 'KeyS': this.input.back = true; break;
      case 'KeyA': this.input.left = true; break;
      case 'KeyD': this.input.right = true; break;
      case 'Space': this.input.jump = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': this.input.sprint = true; break;
      case 'ControlLeft': case 'ControlRight': this.input.crouch = true; e.preventDefault(); break;
      case 'KeyM': this.sound.setMuted(!this.sound.muted); break;
      case 'KeyR':
        if (this.toolMode === 'weapon') this.weapons.startReload();
        break;
      case 'KeyF':
        if (this.toolMode === 'weapon') this.weapons.inspect();
        break;
      case 'KeyE':
        if (this.piloting) this.exitShip();
        else if (this.ship && this.ship.distanceTo(this.player.eye()) < 6) this.boardShip();
        break;
      default:
        if (e.code.startsWith('Digit')) {
          const n = parseInt(e.code.slice(5), 10);
          if (n >= 1 && n <= 6) this.selectSlot(n - 1);
        }
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'KeyW': this.input.forward = false; break;
      case 'KeyS': this.input.back = false; break;
      case 'KeyA': this.input.left = false; break;
      case 'KeyD': this.input.right = false; break;
      case 'Space': this.input.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': this.input.sprint = false; break;
      case 'ControlLeft': case 'ControlRight': this.input.crouch = false; break;
    }
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    const s = 0.0022 * this.weapons.sensFactor(); // scoped -> slower aim
    this.player.yaw -= e.movementX * s;
    this.player.pitch -= e.movementY * s;
    this.player.pitch = Math.max(-1.55, Math.min(1.55, this.player.pitch));
    this.weapons.notifyLook(e.movementX, e.movementY);
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.locked || this.piloting) return;
    if (e.button === 0) {
      this.mouse.left = true;
      if (this.toolMode === 'laser') this.breakT = 0;
    } else if (e.button === 2) {
      this.mouse.right = true;
    }
  };

  private onMouseUp = (e: MouseEvent): void => {
    if (e.button === 0) {
      this.mouse.left = false;
      this.breakT = 0;
      this.crack.visible = false;
    } else if (e.button === 2) this.mouse.right = false;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    this.selectSlot((this.sel + (e.deltaY > 0 ? 1 : -1) + 6) % 6);
  };

  // -------------------------------------------------------------- main loop

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private tick = (): void => {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const fpsNow = 1 / Math.max(dt, 1e-4);
    this.fps += (fpsNow - this.fps) * 0.06;
    this.time += dt;

    if (this.locked) this.tickPlay(dt);
    else this.tickMenuCamera(dt);

    // ---- break atmosphere: high enough -> hand off to the space scene ----
    // Runs in the main tick (not tickPilot) so it fires even if the pointer
    // lock drops mid-climb; the ship continues its ballistic path regardless.
    if (!this.spaceExited && this.piloting && this.ship.pos.y > SPACE_ALTITUDE) {
      this.spaceExited = true;
      this.events.onEnterSpace?.(this.theme);
    }

    // water: per-cell flow is shader-driven (+ subtle global shimmer for pools)
    WATER_TIME.value += dt;
    this.textures.water.offset.x += dt * 0.003;
    this.textures.water.offset.y += dt * 0.006;

    this.fluid.update(dt);
    this.world.update(this.player.pos.x, this.player.pos.z, 6);
    // toroidal rendering: pull every meshed chunk to its nearest-image copy
    this.world.syncChunkOffsets(this.camera.position.x, this.camera.position.z);
    if (this.ship && !this.piloting) this.ship.updateParked(dt);
    this.particles.update(dt);
    this.sky.update(dt, this.camera.position);
    this.sound.update(dt, this.sky.isDay);
    this.applyUnderwaterFx();
    this.reportStats(dt);

    this.renderer.render(this.scene, this.camera);
  };

  private tickMenuCamera(dt: number): void {
    if (this.everLocked) {
      // paused — frozen first-person view, tools holstered
      this.syncCamera(dt);
      this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
      this.heldBlock.update(dt, false, 0);
      this.heldFood.visible = false;
      return;
    }
    // cinematic orbit while on the title screen
    this.menuYaw += dt * 0.05;
    const r = 15;
    const cx = this.spawn.x + Math.cos(this.menuYaw) * r;
    const cz = this.spawn.z + Math.sin(this.menuYaw) * r;
    this.camera.position.set(cx, this.spawn.y + 9.5, cz);
    this.camera.lookAt(this.spawn.x, this.spawn.y + 2.5, this.spawn.z);
    this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
    this.heldBlock.update(dt, false, 0);
    this.heldFood.visible = false;
  }

  private boardShip(): void {
    this.piloting = true;
    this.flyCam.copy(this.camera.position);
    this.highlight.visible = false;
    this.crack.visible = false;
    this.mouse.left = false;
    this.mouse.right = false;
    this.breakT = 0;
    this.sound.playBoard();
  }

  private exitShip(): void {
    this.piloting = false;
    this.spaceExited = false; // allow re-triggering on the next climb
    this.sound.playDisembark();
    this.sound.stopShip();
    // step out beside the ship onto safe ground
    const yaw = this.ship.yaw;
    for (const sign of [1, -1]) {
      const px = this.ship.pos.x + Math.cos(yaw) * 4.2 * sign;
      const pz = this.ship.pos.z - Math.sin(yaw) * 4.2 * sign;
      for (let y = Math.min(this.ship.pos.y + 8, 95); y > 2; y--) {
        const bx = Math.floor(px);
        const bz = Math.floor(pz);
        if (this.world.isSolid(bx, y, bz)) continue;
        if (
          !this.world.isSolid(bx, y + 1, bz) &&
          this.world.isSolid(bx, y - 1, bz)
        ) {
          this.player.setSpawn(bx + 0.5, y, bz + 0.5);
          this.player.yaw = yaw;
          return;
        }
      }
    }
    // worst case: pop out on top of the ship
    this.player.setSpawn(this.ship.pos.x, this.ship.pos.y + 3, this.ship.pos.z);
    this.player.yaw = yaw;
  }

  private tickPilot(dt: number): void {
    const p = this.player;
    this.ship.updatePilot(dt, p.yaw, p.pitch, {
      forward: this.input.forward,
      back: this.input.back,
      left: this.input.left,
      right: this.input.right,
      up: this.input.jump,
      down: this.input.sprint,
    }, this.sound);

    // player body rides along so streaming / minimap / respawn stay coherent
    p.pos.set(this.ship.pos.x, this.ship.pos.y - 0.2, this.ship.pos.z);
    p.vel.set(0, 0, 0);
    p.inWater = false;
    p.headInWater = false;
    this.wasInWater = false;

    // ---- chase camera: orbit behind the ship, clamped against terrain ----
    const yaw = p.yaw;
    const pitch = p.pitch;
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fyy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;
    this.aimDir.set(fx, fyy, fz); // reuse as view dir

    let dist = 11;
    for (let t = 0.75; t < 11.5; t += 0.5) {
      if (this.world.isSolid(
        Math.floor(this.ship.pos.x - fx * t),
        Math.floor(this.ship.pos.y + 1.2 - fyy * t),
        Math.floor(this.ship.pos.z - fz * t)
      )) {
        dist = t - 0.8;
        break;
      }
    }
    dist = Math.max(1.6, Math.min(11, dist));

    this.tmpCam.set(
      this.ship.pos.x - fx * dist,
      this.ship.pos.y + 2.3 - fyy * dist,
      this.ship.pos.z - fz * dist
    );
    this.flyCam.lerp(this.tmpCam, Math.min(1, 11 * dt));

    for (let i = 0; i < 16; i++) {
      if (!this.world.isSolid(
        Math.floor(this.flyCam.x),
        Math.floor(this.flyCam.y),
        Math.floor(this.flyCam.z)
      )) break;
      this.flyCam.x += (this.ship.pos.x - this.flyCam.x) * 0.2;
      this.flyCam.y += (this.ship.pos.y + 2.3 - this.flyCam.y) * 0.2 + 0.15;
      this.flyCam.z += (this.ship.pos.z - this.flyCam.z) * 0.2;
    }
    this.camera.position.copy(this.flyCam);

    this.tmpSeat.set(
      this.ship.pos.x + fx * 3.2,
      this.ship.pos.y + 1.0 + fyy * 3.2,
      this.ship.pos.z + fz * 3.2
    );
    this.camera.lookAt(this.tmpSeat);

    const targetFov = 75 + (this.ship.speed() / 28) * 7;
    this.fov += (targetFov - this.fov) * Math.min(1, 6 * dt);
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }

    this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
    this.heldBlock.update(dt, false, 0);
    this.heldFood.visible = false;
  }

  private tickPlay(dt: number): void {
    if (this.piloting) {
      this.tickPilot(dt);
      return;
    }
    const p = this.player;
    this.prevVelY = p.vel.y;

    // ---- death / respawn flow (world freezes, fx keep playing) ----
    if (this.dead) {
      this.deadTimer += dt;
      // slow-motion while the death scene plays (voxel-fps timeScale)
      const timeScale = THREE.MathUtils.lerp(0.35, 0.85, Math.min(1, this.deadTimer / 2.5));
      const sdt = dt * timeScale;
      this.fx.update(sdt);
      this.weapons.update(dt, this.time, false, false, false);
      // dropped gun tumbles to the dirt + item drops keep magnetizing
      this.updateDroppedWeapon(dt);
      this.itemDrops.update(sdt, this.player.pos);
      // play the voxel-fps collapse camera: buckle, topple, bounce, twitch
      this.player.updateDeath(dt);
      this.player.applyDeathCamera(this.camera);
      if (this.deadTimer >= DEATH_DURATION) this.respawn();
      return;
    }

    p.update(dt, this.input);

    // fell out of the world -> respawn
    if (p.pos.y < -12) p.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);

    // landing thud
    if (p.onGround && !this.wasOnGround && this.prevVelY < -9.5) {
      this.sound.playLand(-this.prevVelY / 12);
    }
    this.wasOnGround = p.onGround;

    // splash on water entry
    if (p.inWater && !this.wasInWater) this.sound.playSplash();
    this.wasInWater = p.inWater;

    // footsteps
    const hs = p.horizontalSpeed();
    if (p.onGround && hs > 0.8 && !p.inWater) {
      this.walkAcc += hs * dt;
      if (this.walkAcc > 2.1) {
        this.walkAcc = 0;
        this.sound.playStep(p.groundSound());
      }
    } else this.walkAcc = Math.min(this.walkAcc, 1.9);

    // head bob distance-driven
    if (p.onGround && hs > 0.5) this.bob += dt * hs * 1.6;

    // ---- unified tool modes ----
    if (this.toolMode === 'weapon') {
      this.triggerDown = this.mouse.left && !this.prevLeft;
      this.adsHeld = this.mouse.right;
      this.highlight.visible = false;
      this.crack.visible = false;
      this.heldFood.visible = false;
      this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: hs });
    } else if (this.toolMode === 'laser') {
      this.triggerDown = false;
      this.adsHeld = false;
      this.heldFood.visible = false;
      this.updateTarget();
      this.updateMining(dt);
    } else if (this.toolMode === 'food') {
      this.triggerDown = false;
      this.adsHeld = false;
      this.placeCd -= dt;
      this.updateFood(dt);
      this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: hs });
    } else {
      this.triggerDown = false;
      this.adsHeld = false;
      this.heldFood.visible = false;
      this.updateTarget();
      this.placeCd -= dt;
      this.placeBlock();
      this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: hs });
    }
    this.prevLeft = this.mouse.left;
    this.heldBlock.update(dt, this.toolMode === 'block', hs);

    const canWeapon = this.toolMode === 'weapon';
    this.weapons.update(
      dt,
      this.time,
      canWeapon && this.triggerDown,
      canWeapon && this.mouse.left,
      canWeapon && this.adsHeld
    );

    this.syncCamera(dt);

    // ---- enemies + combat state ----
    if (this.invulnT > 0) this.invulnT -= dt;
    this.enemies.update(dt);
    this.fx.update(dt);
    this.itemDrops.update(dt, this.player.pos);

    // ---- practice targets wobble ----
    for (const t of this.targets) {
      t.wobbleX.update(dt);
      t.wobbleZ.update(dt);
      t.board.rotation.x = t.wobbleX.v * 0.06;
      t.board.rotation.z = t.wobbleZ.v * 0.06;
      t.board.rotation.y = t.wobbleZ.v * 0.02;
      if (t.flash > 0) {
        t.flash = Math.max(0, t.flash - dt * 4);
        t.boardMat.emissive.setScalar(t.flash * 0.3);
      }
    }

    // ---- look-down shadow body follows the player ----
    this.bodyGroup.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.bodyGroup.rotation.y = p.yaw;
    this.body.update(p.movePhase, Math.min(1, p.speedSmooth / 6.5), !p.onGround);
    const cs = 1 - p.crouchAmt * 0.3;
    this.bodyGroup.scale.set(1, cs, 1);
  }

  private adsHeld = false;

  private syncCamera(dt: number): void {
    const p = this.player;
    const bobY = Math.abs(Math.sin(this.bob)) * 0.055;
    const bobX = Math.cos(this.bob * 0.5) * 0.02;
    this.camera.position.set(
      p.pos.x + Math.cos(p.yaw) * bobX,
      p.pos.y + C.EYE_HEIGHT + bobY,
      p.pos.z + Math.sin(p.yaw) * bobX
    );
    const shakeX = Math.sin(this.time * 31) * p.shake;
    const shakeY = Math.cos(this.time * 27) * p.shake;
    // crouched eye height
    const crouchEye = C.EYE_HEIGHT + (1.12 - C.EYE_HEIGHT) * p.crouchAmt;
    this.camera.position.y = p.pos.y + crouchEye + bobY;

    this.camera.rotation.set(p.pitch + p.recoilP + shakeX, p.yaw + p.recoilY + shakeY, 0);

    // ADS zoom + sprint FOV widen (voxel-fps style)
    const ads = this.weapons.adsT;
    const def = this.weapons.def;
    let targetFov = 75 - (75 - def.adsFov) * ads;
    if (this.input.sprint && !p.crouching && p.horizontalSpeed() > C.WALK_SPEED + 0.4) {
      targetFov += 8 * (1 - ads);
    }
    this.fov += (targetFov - this.fov) * Math.min(1, 14 * dt);
    if (Math.abs(this.fov - this.camera.fov) > 0.05) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  // ----------------------------------------------------------- interactions

  private updateTarget(): void {
    this.camera.getWorldDirection(this.aimDir);
    const eye = this.player.eye();
    this.aimPoint.copy(eye);
    const hit = raycastVoxel(this.world, eye.x, eye.y, eye.z, this.aimDir.x, this.aimDir.y, this.aimDir.z, C.REACH);

    const changed =
      (hit === null) !== (this.target === null) ||
      (hit && this.target && (hit.x !== this.target.x || hit.y !== this.target.y || hit.z !== this.target.z));

    this.target = hit;
    if (changed) this.breakT = 0;

    if (hit) {
      this.highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      this.highlight.visible = true;
      this.aimPoint.addScaledVector(this.aimDir, Math.max(0.01, hit.dist - 0.02));
    } else {
      this.highlight.visible = false;
      this.crack.visible = false;
    }
  }

  private updateMining(dt: number): void {
    const active = this.toolMode === 'laser' && !this.dead;
    if (!active || !this.mouse.left || !this.target) {
      if (!this.target) this.crack.visible = false;
      this.mineCharge = Math.max(0, this.mineCharge - dt * 1.6);
      this.laser.update(dt, { visible: active, firing: false, target: this.target ? this.aimPoint : null, charge: 0, speed: this.player.horizontalSpeed() });
      return;
    }
    const d = DEFS[this.target.id];
    if (!isFinite(d.hardness)) {
      this.crack.visible = false;
      this.laser.update(dt, { visible: true, firing: false, target: this.aimPoint, charge: 0, speed: this.player.horizontalSpeed() });
      return; // bedrock
    }

    this.digSoundT -= dt;
    if (this.digSoundT <= 0) {
      this.digSoundT = 0.24;
      this.sound.playDig(d.sound);
    }

    // laser sparks at the impact point
    this.sparkCd -= dt;
    if (this.sparkCd <= 0) {
      this.sparkCd = 0.075;
      this.particles.burst(
        this.aimPoint.x, this.aimPoint.y, this.aimPoint.z,
        [...d.colors, 0xffe6b8, 0xff8a3c, 0xfff3df],
        4, 2.4
      );
    }

    this.breakT += dt / Math.max(0.05, d.hardness);
    this.mineCharge = Math.min(1, this.breakT);
    const stage = Math.min(4, Math.floor(this.breakT * 5));
    this.crack.material = this.crackMats[stage];
    this.crack.position.set(this.target.x + 0.5, this.target.y + 0.5, this.target.z + 0.5);
    this.crack.visible = true;

    this.laser.update(dt, {
      visible: true,
      firing: true,
      target: this.aimPoint,
      charge: Math.min(1, this.breakT),
      speed: this.player.horizontalSpeed(),
    });

    if (this.breakT >= 1) {
      const { x, y, z, id } = this.target;
      this.world.setBlock(x, y, z, B.AIR);
      this.particles.burst(x + 0.5, y + 0.5, z + 0.5, DEFS[id].colors, 26, 3.6);
      this.sound.playBreak(d.sound);
      this.dropBlock(id, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
      this.enemies.notifyWorldChanged(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
      this.breakT = 0;
      this.mineCharge = 0;
      this.crack.visible = false;
      this.target = null;
      this.updateTarget();
    }
  }

  private playerIntersectsBlock(bx: number, by: number, bz: number): boolean {
    const p = this.player.pos;
    const hw = C.PLAYER_HALF_WIDTH;
    return (
      bx + 1 > p.x - hw && bx < p.x + hw &&
      by + 1 > p.y && by < p.y + C.PLAYER_HEIGHT &&
      bz + 1 > p.z - hw && bz < p.z + hw
    );
  }

  private placeBlock(): void {
    const item = this.inventory.hotbar[this.sel];
    if (!item || item.kind !== 'block' || item.count <= 0) return;
    const hit = this.target;
    if (!hit || !this.mouse.right || this.placeCd > 0) return;

    const atPlant = DEFS[hit.id].cross === true;
    const x = atPlant ? hit.x : hit.x + hit.nx;
    const y = atPlant ? hit.y : hit.y + hit.ny;
    const z = atPlant ? hit.z : hit.z + hit.nz;

    const existing = this.world.getBlockRaw(x, y, z);
    if (existing === -1) return;
    const exDef = DEFS[existing];
    const replaceable = existing === B.AIR || isWaterId(existing) || (exDef.cross ?? false);
    if (!replaceable) return;

    const ourId = FROM_FPS[item.blockId] ?? B.STONE;
    const d = DEFS[ourId];
    if (d.solid && this.playerIntersectsBlock(x, y, z)) return;

    this.world.setBlock(x, y, z, ourId);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, d.colors, 8, 1.7);
    this.sound.playPlace(d.sound);
    this.heldBlock.triggerPlace();
    this.inventory.consumeBlock({ isHotbar: true, index: this.sel });
    this.placeCd = 0.22;
    if (item.count - 1 <= 0) this.selectSlot(this.sel, true);
  }

  /**
   * Food mode — the original voxel-fps eating sequence: the extruded 3D
   * drumstick viewmodel with idle sway, a 4Hz MC chomp jab toward the mouth,
   * bite crumbs + foley, then heal + ding on finish.
   */
  private updateFood(dt: number): void {
    const item = this.inventory.hotbar[this.sel];

    // no food left / dead / not holding RMB -> cancel
    if (!item || item.kind !== 'food' || item.count <= 0 || this.dead || !this.locked) {
      this.eating = false;
      this.eatT = 0;
      this.biteAcc = 0;
      this.heldFood.visible = false;
      return;
    }

    this.heldFood.visible = true;
    this.readT += dt;

    // base MC first-person hold pose (lower-right, tilted)
    const baseX = 0.40, baseY = -0.46, baseZ = -0.56;
    const baseRX = 0.35, baseRY = -0.55, baseRZ = 0.25;

    // hold RMB to eat — release cancels instantly (exactly like Minecraft)
    if (this.mouse.right && this.locked) {
      if (!this.eating) {
        this.eating = true;
        this.eatT = 0;
        this.biteAcc = 0;
      }
    } else if (this.eating) {
      this.eating = false;
      this.eatT = 0;
      this.biteAcc = 0;
    }

    if (!this.eating) {
      // idle sway (subtle walk bob when moving)
      const bob = Math.min(1, this.player.speedSmooth / 5);
      const swx = Math.sin(this.readT * 4.5) * 0.004 * (0.35 + bob);
      const swy = -Math.abs(Math.cos(this.readT * 4.5)) * 0.005 * (0.35 + bob);
      this.heldFood.position.set(baseX + swx, baseY + swy, baseZ);
      this.heldFood.rotation.set(baseRX, baseRY, baseRZ);
      return;
    }

    // ---- Minecraft eating animation (32 ticks / 1.6s) ----
    const EAT_DUR = 1.6;
    this.eatT += dt;
    this.biteAcc += dt;
    const p = Math.min(1, this.eatT / EAT_DUR);

    // ease-in rise toward the mouth (first 20%)
    const rise = Math.min(1, p / 0.2);
    const riseE = rise * rise * (3 - 2 * rise);

    // 4Hz chomp: abs(sin) gives the "jab up, fall down" triangle bob
    const raw = Math.sin(this.eatT * 4.0 * Math.PI * 2);
    const chomp = Math.abs(raw);
    const chompDir = raw >= 0 ? 1 : -1;
    const amp = 0.026 + p * 0.018;

    this.heldFood.position.set(
      baseX - riseE * 0.07,                    // slide toward center
      baseY + riseE * 0.11 + chomp * amp,      // jab up toward the mouth
      baseZ + riseE * 0.06 - chomp * 0.012
    );
    this.heldFood.rotation.set(
      baseRX + riseE * 0.25 + chomp * 0.35,   // tip forward into mouth
      baseRY + riseE * 0.2,
      baseRZ + chompDir * chomp * 0.12        // roll wobble per chomp
    );

    // bite SFX + crumb particles every ~0.25s (one per chomp cycle)
    if (this.biteAcc > 0.25) {
      this.biteAcc = 0;
      this.fpsAudio.foley('grab');
      this.camera.getWorldDirection(this.aimDir);
      const mouth = this.camera.position.clone()
        .addScaledVector(this.aimDir, 0.3)
        .add(new THREE.Vector3(0, -0.05, 0));
      for (let i = 0; i < 5; i++) {
        this.fx.spawnParticle(
          mouth,
          new THREE.Vector3(
            (Math.random() - 0.5) * 1.8,
            -0.5 + Math.random() * 1.2,
            (Math.random() - 0.5) * 1.8
          ),
          [0xa05a28, 0xc87838, 0x7a4018, 0xd89850, 0xe8e0c8][i % 5],
          0.015 + Math.random() * 0.018,
          0.35 + Math.random() * 0.3,
          true
        );
      }
    }

    // finished: consume, heal, ding, final crumb burst, refresh hotbar
    if (p >= 1) {
      this.eating = false;
      this.eatT = 0;
      this.inventory.consumeAt({ isHotbar: true, index: this.sel });
      const food = FOODS[item.foodId];
      this.hp = Math.min(this.maxHp, this.hp + (food?.heal ?? 10));
      this.fpsAudio.ding();
      const head = this.camera.position.clone().addScaledVector(this.aimDir, 0.32);
      for (let i = 0; i < 8; i++) {
        this.fx.spawnParticle(
          head,
          new THREE.Vector3((Math.random() - 0.5) * 2.2, Math.random() * 1.5, (Math.random() - 0.5) * 2.2),
          [0xa05a28, 0xc87838, 0xe8e0c8][i % 3],
          0.02 + Math.random() * 0.02, 0.5 + Math.random() * 0.3, true
        );
      }
      this.syncHotbarMode();
    }
  }

  // ------------------------------------------------------------ combat

  private damagePlayer(dmg: number, from: THREE.Vector3): void {
    if (this.dead || this.invulnT > 0 || !this.locked || this.piloting) return;
    this.hp = Math.max(0, this.hp - dmg);
    this.damageSeq++;
    this.fpsAudio.hurt();
    this.player.addShake(0.012);
    if (this.hp <= 0) this.killPlayer(from);
  }

  private killPlayer(from?: THREE.Vector3): void {
    this.dead = true;
    this.deadTimer = 0;
    if (this.toolMode === 'weapon') {
      this.weapons.startDeath();
      this.spawnDroppedWeapon();
    }
    this.fpsAudio.playerDie();
    // begin the collapse — the camera topples away from the killer
    this.player.startDeath(from);
    const head = this.camera.position.clone();
    for (let i = 0; i < 16; i++) {
      this.fx.spawnParticle(
        head,
        new THREE.Vector3((Math.random() - 0.5) * 4, Math.random() * 3, (Math.random() - 0.5) * 4),
        [0xd0342c, 0x8e1f18, 0x5c1410][i % 3],
        0.04 + Math.random() * 0.04, 0.9 + Math.random() * 0.5, true
      );
    }
  }

  /** Clone the current viewmodel into the world so it tumbles to the dirt. */
  private spawnDroppedWeapon() {
    const rig = this.weapons.rig;
    const gun = rig.gun.clone(true);
    const wp = new THREE.Vector3();
    const wq = new THREE.Quaternion();
    rig.gun.getWorldPosition(wp);
    rig.gun.getWorldQuaternion(wq);
    gun.position.copy(wp);
    gun.quaternion.copy(wq);
    gun.scale.set(1, 1, 1);
    gun.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.frustumCulled = true; }
    });
    this.scene.add(gun);

    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    this.droppedGun = {
      mesh: gun,
      vel: fwd.multiplyScalar(1.5).add(new THREE.Vector3((Math.random() - 0.5) * 0.9, 1.1, (Math.random() - 0.5) * 0.9)),
      spin: new THREE.Vector3((Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7, (Math.random() - 0.5) * 7),
      settled: false,
    };
  }

  private updateDroppedWeapon(dt: number) {
    const g = this.droppedGun;
    if (!g || g.settled) return;
    g.vel.y -= 22 * dt;
    g.mesh.position.addScaledVector(g.vel, dt);
    g.mesh.rotation.x += g.spin.x * dt;
    g.mesh.rotation.y += g.spin.y * dt;
    g.mesh.rotation.z += g.spin.z * dt;
    const bx = Math.floor(g.mesh.position.x);
    const by = Math.floor(g.mesh.position.y - 0.06);
    const bz = Math.floor(g.mesh.position.z);
    if (this.world.solid(bx, by, bz) && g.vel.y < 0) {
      g.mesh.position.y = by + 1.07;
      g.vel.y *= -0.3;
      g.vel.x *= 0.5; g.vel.z *= 0.5;
      g.spin.multiplyScalar(0.42);
      this.fpsAudio.foley('grab');
      if (Math.abs(g.vel.y) < 0.7) {
        g.settled = true;
        g.vel.set(0, 0, 0);
        g.spin.set(0, 0, 0);
        g.mesh.rotation.x = 0;   // lie flat on the ground
        g.mesh.rotation.z = 0;
      }
    }
  }

  private respawn(): void {
    this.dead = false;
    this.deadTimer = 0;
    this.hp = this.maxHp;
    this.invulnT = 2;
    this.player.resetDeath();
    this.player.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);
    this.player.yaw = Math.PI / 4;
    this.player.pitch = 0;
    this.weapons.resetDeath();
    if (this.droppedGun) { this.scene.remove(this.droppedGun.mesh); this.droppedGun = null; }
    this.mineCharge = 0;
    this.eating = false;
    this.eatT = 0;
    this.enemies.clear(this.scene);
    this.selectSlot(this.sel, true);
  }

  private fireShot(muzzle: THREE.Vector3, dir: THREE.Vector3, weaponId: string): void {
    const origin = this.camera.position.clone();
    const worldHit = this.world.raycast(origin, dir, 130);
    this.enemies.alertNearby(origin, weaponId === 'sniper' ? 70 : 50);
    const enemyHit = this.enemies.raycast(origin, dir, 130);

    // practice targets (raycast boards)
    let targetHit: { t: Target; dist: number; point: THREE.Vector3 } | null = null;
    this.raycaster.set(origin, dir);
    this.raycaster.far = 130;
    for (const t of this.targets) {
      const hits = this.raycaster.intersectObject(t.board, false);
      if (hits.length) {
        const h = hits[0];
        if (!targetHit || h.distance < targetHit.dist) targetHit = { t, dist: h.distance, point: h.point.clone() };
      }
    }

    const useEnemy = enemyHit && (!worldHit || enemyHit.dist < worldHit.dist - 0.05) && (!targetHit || enemyHit.dist < targetHit.dist - 0.05);
    const useTarget = !useEnemy && targetHit && (!worldHit || targetHit.dist < worldHit.dist - 0.05);
    const end = useEnemy ? enemyHit!.point : useTarget ? targetHit!.point : worldHit ? worldHit.point : origin.clone().addScaledVector(dir, 130);

    const muzzleBone = this.weapons.rig.muzzle;
    this.fx.tracer(muzzle, end, muzzleBone);
    this.fx.muzzleFlash(muzzle, weaponId === 'sniper' ? 1.6 : 1, muzzleBone);

    if (useEnemy) {
      const eh = enemyHit!;
      eh.enemy.takeDamage(weaponId === 'sniper' ? 50 : weaponId === 'bazooka' ? 999 : 12, eh.point, eh.headshot);
      this.hitSeq++;
      if (eh.headshot) this.fpsAudio.headshot(); else this.fpsAudio.enemyHit();
    } else if (useTarget) {
      this.hitTarget(targetHit!.t, dir);
      this.fx.puff(targetHit!.point, dir.clone().negate(), 0.25, 0.5, '#ffffff');
    } else if (worldHit) {
      this.fx.impact(worldHit.point, worldHit.normal, worldHit.block);
      if ((worldHit.block === B.STONE || worldHit.block === B.GRAVEL) && Math.random() < 0.3) {
        this.fpsAudio.ricochet();
      }
    }
  }

  private launchRocket(muzzle: THREE.Vector3, dir: THREE.Vector3): void {
    this.fx.launchRocket(muzzle.clone().addScaledVector(dir, 0.4), dir);
    this.fpsAudio.whoosh();
    this.player.addShake(0.03);
  }

  private handleExplosion(pos: THREE.Vector3): void {
    const dist = pos.distanceTo(this.player.pos);
    this.enemies.damageInRadius(pos, 3.4, 120);
    const destroyed = this.world.destroySphere(pos, 2.9, (x, y, z, id) => {
      this.dropBlock(id, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    });
    if (destroyed > 0) {
      this.demolition += destroyed;
      this.enemies.notifyWorldChanged(pos, 34);
      for (let i = 0; i < Math.min(14, destroyed); i++) {
        this.fx.spawnParticle(
          pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2, Math.random(), (Math.random() - 0.5) * 2)),
          new THREE.Vector3((Math.random() - 0.5) * 9, 4 + Math.random() * 8, (Math.random() - 0.5) * 9),
          0xd8cd9c, 0.08 + Math.random() * 0.06, 0.9 + Math.random() * 0.6, true
        );
      }
    }
    this.fpsAudio.explosion(dist);
    this.player.addShake(THREE.MathUtils.clamp(0.05 - dist * 0.0022, 0.004, 0.05));
  }

  // ------------------------------------------------------------------- misc

  private applyUnderwaterFx(): void {
    const fog = this.scene.fog as THREE.Fog | null;
    if (!fog) return;
    if (this.player.headInWater) {
      fog.color.copy(UNDERWATER_FOG);
      fog.near = 1;
      fog.far = 20;
    }
  }

  private reportStats(dt: number): void {
    this.statT -= dt;
    if (this.statT > 0) return;
    this.statT = 0.25;
    const p = this.player.pos;
    let shipAlt = 0;
    if (this.piloting && this.ship) {
      for (let y = Math.floor(this.ship.pos.y); y > 0; y--) {
        if (this.world.isSolid(Math.floor(this.ship.pos.x), y, Math.floor(this.ship.pos.z))) {
          shipAlt = Math.round(this.ship.pos.y - y);
          break;
        }
      }
    }
    const selItem = this.inventory.hotbar[this.sel] ?? null;
    const weaponId =
      selItem && selItem.kind === 'weapon' ? selItem.weaponId :
      this.toolMode === 'laser' ? 'laser' : 'block';
    const weaponName =
      selItem && selItem.kind === 'weapon' ? (WEAPONS[selItem.weaponId]?.name ?? LASER_NAME) :
      selItem && selItem.kind === 'food' ? (FOODS[selItem.foodId]?.name ?? 'Food') :
      selItem && selItem.kind === 'block' ? (BLOCK_NAMES[selItem.blockId] ?? 'Block') :
      LASER_NAME;
    const ammo =
      selItem && (selItem.kind === 'block' || selItem.kind === 'food') ? selItem.count :
      this.toolMode === 'weapon' ? this.weapons.ammoInfo.ammo : -1;
    const mag = this.toolMode === 'weapon' ? this.weapons.ammoInfo.mag : selItem && selItem.kind === 'block' ? 64 : 0;
    this.events.onStats({
      fps: Math.round(this.fps),
      x: Math.floor(C.wrapBlock(p.x)),
      y: Math.floor(p.y),
      z: Math.floor(C.wrapBlock(p.z)),
      biome: this.world.gen.biomeDefAt(Math.floor(p.x), Math.floor(p.z)).name,
      time: this.sky.time,
      underwater: this.player.headInWater,
      muted: this.sound.muted,
      isDay: this.sky.isDay,
      piloting: this.piloting,
      shipSpeed: Math.round(this.ship ? this.ship.speed() : 0),
      shipAlt,
      shipNear: !this.piloting && !!this.ship && this.ship.distanceTo(this.player.eye()) < 6,
      hp: Math.max(0, Math.round(this.hp)),
      maxHp: this.maxHp,
      kills: this.kills,
      campsTotal: this.enemies.campsTotal,
      campsCleared: this.enemies.campsCleared,
      enemiesAlive: this.enemies.aliveCount,
      dead: this.dead,
      respawnIn: Math.max(0, Math.ceil(DEATH_DURATION - this.deadTimer)),
      toolMode: this.toolMode,
      weaponId,
      weaponName,
      ammo,
      mag,
      reloading: this.weapons.reloading,
      reloadT: this.weapons.reloadProgress,
      inventoryOpen: this.inventoryOpen,
      slot: this.sel,
      enemiesEnabled: this.enemiesEnabled,
      mineCharge: this.mineCharge,
      heldBlockId:
        selItem && selItem.kind === 'block' && this.toolMode === 'block' ? selItem.blockId : null,
      scoped: this.weapons.scoped,
      ads: this.weapons.adsT,
      hitSeq: this.hitSeq,
      damageSeq: this.damageSeq,
      demolition: this.demolition,
      blocksMined: this.blocksMined,
      targetsHit: this.targetsHit,
      session: 1 - (this.time % 300) / 300,
      switchAt: this.switchAt,
      spread:
        7 + this.weapons.bloomPx * 26 +
        Math.min(1, this.player.speedSmooth / 6) * 9 * (1 - this.weapons.adsT * 0.9),
    });
  }

  /** used by the minimap overlay */
  getWorld(): World {
    return this.world;
  }

  getPlayer(): Player {
    return this.player;
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.sound.stopShip();
    this.itemDrops?.clear();
    this.removeListeners();
    window.removeEventListener('resize', this.resize);
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments || o instanceof THREE.Points) {
        o.geometry.dispose();
        const m = o.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
        else m.dispose();
      }
    });
    this.renderer.dispose();
  }
  getCamps(): { x: number; z: number; cleared: boolean }[] {
    return this.enemies.camps.map((c) => ({
      x: c.site.cx,
      z: c.site.cz,
      cleared: c.cleared,
    }));
  }
}
