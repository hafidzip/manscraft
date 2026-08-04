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
import { WATER_TIME, GRASS_TIME, GRASS_CAM, GRASS_FADE } from './world/mesher';
import { Player, type InputState } from './player/player';
import { raycastVoxel, type RayHit } from './player/raycast';
import { Particles } from './vfx/particles';
import { Sky } from './vfx/sky';
import { LaserTool } from './vfx/laserTool';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { DepthFogPass } from './vfx/depthFog';
import { VolumetricLightPass } from './vfx/volumetric';
import { FOG_UNIFORMS } from './vfx/heightFog';
import { SoundEngine } from './audio/sound';
import { Spaceship } from './vehicle/spaceship';
import { WeaponSystem, type GameBridge } from './fps/WeaponSystem';
import { EnemyManager } from './fps/Enemy';
import { Effects } from './fps/effects';
import { AudioSynth } from './fps/audio';
import { HeldBlockTool } from './fps/HeldBlockTool';
import { WEAPONS, WEAPON_ORDER, buildBody } from './fps/models';
import { Inventory, BLOCK_NAMES, FOODS, type SlotItem } from './fps/Inventory';
import { matchCraft, craftableCount, RECIPES, recipeIngredients } from './crafting/recipes';
import {
  newFurnace, tickFurnace, furnaceIdle, furnaceKey, isFuel, smeltResult, SMELT_TIME,
  type FurnaceState,
} from './crafting/smelting';
import { ItemDropManager } from './fps/ItemDrop';
import { buildExtrudedItem, paintDrumstick } from './fps/textures';
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
  craftingOpen: boolean;
  /** true while a furnace UI is open */
  furnaceOpen: boolean;
  /** 0..1 flame gauge and smelt-arrow progress for the open furnace */
  furnaceBurn: number;
  furnaceCook: number;
  slot: number;
  enemiesEnabled: boolean;
  mineCharge: number;
  heldBlockId: number | null;
  scoped: boolean;
  ads: number;
  hitSeq: number;
  damageSeq: number;
  /** bearing of the last hit in view space: 0 = ahead, +π/2 = right, ±π = behind */
  dmgAngle: number;
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
  [B.CRAFTING_TABLE]: 14, [B.GLASS]: 15, [B.FURNACE]: 16, [B.FURNACE_LIT]: 16,
  [B.COBBLE]: 11,
  // gemstones map to unused high ids in the fps inventory
  [B.ORE_RUBY]: 50, [B.ORE_AMBER]: 51, [B.ORE_LUMINESCENCE]: 52,
  [B.ORE_DIAMOND]: 53, [B.ORE_GOLD]: 54, [B.ORE_SILVER]: 55,
  [B.ORE_JADE]: 56, [B.ORE_EMERALD]: 57,
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
  public inventory!: Inventory;
  private enemiesEnabled = true;
  private triggerDown = false;
  private prevLeft = false;
  private placeCd = 0;

  // ---- post-processing pipeline (built in init, disposed in dispose) ----
  private composer: EffectComposer | null = null;
  private composerRT: THREE.WebGLRenderTarget | null = null;
  private depthFogPass: DepthFogPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private volumetricLight: VolumetricLightPass | null = null;
  /** camera-mounted night torch */
  private flashlight: THREE.SpotLight | null = null;
  private flashlightTarget = new THREE.Object3D();
  /** shadow-map refresh guards */
  private lastShadowX = 1e9;
  private lastShadowZ = 1e9;
  private lastSunElev = 1e9;
  /** minimum seconds between two shadow-map re-renders */
  private shadowCooldown = 0;
  /** true while the moon is the scene's key (shadow-casting) light */
  private moonIsKey = false;
  private inventoryOpen = false;
  private craftingOpen = false;
  /** every placed furnace's contents + burn state, keyed by block position */
  private furnaces = new Map<string, FurnaceState>();
  /** the furnace whose UI is open (null = closed) */
  private openFurnaceKey: string | null = null;
  private hitSeq = 0;
  private damageSeq = 0;
  private dmgAngle = 0;
  private dmgFollowT = 0;
  private lastDamageFrom = new THREE.Vector3();
  private hasDamageFrom = false;
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
  private blockGeomCache = new Map<number, THREE.BufferGeometry>();

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
  /** rolling snapshot of the last rendered frame (seamless scene handoff) */
  private snapCanvas: HTMLCanvasElement | null = null;
  private snapT = 0;

  constructor(
    private canvas: HTMLCanvasElement,
    private events: EngineEvents,
    theme?: PlanetTheme | null,
    /** Optional persistent inventory (survives planet hops when provided) */
    persistentInventory?: Inventory,
    /** Camp IDs that were cleared on a previous visit (cross-planet persistence) */
    private initialClearedCamps?: number[],
    /**
     * Warm re-entry (planet hop from space): preload only a tight ring of
     * chunks and stream the rest in during play, so the descent feels instant
     * instead of showing a loading cut.
     */
    private fastStart = false,
  ) {
    this.theme = theme ?? null;
    // Use provided inventory or create fresh one
    this.inventory = persistentInventory ?? new Inventory();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ---- post pipeline: soft PCF sun shadows, Reinhard tone mapping ----
    // Reinhard (not ACES) preserves grass/block/shadow mid-tones in this
    // Lambert voxel renderer — ACES crushes the dark faces too hard.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ReinhardToneMapping;
    this.renderer.toneMappingExposure = 0.88;

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
      // grass receives shadows like terrain but never casts; the sway +
      // distance-collapse shader is injected below
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
    // grass blade sway + distance collapse. Blade geometry (root at the
    // block base, tips at +h) is built by the mesher; aSway carries
    // (phase, strength, topWeight, height). The shader only adds wind sway
    // at the tips and folds distant blades down into the ground (cheap LOD,
    // no re-mesh). Root/tip shading is already baked into vertex colours.
    mats.cutout.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassTime = GRASS_TIME;
      shader.uniforms.uGrassCam = GRASS_CAM;
      shader.uniforms.uGrassFade = GRASS_FADE;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec4 aSway;
           uniform float uGrassTime;
           uniform vec3 uGrassCam;
           uniform vec2 uGrassFade;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float gPlant = step(0.001, aSway.y);
           float gTw = aSway.z;
           float gH = aSway.w;
           float gDist = distance((modelMatrix * vec4(position, 1.0)).xz, uGrassCam.xz);
           float gCol = 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, gDist);
           vec3 gWind = vec3(cos(aSway.x * 1.7), 0.0, sin(aSway.x * 1.3));
           float gSw = sin(uGrassTime * 1.9 + aSway.x) * aSway.y;
           vec3 gP = position;
           gP += gWind * (gSw * gTw);
           gP.y -= gTw * gH * (1.0 - gCol);
           transformed = mix(position, gP, gPlant);`
        );
      // upward-biased normals kill angle-dependent black back faces while
      // still answering the shadow map exactly like the grass_top surface
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <normal_fragment_begin>',
          `vec3 normal = normalize( vec3( vNormal.x * 0.25, abs(vNormal.y) + 0.9, vNormal.z * 0.25 ) );`
        );
    };

    // deterministic per-planet seed; only fall back to random with no theme
    const seed = this.theme
      ? planetSeedToWorldSeed(this.theme.seed)
      : (Math.random() * 0x7fffffff) | 0;
    this.world = new World(seed, mats);
    this.scene.add(this.world.group);

    // Generate camps for every planet type. Ocean worlds still receive camps
    // on their deterministic dry islands; the generator itself filters out
    // underwater footprints using the active planet sea level.
    const sites = generateCamps(this.world.gen, seed);
    this.camps = sites.map((site) => ({ site, build: buildCamp(this.world, site, seed) }));

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

    // ---- celestial shadows: sun by day, moon by night. Both lights share
    // the same compact PCF shadow settings; intensities cross-fade in Sky.
    for (const light of [this.sky.sun, this.sky.moon]) {
      light.castShadow = true;
      light.shadow.mapSize.set(1024, 1024);
      light.shadow.camera.left = -62;
      light.shadow.camera.right = 62;
      light.shadow.camera.top = 62;
      light.shadow.camera.bottom = -62;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 180;
      light.shadow.bias = -0.0003;
      light.shadow.normalBias = 0.15;
      light.shadow.radius = 2;
    }

    // ---- post pipeline: depth fog -> bloom -> god rays -> output ----
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.composerRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });
    this.composerRT.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.composerRT.depthTexture.type = THREE.UnsignedIntType;

    this.composer = new EffectComposer(this.renderer, this.composerRT);
    // RenderPass draws the scene into the composer's *read* buffer (the
    // cloned second RT), so that buffer also needs a depth texture for the
    // fog pass to reconstruct world positions.
    const rt2 = this.composer.renderTarget2;
    rt2.depthTexture = new THREE.DepthTexture(size.x, size.y);
    rt2.depthTexture.type = THREE.UnsignedIntType;
    this.composer.addPass(new RenderPass(this.scene, this.camera));

    this.depthFogPass = new DepthFogPass(this.camera);
    this.depthFogPass.material.uniforms.tDepth.value = this.composerRT.depthTexture;
    this.composer.addPass(this.depthFogPass);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.55, 0.82);
    this.composer.addPass(this.bloom);

    this.volumetricLight = new VolumetricLightPass(this.scene, this.camera, size.x, size.y);
    this.composer.addPass(this.volumetricLight);

    this.composer.addPass(new OutputPass());

    // ---- camera-mounted flashlight for night exploration ----
    // Slightly warm, tighter cone: reads as a carried torch cutting through
    // mist rather than a flat white wash.
    this.flashlight = new THREE.SpotLight(
      0xfff0d8, 0, 58, THREE.MathUtils.degToRad(42), 0.62, 1.5,
    );
    // Mounted BEHIND the eye (+z is backwards in view space). The old -1.1
    // put the cone origin a block and a bit in front of the camera, so any
    // wall closer than that fell entirely behind the spotlight and stayed
    // pitch black while you were pressed against it.
    this.flashlight.position.set(0.12, -0.16, 0.55);
    this.flashlightTarget.position.set(0, -1.2, -30);
    this.camera.add(this.flashlight);
    this.camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;

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
    const startInShip = this.theme !== null;
    if (startInShip) {
      this.ship.enterAtmosphere(this.world.gen, this.spawn.x, this.spawn.z, this.player.yaw);
      this.player.setSpawn(this.ship.pos.x, this.ship.pos.y - 0.2, this.ship.pos.z);
      this.player.yaw = this.ship.yaw;
      this.player.pitch = -0.16;
      this.menuYaw = this.player.yaw;
    }

    // ---- budgeted world preload with progress ----
    // Warm re-entries only preload a tight 3-chunk ring (≈instant) and let the
    // main loop stream the rest in while the player is already controlling the
    // ship — the transition overlay covers any horizon pop-in.
    const preloadRadius = this.fastStart ? 3 : C.VIEW_DISTANCE;
    const total = World.cellsInRadius(preloadRadius);
    let loaded = 0;
    let labelIdx = -1;
    while (true) {
      loaded += this.world.update(this.player.pos.x, this.player.pos.z, this.fastStart ? 48 : 32);
      if (this.fastStart ? loaded >= total : !this.world.pendingWork) break;
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
    // Restore cleared camp state from a previous visit to this planet
    if (this.initialClearedCamps?.length) {
      this.enemies.markCampsCleared(this.initialClearedCamps);
    }
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
    if (startInShip) this.boardShip();

    this.clock.start();
    this.renderer.setAnimationLoop(this.tick);
  }

  private nextFrame(): Promise<void> {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  /**
   * Blit the just-rendered frame into a small offscreen canvas every ~250 ms
   * (same task as the render, so the WebGL bitmap is guaranteed valid — no
   * preserveDrawingBuffer needed). The app layer grabs this when the ship
   * breaks atmosphere so the last frame stays on screen while the space scene
   * boots: that's what makes the handoff feel like one continuous shot.
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

  /** The last captured frame, for the seamless planet → space handoff. */
  getSnapshot(): HTMLCanvasElement | null {
    return this.snapCanvas;
  }

  // ------------------------------------------------------- unified hotbar

  private blockGeometry(id: number): THREE.BufferGeometry {
    const cached = this.blockGeomCache.get(id);
    if (cached) return cached;

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
    this.blockGeomCache.set(id, g);
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

  // ---------------------------------------------------------------- crafting

  /** open the inventory at the 2×2 pocket grid or the 3×3 table grid */
  openCrafting(table: boolean): void {
    if (table) this.inventory.setCraftSize(3);
    else this.inventory.setCraftSize(2);
    this.toggleInventory(true);
  }

  /**
   * Commit `times` crafts of whatever the grid currently matches: consume one
   * ingredient per filled cell per craft, hand the output to the inventory.
   * Atomic — refuses to consume when the output would not fit.
   */
  takeCraftResult(times: number): boolean {
    const inv = this.inventory;
    const recipe = matchCraft(inv.craftCells, inv.craftSize);
    if (!recipe) return false;
    const s = inv.craftSize;
    const possible = Math.min(times, craftableCount(inv.craft, s));
    if (possible <= 0) return false;
    const base = recipe.output;
    const out: SlotItem = base.kind === 'weapon'
      ? { ...base }
      : { ...base, count: (base.count ?? 1) * possible };
    if (!inv.canAdd(out)) return false;
    for (let i = 0; i < s * s; i++) {
      const it = inv.craft[i];
      if (it && it.kind === 'block') {
        it.count -= possible;
        if (it.count <= 0) inv.craft[i] = null;
      }
    }
    inv.addItem(out);
    this.sound.playPlace('wood');
    return true;
  }

  /**
   * Console recipe-book craft: pull ingredients straight out of storage and
   * hand over the output. Returns how many crafts actually happened (0 when
   * ingredients or space run out). Keeps the book a pure read-the-recipe /
   * click-to-craft flow like the console edition.
   */
  craftRecipe(id: string, times: number): number {
    const recipe = RECIPES.find((r) => r.id === id);
    if (!recipe || times <= 0) return 0;
    const inv = this.inventory;

    const need = new Map<number, number>();
    for (const ing of recipeIngredients(recipe))
      need.set(ing.blockId, (need.get(ing.blockId) ?? 0) + 1);

    let possible = times;
    for (const [bid, per] of need) {
      let have = 0;
      for (const arr of [inv.hotbar, inv.mainInv])
        for (const s of arr) if (s && s.kind === 'block' && s.blockId === bid) have += s.count;
      possible = Math.min(possible, Math.floor(have / per));
    }
    if (possible <= 0) return 0;

    const base = recipe.output;
    const out: SlotItem = base.kind === 'weapon'
      ? { ...base }
      : { ...base, count: (base.count ?? 1) * possible };
    if (!inv.canAdd(out)) return 0;

    for (const [bid, per] of need) {
      let left = per * possible;
      for (const arr of [inv.hotbar, inv.mainInv]) {
        for (let i = 0; i < arr.length && left > 0; i++) {
          const s = arr[i];
          if (s && s.kind === 'block' && s.blockId === bid) {
            const take = Math.min(s.count, left);
            s.count -= take; left -= take;
            if (s.count <= 0) arr[i] = null;
          }
        }
      }
    }
    inv.addItem(out);
    this.sound.playPlace('wood');
    return possible;
  }

  // ----------------------------------------------------------------- furnace

  /** live state of the furnace whose UI is open (HUD reads this) */
  get openFurnace(): FurnaceState | null {
    return this.openFurnaceKey ? this.furnaces.get(this.openFurnaceKey) ?? null : null;
  }

  private openFurnaceAt(x: number, y: number, z: number): void {
    const k = furnaceKey(x, y, z);
    if (!this.furnaces.has(k)) this.furnaces.set(k, newFurnace());
    this.openFurnaceKey = k;
    this.craftingOpen = false;
    this.inventoryOpen = false;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.events.onStats(this.buildStats());
  }

  closeFurnace(): void {
    this.openFurnaceKey = null;
    this.requestLock();
    this.events.onStats(this.buildStats());
  }

  /**
   * Move one (or a whole stack with `all`) between a furnace slot and the
   * player's inventory. Slot semantics mirror Minecraft: input and fuel take
   * items in, output only gives them out.
   */
  furnaceTransfer(slot: 'input' | 'fuel' | 'output', all: boolean): void {
    const st = this.openFurnace;
    if (!st) return;
    const inv = this.inventory;
    const held = st[slot];

    if (held) {
      // pull out of the furnace
      const take = all ? held : { ...held, count: held.kind === 'weapon' ? 1 : 1 } as SlotItem;
      if (all) {
        if (inv.canAdd(held)) { inv.addItem(held); st[slot] = null; }
      } else if (held.kind !== 'weapon') {
        if (inv.canAdd({ ...held, count: 1 })) {
          inv.addItem({ ...held, count: 1 });
          held.count -= 1;
          if (held.count <= 0) st[slot] = null;
        }
      } else if (inv.canAdd(take)) { inv.addItem(take); st[slot] = null; }
      this.events.onStats(this.buildStats());
      return;
    }

    if (slot === 'output') return; // nothing to insert into the result slot

    // insert the selected hotbar stack, if it is valid for this slot
    const sel = inv.hotbar[this.sel];
    if (!sel || sel.kind !== 'block') return;
    const ok = slot === 'fuel' ? isFuel(sel.blockId) : !!smeltResult(sel.blockId);
    if (!ok) return;
    const n = all ? sel.count : 1;
    st[slot] = { kind: 'block', blockId: sel.blockId, count: n };
    sel.count -= n;
    if (sel.count <= 0) { inv.hotbar[this.sel] = null; this.selectSlot(this.sel, true); }
    this.events.onStats(this.buildStats());
  }

  /**
   * Minecraft shift-click semantics: clicking an inventory stack while the
   * furnace is open routes the WHOLE stack to the correct slot automatically —
   * smeltable items go to input, fuel goes to fuel (merging with same-type
   * stacks up to 64). Returns false when the item fits neither slot.
   */
  furnaceQuickMove(ref: { isHotbar: boolean; isCraft?: boolean; index: number }): boolean {
    const st = this.openFurnace;
    if (!st) return false;
    const inv = this.inventory;
    const item = inv.getItem(ref);
    if (!item || item.kind !== 'block') return false;

    // smeltable wins when an item is somehow both (mirrors MC priority)
    const target: 'input' | 'fuel' | null =
      smeltResult(item.blockId) ? 'input' :
      isFuel(item.blockId) ? 'fuel' : null;
    if (!target) return false;

    const cur = st[target];
    if (cur && (cur.kind !== 'block' || cur.blockId !== item.blockId || cur.count >= 64)) return false;

    const space = cur && cur.kind === 'block' ? 64 - cur.count : 64;
    const n = Math.min(space, item.count);
    if (n <= 0) return false;

    if (cur && cur.kind === 'block') cur.count += n;
    else st[target] = { kind: 'block', blockId: item.blockId, count: n };
    item.count -= n;
    if (item.count <= 0) inv.setItem(ref, null);

    this.syncHotbarMode();
    this.events.onStats(this.buildStats());
    return true;
  }

  /** advance every furnace; swap lit/unlit blocks as flames start and die */
  private updateFurnaces(dt: number): void {
    if (this.furnaces.size === 0) return;
    for (const [k, st] of this.furnaces) {
      const wasLit = st.burn > 0;
      tickFurnace(st, dt);
      const lit = st.burn > 0;
      if (lit !== wasLit) {
        const [x, y, z] = k.split(',').map(Number);
        const cur = this.world.getBlockRaw(x, y, z);
        if (cur === B.FURNACE || cur === B.FURNACE_LIT) {
          this.world.setBlock(x, y, z, lit ? B.FURNACE_LIT : B.FURNACE);
        }
      }
      // reclaim memory from furnaces that were emptied out
      if (furnaceIdle(st) && k !== this.openFurnaceKey) this.furnaces.delete(k);
    }
  }

  /** Tab — opens inventory. Opening frees the pointer; closing re-locks. */
  toggleInventory(open?: boolean): void {
    const want = open !== undefined ? open : !this.inventoryOpen;
    // Close crafting if open while opening inventory (only one modal at a time)
    if (want) this.craftingOpen = false;
    this.inventoryOpen = want;
    if (want) {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else {
      this.requestLock();
    }
    // flush to React in the same frame the lock changes, so the inventory
    // lands instantly instead of the pause screen flashing first
    this.events.onStats(this.buildStats());
  }

  /** Open the crafting table 3×3 screen (separate from inventory). */
  openCraftingTable(): void {
    this.craftingOpen = true;
    this.inventoryOpen = false;
    this.inventory.setCraftSize(3);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.events.onStats(this.buildStats());
  }

  /** Close the crafting table screen. */
  closeCraftingTable(): void {
    this.craftingOpen = false;
    // return items in craft grid to inventory, shrink back to 2×2 pocket
    const inv = this.inventory;
    for (let i = 0; i < inv.craft.length; i++) {
      const it = inv.craft[i];
      if (it) { inv.addItem(it); inv.craft[i] = null; }
    }
    inv.setCraftSize(2);
    this.requestLock();
    this.events.onStats(this.buildStats());
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
    // Do not build/push a full React HUD snapshot synchronously from the
    // keydown handler. Slot changes can happen in bursts; the next animation
    // tick will publish stats, keeping input responsive during weapon swaps.
    this.statT = 0;
  }

  // ------------------------------------------------------------ practice range

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
      // Close whichever station is open; otherwise toggle inventory
      if (this.openFurnaceKey) { this.closeFurnace(); return; }
      if (this.craftingOpen) { this.closeCraftingTable(); return; }
      this.toggleInventory();
      return;
    }
    if (e.code === 'Escape' && this.openFurnaceKey) {
      this.closeFurnace();
      return;
    }
    if (e.code === 'Escape' && this.craftingOpen) {
      this.closeCraftingTable();
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
        if (e.code.startsWith('Digit') || e.code.startsWith('Numpad')) {
          const n = parseInt(e.code.replace('Digit', '').replace('Numpad', ''), 10);
          if (n >= 1 && n <= 6) {
            e.preventDefault();
            this.selectSlot(n - 1);
          }
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
      // right-click a placed crafting table (within reach) opens the 3×3 grid
      const eye = this.player.eye();
      this.camera.getWorldDirection(this.aimDir);
      const hit = raycastVoxel(this.world, eye.x, eye.y, eye.z,
        this.aimDir.x, this.aimDir.y, this.aimDir.z, 5);
      if (hit && hit.id === B.CRAFTING_TABLE) {
        this.mouse.right = false;
        this.openCraftingTable();
        return;
      }
      if (hit && (hit.id === B.FURNACE || hit.id === B.FURNACE_LIT)) {
        this.mouse.right = false;
        this.openFurnaceAt(hit.x, hit.y, hit.z);
        return;
      }
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
    this.composer?.setSize(w, h);
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
    if (this.dmgFollowT > 0) this.dmgFollowT = Math.max(0, this.dmgFollowT - dt);

    // ---- break atmosphere: high enough -> hand off to the space scene ----
    // Runs in the main tick (not tickPilot) so it fires even if the pointer
    // lock drops mid-climb; the ship continues its ballistic path regardless.
    if (!this.spaceExited && this.piloting && this.ship.pos.y > SPACE_ALTITUDE) {
      this.spaceExited = true;
      this.weapons.setAllVisible(false);
      this.bodyGroup.visible = false;
      this.heldFood.visible = false;
      this.events.onEnterSpace?.(this.theme);
    }

    // water: per-cell flow is shader-driven (+ subtle global shimmer for pools)
    WATER_TIME.value += dt;
    this.textures.water.offset.x += dt * 0.003;
    this.textures.water.offset.y += dt * 0.006;

    this.fluid.update(dt);
    // Streaming budget follows the frame clock: when a frame is already over
    // budget (heavy combat, lots of VFX) the streamer backs off instead of
    // stacking chunk builds on top of a frame that is running late.
    //
    // While flying, the ship covers ~28 blocks/s — a whole chunk every ~0.6s.
    // Streaming around the ship's CURRENT column means the generator always
    // reacts late, so chunks land in bursts right in front of the cockpit.
    // Leading the stream centre along the velocity vector lets the ring build
    // ahead of the hull instead of chasing it.
    let streamX = this.player.pos.x;
    let streamZ = this.player.pos.z;
    if (this.piloting && this.ship) {
      // Ensure the streaming center matches the spaceship's actual position,
      // led slightly ahead by the velocity vector to build chunks in advance.
      // The original code was using `this.player.pos` (which stays stationary at
      // the boarding spot), causing a massive desync where the wrong terrain heightmap
      // columns were generated and shifted, resulting in floating islands, holes,
      // and sheared cliffs at high speed.
      streamX = this.ship.pos.x + this.ship.vel.x * 0.7;
      streamZ = this.ship.pos.z + this.ship.vel.z * 0.7;
    }
    this.world.update(streamX, streamZ, dt > 0.024 ? 2.5 : 6);
    // toroidal rendering: pull every meshed chunk to its nearest-image copy
    this.world.syncChunkOffsets(this.camera.position.x, this.camera.position.z);
    if (this.ship && !this.piloting) this.ship.updateParked(dt);
    // Camps run on the main clock, not tickPlay: squads must materialize the
    // moment a planet loads (including right after a space landing, before
    // the first pointer lock) and keep respawning through pause/death.
    // damagePlayer() already ignores hits while unlocked, piloting or dead.
    //
    // Cruising above the terrain is the exception: enemies cannot reach the
    // ship, but flying drags the simulation radius across camp after camp, and
    // every newly-entered camp builds a whole squad (rigs + generated canvas
    // textures) inside one frame. That is the hitching felt while piloting
    // even when the averaged FPS counter still reads 60.
    if (!this.piloting || this.shipAltitude() < 26) this.enemies.update(dt);
    // furnaces smelt on the main clock so they keep cooking while the player
    // walks away or has the UI open
    this.updateFurnaces(dt);
    if (this.openFurnaceKey) this.events.onStats(this.buildStats());
    this.particles.update(dt);
    this.sky.update(dt, this.camera.position);
    const moonAsKey = this.sky.dayFactor < 0.32;
    if (moonAsKey !== this.moonIsKey) {
      // NOTE: do NOT toggle `castShadow` here.
      //
      // `castShadow` feeds numDirLightsWithShadow, which is part of three.js's
      // program cache key. Flipping it invalidates every cached shader, so the
      // renderer recompiles EVERY material in the scene (hundreds of chunk
      // meshes, enemy rigs, props) on a single frame — that was the multi-second
      // freeze at dawn and dusk.
      //
      // Both lights keep castShadow = true for the whole session; the handover
      // is purely an intensity cross-fade in Sky.update(). All we do here is
      // force one shadow-map refresh so the new key light's depth is current.
      this.moonIsKey = moonAsKey;
      this.shadowCooldown = 0;
      if (this.renderer.shadowMap) this.renderer.shadowMap.needsUpdate = true;
    }
    this.sound.update(dt, this.sky.isDay);

    // ---- atmosphere: drive the shared fog uniforms from the sky ----
    // (Underwater overrides run AFTER this so they win for the frame.)
    const nightFog = 1 - THREE.MathUtils.smoothstep(this.sky.dayFactor, 0.08, 0.42);
    const directT = THREE.MathUtils.smoothstep(this.sky.dayFactor, 0.18, 0.45);
    const directPos = directT > 0.5 ? this.sky.sunWorldPos : this.sky.moonWorldPos;

    // CRITICAL: fog colour MUST equal the sky background exactly, or distant
    // terrain never dissolves into the sky (hard silhouettes). No night-mist
    // offset — that desync is what left black ridges floating against a
    // different-coloured sky.
    FOG_UNIFORMS.uFogColor.value.copy(this.sky.skyColor);
    FOG_UNIFORMS.uSkyFogColor.value.copy(this.sky.skyColor);
    // Soft sky murk at night only (stars fade into the same sky colour).
    FOG_UNIFORMS.uSkyFog.value = nightFog * 0.55;

    FOG_UNIFORMS.uFogSunColor.value.copy(this.sky.moonColor).lerp(this.sky.sunColor, directT);
    FOG_UNIFORMS.uFogSunDir.value.copy(directPos)
      .sub(this.camera.position).normalize();

    // Density + falloff. Night is thicker near the ground; day keeps a gentle
    // atmospheric haze. Falloff is tall enough that flying still has fog.
    FOG_UNIFORMS.uFogDensity.value = 0.012 + nightFog * 0.045;
    FOG_UNIFORMS.uFogHeight.value = this.world.gen.sea + 2;
    FOG_UNIFORMS.uFogFalloff.value = 28 + this.sky.dayFactor * 18;
    // In-scatter is a DAY effect (sun glare through haze). Kill it at night
    // so the moon never paints the fog white.
    FOG_UNIFORMS.uFogInscatter.value = 0.04 + this.sky.dayFactor * 0.55;
    FOG_UNIFORMS.uFogStart.value = THREE.MathUtils.lerp(8, 2, nightFog);

    // Far-fog ramp: dissolve terrain BEFORE the mesh cutoff. View radius is a
    // CIRCLE of VIEW_DISTANCE chunks, so the farthest visible column is about
    // (VIEW_DISTANCE+0.75)*CHUNK_SIZE (~92), not the axis-aligned 80. Ending
    // the ramp short of that left hard silhouettes on the diagonal.
    const maxRange = (C.VIEW_DISTANCE + 0.75) * C.CHUNK_SIZE;
    const flyAmt = this.piloting
      ? THREE.MathUtils.smoothstep(this.shipAltitude(), 10, 40)
      : THREE.MathUtils.smoothstep(this.camera.position.y - this.world.gen.sea, 16, 46);
    const blend = Math.max(nightFog, flyAmt);
    // Start the dissolve earlier when flying/night; always hit full fog by ~0.9
    // of the mesh radius so nothing hard remains against the sky.
    FOG_UNIFORMS.uFarFogStart.value = THREE.MathUtils.lerp(maxRange * 0.48, maxRange * 0.32, blend);
    FOG_UNIFORMS.uFarFogEnd.value = THREE.MathUtils.lerp(maxRange * 0.92, maxRange * 0.78, blend);

    // Underwater wins last so background + fog stay a single deep-blue field.
    this.applyUnderwaterFx();

    // ---- grass animation + distance LOD camera ----
    GRASS_TIME.value += dt;
    GRASS_CAM.value.copy(this.camera.position);

    // ---- god rays: sun shafts by day, moonbeams after dark ----
    // The pass used to track the sun unconditionally, so at night it aimed at
    // a light that was below the horizon and faded to nothing — there was no
    // way to ever see a moonbeam. Hand it the moon once the moon is the key.
    if (this.volumetricLight) {
      if (moonAsKey) {
        this.volumetricLight.lightWorldPosition.copy(this.sky.moonWorldPos);
        const moonUp = THREE.MathUtils.clamp(-this.sky.sunElev, 0, 1);
        // A faint cold shaft, nothing more. The emitter disc is also shrunk
        // hard: at the sun's 85-unit size the additive sprite bloomed into the
        // huge white halo that was swallowing the entire night sky.
        this.volumetricLight.intensity = 0.05 + moonUp * 0.09;
        this.volumetricLight.discScale = 18;
        this.volumetricLight.tint.copy(this.sky.moonColor);
      } else {
        this.volumetricLight.lightWorldPosition.copy(this.sky.sunWorldPos);
        const elev = this.sky.sunElev;
        const angleFactor = THREE.MathUtils.clamp(0.75 - Math.abs(elev - 0.15) * 0.9, 0, 0.75);
        this.volumetricLight.intensity = angleFactor * 0.85;
        this.volumetricLight.discScale = 85;
        this.volumetricLight.tint.copy(this.sky.sunColor);
      }
    }

    // ---- bloom fades out at night so the dark scene stays clean ----
    if (this.bloom) {
      this.bloom.strength = 0.30 * THREE.MathUtils.smoothstep(this.sky.dayFactor, 0.0, 0.35);
    }

    // ---- flashlight: camera torch after dark, off while flying/dead ----
    if (this.flashlight) {
      const canUse = !this.dead && !this.piloting;
      const nightAmt = 1 - THREE.MathUtils.smoothstep(this.sky.dayFactor, 0.05, 0.3);
      // Ambient is near-zero at night now, so the torch carries the scene and
      // needs real punch again — but the tight cone keeps it from flattening
      // the mist the way the old wide 2.6 flood did.
      this.flashlight.intensity = canUse ? nightAmt * 2.4 : 0;
    }

    // ---- celestial shadow: refresh only when the player or active light moves ----
    const p = this.player.pos;
    const moved = Math.abs(p.x - this.lastShadowX) > 2 || Math.abs(p.z - this.lastShadowZ) > 2;
    const activeElev = this.sky.dayFactor > 0.35 ? this.sky.sunElev : -this.sky.sunElev;
    const lightMoved = Math.abs(activeElev - this.lastSunElev) > 0.0087; // ~0.5°
    // A shadow refresh is a full extra depth pass over every chunk mesh.
    // Sprinting crosses the 2-block threshold ~3x a second, and the sun test
    // fires on its own cadence, so the two together were re-rendering the map
    // far more often than the soft, low-frequency shadows actually need.
    this.shadowCooldown -= dt;
    if (this.renderer.shadowMap && (moved || lightMoved) && this.shadowCooldown <= 0) {
      this.lastShadowX = p.x;
      this.lastShadowZ = p.z;
      this.lastSunElev = activeElev;
      // Flying crosses the 2-block trigger every frame, so the shadow map
      // would re-render a full depth pass 5x a second while nothing on the
      // ground is being inspected up close. Back it right off in the air.
      this.shadowCooldown = this.piloting ? 0.75 : 0.2;
      this.renderer.shadowMap.needsUpdate = true;
    }

    this.reportStats(dt);

    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);

    // keep a fresh frame grab ready for the seamless space handoff
    this.captureSnapshot(dt);
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
    this.ship.ensureClearance(0.35);
    this.piloting = true;
    // Stow EVERY camera child so nothing from the FPS kit rides along into
    // the chase cam or the space handoff: weapon rigs, the laser viewmodel,
    // the held block, the held food and the shadow body.
    this.weapons.setAllVisible(false);
    this.laser.update(0, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
    this.heldBlock.update(0, false, 0);
    this.heldFood.visible = false;
    this.bodyGroup.visible = false;
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
    let placed = false;
    for (const sign of [1, -1]) {
      if (placed) break;
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
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      // worst case: pop out on top of the ship
      this.player.setSpawn(this.ship.pos.x, this.ship.pos.y + 3, this.ship.pos.z);
      this.player.yaw = yaw;
    }
    // hand the ship back to the parked hover state at its current altitude so
    // it settles instead of hanging in the freshly restored first-person view
    this.ship.settleHere();
    // Re-arm the hotbar through the normal slot pipeline. This properly
    // re-initializes holster state, the weapon rig springs/bones, the laser,
    // block and food viewmodels — so the first FP frame never draws stale
    // garbage geometry from the flight. (bodyGroup restores lazily in tick.)
    this.selectSlot(this.sel, true);
    // kill the stale chase-cam frame before the first FP render
    this.snapCameraToEye();
  }

  /** snap the FP camera to the player's eye immediately (kills the stale
   *  chase-cam frame that showed the ship hull filling the screen on exit) */
  /** height of the ship above the terrain column it is over (O(1)) */
  private shipAltitude(): number {
    if (!this.ship) return 0;
    const gy = this.world.highestY(Math.floor(this.ship.pos.x), Math.floor(this.ship.pos.z));
    return this.ship.pos.y - gy;
  }

  private snapCameraToEye(): void {
    const eye = this.player.eye();
    this.camera.position.copy(eye);
    this.camera.rotation.set(this.player.pitch, this.player.yaw, 0);
    this.fov = 75;
    this.camera.fov = 75;
    this.camera.updateProjectionMatrix();
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
    this.flyCam.lerp(this.tmpCam, Math.min(1, 17 * dt));

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

    // Keep pooled VFX advancing while flying — otherwise any tracers/impacts
    // fired the instant we boarded (or by camps below) freeze mid-air and
    // pile up into the streaks seen crossing the cockpit view.
    // (particles are stepped once by the main tick — stepping them here too
    // ran the whole pool at double rate for every frame spent piloting.)
    this.fx.update(dt);
  }

  private tickPlay(dt: number): void {
    if (this.piloting) {
      this.tickPilot(dt);
      return;
    }
    // shadow body rides on layer 2 (never seen by the main camera) — restore
    // it lazily here rather than in exitShip so disembark stays glitch-free
    this.bodyGroup.visible = true;
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

    // ---- combat state (enemies tick on the main clock, see tick()) ----
    if (this.invulnT > 0) this.invulnT -= dt;
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

  /** laser mining: charge the beam, crack the block, break + drop it */
  private updateMining(dt: number): void {
    const active = this.toolMode === 'laser' && !this.dead;
    const speed = this.player.horizontalSpeed();

    if (!active || !this.mouse.left || !this.target) {
      if (!this.target) this.crack.visible = false;
      this.breakT = 0;
      this.mineCharge = Math.max(0, this.mineCharge - dt * 1.6);
      this.laser.update(dt, {
        visible: active, firing: false,
        target: this.target ? this.aimPoint : null,
        charge: 0, speed,
      });
      return;
    }

    const d = DEFS[this.target.id];
    if (!isFinite(d.hardness)) {
      this.crack.visible = false;
      this.laser.update(dt, { visible: true, firing: false, target: this.aimPoint, charge: 0, speed });
      return; // bedrock
    }

    this.mineCharge = Math.min(1, this.mineCharge + dt * 1.9);
    this.breakT += dt / Math.max(0.05, d.hardness);

    this.digSoundT -= dt;
    if (this.digSoundT <= 0) {
      this.digSoundT = 0.12;
      this.fpsAudio.laserSizzle();
      this.particles.burst(
        this.aimPoint.x, this.aimPoint.y, this.aimPoint.z,
        d.colors, 2, 1.4,
      );
    }

    this.laser.update(dt, {
      visible: true, firing: true, target: this.aimPoint,
      charge: this.mineCharge, speed,
    });

    // crack overlay stage
    const stages = this.crackMats.length;
    if (stages > 0) {
      const stage = Math.min(stages - 1, Math.max(0, Math.floor(this.breakT * stages)));
      this.crack.material = this.crackMats[stage];
      this.crack.position.set(this.target.x + 0.5, this.target.y + 0.5, this.target.z + 0.5);
      this.crack.visible = true;
    }

    if (this.breakT < 1) return;

    const { x, y, z, id } = this.target;
    this.world.setBlock(x, y, z, B.AIR);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, DEFS[id].colors, 26, 3.6);
    this.sound.playBreak(d.sound);
    this.dropBlock(id, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    this.blocksMined++;

    // a broken furnace spills its contents, like Minecraft
    if (id === B.FURNACE || id === B.FURNACE_LIT) {
      const k = furnaceKey(x, y, z);
      const st = this.furnaces.get(k);
      if (st) {
        const drop = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
        for (const it of [st.input, st.fuel, st.output]) {
          if (it && it.kind === 'block') {
            for (let n = 0; n < it.count; n++) this.itemDrops.spawn(it.blockId, drop);
          }
        }
        this.furnaces.delete(k);
        if (this.openFurnaceKey === k) this.closeFurnace();
      }
    }

    this.enemies.notifyWorldChanged(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    this.breakT = 0;
    this.mineCharge = 0;
    this.crack.visible = false;
    this.target = null;
  }

  /** would a solid block at (x,y,z) overlap the player's own collider? */
  private playerIntersectsBlock(x: number, y: number, z: number): boolean {
    const p = this.player.pos;
    const hw = C.PLAYER_HALF_WIDTH;
    return (
      x + 1 > p.x - hw && x < p.x + hw &&
      y + 1 > p.y && y < p.y + this.player.height &&
      z + 1 > p.z - hw && z < p.z + hw
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
    const baseX = 0.38, baseY = -0.32, baseZ = -0.52;
    const baseRX = 0.35, baseRY = -0.55, baseRZ = 0.25;

    if (!this.mouse.right) {
      this.eating = false;
      this.eatT = Math.max(0, this.eatT - dt * 2);
      this.biteAcc = 0;
    } else {
      this.eating = true;
      this.eatT += dt;
      this.biteAcc += dt;
    }

    const EAT_TIME = 1.6;
    const p = Math.min(1, this.eatT / EAT_TIME);
    const riseE = this.eating ? Math.min(1, this.eatT * 4) : p;
    const chomp = this.eating ? Math.abs(Math.sin(this.eatT * Math.PI * 4)) : 0;
    const chompDir = Math.sin(this.eatT * Math.PI * 4) >= 0 ? 1 : -1;
    const amp = 0.026 + p * 0.018;

    this.heldFood.position.set(
      baseX - riseE * 0.07,
      baseY + riseE * 0.11 + chomp * amp,
      baseZ + riseE * 0.06 - chomp * 0.012,
    );
    this.heldFood.rotation.set(
      baseRX + riseE * 0.25 + chomp * 0.35,
      baseRY + riseE * 0.2,
      baseRZ + chompDir * chomp * 0.12,
    );

    if (!this.eating) return;

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
            (Math.random() - 0.5) * 1.2,
            -0.4 - Math.random() * 0.6,
            (Math.random() - 0.5) * 1.2,
          ),
          0xc08050, 0.016 + Math.random() * 0.012, 0.5, true,
        );
      }
    }

    // finished: consume, heal, ding, final crumb burst, refresh hotbar
    if (p >= 1) {
      this.eating = false;
      this.eatT = 0;
      this.biteAcc = 0;
      this.inventory.consumeAt({ isHotbar: true, index: this.sel });
      const food = FOODS[item.foodId];
      this.hp = Math.min(this.maxHp, this.hp + (food?.heal ?? 10));
      this.fpsAudio.ding();
      const head = this.camera.position.clone().addScaledVector(this.aimDir, 0.32);
      for (let i = 0; i < 8; i++) {
        this.fx.spawnParticle(
          head,
          new THREE.Vector3(
            (Math.random() - 0.5) * 1.6,
            -0.2 - Math.random() * 0.8,
            (Math.random() - 0.5) * 1.6,
          ),
          0xd8a86a, 0.018, 0.6, true,
        );
      }
      this.selectSlot(this.sel, true);
      this.statT = 0;
    }
  }

  /** submerged: swap the scene backdrop for deep-water blue */
  private applyUnderwaterFx(): void {
    // Keep background and fog colour identical so underwater far-field also
    // dissolves cleanly (same rule as the surface sky/fog lock).
    if (this.player.headInWater) {
      this.scene.background = UNDERWATER_FOG;
      FOG_UNIFORMS.uFogColor.value.copy(UNDERWATER_FOG);
      FOG_UNIFORMS.uSkyFogColor.value.copy(UNDERWATER_FOG);
      FOG_UNIFORMS.uSkyFog.value = 0.92;
      FOG_UNIFORMS.uFogDensity.value = Math.max(FOG_UNIFORMS.uFogDensity.value, 0.045);
      FOG_UNIFORMS.uFogStart.value = 1.5;
    } else {
      this.scene.background = this.sky.skyColor;
    }
  }

  // ------------------------------------------------------------ combat

  /**
   * Recompute the HUD hit chevron from the attacker's WORLD position against
   * the player's CURRENT yaw. Storing a baked view-space angle at hit time
   * made the arrow point the wrong way as soon as the player turned.
   */
  private updateDamageBearing(): void {
    if (!this.hasDamageFrom) return;
    const p = this.player.pos;
    const dx = C.minImageF(this.lastDamageFrom.x - p.x);
    const dz = C.minImageF(this.lastDamageFrom.z - p.z);
    const yaw = this.player.yaw;
    const fwd = dx * -Math.sin(yaw) + dz * -Math.cos(yaw);
    const right = dx * Math.cos(yaw) + dz * -Math.sin(yaw);
    if (fwd !== 0 || right !== 0) this.dmgAngle = Math.atan2(right, fwd);
  }

  private damagePlayer(dmg: number, from: THREE.Vector3): void {
    if (this.dead || this.invulnT > 0 || !this.locked || this.piloting) return;
    this.hp = Math.max(0, this.hp - dmg);
    this.damageSeq++;
    this.lastDamageFrom.copy(from);
    this.hasDamageFrom = true;
    this.dmgFollowT = 1.2;
    this.updateDamageBearing();
    this.statT = 0;
    this.fpsAudio.hurt();
    this.player.addShake(0.012);

    if (this.hp <= 0) {
      // attacker position arrives in wrapped torus space; image it next to
      // the (unbounded) player so the death camera topples the right way
      const p = this.player.pos;
      const img = new THREE.Vector3(
        p.x + C.minImageF(from.x - p.x),
        from.y,
        p.z + C.minImageF(from.z - p.z),
      );
      this.dead = true;
      this.deadTimer = 0;
      this.weapons.startDeath();
      this.spawnDroppedWeapon();
      this.fpsAudio.playerDie();
      this.player.startDeath(img);
      const head = this.camera.position.clone();
      for (let i = 0; i < 16; i++) {
        this.fx.spawnParticle(
          head,
          new THREE.Vector3(
            (Math.random() - 0.5) * 3,
            Math.random() * 2,
            (Math.random() - 0.5) * 3,
          ),
          0xd0342c, 0.03 + Math.random() * 0.03, 0.8, true,
        );
      }
    }
  }

  private respawn(): void {
    this.dead = false;
    this.deadTimer = 0;
    this.hp = this.maxHp;
    this.invulnT = 1.5;
    this.hasDamageFrom = false;
    this.dmgFollowT = 0;
    if (this.droppedGun) {
      this.scene.remove(this.droppedGun.mesh);
      this.droppedGun = null;
    }
    this.player.resetDeath();
    this.player.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);
    this.player.pitch = 0;
    this.weapons.resetDeath();
    this.selectSlot(this.sel, true);
    this.snapCameraToEye();
    this.statT = 0;
  }

  /** the held firearm falls out of the hands as a world prop on death */
  private spawnDroppedWeapon(): void {
    const gun = this.weapons.rig.gun.clone(true);
    gun.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.frustumCulled = true; }
    });
    gun.position.copy(this.camera.position);
    gun.scale.setScalar(1);
    this.scene.add(gun);

    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    this.droppedGun = {
      mesh: gun,
      vel: fwd.multiplyScalar(1.5).add(
        new THREE.Vector3((Math.random() - 0.5) * 0.9, 1.1, (Math.random() - 0.5) * 0.9),
      ),
      spin: new THREE.Vector3(
        (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 7,
        (Math.random() - 0.5) * 7,
      ),
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
      g.mesh.position.y = by + 1.06;
      g.vel.y *= -0.28;
      g.vel.x *= 0.5; g.vel.z *= 0.5;
      g.spin.multiplyScalar(0.42);
      this.fpsAudio.foley('grab');
      if (Math.abs(g.vel.y) < 0.7) {
        g.settled = true;
        g.vel.set(0, 0, 0);
        g.spin.set(0, 0, 0);
      }
    }
  }

  private fireShot(muzzle: THREE.Vector3, dir: THREE.Vector3, weaponId: string): void {
    const origin = this.camera.position.clone();
    const worldHit = this.world.raycast(origin, dir, 130);
    const enemyHit = this.enemies.raycast(origin, dir, 130);
    // NOTE: alertNearby only re-points squads that are ALREADY in a firefight.
    // Firing near a peaceful camp must not provoke it — a camp is only ever
    // provoked by actually hitting one of its members (see below).
    this.enemies.alertNearby(origin, weaponId === 'sniper' ? 70 : 50);

    // practice-range boards
    this.raycaster.set(origin, dir);
    this.raycaster.far = 130;
    let targetHit: { t: Target; point: THREE.Vector3; dist: number } | null = null;
    for (const t of this.targets) {
      const hits = this.raycaster.intersectObject(t.board, false);
      if (hits.length > 0 && (!targetHit || hits[0].distance < targetHit.dist)) {
        targetHit = { t, point: hits[0].point.clone(), dist: hits[0].distance };
      }
    }

    const wd = worldHit ? worldHit.dist : Infinity;
    const ed = enemyHit ? enemyHit.dist : Infinity;
    const td = targetHit ? targetHit.dist : Infinity;
    const useEnemy = !!enemyHit && ed <= wd && ed <= td;
    const useTarget = !useEnemy && !!targetHit && td <= wd;

    const end = useEnemy ? enemyHit!.point.clone()
      : useTarget ? targetHit!.point.clone()
      : worldHit ? worldHit.point.clone()
      : origin.clone().addScaledVector(dir, 130);

    this.fx.muzzleFlash(muzzle, 0.5);
    this.fx.tracer(muzzle, end);

    if (useEnemy) {
      const eh = enemyHit!;
      eh.enemy.takeDamage(weaponId === 'sniper' ? 50 : weaponId === 'bazooka' ? 999 : 12, eh.point, eh.headshot);
      // Alert the entire squad when any member is shot
      this.enemies.alertSquadOf(eh.enemy);
      this.hitSeq++;
      if (eh.headshot) this.fpsAudio.headshot(); else this.fpsAudio.enemyHit();
    } else if (useTarget) {
      this.hitTarget(targetHit!.t, dir);
      this.fx.puff(targetHit!.point, dir.clone().negate(), 0.25, 0.5, '#ffffff');
      this.targetsHit++;
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
    // Alert entire squads of any camp that had a member in the blast
    this.enemies.alertCampsInRadius(pos, 3.4);

    // A blast carves ~100 voxels. Spawning an un-pooled item entity for every
    // one of them stalls the frame (and buries the player in pickups), so the
    // crater only yields a sampled handful — like a Minecraft explosion.
    const MAX_BLAST_DROPS = 14;
    let drops = 0;
    const destroyed = this.world.destroySphere(pos, 2.9, (x, y, z, id) => {
      if (drops >= MAX_BLAST_DROPS || Math.random() > 0.28) return;
      drops++;
      this.dropBlock(id, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    });

    if (destroyed > 0) {
      this.demolition += destroyed;
      this.enemies.notifyWorldChanged(pos, 34);
    }

    this.fpsAudio.explosion(dist);
    this.player.addShake(THREE.MathUtils.clamp(0.05 - dist * 0.0022, 0.004, 0.05));
    if (dist < 6.5) this.damagePlayer(Math.round((1 - dist / 6.5) * 42), pos);
  }

  // ------------------------------------------------------------------- misc

  private reportStats(dt: number): void {
    this.statT -= dt;
    if (this.statT > 0) return;
    // While the damage chevron is on screen it has to track the player's yaw,
    // so the HUD is refreshed far more often for that short window.
    this.statT = this.dmgFollowT > 0 ? 0.05 : 0.25;
    this.events.onStats(this.buildStats());
  }

  /**
   * Snapshot the HUD payload. Kept separate from the throttled loop push so
   * modal toggles (inventory / crafting) can flush it to React synchronously
   * in the same frame the pointer lock changes — otherwise the pause screen
   * flashes for a beat before the inventory arrives.
   */
  private buildStats(): HudStats {
    this.updateDamageBearing();
    const p = this.player.pos;
    const shipAlt = this.piloting && this.ship ? Math.max(0, Math.round(this.shipAltitude())) : 0;

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

    return {
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
      craftingOpen: this.craftingOpen,
      furnaceOpen: !!this.openFurnaceKey,
      furnaceBurn: (() => {
        const f = this.openFurnace;
        return f && f.burnMax > 0 ? Math.max(0, Math.min(1, f.burn / f.burnMax)) : 0;
      })(),
      furnaceCook: (() => {
        const f = this.openFurnace;
        return f ? Math.max(0, Math.min(1, f.cook / SMELT_TIME)) : 0;
      })(),
      slot: this.sel,
      enemiesEnabled: this.enemiesEnabled,
      mineCharge: this.mineCharge,
      heldBlockId:
        selItem && selItem.kind === 'block' && this.toolMode === 'block' ? selItem.blockId : null,
      scoped: this.weapons.scoped,
      ads: this.weapons.adsT,
      hitSeq: this.hitSeq,
      damageSeq: this.damageSeq,
      dmgAngle: this.dmgAngle,
      demolition: this.demolition,
      blocksMined: this.blocksMined,
      targetsHit: this.targetsHit,
      session: 1 - (this.time % 300) / 300,
      switchAt: this.switchAt,
      spread:
        7 + this.weapons.bloomPx * 26 +
        Math.min(1, this.player.speedSmooth / 6) * 9 * (1 - this.weapons.adsT * 0.9),
    };
  }

  /** used by the minimap overlay */
  getWorld(): World {
    return this.world;
  }

  getPlayer(): Player {
    return this.player;
  }

  getCamps(): { x: number; z: number; cleared: boolean }[] {
    return this.enemies.camps.map((c) => ({
      x: c.site.cx,
      z: c.site.cz,
      cleared: c.cleared,
    }));
  }

  /** Return the IDs of camps that have been cleared (for cross-planet persistence). */
  getClearedCampIds(): number[] {
    return this.enemies.getClearedCampIds();
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.sound.stopShip();
    this.itemDrops?.clear();
    this.removeListeners();
    window.removeEventListener('resize', this.resize);
    this.depthFogPass?.dispose();
    this.bloom?.dispose();
    this.volumetricLight?.dispose();
    this.composer?.dispose();
    this.composerRT?.dispose();
    for (const g of this.blockGeomCache.values()) g.dispose();
    this.blockGeomCache.clear();
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
}