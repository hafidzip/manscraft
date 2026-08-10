
import { TILES, tintsFromTheme } from '../core/textures';
import type { PlanetTheme } from '../space/theme';

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
} as const;

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
  hardness: 0.45, sound: 'grass', colors: [0x5e9c34, 0x6fb23e, 0x79553a, 0x4a7a2c],
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
DEFS[B.LEAVES] = def({
  name: 'Leaves', top: TILES.leaves, opaque: false, cutout: true, hardness: 0.15, sound: 'plant',
  colors: [0x2e6626, 0x3f8428, 0x27571f],
});
DEFS[B.WATER] = def({
  name: 'Water', top: TILES.water, solid: false, opaque: false, water: true, cutout: false,
  hardness: 0, sound: 'sand', colors: [0x3a66de, 0x5c8af4],
});
DEFS[B.SNOW] = def({
  name: 'Snow Block', top: TILES.snow, side: TILES.snow_side, bottom: TILES.dirt, icon: TILES.snow,
  hardness: 0.3, sound: 'sand', colors: [0xeef6f8, 0xd6e8ee, 0x79553a],
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
  hardness: 0.05, sound: 'plant', colors: [0x589436, 0x467527],
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

const machineDef = (name: string, top: number, side: number, hardness: number, colors: number[]): BlockDef =>
  def({ name, top, side, bottom: side, icon: top, hardness, sound: 'stone', colors });

CONV.forEach((id, i) => {
  DEFS[id] = machineDef('Conveyor Belt', CONV_TOPS[i], TILES.conveyor_side, 0.8, [0x484854, 0x6a6a72, 0xdc8c1e]);
});
INS.forEach((id, i) => {
  DEFS[id] = machineDef('Inserter', INS_TOPS[i], TILES.inserter_side, 1.0, [0x505058, 0x6a6a72, 0xdc8c1e]);
});
{
  const lm = machineDef('Laser Miner', TILES.furnace_top, TILES.inserter_side, 1.4, [0x54575c, 0x9aa0a8, 0xff5a1e, 0x2c2f34]);
  LM.forEach((id) => { DEFS[id] = lm; });
}

const CONV_DIR = orient(CONV, (i) => DIRS[i]);
const INS_DIR = orient(INS, (i) => DIRS[i]);
const LM_DIR = orient(LM, (i) => DIRS[i]);

export const isConveyor = (id: number): boolean => CONV_DIR.has(id);
export const isInserter = (id: number): boolean => INS_DIR.has(id);
export const isLaserMiner = (id: number): boolean => LM_DIR.has(id);
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
const BLOCK_GROUP: Partial<Record<number, string>> = {
  [B.GRASS]: 'grass', [B.DIRT]: 'dirt', [B.SAND]: 'sand',
  [B.LOG]: 'log', [B.LEAVES]: 'leaves', [B.WATER]: 'water', [B.SNOW]: 'snow',
  [B.PLANKS]: 'planks', [B.TALLGRASS]: 'grass',
  [B.CACTUS]: 'cactus', [B.CRAFTING_TABLE]: 'planks',
  ...Object.fromEntries(STONE_GROUP.map((id) => [id, 'stone'])),
};

const BASE_COLORS: number[][] = DEFS.map((d) => (d ? d.colors.slice() : []));

export function applyThemeToBlockColors(theme?: PlanetTheme | null): void {
  const tints = tintsFromTheme(theme);
  for (let id = 0; id < DEFS.length; id++) {
    const d = DEFS[id];
    if (!d) continue;
    const base = BASE_COLORS[id];
    const m = tints ? tints[BLOCK_GROUP[id] ?? ''] : null;
    d.colors = base.map((hex) => {
      if (!m) return hex;
      const ch = (shift: number, f: number) => Math.max(0, Math.min(255, ((hex >> shift) & 255) * f));
      return (ch(16, m[0]) << 16) | (ch(8, m[1]) << 8) | ch(0, m[2]);
    });
  }
}
