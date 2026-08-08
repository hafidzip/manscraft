/**
 * Biome system. Biomes are chosen per-column from low-frequency
 * temperature / humidity / mountain-ness noise fields.
 */

import { B } from './blocks';

export enum Biome {
  PLAINS = 0,
  FOREST = 1,
  DESERT = 2,
  MOUNTAINS = 3,
  SNOW = 4,
}

export type TreeKind = 'oak' | 'spruce' | null;

export interface BiomeDef {
  name: string;
  surface: number;
  sub: number;
  /** rolling-hill amplitude */
  hill: number;
  /** per-column tree probability */
  trees: number;
  tree: TreeKind;
  flowers: number;
  grass: number;
  cactus: number;
}

export const BIOME_DEFS: BiomeDef[] = [
  {
    name: 'Plains', surface: B.GRASS, sub: B.DIRT, hill: 2.0,
    trees: 0.006, tree: 'oak', flowers: 0.03, grass: 0.58, cactus: 0,
  },
  {
    name: 'Forest', surface: B.GRASS, sub: B.DIRT, hill: 3.0,
    trees: 0.05, tree: 'oak', flowers: 0.012, grass: 0.64, cactus: 0,
  },
  {
    name: 'Desert', surface: B.SAND, sub: B.SAND, hill: 1.5,
    trees: 0, tree: null, flowers: 0, grass: 0, cactus: 0.014,
  },
  {
    name: 'Mountains', surface: B.GRASS, sub: B.STONE, hill: 7,
    trees: 0.006, tree: 'oak', flowers: 0.01, grass: 0.32, cactus: 0,
  },
  {
    name: 'Snowy Taiga', surface: B.SNOW, sub: B.DIRT, hill: 4,
    trees: 0.022, tree: 'spruce', flowers: 0, grass: 0.02, cactus: 0,
  },
];

export function pickBiome(temp: number, humid: number, mount: number, cont: number): Biome {
  // cliffs & islets off the coast pick the "mountain" look for stony shores
  if (cont < -0.02) return Biome.MOUNTAINS;
  if (mount > 0.68) return temp < 0.3 ? Biome.SNOW : Biome.MOUNTAINS;
  if (temp < 0.26) return Biome.SNOW;
  if (temp > 0.68 && humid < 0.45) return Biome.DESERT;
  if (humid > 0.55) return Biome.FOREST;
  return Biome.PLAINS;
}
