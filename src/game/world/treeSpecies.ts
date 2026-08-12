import { B } from './blocks';

export type TreeSpecies =
  | 'oak' | 'birch' | 'autumn' | 'spruce' | 'palm' | 'jungle'
  | 'alien' | 'crimson' | 'neon' | 'crystal' | 'cactus';

export interface TreePalette {
  log: number;
  leaves: number;
  leavesAlt?: number;
  altChance: number;
  fruit?: number;
}

export const SPECIES: Record<TreeSpecies, TreePalette> = {
  oak:     { log: B.LOG,        leaves: B.LEAVES,         leavesAlt: B.LEAVES_AUTUMN, altChance: 0.05 },
  birch:   { log: B.LOG_BIRCH,  leaves: B.LEAVES_BIRCH,   leavesAlt: B.LEAVES,        altChance: 0.08 },
  autumn:  { log: B.LOG,        leaves: B.LEAVES_AUTUMN,  leavesAlt: B.LEAVES,        altChance: 0.12 },
  spruce:  { log: B.LOG_SPRUCE, leaves: B.LEAVES_SPRUCE,  altChance: 0 },
  palm:    { log: B.LOG_PALM,   leaves: B.LEAVES_JUNGLE,  altChance: 0 },
  jungle:  { log: B.LOG,        leaves: B.LEAVES_JUNGLE,  leavesAlt: B.LEAVES,        altChance: 0.15 },
  alien:   { log: B.LOG_ALIEN,  leaves: B.LEAVES_ALIEN,   leavesAlt: B.LEAVES_NEON,   altChance: 0.10 },
  crimson: { log: B.LOG_SPRUCE, leaves: B.LEAVES_CRIMSON, altChance: 0 },
  neon:    { log: B.LOG_ALIEN,  leaves: B.LEAVES_NEON,    leavesAlt: B.LEAVES_ALIEN,  altChance: 0.12 },
  crystal: { log: B.LOG_SPRUCE, leaves: B.LEAVES_CRYSTAL, altChance: 0 },
  cactus:  { log: B.CACTUS,     leaves: B.LEAVES_CRIMSON, altChance: 0 },
};

export interface SpeciesMix { species: TreeSpecies; w: number }

export function resolveSpecies(mix: readonly SpeciesMix[], t: number): TreePalette {
  if (!mix.length) return SPECIES.oak;
  let total = 0;
  for (const m of mix) total += Math.max(0, m.w);
  if (total <= 0) return SPECIES[mix[0].species];
  let acc = t * total;
  for (const m of mix) {
    acc -= Math.max(0, m.w);
    if (acc <= 0) return SPECIES[m.species] ?? SPECIES.oak;
  }
  return SPECIES[mix[mix.length - 1].species] ?? SPECIES.oak;
}
