/**
 * Block registry — the single source of truth for every block type.
 * Each definition declares its atlas tiles, physics flags, break behavior,
 * sound material and particle palette.
 */

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
} as const;

export type SoundMat = 'grass' | 'dirt' | 'sand' | 'stone' | 'wood' | 'glass' | 'plant';

export interface BlockDef {
  name: string;
  /** atlas tiles */
  top: number;
  side: number;
  bottom: number;
  /** tile used for the hotbar icon */
  icon: number;
  /** participates in collision */
  solid: boolean;
  /** fully occludes neighbor faces */
  opaque: boolean;
  /** alpha-cutout rendering (leaves, glass, plants) */
  cutout?: boolean;
  /** cross-quad plant shape */
  cross?: boolean;
  water?: boolean;
  /** seconds to mine; Infinity = unbreakable */
  hardness: number;
  sound: SoundMat;
  /** particle palette for break VFX */
  colors: number[];
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

/** hotbar pseudo-item: the water bucket (not a placeable block id) */
export const BUCKET_ID = 100;

/** blocks the player can select (hotbar slots 1-9) */
export const HOTBAR: number[] = [
  B.GRASS, B.DIRT, B.STONE, B.PLANKS, B.LOG, B.SAND, B.GLASS, B.LEAVES, BUCKET_ID,
];

// ---------------------------------------------------------------------------
// dynamic water state encoding
// ---------------------------------------------------------------------------
// level 0 = source (B.WATER), levels 1..7 = flowing (ids 24..30),
// falling water (waterfalls) levels 0..7 = ids 31..38

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

/** rendered surface height of a water state (top face as a fraction of a block) */
export function waterHeight(level: number, falling: boolean): number {
  if (falling) return 1;
  if (level === 0) return 0.875; // sources sit at 14/16
  return (8 - level) / 9; // MC formula: level 1 -> 0.778 ... level 7 -> 0.111
}

// register defs for every dynamic water state + fill reserved holes safely
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

// ---------------------------------------------------------------------------
// theme tinting for particle / minimap colours
// ---------------------------------------------------------------------------

/** which tint group each block's particle palette follows */
const BLOCK_GROUP: Partial<Record<number, string>> = {
  [B.GRASS]: 'grass', [B.DIRT]: 'dirt', [B.STONE]: 'stone', [B.SAND]: 'sand',
  [B.LOG]: 'log', [B.LEAVES]: 'leaves', [B.WATER]: 'water', [B.SNOW]: 'snow',
  [B.PLANKS]: 'planks', [B.TALLGRASS]: 'grass', [B.GRAVEL]: 'stone',
  [B.BEDROCK]: 'stone', [B.CACTUS]: 'cactus', [B.CRAFTING_TABLE]: 'planks',
  [B.FURNACE]: 'stone', [B.COBBLE]: 'stone',
};

/** stock colours, captured once so re-theming is never cumulative */
const BASE_COLORS: number[][] = DEFS.map((d) => (d ? d.colors.slice() : []));

/**
 * Re-tint DEFS[].colors to match a planet theme. Call once right after
 * createTextures(theme) so break particles and the minimap agree with the
 * atlas. Passing null/undefined restores the stock palette.
 */
export function applyThemeToBlockColors(theme?: PlanetTheme | null): void {
  const tints = tintsFromTheme(theme);
  for (let id = 0; id < DEFS.length; id++) {
    const d = DEFS[id];
    if (!d) continue;
    const base = BASE_COLORS[id];
    const m = tints ? tints[BLOCK_GROUP[id] ?? ''] : null;
    d.colors = base.map((hex) => {
      if (!m) return hex;
      const r = Math.max(0, Math.min(255, ((hex >> 16) & 255) * m[0]));
      const g = Math.max(0, Math.min(255, ((hex >> 8) & 255) * m[1]));
      const b = Math.max(0, Math.min(255, (hex & 255) * m[2]));
      return (r << 16) | (g << 8) | b;
    });
  }
}
