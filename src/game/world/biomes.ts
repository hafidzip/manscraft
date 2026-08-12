import { B } from './blocks';
import type { SpeciesMix } from './treeSpecies';

export enum Biome {
  PLAINS = 0,
  FOREST = 1,
  DESERT = 2,
  MOUNTAINS = 3,
  SNOW = 4,
}

export type TreeKind = 'auto' | null;
export const LEGACY_TREE_KINDS = { oak: 'auto', spruce: 'auto' } as const;

export interface BiomeDef {
  name: string;
  surface: number;
  sub: number;
  hill: number;
  trees: number;
  tree: TreeKind;
  flowers: number;
  grass: number;
  cactus: number;
  treeMix?: SpeciesMix[];
}

export const BIOME_DEFS: BiomeDef[] = [
  {
    name: 'Plains', surface: B.GRASS, sub: B.DIRT, hill: 2.0,
    trees: 0.006, tree: 'auto', flowers: 0.03, grass: 0.58, cactus: 0,
    treeMix: [{ species: 'oak', w: 6 }, { species: 'birch', w: 3 }, { species: 'autumn', w: 1 }],
  },
  {
    name: 'Forest', surface: B.GRASS, sub: B.DIRT, hill: 3.0,
    trees: 0.05, tree: 'auto', flowers: 0.012, grass: 0.64, cactus: 0,
    treeMix: [{ species: 'oak', w: 5 }, { species: 'birch', w: 3 }, { species: 'autumn', w: 2 }],
  },
  {
    name: 'Desert', surface: B.SAND, sub: B.SAND, hill: 1.5,
    trees: 0, tree: 'auto', flowers: 0, grass: 0, cactus: 0.014,
  },
  {
    name: 'Mountains', surface: B.GRASS, sub: B.STONE, hill: 7,
    trees: 0.006, tree: 'auto', flowers: 0.01, grass: 0.32, cactus: 0,
    treeMix: [{ species: 'spruce', w: 5 }, { species: 'oak', w: 2 }, { species: 'autumn', w: 1 }],
  },
  {
    name: 'Snowy Taiga', surface: B.SNOW, sub: B.DIRT, hill: 4,
    trees: 0.022, tree: 'auto', flowers: 0, grass: 0.02, cactus: 0,
    treeMix: [{ species: 'spruce', w: 8 }, { species: 'birch', w: 2 }],
  },
];

export function pickBiome(temp: number, humid: number, mount: number, cont: number): Biome {
  if (cont < -0.02) return Biome.MOUNTAINS;
  if (mount > 0.68) return temp < 0.3 ? Biome.SNOW : Biome.MOUNTAINS;
  if (temp < 0.26) return Biome.SNOW;
  if (temp > 0.68 && humid < 0.45) return Biome.DESERT;
  if (humid > 0.55) return Biome.FOREST;
  return Biome.PLAINS;
}
