
import { B } from '../fps/World';

export type BlockCategory =
  | 'log' | 'planks' | 'leaves' | 'stone' | 'sand' | 'dirt' | 'grass' | 'snow'
  | 'glass' | 'coal' | 'stick' | 'cactus';

const CATEGORY: Readonly<Record<number, BlockCategory>> = {
  [B.LOG]: 'log',
  [B.PLANK]: 'planks',
  [B.LEAVES]: 'leaves',
  [B.STONE]: 'stone',
  [B.COBBLE]: 'stone',
  [B.SAND]: 'sand',
  [B.SANDSTONE]: 'sand',
  [B.DIRT]: 'dirt',
  [B.GRASS]: 'grass',
  [B.SNOW]: 'snow',
  [B.GLASS]: 'glass',
  [B.COAL]: 'coal',
  [B.STICK]: 'stick',
  [B.CACTUS]: 'cactus',
};

const CANONICAL: Record<BlockCategory, number> = {
  log: B.LOG, planks: B.PLANK, leaves: B.LEAVES, stone: B.STONE, sand: B.SAND,
  dirt: B.DIRT, grass: B.GRASS, snow: B.SNOW, glass: B.GLASS, coal: B.COAL,
  stick: B.STICK, cactus: B.CACTUS,
};

export function categoryOf(blockId: number): BlockCategory | null {
  return CATEGORY[blockId] ?? null;
}

export const canonicalOf = (c: BlockCategory): number => CANONICAL[c];

const PLANET_SCOPED: ReadonlySet<number> = new Set([
  B.LOG, B.PLANK, B.LEAVES, B.STONE, B.COBBLE, B.SAND, B.SANDSTONE,
  B.DIRT, B.GRASS, B.SNOW, B.CACTUS,
]);

export const isPlanetScoped = (id: number): boolean => PLANET_SCOPED.has(id);
