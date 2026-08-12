import { B } from './blocks';

export type TreeSpecies =
  | 'oak' | 'birch' | 'autumn' | 'spruce' | 'palm' | 'jungle'
  | 'alien' | 'crimson' | 'neon' | 'crystal' | 'cactus'
  | 'frost' | 'frost_birch';

export interface TreePalette {
  log: number;
  leaves: number;
  fruit?: number;
}

export const SPECIES: Record<TreeSpecies, TreePalette> = {
  oak:     { log: B.LOG,        leaves: B.LEAVES },
  birch:   { log: B.LOG_BIRCH,  leaves: B.LEAVES_BIRCH },
  autumn:  { log: B.LOG,        leaves: B.LEAVES_AUTUMN },
  spruce:  { log: B.LOG_SPRUCE, leaves: B.LEAVES_SPRUCE },
  palm:    { log: B.LOG_PALM,   leaves: B.LEAVES_JUNGLE },
  jungle:  { log: B.LOG,        leaves: B.LEAVES_JUNGLE },
  alien:   { log: B.LOG_ALIEN,  leaves: B.LEAVES_ALIEN },
  crimson: { log: B.LOG_SPRUCE, leaves: B.LEAVES_CRIMSON },
  neon:    { log: B.LOG_ALIEN,  leaves: B.LEAVES_NEON },
  crystal:     { log: B.LOG_SPRUCE, leaves: B.LEAVES_CRYSTAL },
  cactus:      { log: B.CACTUS,     leaves: B.LEAVES_CRIMSON },
  frost:       { log: B.LOG_SPRUCE, leaves: B.LEAVES_SNOW },
  frost_birch: { log: B.LOG_BIRCH,  leaves: B.LEAVES_SNOW },
};

const WINTER_SKIP = new Set<number>([
  B.LEAVES_SNOW, B.LEAVES_ALIEN, B.LEAVES_CRIMSON, B.LEAVES_NEON, B.LEAVES_CRYSTAL,
]);

export function winterPalette(pal: TreePalette): TreePalette {
  if (WINTER_SKIP.has(pal.leaves)) return pal;
  return { ...pal, leaves: B.LEAVES_SNOW };
}

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
