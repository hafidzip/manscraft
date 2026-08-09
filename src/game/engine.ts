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
import { createTextures, tileUV, animateConveyorTiles, type TextureSet } from './core/textures';
import { B, DEFS, isWaterId, applyThemeToBlockColors, conveyorDir, isConveyor, isInserter, isLaserMiner } from './world/blocks';
import { World, type ChunkMaterials } from './world/world';
import { InserterManager } from './fps/Inserter';
import { LaserMinerManager } from './fps/LaserMiner';
import type { CampSite, CampBuild } from './world/camps';
import { setActivePlanetTheme, planetSeedToWorldSeed } from './world/generator';
import type { PlanetTheme } from './space/theme';
import { FluidSim } from './world/fluid';
import { WATER_TIME, GRASS_TIME, GRASS_CAM, GRASS_FADE, GRASS_YAW } from './world/mesher';
import { Player, type InputState } from './player/player';
import { raycastVoxel, type RayHit } from './player/raycast';
import { Particles } from './vfx/particles';
import { Sky } from './vfx/sky';
import { LaserTool } from './vfx/laserTool';
import { SoundEngine } from './audio/sound';
import { Spaceship } from './vehicle/spaceship';
import { WeaponSystem, type GameBridge } from './fps/WeaponSystem';
import { EnemyManager, ENEMY_PRESETS } from './fps/Enemy';
import { Effects } from './fps/effects';
import { AudioSynth } from './fps/audio';
import { HeldBlockTool } from './fps/HeldBlockTool';
import { WEAPONS, WEAPON_ORDER, buildBody } from './fps/models';
import { Inventory, BLOCK_NAMES, FOODS, type SlotItem } from './fps/Inventory';
import { matchCraft, craftableCount, RECIPES, recipeIngredients } from './crafting/recipes';
import { TorchLights } from './world/torchLights';
import { furnaceKey, type FurnaceState } from './crafting/smelting';
import { ItemDropManager } from './fps/ItemDrop';
import { buildExtrudedItem, paintDrumstick, pixelTexture } from './fps/textures';
import type { BodyRig } from './fps/models';

import { PostProcessingPipeline } from './engine/PostProcessingPipeline';
import { EnvironmentLighting } from './engine/EnvironmentLighting';
import { ShopManager } from './engine/ShopManager';
import { FurnaceManager } from './engine/FurnaceManager';
import { TargetManager, type Target } from './engine/TargetManager';

export type { Target };

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
  // ---- merchant economy ----
  coins: number;
  /** increments on every coin gain/spend — HUD uses it to pulse the purse */
  coinSeq: number;
  /** signed amount of the most recent purse change (+kill loot, −purchase) */
  lastCoinGain: number;
  /** an idle merchant is close enough to trade */
  nearMerchant: boolean;
  shopOpen: boolean;
  shopMerchantName: string | null;
  /** the items this merchant currently stocks (empty = use full catalogue) */
  shopStock: { itemId: string; quantity: number; maxQuantity: number }[];
  /** true when the sell tab is active in the shop UI */
  shopSellOpen: boolean;
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

const LASER_NAME = "MK-7 'PROSPECTOR'";
const DEATH_DURATION = 4;

/** map our world block ids to voxel-fps inventory ids (they diverge after SAND) */
const TO_FPS: Record<number, number> = {
  [B.GRASS]: 1, [B.DIRT]: 2, [B.STONE]: 3, [B.SAND]: 4,
  [B.LOG]: 6, [B.LEAVES]: 7, [B.CACTUS]: 8, [B.PLANKS]: 9,
  [B.CRAFTING_TABLE]: 14, [B.GLASS]: 15, [B.FURNACE]: 16, [B.FURNACE_LIT]: 16,
  [B.COBBLE]: 11,
  // coal ore mines into a coal lump; torch places back as a torch
  [B.COAL_ORE]: 58, [B.TORCH]: 60,
  // conveyor belt (all 4 directional variants → single inventory id)
  [B.CONVEYOR_N]: 61, [B.CONVEYOR_E]: 61, [B.CONVEYOR_S]: 61, [B.CONVEYOR_W]: 61,
  // inserter (same treatment)
  [B.INSERTER_N]: 62, [B.INSERTER_E]: 62, [B.INSERTER_S]: 62, [B.INSERTER_W]: 62,
  // laser miner (same treatment)
  [B.LASER_MINER_N]: 63, [B.LASER_MINER_E]: 63, [B.LASER_MINER_S]: 63, [B.LASER_MINER_W]: 63,
  // gemstones map to unused high ids in the fps inventory
  [B.ORE_RUBY]: 50, [B.ORE_AMBER]: 51, [B.ORE_LUMINESCENCE]: 52,
  [B.ORE_DIAMOND]: 53, [B.ORE_GOLD]: 54, [B.ORE_SILVER]: 55,
  [B.ORE_JADE]: 56, [B.ORE_EMERALD]: 57,
};
const FROM_FPS: Record<number, number> = Object.fromEntries(
  Object.entries(TO_FPS).map(([k, v]) => [v, Number(k)])
);
FROM_FPS[58] = B.COAL_ITEM;
FROM_FPS[59] = B.STICK_ITEM;
FROM_FPS[60] = B.TORCH;
FROM_FPS[61] = B.CONVEYOR_E;
FROM_FPS[62] = B.INSERTER_E;
FROM_FPS[63] = B.LASER_MINER_E;

/** fps inventory ids for non-placeable crafting materials */
const B_COAL = 58;
const B_STICK = 59;

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

  // ---- extracted subsystem managers ----
  private postPipeline!: PostProcessingPipeline;
  private lighting!: EnvironmentLighting;
  public shop!: ShopManager;
  private furnaceMgr!: FurnaceManager;
  private targetMgr = new TargetManager();

  // ---- unified fps systems ----
  private fpsAudio = new AudioSynth();
  private weapons!: WeaponSystem;
  private enemies!: EnemyManager;
  camps: { site: CampSite; build: CampBuild }[] = [];
  private fx!: Effects;
  private heldBlock!: HeldBlockTool;
  private torchLights!: TorchLights;
  private toolMode: 'weapon' | 'laser' | 'block' | 'food' = 'weapon';
  /** unified inventory (voxel-fps): 6-slot hotbar + 3x9 storage */
  public inventory!: Inventory;
  private inserters!: InserterManager;
  private laserMiners!: LaserMinerManager;
  private enemiesEnabled = true;
  private triggerDown = false;
  private prevLeft = false;
  private placeCd = 0;

  private inventoryOpen = false;
  private craftingOpen = false;

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
  private raycaster = new THREE.Raycaster();
  private body!: BodyRig;
  private bodyGroup!: THREE.Group;
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
  private lumenSunDir = new THREE.Vector3();
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
  ) {
    this.theme = theme ?? null;
    this.inventory = persistentInventory ?? new Inventory();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.08, 900);
    this.camera.rotation.order = 'YXZ';

    // Instantiating managers
    this.postPipeline = new PostProcessingPipeline(this.scene, this.camera, this.renderer);
    this.lighting = new EnvironmentLighting(this.camera);
    this.shop = new ShopManager(
      this.fpsAudio,
      this.inventory,
      this.canvas,
      () => this.events.onStats(this.buildStats()),
      () => this.requestLock(),
    );
    this.furnaceMgr = new FurnaceManager(
      this.canvas,
      this.inventory,
      () => this.events.onStats(this.buildStats()),
      () => this.requestLock(),
    );

    this.resize();
    window.addEventListener('resize', this.resize);
  }

  get planetTheme(): PlanetTheme | null { return this.theme; }

  async init(theme?: PlanetTheme | null): Promise<void> {
    if (theme !== undefined) this.theme = theme;
    setActivePlanetTheme(this.theme);
    this.textures = createTextures(this.theme);
    applyThemeToBlockColors(this.theme);

    const mats: ChunkMaterials & {
      opaque: THREE.MeshLambertMaterial;
      cutout: THREE.MeshLambertMaterial;
      foliage: THREE.MeshLambertMaterial;
      water: THREE.MeshLambertMaterial;
    } = {
      opaque: new THREE.MeshLambertMaterial({ map: this.textures.atlas, vertexColors: true }),
      cutout: new THREE.MeshLambertMaterial({
        map: this.textures.atlas, vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide,
      }),
      foliage: new THREE.MeshLambertMaterial({
        map: this.textures.atlas, vertexColors: true, alphaTest: 0.4, side: THREE.DoubleSide,
      }),
      water: new THREE.MeshLambertMaterial({
        map: this.textures.water, vertexColors: true, transparent: false, opacity: 1.0,
        side: THREE.DoubleSide,
      }),
    };

    mats.opaque.shadowSide = THREE.DoubleSide;
    mats.cutout.shadowSide = THREE.DoubleSide;
    mats.foliage.shadowSide = THREE.DoubleSide;

    mats.water.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = WATER_TIME;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nattribute vec2 aFlow;\nvarying vec2 vFlow;\nvarying vec3 vWpos;'
        )
        .replace(
          '#include <uv_vertex>',
          '#include <uv_vertex>\nvFlow = aFlow;\nvWpos = (modelMatrix * vec4(position, 1.0)).xyz;'
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nuniform float uTime;\nvarying vec2 vFlow;\nvarying vec3 vWpos;'
        )
        .replace(
          '#include <map_fragment>',
          `vec2 flowUv = vMapUv + vFlow * uTime;
           vec2 shim = vec2(
             sin(vWpos.z * 1.9 + uTime * 0.7) + sin(vWpos.x * 1.1 - uTime * 0.5),
             cos(vWpos.x * 1.7 + uTime * 0.6) + cos(vWpos.z * 1.3 - uTime * 0.8)
           ) * 0.02;
           vec4 sampledDiffuseColor = texture2D( map, flowUv + shim );
           diffuseColor *= sampledDiffuseColor;`
        );
    };

    mats.cutout.onBeforeCompile = (shader) => {
      shader.uniforms.uGrassTime = GRASS_TIME;
      shader.uniforms.uGrassCam = GRASS_CAM;
      shader.uniforms.uGrassFade = GRASS_FADE;
      shader.uniforms.uGrassYaw = GRASS_YAW;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec4 aSway;
           uniform float uGrassTime;
           uniform vec3 uGrassCam;
           uniform vec2 uGrassFade;
           uniform float uGrassYaw;
           varying float vTorchUnlit;
           varying float vIsGrass;`
        )
        .replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
           objectNormal = vec3(0.0, 1.0, 0.0);`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           vTorchUnlit = step(aSway.y, -0.5);
           float gBlade = step(10.0, normal.z);
           float gPlant = step(0.001, aSway.y);
           vIsGrass = gBlade;

           if (gBlade > 0.5) {
             float bCx = normal.x;
             float bCz = normal.y;
             float bAng = normal.z - 100.0;
             vec3 bWorld = (modelMatrix * vec4(bCx, 0.0, bCz, 1.0)).xyz;
             vec2 toCamera = normalize(uGrassCam.xz - bWorld.xz);
             float camAng = atan(toCamera.y, toCamera.x);
             float blendedAng = bAng + 0.6 * sin(camAng - bAng);
             float dAng = blendedAng - bAng;
             float cosD = cos(dAng);
             float sinD = sin(dAng);
             float offX = position.x - bCx;
             float offZ = position.z - bCz;
             transformed.x = bCx + offX * cosD - offZ * sinD;
             transformed.z = bCz + offX * sinD + offZ * cosD;
             transformed.y = position.y;
           }

           float gTw = aSway.z;
           float gH = aSway.w;
           float gDist = distance((modelMatrix * vec4(transformed, 1.0)).xz, uGrassCam.xz);
           float gCol = 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, gDist);
           vec3 gWind = vec3(cos(aSway.x * 1.7), 0.0, sin(aSway.x * 1.3));
           float gSw = sin(uGrassTime * 1.9 + aSway.x) * aSway.y;
           vec3 gP = transformed;
           gP += gWind * (gSw * gTw) * gPlant;
           gP.y -= gTw * gH * (1.0 - gCol) * gPlant;
           transformed = mix(transformed, gP, gPlant);`
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
           varying float vTorchUnlit;
           varying float vIsGrass;`
        )
        .replace(
          '#include <normal_fragment_begin>',
          `float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
           vec3 normal = normalize(vNormal);
           vec3 nonPerturbedNormal = normal;`
        )
        .replace(
          '#include <opaque_fragment>',
          `if (vTorchUnlit > 0.5) {
             outgoingLight = diffuseColor.rgb;
           } else {
             #include <opaque_fragment>
             if (vIsGrass > 0.5) {
               outgoingLight = max(outgoingLight, diffuseColor.rgb * 0.22);
             }
           }`
        );
    };

    mats.foliage.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         objectNormal = vec3(0.0, 1.0, 0.0);`
      );
    };

    mats.cutoutDepth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.textures.atlas,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });
    mats.cutoutDepth.onBeforeCompile = (shader: THREE.WebGLProgramParametersWithUniforms) => {
      shader.uniforms.uGrassTime = GRASS_TIME;
      shader.uniforms.uGrassCam = GRASS_CAM;
      shader.uniforms.uGrassFade = GRASS_FADE;
      shader.uniforms.uGrassYaw = GRASS_YAW;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          `#include <common>
           attribute vec4 aSway;
           uniform float uGrassTime;
           uniform vec3 uGrassCam;
           uniform vec2 uGrassFade;
           uniform float uGrassYaw;`
        )
        .replace(
          '#include <begin_vertex>',
          `#include <begin_vertex>
           float gPlant = step(0.001, aSway.y);
           float gBlade = step(10.0, normal.z);

           if (gBlade > 0.5) {
             float bCx = normal.x;
             float bCz = normal.y;
             float bAng = normal.z - 100.0;
             vec3 bWorld = (modelMatrix * vec4(bCx, 0.0, bCz, 1.0)).xyz;
             vec2 toCamera = normalize(uGrassCam.xz - bWorld.xz);
             float camAng = atan(toCamera.y, toCamera.x);
             float blendedAng = bAng + 0.6 * sin(camAng - bAng);
             float dAng = blendedAng - bAng;
             float cosD = cos(dAng);
             float sinD = sin(dAng);
             float offX = position.x - bCx;
             float offZ = position.z - bCz;
             transformed.x = bCx + offX * cosD - offZ * sinD;
             transformed.z = bCz + offX * sinD + offZ * cosD;
             transformed.y = position.y;
           }

           float gTw = aSway.z;
           float gH = aSway.w;
           float gDist = distance((modelMatrix * vec4(transformed, 1.0)).xz, uGrassCam.xz);
           float gCol = 1.0 - smoothstep(uGrassFade.x, uGrassFade.y, gDist);
           vec3 gWind = vec3(cos(aSway.x * 1.7), 0.0, sin(aSway.x * 1.3));
           float gSw = sin(uGrassTime * 1.9 + aSway.x) * aSway.y;
           vec3 gP = transformed;
           gP += gWind * (gSw * gTw) * gPlant;
           gP.y -= gTw * gH * (1.0 - gCol) * gPlant;
           transformed = mix(transformed, gP, gPlant);`
        );
    };

    mats.foliageDepth = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      map: this.textures.atlas,
      alphaTest: 0.4,
      side: THREE.DoubleSide,
    });

    const seed = this.theme
      ? planetSeedToWorldSeed(this.theme.seed)
      : (Math.random() * 0x7fffffff) | 0;
    this.world = new World(seed, mats);
    this.scene.add(this.world.group);

    this.camps = [];

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

    if (this.sky) this.sky.applyTheme(this.theme?.skyHex ?? null);
    else this.sky = new Sky(this.scene, this.theme?.skyHex ?? null);

    // Configure sun/moon shadow maps via EnvironmentLighting static method
    EnvironmentLighting.configureShadows(this.sky.sun, this.sky.moon);

    this.particles = new Particles(this.scene);
    this.laser = new LaserTool(this.scene, this.camera);

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

    this.player = new Player(this.world);
    const [sx, sz] = this.world.gen.findSpawn();
    const spawnH = this.world.gen.heightAt(sx, sz);
    this.spawn.set(sx + 0.5, spawnH + 1.01, sz + 0.5);
    this.player.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);
    this.player.yaw = Math.PI / 4;
    this.menuYaw = this.player.yaw;
    this.world.syncChunkOffsets(this.spawn.x, this.spawn.z);
    this.world.spawn.copy(this.spawn);

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

    let dataProgress = 0;
    while (dataProgress < 1) {
      dataProgress = this.world.prepareAllData(24);
      this.events.onProgress(dataProgress * 0.48, 'Cooking terrain data');
      if (dataProgress < 1) await this.nextFrame();
      if (this.disposed) return;
    }

    const preloadRadius = C.EVICT_DISTANCE;
    const total = World.cellsInRadius(preloadRadius);
    let loaded = 0;
    let labelIdx = -1;
    while (true) {
      loaded += this.world.update(this.player.pos.x, this.player.pos.z, 28, preloadRadius);
      if (!this.world.pendingWork && loaded >= total) break;
      const p = Math.min(0.99, loaded / total);
      const idx = Math.min(LOAD_LABELS.length - 1, Math.floor(p * LOAD_LABELS.length));
      if (idx !== labelIdx) {
        labelIdx = idx;
        this.events.onProgress(0.48 + p * 0.32, LOAD_LABELS[idx]);
      } else this.events.onProgress(0.48 + p * 0.32, LOAD_LABELS[labelIdx]);
      await this.nextFrame();
      if (this.disposed) return;
    }
    this.events.onProgress(0.8, 'World geometry ready');

    this.fx = new Effects(this.scene, this.world, this.player.pos, (pos) => this.handleExplosion(pos));
    this.fx.prewarm(Object.values(DEFS).flatMap((def) => def.colors));
    const bridge: GameBridge = {
      fireShot: (m, d, def, anchor) => this.fireShot(m, d, def.id, anchor),
      launchRocket: (m, d, anchor) => this.launchRocket(m, d, anchor),
      casing: (p, r, big) => this.fx.casing(p, r, big, this.player.vel),
    };
    this.weapons = new WeaponSystem(this.camera, this.player, this.fpsAudio, bridge, () => {});
    this.enemies = new EnemyManager(this.player, {
      world: this.world,
      effects: this.fx,
      audio: this.fpsAudio,
      camera: this.camera,
      onPlayerHit: (dmg, from) => this.damagePlayer(dmg, from),
      onEnemyKilled: (e) => { this.kills++; this.shop.rewardCoins(e); },
    }, this.camps);
    if (this.initialClearedCamps?.length) {
      this.enemies.markCampsCleared(this.initialClearedCamps);
    }
    this.enemies.addScene(this.scene);

    for (const cfg of Object.values(ENEMY_PRESETS)) {
      pixelTexture(cfg.skin, 14, 16, cfg.seed);
      pixelTexture(cfg.shirt, 16, 16, cfg.seed + 1);
      pixelTexture(cfg.pants, 14, 16, cfg.seed + 2);
    }

    {
      const sp = this.player.pos;
      this.enemies.spawnWanderingMerchant(sp.x + 7, sp.z + 5, sp.y);
    }
    this.heldBlock = new HeldBlockTool(this.scene, this.camera, new THREE.MeshLambertMaterial({ map: this.textures.atlas, alphaTest: 0.4, side: THREE.DoubleSide }));
    this.heldBlock.setGeometry(this.blockGeometry(B.GRASS));

    this.torchLights = new TorchLights(this.scene);

    this.itemDrops = new ItemDropManager(this.scene, this.world, this.inventory, this.fpsAudio, () => {
      this.syncHotbarMode();
    });
    this.inserters = new InserterManager(this.scene, this.world, this.itemDrops, this.fpsAudio);
    this.laserMiners = new LaserMinerManager(this.scene, this.world, {
      mineable: (id) => this.laserMinerCanMine(id),
      mine: (x, y, z, dropPos) => this.laserMinerMine(x, y, z, dropPos),
    });
    this.itemDrops.prewarm(new Set(Object.values(TO_FPS)));

    for (const id of new Set(Object.values(FROM_FPS))) {
      if (DEFS[id]) this.blockGeometry(id);
    }

    this.heldFood = buildExtrudedItem(paintDrumstick, 0.017, 0.034);
    this.heldFood.position.set(0.38, -0.32, -0.52);
    this.heldFood.rotation.set(0.35, -0.55, 0.25);
    this.heldFood.scale.setScalar(1.15);
    this.heldFood.visible = false;
    this.camera.add(this.heldFood);

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

    this.events.onProgress(0.86, 'Warming up equipment');
    await this.nextFrame();
    if (this.disposed) return;

    const cutoutWarmGeo = new THREE.PlaneGeometry(0.01, 0.01);
    const warmCount = cutoutWarmGeo.getAttribute('position').count;
    cutoutWarmGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(warmCount * 3).fill(1), 3));
    cutoutWarmGeo.setAttribute('aSway', new THREE.Float32BufferAttribute(new Array(warmCount * 4).fill(0), 4));
    const cutoutWarmMesh = new THREE.Mesh(cutoutWarmGeo, mats.cutout);
    cutoutWarmMesh.frustumCulled = false;
    this.scene.add(cutoutWarmMesh);

    const foliageWarmGeo = new THREE.PlaneGeometry(0.01, 0.01);
    const foliageWarmCount = foliageWarmGeo.getAttribute('position').count;
    foliageWarmGeo.setAttribute('color', new THREE.Float32BufferAttribute(new Array(foliageWarmCount * 3).fill(1), 3));
    const foliageWarmMesh = new THREE.Mesh(foliageWarmGeo, mats.foliage);
    foliageWarmMesh.frustumCulled = false;
    this.scene.add(foliageWarmMesh);

    this.heldBlock.showTorch();
    this.heldBlock.group.visible = true;
    this.heldFood.visible = true;
    const laserWarmTarget = this.camera.position.clone().add(new THREE.Vector3(0, 0, -3));
    this.laser.update(0, { visible: true, firing: true, target: laserWarmTarget, charge: 1, speed: 0 });
    try {
      await this.weapons.warmup(this.renderer, this.scene);
    } finally {
      this.scene.remove(cutoutWarmMesh);
      cutoutWarmGeo.dispose();
      this.scene.remove(foliageWarmMesh);
      foliageWarmGeo.dispose();
      this.heldBlock.group.visible = false;
      this.heldFood.visible = false;
      this.laser.update(0, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
      this.heldBlock.setGeometry(this.blockGeometry(B.GRASS));
    }
    if (this.disposed) return;

    this.events.onProgress(0.94, 'Compiling lighting pipeline');
    await this.warmupRenderPipeline();
    if (this.disposed) return;
    this.events.onProgress(1, 'All systems ready');

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

  private async warmupRenderPipeline(): Promise<void> {
    const textures = new Set<THREE.Texture>();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh && !(object as THREE.Sprite).isSprite && !(object as THREE.Points).isPoints) return;
      const raw = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      const materials = raw ? (Array.isArray(raw) ? raw : [raw]) : [];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) textures.add(value);
        }
      }
    });
    for (const texture of textures) this.renderer.initTexture(texture);
    await this.renderer.compileAsync(this.scene, this.camera);
    if (this.disposed || !this.postPipeline) return;

    this.sky.update(0, this.camera.position);
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.setRenderTarget(this.postPipeline.mainRT);
    this.renderer.render(this.scene, this.camera);

    await this.postPipeline.warmup(
      this.renderer,
      this.sky.skyColor,
      this.sky.sunColor,
      this.lumenSunDir.copy(this.sky.sunWorldPos).sub(this.camera.position).normalize(),
      this.sky.dayFactor,
      this.world.gen.sea,
      this.sky.sunWorldPos,
    );
    await this.nextFrame();
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
    ctx.fillStyle = dark;
    ctx.fillRect(10, 18, 24, 9);
    ctx.fillRect(22, 10, 14, 6);
    ctx.fillRect(13, 27, 8, 11);
    ctx.fillStyle = accent;
    ctx.fillRect(10, 20, 24, 3);
    if (i === 5) {
      ctx.fillRect(34, 10, 4, 6);
    } else {
      ctx.fillRect(26, 10, 4, 6);
    }
    return c.toDataURL();
  }

  private dropBlock(id: number, pos: THREE.Vector3): void {
    const fpsId = TO_FPS[id];
    if (fpsId === undefined) return;
    this.itemDrops.spawn(fpsId, pos);
    this.blocksMined++;
  }

  private laserMinerCanMine(id: number): boolean {
    if (id === B.AIR || id < 0) return false;
    if (isWaterId(id)) return false;
    if (isConveyor(id) || isInserter(id) || isLaserMiner(id)) return false;
    const d = DEFS[id];
    if (!d || !d.solid || !isFinite(d.hardness)) return false;
    return TO_FPS[id] !== undefined;
  }

  private laserMinerMine(x: number, y: number, z: number, dropPos: THREE.Vector3): void {
    const id = this.world.getBlockRaw(x, y, z);
    if (id < 0 || !this.laserMinerCanMine(id)) return;
    const d = DEFS[id];
    this.world.setBlock(x, y, z, B.AIR);
    if (id === B.TORCH) this.torchLights.remove(x, y, z);
    this.detachTorchesSupportedBy(x, y, z, true);
    this.removeFloatingPlantsAbove(x, y, z);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, d.colors, 20, 3.2);

    const from = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
    const pull = dropPos.clone().sub(from);
    for (let i = 0; i < 6; i++) {
      this.fx.spawnParticle(
        from.clone(),
        pull.clone().multiplyScalar(1.4 + Math.random() * 0.6)
          .add(new THREE.Vector3((Math.random() - 0.5) * 0.6, 0.4, (Math.random() - 0.5) * 0.6)),
        0xffb060, 0.02 + Math.random() * 0.01, 0.35, false,
      );
    }

    const fpsId = TO_FPS[id];
    if (fpsId !== undefined) {
      this.itemDrops.spawn(fpsId, dropPos.clone(), new THREE.Vector3(
        (Math.random() - 0.5) * 0.4, 0.6, (Math.random() - 0.5) * 0.4));
    }
    this.sound.playBreak(d.sound);
    this.blocksMined++;
    this.enemies.notifyWorldChanged(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
  }

  private removeFloatingPlantsAbove(x: number, y: number, z: number): void {
    let cy = y + 1;
    while (true) {
      const id = this.world.getBlockRaw(x, cy, z);
      if (id === -1 || id === B.AIR) return;
      const d = DEFS[id];
      if (!d || d.cross !== true) return;
      this.world.setBlock(x, cy, z, B.AIR);
      if (id === B.TORCH) this.torchLights.remove(x, cy, z);
      this.particles.burst(x + 0.5, cy + 0.5, z + 0.5, d.colors, 8, 1.6);
      this.sound.playBreak(d.sound);
      this.dropBlock(id, new THREE.Vector3(x + 0.5, cy + 0.5, z + 0.5));
      cy++;
    }
  }

  private detachTorchesSupportedBy(bx: number, by: number, bz: number, drop: boolean): void {
    const popped = this.torchLights.detachSupportedBy(bx, by, bz);
    for (const [tx, ty, tz] of popped) {
      if (this.world.getBlockRaw(tx, ty, tz) === B.TORCH) this.world.setBlock(tx, ty, tz, B.AIR);
      this.particles.burst(tx + 0.5, ty + 0.55, tz + 0.5, DEFS[B.TORCH].colors, 10, 2);
      this.sound.playBreak('wood');
      if (drop) this.dropBlock(B.TORCH, new THREE.Vector3(tx + 0.5, ty + 0.5, tz + 0.5));
    }
  }

  openCrafting(table: boolean): void {
    if (table) this.inventory.setCraftSize(3);
    else this.inventory.setCraftSize(2);
    this.toggleInventory(true);
  }

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

  // ---- Furnace Delegations ----
  get openFurnace(): FurnaceState | null { return this.furnaceMgr.openFurnace; }
  openFurnaceAt(x: number, y: number, z: number): void { this.furnaceMgr.openFurnaceAt(x, y, z); }
  closeFurnace(): void { this.furnaceMgr.closeFurnace(); }
  furnaceTransfer(slot: 'input' | 'fuel' | 'output', all: boolean): void { this.furnaceMgr.furnaceTransfer(slot, all, this.sel); }
  furnaceQuickMove(ref: { isHotbar: boolean; isCraft?: boolean; index: number }): boolean { return this.furnaceMgr.furnaceQuickMove(ref); }

  // ---- Shop Delegations ----
  buyShopItem(id: string): boolean { return this.shop.buyShopItem(id); }
  toggleShopSell(open?: boolean): void { this.shop.toggleShopSell(open); }
  sellShopItem(ref: { isHotbar: boolean; index: number }, amount: number): boolean { return this.shop.sellShopItem(ref, amount); }
  closeShop(): void { this.shop.closeShop(); }

  toggleInventory(open?: boolean): void {
    const want = open !== undefined ? open : !this.inventoryOpen;
    if (want) this.craftingOpen = false;
    this.inventoryOpen = want;
    if (want) {
      if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    } else {
      this.requestLock();
    }
    this.events.onStats(this.buildStats());
  }

  openCraftingTable(): void {
    this.craftingOpen = true;
    this.inventoryOpen = false;
    this.inventory.setCraftSize(3);
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.events.onStats(this.buildStats());
  }

  closeCraftingTable(): void {
    this.craftingOpen = false;
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
      const worldId = FROM_FPS[item.blockId] ?? B.STONE;
      if (worldId === B.TORCH) this.heldBlock.showTorch();
      else this.heldBlock.setGeometry(this.blockGeometry(worldId));
    } else if (item && item.kind === 'food') {
      this.toolMode = 'food';
      this.weapons.setHolstered(true);
    } else {
      this.toolMode = 'weapon';
      this.weapons.setHolstered(false);
      this.weapons.switchTo('handgun');
    }
    this.target = null;
    this.breakT = 0;
    this.crack.visible = false;
    this.statT = 0;
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
      if (this.piloting) this.sound.setShip(0, 0);
    }
    this.events.onLock(this.locked);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Tab') {
      e.preventDefault();
      if (this.shop.shopEnemy) { this.closeShop(); return; }
      if (this.furnaceMgr.openFurnaceKey) { this.closeFurnace(); return; }
      if (this.craftingOpen) { this.closeCraftingTable(); return; }
      this.toggleInventory();
      return;
    }
    if (e.code === 'Escape' && this.shop.shopEnemy) {
      this.closeShop();
      return;
    }
    if (e.code === 'Escape' && this.furnaceMgr.openFurnaceKey) {
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
        else if (this.shop.nearMerchantEnemy) this.shop.openShop();
        else if (this.ship && this.ship.distanceTo(this.player.eye()) < 6) this.boardShip();
        else {
          const eye = this.player.eye();
          this.camera.getWorldDirection(this.aimDir);
          const hit = raycastVoxel(this.world, eye.x, eye.y, eye.z,
            this.aimDir.x, this.aimDir.y, this.aimDir.z, 5);
          if (hit && (isConveyor(hit.id) || isInserter(hit.id) || isLaserMiner(hit.id))) {
            e.preventDefault();
            this.sound.playClick();
            this.rotateConveyor(hit.x, hit.y, hit.z, hit.id);
          }
        }
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
    const s = 0.0022 * this.weapons.sensFactor();
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

  private wheelAcc = 0;

  private onWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    e.preventDefault();
    this.wheelAcc += e.deltaY > 0 ? 1 : -1;
  };

  private flushWheel(): void {
    if (this.wheelAcc === 0) return;
    const step = this.wheelAcc > 0 ? 1 : -1;
    this.wheelAcc = 0;
    this.selectSlot((this.sel + step + 6) % 6, true);
  }

  // -------------------------------------------------------------- main loop

  private resize = (): void => {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    if (this.postPipeline) this.postPipeline.resize(w, h);
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

    if (!this.spaceExited && this.piloting && this.ship.pos.y > SPACE_ALTITUDE) {
      this.spaceExited = true;
      this.weapons.setAllVisible(false);
      this.bodyGroup.visible = false;
      this.heldFood.visible = false;
      this.events.onEnterSpace?.(this.theme);
    }

    WATER_TIME.value += dt;
    if (this.textures) {
      this.textures.water.offset.x += dt * 0.003;
      this.textures.water.offset.y += dt * 0.006;
      animateConveyorTiles(this.textures, this.time);
    }
    if (this.locked) this.fluid.update(dt);

    if (this.locked) {
      let streamX = this.player.pos.x;
      let streamZ = this.player.pos.z;
      if (this.piloting && this.ship) {
        streamX = this.ship.pos.x + this.ship.vel.x * 0.7;
        streamZ = this.ship.pos.z + this.ship.vel.z * 0.7;
      }
      this.world.update(streamX, streamZ, dt > 0.024 ? 2.5 : 6);
      this.world.syncChunkOffsets(this.camera.position.x, this.camera.position.z);
      if (this.ship && !this.piloting) this.ship.updateParked(dt);
    }

    if (this.locked && (!this.piloting || this.shipAltitude() < 26)) this.enemies.update(dt);

    if (this.locked) {
      this.furnaceMgr.updateFurnaces(dt, this.world);
      if (this.furnaceMgr.openFurnaceKey) this.events.onStats(this.buildStats());
      this.shop.updateProximity(this.player.pos, this.dead, this.piloting, this.enemies);
      this.shop.updateShop(this.player.pos, this.dead, this.piloting);
      this.particles.update(dt);
      this.sky.update(dt, this.camera.position);

      // EnvironmentLighting update handles atmosphere, fog, flashlight, god rays, bloom, shadows
      this.lighting.update(
        dt,
        this.camera,
        this.renderer,
        this.sky,
        this.world,
        this.scene,
        this.player,
        this.piloting,
        this.dead,
        this.postPipeline.volumetricLight,
        this.postPipeline.bloom,
        this.shipAltitude(),
      );
    }

    this.sound.update(dt, this.sky.isDay);
    if (this.locked) {
      this.enemies.setNight(this.sky.sunElev < 0.02);
    }

    if (this.locked) {
      GRASS_TIME.value += dt;
      GRASS_CAM.value.copy(this.camera.position);
      GRASS_YAW.value = this.player.yaw;
    }

    if (this.locked) {
      this.reportStats(dt);
    }

    if (this.postPipeline) {
      this.renderer.setRenderTarget(this.postPipeline.mainRT);
      this.renderer.render(this.scene, this.camera);

      this.postPipeline.render(
        this.renderer,
        this.sky.skyColor,
        this.sky.sunColor,
        this.lumenSunDir.copy(this.sky.sunWorldPos).sub(this.camera.position).normalize(),
        this.sky.dayFactor,
        this.world.gen.sea,
        dt,
      );
    } else {
      this.renderer.render(this.scene, this.camera);
    }

    this.captureSnapshot(dt);
  };

  private tickMenuCamera(dt: number): void {
    if (this.everLocked) {
      this.syncCamera(dt);
      this.laser.update(dt, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
      this.heldBlock.update(dt, false, 0);
      this.heldFood.visible = false;
      return;
    }
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

  private boardShip(resetCamera = false): void {
    this.ship.ensureClearance(0.35);
    this.piloting = true;
    this.weapons.setAllVisible(false);
    this.laser.update(0, { visible: false, firing: false, target: null, charge: 0, speed: 0 });
    this.heldBlock.update(0, false, 0);
    this.heldFood.visible = false;
    this.bodyGroup.visible = false;
    if (resetCamera) {
      const yaw = this.player.yaw;
      this.flyCam.set(
        this.ship.pos.x + Math.sin(yaw) * 11,
        this.ship.pos.y + 2.3,
        this.ship.pos.z + Math.cos(yaw) * 11,
      );
      this.camera.position.copy(this.flyCam);
      this.tmpSeat.set(
        this.ship.pos.x - Math.sin(yaw) * 3.2,
        this.ship.pos.y + 1.0,
        this.ship.pos.z - Math.cos(yaw) * 3.2,
      );
      this.camera.lookAt(this.tmpSeat);
      this.fov = 75;
      this.camera.fov = 75;
      this.camera.updateProjectionMatrix();
    } else {
      this.flyCam.copy(this.camera.position);
    }
    this.highlight.visible = false;
    this.crack.visible = false;
    this.mouse.left = false;
    this.mouse.right = false;
    this.breakT = 0;
    this.sound.playBoard();
  }

  private exitShip(): void {
    this.piloting = false;
    this.spaceExited = false;
    this.sound.playDisembark();
    this.sound.stopShip();
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
      this.player.setSpawn(this.ship.pos.x, this.ship.pos.y + 3, this.ship.pos.z);
      this.player.yaw = yaw;
    }
    this.ship.settleHere();
    this.selectSlot(this.sel, true);
    this.snapCameraToEye();
  }

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

    p.pos.set(this.ship.pos.x, this.ship.pos.y - 0.2, this.ship.pos.z);
    p.vel.set(0, 0, 0);
    p.inWater = false;
    p.headInWater = false;
    this.wasInWater = false;

    const yaw = p.yaw;
    const pitch = p.pitch;
    const cp = Math.cos(pitch);
    const fx = -Math.sin(yaw) * cp;
    const fyy = Math.sin(pitch);
    const fz = -Math.cos(yaw) * cp;
    this.aimDir.set(fx, fyy, fz);

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
    this.fx.update(dt);
  }

  private tickPlay(dt: number): void {
    this.flushWheel();
    if (this.piloting) {
      this.tickPilot(dt);
      return;
    }
    this.bodyGroup.visible = true;
    const p = this.player;
    this.prevVelY = p.vel.y;

    if (this.dead) {
      this.deadTimer += dt;
      const timeScale = THREE.MathUtils.lerp(0.35, 0.85, Math.min(1, this.deadTimer / 2.5));
      const sdt = dt * timeScale;
      this.fx.update(sdt);
      this.weapons.update(dt, this.time, false, false, false);
      this.updateDroppedWeapon(dt);
      this.itemDrops.update(sdt, this.player.pos);
      this.inserters.update(sdt, this.player.pos);
      this.laserMiners.update(sdt, this.player.pos);
      this.player.updateDeath(dt);
      this.player.applyDeathCamera(this.camera);
      if (this.deadTimer >= DEATH_DURATION) this.respawn();
      return;
    }

    p.update(dt, this.input);

    if (p.onGround) {
      const belowId = this.world.getBlockRaw(
        Math.floor(p.pos.x), Math.floor(p.pos.y - 0.05), Math.floor(p.pos.z));
      const dir = conveyorDir(belowId);
      if (dir) {
        const BELT_ACCEL = 46;
        p.vel.x += dir[0] * BELT_ACCEL * dt;
        p.vel.z += dir[1] * BELT_ACCEL * dt;
      }
    }

    if (p.pos.y < -12) p.setSpawn(this.spawn.x, this.spawn.y, this.spawn.z);

    if (p.onGround && !this.wasOnGround && this.prevVelY < -9.5) {
      this.sound.playLand(-this.prevVelY / 12);
    }
    this.wasOnGround = p.onGround;

    if (p.inWater && !this.wasInWater) this.sound.playSplash();
    this.wasInWater = p.inWater;

    const hs = p.horizontalSpeed();
    if (p.onGround && hs > 0.8 && !p.inWater) {
      this.walkAcc += hs * dt;
      if (this.walkAcc > 2.1) {
        this.walkAcc = 0;
        this.sound.playStep(p.groundSound());
      }
    } else this.walkAcc = Math.min(this.walkAcc, 1.9);

    if (p.onGround && hs > 0.5) this.bob += dt * hs * 1.6;

    this.syncCamera(dt);

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

    if (this.invulnT > 0) this.invulnT -= dt;
    this.fx.update(dt);
    this.itemDrops.update(dt, this.player.pos);
    this.inserters.update(dt, this.player.pos);
    this.laserMiners.update(dt, this.player.pos);
    this.torchLights.update(dt, this.camera.position);

    // TargetManager updates shooting targets wobble / flash
    this.targetMgr.update(dt);

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
    const crouchEye = C.EYE_HEIGHT + (1.12 - C.EYE_HEIGHT) * p.crouchAmt;
    this.camera.position.y = p.pos.y + crouchEye + bobY;

    this.camera.rotation.set(p.pitch + p.recoilP + shakeX, p.yaw + p.recoilY + shakeY, 0);

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
      return;
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
    if (id === B.TORCH) this.torchLights.remove(x, y, z);
    this.detachTorchesSupportedBy(x, y, z, true);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, DEFS[id].colors, 26, 3.6);
    this.sound.playBreak(d.sound);
    this.dropBlock(id, new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    this.blocksMined++;

    this.removeFloatingPlantsAbove(x, y, z);

    if (id === B.FURNACE || id === B.FURNACE_LIT) {
      const k = furnaceKey(x, y, z);
      const st = this.furnaceMgr.furnaces.get(k);
      if (st) {
        const drop = new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5);
        for (const it of [st.input, st.fuel, st.output]) {
          if (it && it.kind === 'block') {
            for (let n = 0; n < it.count; n++) this.itemDrops.spawn(it.blockId, drop);
          }
        }
        this.furnaceMgr.furnaces.delete(k);
        if (this.furnaceMgr.openFurnaceKey === k) this.closeFurnace();
      }
    }

    this.enemies.notifyWorldChanged(new THREE.Vector3(x + 0.5, y + 0.5, z + 0.5));
    this.breakT = 0;
    this.mineCharge = 0;
    this.crack.visible = false;
    this.target = null;
  }

  private playerIntersectsBlock(x: number, y: number, z: number): boolean {
    const p = this.player.pos;
    const hw = C.PLAYER_HALF_WIDTH;
    return (
      x + 1 > p.x - hw && x < p.x + hw &&
      y + 1 > p.y && y < p.y + this.player.height &&
      z + 1 > p.z - hw && z < p.z + hw
    );
  }

  private yawCardinal(yaw: number): 'N' | 'E' | 'S' | 'W' {
    const a = ((yaw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    if (a < Math.PI * 0.25 || a >= Math.PI * 1.75) return 'N';
    if (a < Math.PI * 0.75) return 'W';
    if (a < Math.PI * 1.25) return 'S';
    return 'E';
  }

  private facingBlock(family: 'belt' | 'inserter' | 'miner', yaw: number): number {
    const c = this.yawCardinal(yaw);
    if (family === 'belt') {
      return c === 'N' ? B.CONVEYOR_N : c === 'E' ? B.CONVEYOR_E : c === 'S' ? B.CONVEYOR_S : B.CONVEYOR_W;
    }
    if (family === 'miner') {
      return c === 'N' ? B.LASER_MINER_N : c === 'E' ? B.LASER_MINER_E : c === 'S' ? B.LASER_MINER_S : B.LASER_MINER_W;
    }
    return c === 'N' ? B.INSERTER_N : c === 'E' ? B.INSERTER_E : c === 'S' ? B.INSERTER_S : B.INSERTER_W;
  }

  private rotateConveyor(x: number, y: number, z: number, id: number): void {
    const NEXT: Record<number, number> = {
      [B.CONVEYOR_N]: B.CONVEYOR_E,
      [B.CONVEYOR_E]: B.CONVEYOR_S,
      [B.CONVEYOR_S]: B.CONVEYOR_W,
      [B.CONVEYOR_W]: B.CONVEYOR_N,
      [B.INSERTER_N]: B.INSERTER_E,
      [B.INSERTER_E]: B.INSERTER_S,
      [B.INSERTER_S]: B.INSERTER_W,
      [B.INSERTER_W]: B.INSERTER_N,
      [B.LASER_MINER_N]: B.LASER_MINER_E,
      [B.LASER_MINER_E]: B.LASER_MINER_S,
      [B.LASER_MINER_S]: B.LASER_MINER_W,
      [B.LASER_MINER_W]: B.LASER_MINER_N,
    };
    const next = NEXT[id];
    if (next === undefined) return;
    this.world.setBlock(x, y, z, next);
    this.sound.playPlace('stone');
    this.particles.burst(x + 0.5, y + 1.02, z + 0.5, DEFS[next].colors, 6, 1.2);
    this.placeCd = 0.22;
  }

  private placeBlock(): void {
    const item = this.inventory.hotbar[this.sel];
    if (!item || item.kind !== 'block' || item.count <= 0) return;
    if (item.blockId === B_COAL || item.blockId === B_STICK) return;
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

    let ourId = FROM_FPS[item.blockId] ?? B.STONE;

    if (isConveyor(ourId)) {
      if (!DEFS[this.world.getBlockRaw(x, y - 1, z)]?.solid) return;
      ourId = this.facingBlock('belt', this.player.yaw);
    }

    if (isInserter(ourId)) {
      if (!DEFS[this.world.getBlockRaw(x, y - 1, z)]?.solid) return;
      ourId = this.facingBlock('inserter', this.player.yaw);
    }

    if (isLaserMiner(ourId)) {
      if (!DEFS[this.world.getBlockRaw(x, y - 1, z)]?.solid) return;
      ourId = this.facingBlock('miner', this.player.yaw);
    }

    const d = DEFS[ourId];
    if (d.solid && this.playerIntersectsBlock(x, y, z)) return;
    if (ourId === B.TORCH && !atPlant) {
      const supportDef = DEFS[hit.id];
      if (!supportDef?.solid) return;
    }

    this.world.setBlock(x, y, z, ourId);
    if (ourId === B.TORCH) this.torchLights.add(x, y, z, x - hit.nx, y - hit.ny, z - hit.nz);
    this.particles.burst(x + 0.5, y + 0.5, z + 0.5, d.colors, 8, 1.7);
    this.sound.playPlace(d.sound);
    this.heldBlock.triggerPlace();
    this.inventory.consumeBlock({ isHotbar: true, index: this.sel });
    this.placeCd = 0.22;
    if (item.count - 1 <= 0) this.selectSlot(this.sel, true);
  }

  private updateFood(dt: number): void {
    const item = this.inventory.hotbar[this.sel];

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
      this.enemies.onPlayerDeath(6);
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
    this.sky.skipToMorning();
    this.invulnT = 1.5;
    this.hasDamageFrom = false;
    this.dmgFollowT = 0;
    if (this.droppedGun) {
      this.scene.remove(this.droppedGun.mesh);
      this.droppedGun = null;
    }

    this.player.resetDeath();
    this.player.setSpawn(this.ship.pos.x, this.ship.pos.y - 0.2, this.ship.pos.z);
    this.player.yaw = this.ship.yaw;
    this.player.pitch = 0;
    this.wasOnGround = false;
    this.wasInWater = false;
    this.prevVelY = 0;
    this.spaceExited = false;
    this.weapons.resetDeath();
    this.selectSlot(this.sel, true);
    this.boardShip(true);
    this.statT = 0;
  }

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

  private fireShot(
    muzzle: THREE.Vector3,
    dir: THREE.Vector3,
    weaponId: string,
    muzzleAnchor: THREE.Object3D,
  ): void {
    const origin = this.camera.position.clone();
    const worldHit = this.world.raycast(origin, dir, 130);
    const enemyHit = this.enemies.raycast(origin, dir, 130);
    this.enemies.alertNearby(origin, weaponId === 'sniper' ? 70 : 50);

    this.raycaster.set(origin, dir);
    this.raycaster.far = 130;
    let targetHit: { t: Target; point: THREE.Vector3; dist: number } | null = null;
    for (const t of this.targetMgr.targets) {
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

    this.fx.muzzleFlash(muzzle, 0.5, muzzleAnchor);
    this.fx.tracer(muzzle, end, muzzleAnchor);

    if (useEnemy) {
      const eh = enemyHit!;
      eh.enemy.takeDamage(weaponId === 'sniper' ? 50 : weaponId === 'bazooka' ? 999 : 12, eh.point, eh.headshot);
      this.enemies.alertSquadOf(eh.enemy);
      this.hitSeq++;
      if (eh.headshot) this.fpsAudio.headshot(); else this.fpsAudio.enemyHit();
    } else if (useTarget) {
      this.targetMgr.hitTarget(targetHit!.t, dir, this.fpsAudio, () => this.hitSeq++);
      this.fx.puff(targetHit!.point, dir.clone().negate(), 0.25, 0.5, '#ffffff');
    } else if (worldHit) {
      this.fx.impact(worldHit.point, worldHit.normal, worldHit.block, worldHit);
      if ((worldHit.block === B.STONE || worldHit.block === B.GRAVEL) && Math.random() < 0.3) {
        this.fpsAudio.ricochet();
      }
    }
  }

  private launchRocket(muzzle: THREE.Vector3, dir: THREE.Vector3, muzzleAnchor: THREE.Object3D): void {
    this.fx.muzzleFlash(muzzle, 0.7, muzzleAnchor);
    this.fx.launchRocket(muzzle.clone().addScaledVector(dir, 0.4), dir);
    this.fpsAudio.whoosh();
    this.player.addShake(0.03);
  }

  private handleExplosion(pos: THREE.Vector3): void {
    const dist = pos.distanceTo(this.player.pos);
    this.enemies.damageInRadius(pos, 3.4, 120);
    this.enemies.alertCampsInRadius(pos, 3.4);

    const MAX_BLAST_DROPS = 14;
    let drops = 0;
    const destroyed = this.world.destroySphere(pos, 2.9, (x, y, z, id) => {
      this.removeFloatingPlantsAbove(x, y, z);
      if (id === B.TORCH) this.torchLights.remove(x, y, z);
      this.detachTorchesSupportedBy(x, y, z, false);
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

  private reportStats(dt: number): void {
    this.statT -= dt;
    if (this.statT > 0) return;
    this.statT = this.dmgFollowT > 0 ? 0.05 : 0.25;
    this.events.onStats(this.buildStats());
  }

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

    const furnaceGauges = this.furnaceMgr.getFurnaceGauges();

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
      furnaceOpen: !!this.furnaceMgr.openFurnaceKey,
      furnaceBurn: furnaceGauges.furnaceBurn,
      furnaceCook: furnaceGauges.furnaceCook,
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
      targetsHit: this.targetMgr.targetsHit,
      session: 1 - (this.time % 300) / 300,
      switchAt: this.switchAt,
      spread:
        7 + this.weapons.bloomPx * 26 +
        Math.min(1, this.player.speedSmooth / 6) * 9 * (1 - this.weapons.adsT * 0.9),
      coins: this.shop.coins,
      coinSeq: this.shop.coinSeq,
      lastCoinGain: this.shop.lastCoinGain,
      nearMerchant: this.shop.nearMerchant,
      shopOpen: !!this.shop.shopEnemy,
      shopMerchantName: this.shop.shopEnemy ? this.shop.shopEnemy.cfg.name : null,
      shopStock: this.shop.shopStock.map((s) => ({ ...s })),
      shopSellOpen: this.shop.shopSellOpen,
    };
  }

  getWorld(): World {
    return this.world;
  }

  getPlayer(): Player {
    return this.player;
  }

  getCamps(): { x: number; z: number; cleared: boolean }[] {
    const camps = this.enemies?.camps ?? [];
    return camps.map((c) => ({
      x: c.site.cx,
      z: c.site.cz,
      cleared: c.cleared,
    }));
  }

  getClearedCampIds(): number[] {
    return this.enemies?.getClearedCampIds() ?? [...(this.initialClearedCamps ?? [])];
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.sound.stopShip();
    this.itemDrops?.clear();
    this.inserters?.clear();
    this.laserMiners?.clear();
    this.removeListeners();
    window.removeEventListener('resize', this.resize);
    this.world?.materials.cutoutDepth?.dispose();
    this.world?.materials.foliageDepth?.dispose();
    if (this.postPipeline) this.postPipeline.dispose();
    for (const g of this.blockGeomCache.values()) g.dispose();
    this.blockGeomCache.clear();
    this.weapons?.dispose();
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