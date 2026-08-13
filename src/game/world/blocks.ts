
import { TILES, tintsFromTheme } from '../core/textures';
import type { PlanetTheme } from '../space/theme';
import { NO_ORIGIN, originColorMul, type OriginTag } from '../core/origin';

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  LOG: 5,
  LEAVES: 6,
  WATER: 7,
  SNOW: 8,
  PLANKS: 9,
  GLASS: 10,
  FLOWER_RED: 11,
  FLOWER_YELLOW: 12,
  TALLGRASS: 13,
  BEDROCK: 14,
  GRAVEL: 15,
  CACTUS: 16,
  CRAFTING_TABLE: 17,
  FURNACE: 18,
  FURNACE_LIT: 19,
  COBBLE: 20,
  ORE_RUBY: 40,
  ORE_AMBER: 41,
  ORE_LUMINESCENCE: 42,
  ORE_DIAMOND: 43,
  ORE_GOLD: 44,
  ORE_SILVER: 45,
  ORE_JADE: 46,
  ORE_EMERALD: 47,
  COAL_ORE: 48,
  TORCH: 49,
  COAL_ITEM: 50,
  STICK_ITEM: 51,
  CONVEYOR_N: 52,
  CONVEYOR_E: 53,
  CONVEYOR_S: 54,
  CONVEYOR_W: 55,
  INSERTER_N: 56,
  INSERTER_E: 57,
  INSERTER_S: 58,
  INSERTER_W: 59,
  LASER_MINER_N: 60,
  LASER_MINER_E: 61,
  LASER_MINER_S: 62,
  LASER_MINER_W: 63,
  TURRET: 64,

  LOG_BIRCH: 110,
  LOG_SPRUCE: 111,
  LOG_PALM: 112,
  LOG_ALIEN: 113,
  LEAVES_BIRCH: 114,
  LEAVES_SPRUCE: 115,
  LEAVES_AUTUMN: 116,
  LEAVES_JUNGLE: 117,
  LEAVES_ALIEN: 118,
  LEAVES_CRIMSON: 119,
  LEAVES_NEON: 120,
  LEAVES_CRYSTAL: 121,
  LEAVES_SNOW: 122,
} as const;

export const LOG_IDS: readonly number[] = [
  B.LOG, B.LOG_BIRCH, B.LOG_SPRUCE, B.LOG_PALM, B.LOG_ALIEN,
] as const;
export const LEAF_IDS: readonly number[] = [
  B.LEAVES, B.LEAVES_BIRCH, B.LEAVES_SPRUCE, B.LEAVES_AUTUMN, B.LEAVES_JUNGLE,
  B.LEAVES_ALIEN, B.LEAVES_CRIMSON, B.LEAVES_NEON, B.LEAVES_CRYSTAL, B.LEAVES_SNOW,
] as const;
const LOG_SET = new Set<number>(LOG_IDS);
const LEAF_SET = new Set<number>(LEAF_IDS);
export const isLog = (id: number): boolean => LOG_SET.has(id);
export const isLeaves = (id: number): boolean => LEAF_SET.has(id);

export type SoundMat = 'grass' | 'dirt' | 'sand' | 'stone' | 'wood' | 'glass' | 'plant';

export interface BlockDef {
  name: string;
  top: number;
  side: number;
  bottom: number;
  icon: number;
  solid: boolean;
  opaque: boolean;
  cutout?: boolean;
  cross?: boolean;
  water?: boolean;
  hardness: number;
  sound: SoundMat;
  colors: number[];
  light?: number;
}

interface DefSpec {
  name: string;
  top: number;
  side?: number;
  bottom?: number;
  icon?: number;
  solid?: boolean;
  opaque?: boolean;
  cutout?: boolean;
  cross?: boolean;
  water?: boolean;
  hardness?: number;
  sound?: SoundMat;
  colors?: number[];
  light?: number;
}

function def(p: DefSpec): BlockDef {
  const side = p.side ?? p.top;
  return {
    name: p.name,
    top: p.top,
    side,
    bottom: p.bottom ?? side,
    icon: p.icon ?? side,
    solid: p.solid ?? true,
    opaque: p.opaque ?? true,
    cutout: p.cutout,
    cross: p.cross,
    water: p.water,
    hardness: p.hardness ?? 0.5,
    sound: p.sound ?? 'stone',
    colors: p.colors ?? [0x888888],
    light: p.light ?? 0,
  };
}

export const DEFS: BlockDef[] = [];
DEFS[B.AIR] = def({ name: 'Air', top: 0, solid: false, opaque: false, hardness: 0 });
DEFS[B.GRASS] = def({
  name: 'Grass Block', top: TILES.grass_top, side: TILES.grass_side, bottom: TILES.dirt, icon: TILES.grass_top,
  hardness: 0.45, sound: 'grass', colors: [0x91bd59, 0xa4c86a, 0x79553a, 0x6b8c3a],
});
DEFS[B.DIRT] = def({
  name: 'Dirt', top: TILES.dirt, hardness: 0.4, sound: 'dirt',
  colors: [0x79553a, 0x8a6142, 0x694830],
});
DEFS[B.STONE] = def({
  name: 'Stone', top: TILES.stone, hardness: 1.0, sound: 'stone',
  colors: [0x808080, 0x929292, 0x6a6a6e],
});
DEFS[B.SAND] = def({
  name: 'Sand', top: TILES.sand, hardness: 0.35, sound: 'sand',
  colors: [0xdbcfa3, 0xc7b885, 0xe8ddbb],
});
DEFS[B.LOG] = def({
  name: 'Oak Log', top: TILES.log_top, side: TILES.log_side, hardness: 0.8, sound: 'wood',
  colors: [0x684c2c, 0x563e24, 0xb08a5a],
});
DEFS[B.LOG_BIRCH] = def({
  name: 'Birch Log', top: TILES.log_birch_top, side: TILES.log_birch_side, hardness: 0.8, sound: 'wood',
  colors: [0xd6d2c4, 0xbfbaa8, 0x2c2824],
});
DEFS[B.LOG_SPRUCE] = def({
  name: 'Spruce Log', top: TILES.log_spruce_top, side: TILES.log_spruce_side, hardness: 0.85, sound: 'wood',
  colors: [0x4a3626, 0x38281c, 0x6d523a],
});
DEFS[B.LOG_PALM] = def({
  name: 'Palm Log', top: TILES.log_palm_top, side: TILES.log_palm_side, hardness: 0.7, sound: 'wood',
  colors: [0x7a623e, 0x5f4c30, 0x9c8154],
});
DEFS[B.LOG_ALIEN] = def({
  name: 'Xeno Stalk', top: TILES.log_alien_top, side: TILES.log_alien_side, hardness: 0.7, sound: 'wood',
  colors: [0x60467c, 0x452f5c, 0x9a6ec4], light: 4,
});

const leafDef = (name: string, tile: number, colors: number[], light?: number) =>
  def({ name, top: tile, opaque: false, cutout: true, hardness: 0.15, sound: 'plant', colors, light });

DEFS[B.LEAVES] = leafDef('Oak Leaves', TILES.leaves, [0x2e6626, 0x3f8428, 0x27571f]);
DEFS[B.LEAVES_BIRCH] = leafDef('Birch Leaves', TILES.leaves_birch, [0x789a3c, 0x8fb04a, 0x5f8030]);
DEFS[B.LEAVES_SPRUCE] = leafDef('Spruce Needles', TILES.leaves_spruce, [0x1f5044, 0x2b6a56, 0x17403a]);
DEFS[B.LEAVES_AUTUMN] = leafDef('Autumn Leaves', TILES.leaves_autumn, [0xb4701e, 0xce8a26, 0x8c4c18]);
DEFS[B.LEAVES_JUNGLE] = leafDef('Jungle Leaves', TILES.leaves_jungle, [0x2a7122, 0x3a8c2a, 0x1d551c]);
DEFS[B.LEAVES_ALIEN] = leafDef('Xeno Fronds', TILES.leaves_alien, [0x9f3cb0, 0xc454d0, 0x7a2a8c], 5);
DEFS[B.LEAVES_CRIMSON] = leafDef('Crimson Fronds', TILES.leaves_crimson, [0x992528, 0xb43a36, 0x71191d]);
DEFS[B.LEAVES_NEON] = leafDef('Neon Caps', TILES.leaves_neon, [0x2bc1a2, 0x40e0c0, 0x1c8f78], 8);
DEFS[B.LEAVES_CRYSTAL] = leafDef('Frost Shards', TILES.leaves_crystal, [0x7cb6d6, 0xa2d6ee, 0x5e93b4], 3);
DEFS[B.LEAVES_SNOW] = leafDef('Snow Leaves', TILES.leaves_snow, [0xdce8ea, 0xf2f7f8, 0xc5d4d6]);
DEFS[B.WATER] = def({
  name: 'Water', top: TILES.water, solid: false, opaque: false, water: true, cutout: false,
  hardness: 0, sound: 'sand', colors: [0x3a66de, 0x5c8af4],
});
DEFS[B.SNOW] = def({
  name: 'Snow Block', top: TILES.snow, side: TILES.snow_side, bottom: TILES.dirt, icon: TILES.snow,
  hardness: 0.3, sound: 'sand', colors: [0xeef6f8, 0xd6e8ee, 0xf0f7fa],
});
DEFS[B.PLANKS] = def({
  name: 'Oak Planks', top: TILES.planks, hardness: 0.8, sound: 'wood',
  colors: [0xa48150, 0x8f6d3f, 0xbd9260],
});
DEFS[B.GLASS] = def({
  name: 'Glass', top: TILES.glass, opaque: false, cutout: true, hardness: 0.3, sound: 'glass',
  colors: [0xcee8f5, 0xe0f4fc],
});
DEFS[B.FLOWER_RED] = def({
  name: 'Poppy', top: TILES.flower_red, solid: false, opaque: false, cutout: true, cross: true,
  hardness: 0.05, sound: 'plant', colors: [0xcd2f2a, 0x3a7a2c, 0xffd65c],
});
DEFS[B.FLOWER_YELLOW] = def({
  name: 'Dandelion', top: TILES.flower_yellow, solid: false, opaque: false, cutout: true, cross: true,
  hardness: 0.05, sound: 'plant', colors: [0xe4c642, 0x3a7a2c, 0xb47828],
});
DEFS[B.TALLGRASS] = def({
  name: 'Tall Grass', top: TILES.tallgrass, solid: false, opaque: false, cutout: true, cross: true,
  hardness: 0.05, sound: 'plant', colors: [0x7fad4a, 0x5e8234],
});
DEFS[B.BEDROCK] = def({
  name: 'Bedrock', top: TILES.bedrock, hardness: Infinity, sound: 'stone',
  colors: [0x383838, 0x585858],
});
DEFS[B.GRAVEL] = def({
  name: 'Gravel', top: TILES.gravel, hardness: 0.4, sound: 'dirt',
  colors: [0x807e7b, 0x8e8780, 0x686562],
});
DEFS[B.CACTUS] = def({
  name: 'Cactus', top: TILES.cactus_top, side: TILES.cactus_side, hardness: 0.4, sound: 'grass',
  colors: [0x3e8a38, 0x2a6a28, 0x52a24a],
});
DEFS[B.CRAFTING_TABLE] = def({
  name: 'Crafting Table',
  top: TILES.craft_top, side: TILES.craft_side, bottom: TILES.craft_bottom, icon: TILES.craft_top,
  hardness: 0.8, sound: 'wood',
  colors: [0xa48150, 0x8f6d3f, 0x64482a, 0xbd9260],
});
DEFS[B.COBBLE] = def({
  name: 'Cobblestone', top: TILES.cobble, hardness: 1.1, sound: 'stone',
  colors: [0x8c8c90, 0x76767a, 0x646468],
});
DEFS[B.FURNACE] = def({
  name: 'Furnace',
  top: TILES.furnace_top, side: TILES.furnace_front, bottom: TILES.furnace_top,
  icon: TILES.furnace_front,
  hardness: 1.2, sound: 'stone',
  colors: [0x7c7c80, 0x8e8e92, 0x5a5a5e, 0x2c2c30],
});
DEFS[B.FURNACE_LIT] = def({
  name: 'Furnace',
  top: TILES.furnace_top, side: TILES.furnace_front_lit, bottom: TILES.furnace_top,
  icon: TILES.furnace_front_lit,
  hardness: 1.2, sound: 'stone',
  colors: [0x7c7c80, 0xffa028, 0xe45818, 0xffd65c],
});

DEFS[B.ORE_RUBY] = def({
  name: 'Ruby Ore', top: TILES.ore_ruby, hardness: 2.5, sound: 'stone',
  colors: [0xb41e28, 0xff505a, 0x7a7a80],
});
DEFS[B.ORE_AMBER] = def({
  name: 'Amber Ore', top: TILES.ore_amber, hardness: 2.0, sound: 'stone',
  colors: [0xc88c1e, 0xffc83c, 0x7a7a80],
});
DEFS[B.ORE_LUMINESCENCE] = def({
  name: 'Luminescence Ore', top: TILES.ore_luminescence, hardness: 3.0, sound: 'stone',
  colors: [0x3cb496, 0x8cffe0, 0x6a6a70],
});
DEFS[B.ORE_DIAMOND] = def({
  name: 'Diamond Ore', top: TILES.ore_diamond, hardness: 3.5, sound: 'stone',
  colors: [0x50b4dc, 0xb4f0ff, 0x7a7a80],
});
DEFS[B.ORE_GOLD] = def({
  name: 'Gold Ore', top: TILES.ore_gold, hardness: 2.8, sound: 'stone',
  colors: [0xc8a028, 0xffdc50, 0x7a7a80],
});
DEFS[B.ORE_SILVER] = def({
  name: 'Silver Ore', top: TILES.ore_silver, hardness: 2.5, sound: 'stone',
  colors: [0xaab0b4, 0xe6ebf0, 0x7a7a80],
});
DEFS[B.ORE_JADE] = def({
  name: 'Jade Ore', top: TILES.ore_jade, hardness: 2.8, sound: 'stone',
  colors: [0x46965a, 0x8cdc9f, 0x7a7a80],
});
DEFS[B.ORE_EMERALD] = def({
  name: 'Emerald Ore', top: TILES.ore_emerald, hardness: 3.2, sound: 'stone',
  colors: [0x1ea050, 0x50ff78, 0x7a7a80],
});
DEFS[B.COAL_ORE] = def({
  name: 'Coal Ore', top: TILES.coal_ore, hardness: 1.6, sound: 'stone',
  colors: [0x2c2c30, 0x808085, 0x1a1a1e],
});
DEFS[B.TORCH] = def({
  name: 'Torch', top: TILES.torch, icon: TILES.torch,
  solid: false, opaque: false, cutout: true, cross: true,
  hardness: 0.05, sound: 'wood', light: 1,
  colors: [0xffd65c, 0xffa028, 0x6b5136],
});
DEFS[B.COAL_ITEM] = def({
  name: 'Coal', top: TILES.coal, icon: TILES.coal,
  solid: false, opaque: false, cutout: true,
  hardness: 0, sound: 'stone', colors: [0x26262c, 0x44444a],
});
DEFS[B.STICK_ITEM] = def({
  name: 'Stick', top: TILES.stick, icon: TILES.stick,
  solid: false, opaque: false, cutout: true,
  hardness: 0, sound: 'wood', colors: [0x8a643a, 0xa67c4a],
});

type Dir = [number, number];
const DIRS: Dir[] = [[0, -1], [1, 0], [0, 1], [-1, 0]];

const orient = <T>(ids: readonly number[], val: T | ((i: number) => T)): Map<number, T> => {
  const m = new Map<number, T>();
  ids.forEach((id, i) => m.set(id, typeof val === 'function' ? (val as (i: number) => T)(i) : val));
  return m;
};

const CONV = [B.CONVEYOR_N, B.CONVEYOR_E, B.CONVEYOR_S, B.CONVEYOR_W] as const;
const INS = [B.INSERTER_N, B.INSERTER_E, B.INSERTER_S, B.INSERTER_W] as const;
const LM = [B.LASER_MINER_N, B.LASER_MINER_E, B.LASER_MINER_S, B.LASER_MINER_W] as const;

const CONV_TOPS = [TILES.conveyor_top_n, TILES.conveyor_top_e, TILES.conveyor_top_s, TILES.conveyor_top_w];
const INS_TOPS = [TILES.inserter_top_n, TILES.inserter_top_e, TILES.inserter_top_s, TILES.inserter_top_w];

const machineDef = (name: string, top: number, side: number, hardness: number, colors: number[], ghost = false): BlockDef => {
  const d = def({ name, top, side, bottom: side, icon: top, hardness, sound: 'stone', colors });
  if (ghost) {
    d.solid = false;
    d.opaque = false;
    d.hardness = 0.05;
  }
  return d;
};

CONV.forEach((id, i) => {
  DEFS[id] = machineDef('Conveyor Belt', CONV_TOPS[i], TILES.conveyor_side, 0.8, [0x484854, 0x6a6a72, 0xdc8c1e]);
});
INS.forEach((id, i) => {
  DEFS[id] = machineDef('Inserter', INS_TOPS[i], TILES.inserter_side, 1.0, [0x505058, 0x6a6a72, 0xdc8c1e], true);
});
{
  const lm = machineDef('Laser Miner', TILES.furnace_top, TILES.inserter_side, 1.4, [0x54575c, 0x9aa0a8, 0xff5a1e, 0x2c2f34], true);
  LM.forEach((id) => { DEFS[id] = lm; });
}
DEFS[B.TURRET] = machineDef(
  'Turret', TILES.furnace_top, TILES.inserter_side, 1.6,
  [0x4a4e56, 0x8c939c, 0xffcc44, 0x24272c], true,
);

const CONV_DIR = orient(CONV, (i) => DIRS[i]);
const INS_DIR = orient(INS, (i) => DIRS[i]);
const LM_DIR = orient(LM, (i) => DIRS[i]);

export const isConveyor = (id: number): boolean => CONV_DIR.has(id);
export const isInserter = (id: number): boolean => INS_DIR.has(id);
export const isLaserMiner = (id: number): boolean => LM_DIR.has(id);
export const isTurret = (id: number): boolean => id === B.TURRET;

export const ORE_BLOCK_IDS = [
  B.ORE_RUBY, B.ORE_AMBER, B.ORE_LUMINESCENCE, B.ORE_DIAMOND,
  B.ORE_GOLD, B.ORE_SILVER, B.ORE_JADE, B.ORE_EMERALD, B.COAL_ORE,
] as const;
const ORE_SET = new Set<number>(ORE_BLOCK_IDS);

export const isOreBlock = (id: number): boolean => ORE_SET.has(id);
export const isIndestructible = (id: number): boolean => id === B.BEDROCK || isOreBlock(id);
export const oreHarvestTime = (id: number): number => {
  const h = DEFS[id]?.hardness ?? 1.6;
  return Number.isFinite(h) && h > 0 ? h : 1.6;
};

export const isCrossPlant = (id: number): boolean => DEFS[id]?.cross === true;

export const isLaserProtected = (id: number): boolean => {
  if (id === B.TORCH) return true;
  const d = DEFS[id];
  if (!d) return true;
  return false;
};

export const canLaserBreak = (id: number): boolean => {
  if (id < 0 || id === B.AIR) return false;
  if (isLaserProtected(id)) return false;
  const d = DEFS[id];
  if (!d) return false;
  return Number.isFinite(d.hardness);
};

export const isMachine = (id: number): boolean =>
  CONV_DIR.has(id) || INS_DIR.has(id) || LM_DIR.has(id) || id === B.TURRET;
export const conveyorDir = (id: number): Dir | null => CONV_DIR.get(id) ?? null;
export const inserterDir = (id: number): Dir | null => INS_DIR.get(id) ?? null;
export const laserMinerDir = (id: number): Dir | null => LM_DIR.get(id) ?? null;

export const BUCKET_ID = 100;

export const HOTBAR: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.PLANKS, B.LOG, B.SAND, B.GLASS, B.LEAVES, BUCKET_ID,
];


export const WATER_FLOW_BASE = 24;
export const WATER_FALL_BASE = 31;

export interface WaterInfo {
  level: number;
  falling: boolean;
}

export function waterInfo(id: number): WaterInfo | null {
  if (id === B.WATER) return { level: 0, falling: false };
  if (id >= WATER_FLOW_BASE && id <= WATER_FLOW_BASE + 6) return { level: id - 23, falling: false };
  if (id >= WATER_FALL_BASE && id <= WATER_FALL_BASE + 7) return { level: id - WATER_FALL_BASE, falling: true };
  return null;
}

export function isWaterId(id: number): boolean {
  return waterInfo(id) !== null;
}

export function waterId(level: number, falling: boolean): number {
  if (falling) return WATER_FALL_BASE + level;
  return level === 0 ? B.WATER : 23 + level;
}

export const WATER_MAX_LEVEL = 7;

export function waterHeight(level: number, falling: boolean): number {
  if (falling) return 1;
  if (level === 0) return 0.875;
  return (8 - level) / 9;
}

{
  const waterDef = (name: string): BlockDef =>
    def({
      name, top: TILES.water, solid: false, opaque: false, water: true,
      hardness: 0, sound: 'sand', colors: [0x3a66de, 0x5c8af4, 0x2a4fc0],
    });
  for (let l = 1; l <= 7; l++) DEFS[23 + l] = waterDef('Flowing Water');
  for (let l = 0; l <= 7; l++) DEFS[WATER_FALL_BASE + l] = waterDef('Falling Water');
  for (let i = 0; i < DEFS.length; i++) {
    if (!DEFS[i]) DEFS[i] = def({ name: 'Reserved', top: 0, solid: false, opaque: false, hardness: 0 });
  }
}


const STONE_GROUP = [
  B.STONE, B.GRAVEL, B.BEDROCK, B.FURNACE, B.COBBLE,
  ...CONV, ...INS, ...LM,
];
export const BLOCK_GROUP: Partial<Record<number, string>> = {
  [B.GRASS]: 'grass', [B.DIRT]: 'dirt', [B.SAND]: 'sand',
  [B.LOG]: 'log', [B.LEAVES]: 'leaves', [B.WATER]: 'water', [B.SNOW]: 'snow',
  [B.PLANKS]: 'planks', [B.TALLGRASS]: 'grass',
  [B.CACTUS]: 'cactus', [B.CRAFTING_TABLE]: 'planks',
  [B.LOG_BIRCH]: 'log_birch',
  [B.LOG_SPRUCE]: 'log_spruce',
  [B.LOG_PALM]: 'log_palm',
  [B.LOG_ALIEN]: 'log_alien',
  [B.LEAVES_BIRCH]: 'leaves_birch',
  [B.LEAVES_SPRUCE]: 'leaves_spruce',
  [B.LEAVES_AUTUMN]: 'leaves_autumn',
  [B.LEAVES_JUNGLE]: 'leaves_jungle',
  [B.LEAVES_ALIEN]: 'leaves_alien',
  [B.LEAVES_CRIMSON]: 'leaves_crimson',
  [B.LEAVES_NEON]: 'leaves_neon',
  [B.LEAVES_CRYSTAL]: 'leaves_crystal',
  [B.LEAVES_SNOW]: 'leaves_snow',
  ...Object.fromEntries(STONE_GROUP.map((id) => [id, 'stone'])),
};

export const THEMED_IDS: ReadonlySet<number> = new Set([
  B.GRASS, B.DIRT, B.SAND, B.LOG, B.LEAVES, B.PLANKS, B.TALLGRASS,
  B.FLOWER_RED, B.FLOWER_YELLOW, B.SNOW, B.WATER, B.CACTUS,
  B.LOG_BIRCH, B.LOG_SPRUCE, B.LOG_PALM, B.LOG_ALIEN,
  B.LEAVES_BIRCH, B.LEAVES_SPRUCE, B.LEAVES_AUTUMN, B.LEAVES_JUNGLE,
  B.LEAVES_ALIEN, B.LEAVES_CRIMSON, B.LEAVES_NEON, B.LEAVES_CRYSTAL, B.LEAVES_SNOW,
]);
export const isThemedId = (id: number): boolean => THEMED_IDS.has(id);

const BASE_COLORS: number[][] = DEFS.map((d) => (d ? d.colors.slice() : []));

function tintColors(base: number[], m: readonly [number, number, number] | null | undefined): number[] {
  if (!m) return base;
  return base.map((hex) => {
    const ch = (shift: number, f: number) => Math.max(0, Math.min(255, ((hex >> shift) & 255) * f));
    return (ch(16, m[0]) << 16) | (ch(8, m[1]) << 8) | ch(0, m[2]);
  });
}

export function applyThemeToBlockColors(theme?: PlanetTheme | null): void {
  const tints = tintsFromTheme(theme);
  for (let id = 0; id < DEFS.length; id++) {
    const d = DEFS[id];
    if (!d) continue;
    const base = BASE_COLORS[id];
    const m = tints ? tints[BLOCK_GROUP[id] ?? ''] : null;
    d.colors = tintColors(base, m);
  }
}

const colorCache = new Map<number, number[]>();

export function colorsFor(id: number, tag: OriginTag = NO_ORIGIN): number[] {
  const d = DEFS[id];
  if (!d) return [0xffffff];
  const base = BASE_COLORS[id] ?? d.colors;
  const group = BLOCK_GROUP[id];
  if (!tag || !group) return d.colors;
  const key = (id << 8) | tag;
  const hit = colorCache.get(key);
  if (hit) return hit;
  const m = originColorMul(tag, group);
  const out = tintColors(base, m);
  colorCache.set(key, out);
  return out;
}
