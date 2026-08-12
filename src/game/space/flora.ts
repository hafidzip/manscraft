import { Rng, derive } from './rng';
import type { PlanetType } from './palettes';
import type { SpeciesMix, TreeSpecies } from '../world/treeSpecies';

export type TreeSilhouette =
  | 'broadleaf'
  | 'conifer'
  | 'palm'
  | 'spire'
  | 'crystal'
  | 'succulent'
  | 'umbrella'
  | 'fungal'
  | 'mega'
  | 'none';

export interface TreeShape {
  silhouette: TreeSilhouette;
  densityMul: number;
  trunkH: [number, number];
  trunkLean: number;
  branches: number;
  canopyR: [number, number];
  canopyH: number;
  leafDensity: number;
  droop: number;
  glow: number;
  species: TreeSpecies;
  mix: SpeciesMix[];
  earthlike: boolean;
}

export interface GrassShape {
  present: boolean;
  blades: [number, number];
  height: [number, number];
  width: [number, number];
  curve: number;
  lean: number;
  glow: number;
}

export interface FlowerShape {
  present: boolean;
  quads: 2 | 3 | 4;
  radius: number;
  glow: number;
}

export interface Flora {
  tree: TreeShape;
  grass: GrassShape;
  flower: FlowerShape;
}

type Rule = {
  s: TreeSilhouette;
  dens: number;
  glow?: number;
  mix?: SpeciesMix[];
  grass?: Partial<GrassShape> | false;
  flower?: Partial<FlowerShape> | false;
};

const RULES: Record<PlanetType, Rule> = {
  terran: {
    s: 'broadleaf', dens: 1.0,
    mix: [{ species: 'oak', w: 6 }, { species: 'birch', w: 3 }, { species: 'autumn', w: 1 }],
  },
  ocean: {
    s: 'palm', dens: 0.7,
    mix: [{ species: 'palm', w: 1 }],
    grass: { height: [0.6, 1.1], curve: 0.22 },
  },
  desert: {
    s: 'succulent', dens: 0.5,
    mix: [{ species: 'cactus', w: 1 }],
    grass: false, flower: { quads: 2, radius: 0.22 },
  },
  ice: {
    s: 'crystal', dens: 0.6, glow: 0.25,
    mix: [{ species: 'crystal', w: 1 }],
    grass: { height: [0.3, 0.6], curve: 0.02, glow: 0.15 }, flower: false,
  },
  oceanic_ice: {
    s: 'crystal', dens: 0.35, glow: 0.2,
    mix: [{ species: 'crystal', w: 1 }],
    grass: false, flower: false,
  },
  volcanic: { s: 'none', dens: 0, grass: false, flower: false },
  lava: { s: 'none', dens: 0, grass: false, flower: false },
  barren: { s: 'none', dens: 0, grass: false, flower: false },
  alien: {
    s: 'spire', dens: 1.1, glow: 0.55,
    mix: [{ species: 'alien', w: 5 }, { species: 'neon', w: 2 }],
    grass: { curve: 0.42, height: [0.8, 1.6], glow: 0.35 },
    flower: { quads: 3, radius: 0.34, glow: 0.5 },
  },
  jungle: {
    s: 'mega', dens: 2.2,
    mix: [{ species: 'jungle', w: 5 }, { species: 'palm', w: 3 }],
    grass: { blades: [7, 11], height: [0.9, 1.5], curve: 0.34 },
    flower: { quads: 4, radius: 0.3 },
  },
  savanna: {
    s: 'umbrella', dens: 0.45,
    mix: [{ species: 'autumn', w: 5 }, { species: 'oak', w: 3 }],
    grass: { blades: [6, 9], height: [0.7, 1.35], curve: 0.16 },
  },
  tundra: {
    s: 'conifer', dens: 0.9,
    mix: [{ species: 'frost', w: 8 }, { species: 'frost_birch', w: 2 }],
    grass: { blades: [3, 5], height: [0.25, 0.5] }, flower: false,
  },
  crimson: {
    s: 'succulent', dens: 0.8, glow: 0.15,
    mix: [{ species: 'crimson', w: 1 }],
    grass: { curve: 0.0, height: [0.5, 0.95], width: [0.06, 0.11] },
    flower: { quads: 2, radius: 0.2, glow: 0.2 },
  },
  neon: {
    s: 'fungal', dens: 1.4, glow: 0.85,
    mix: [{ species: 'neon', w: 6 }, { species: 'alien', w: 2 }],
    grass: { curve: 0.3, height: [0.7, 1.4], glow: 0.9, blades: [8, 12] },
    flower: { quads: 4, radius: 0.36, glow: 1.0 },
  },
};

const GRASS_D: GrassShape = {
  present: true, blades: [5, 7], height: [0.5, 1.28], width: [0.13, 0.26], curve: 0.12, lean: 0.2, glow: 0,
};
const FLOWER_D: FlowerShape = { present: true, quads: 2, radius: 0.35, glow: 0 };

const TRUNK_BY_SILHOUETTE: Record<TreeSilhouette, Omit<TreeShape, 'densityMul' | 'silhouette' | 'glow' | 'species' | 'mix' | 'earthlike'>> = {
  broadleaf: { trunkH: [6, 9], canopyR: [2, 3], canopyH: 4, leafDensity: 0.78, branches: 0, droop: 0, trunkLean: 0 },
  conifer: { trunkH: [8, 13], canopyR: [2, 3], canopyH: 8, leafDensity: 0.88, branches: 0, droop: 0.1, trunkLean: 0 },
  palm: { trunkH: [9, 15], canopyR: [3, 4], canopyH: 2, leafDensity: 0.55, branches: 6, droop: 0.85, trunkLean: 0 },
  spire: { trunkH: [12, 20], canopyR: [1, 2], canopyH: 2, leafDensity: 0.6, branches: 3, droop: 0.1, trunkLean: 0 },
  crystal: { trunkH: [3, 6], canopyR: [1, 3], canopyH: 6, leafDensity: 0.95, branches: 4, droop: 0, trunkLean: 0 },
  succulent: { trunkH: [4, 8], canopyR: [0, 1], canopyH: 1, leafDensity: 0.35, branches: 3, droop: 0, trunkLean: 0 },
  umbrella: { trunkH: [4, 6], canopyR: [3, 5], canopyH: 2, leafDensity: 0.62, branches: 2, droop: 0, trunkLean: 0 },
  fungal: { trunkH: [4, 7], canopyR: [2, 4], canopyH: 3, leafDensity: 0.92, branches: 0, droop: 0.4, trunkLean: 0 },
  mega: { trunkH: [10, 16], canopyR: [4, 6], canopyH: 3, leafDensity: 0.8, branches: 2, droop: 0.3, trunkLean: 0 },
  none: { trunkH: [0, 0], canopyR: [0, 0], canopyH: 0, leafDensity: 0, branches: 0, droop: 0, trunkLean: 0 },
};

const SPECIES_BY_SILHOUETTE: Record<TreeSilhouette, TreeSpecies> = {
  broadleaf: 'oak', conifer: 'spruce', palm: 'palm', spire: 'alien', crystal: 'crystal',
  succulent: 'cactus', umbrella: 'autumn', fungal: 'neon', mega: 'jungle', none: 'oak',
};
const EARTHLIKE: TreeSilhouette[] = ['broadleaf', 'conifer', 'umbrella'];

const FLORA_SALT = 0xf10a;
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function floraFor(type: PlanetType, seed: bigint): Flora {
  const rule = RULES[type] ?? RULES.terran;
  const r = new Rng(derive(seed, FLORA_SALT));
  const t = TRUNK_BY_SILHOUETTE[rule.s];

  const mix = rule.mix?.length ? rule.mix : [{ species: SPECIES_BY_SILHOUETTE[rule.s], w: 1 }];

  const tree: TreeShape = {
    silhouette: rule.s,
    densityMul: rule.dens * r.range(0.8, 1.25),
    trunkH: [
      Math.max(0, Math.round(t.trunkH[0] * r.range(0.85, 1.15))),
      Math.max(0, Math.round(t.trunkH[1] * r.range(0.9, 1.2))),
    ],
    trunkLean: 0,
    branches: Math.max(0, Math.round(t.branches * r.range(0.75, 1.3))),
    canopyR: [t.canopyR[0], Math.max(t.canopyR[0], Math.round(t.canopyR[1] * r.range(0.85, 1.25)))],
    canopyH: Math.max(1, Math.round(t.canopyH * r.range(0.85, 1.2))),
    leafDensity: clamp01(t.leafDensity * r.range(0.88, 1.12)),
    droop: t.droop * r.range(0.7, 1.3),
    glow: clamp01((rule.glow ?? 0) * r.range(0.8, 1.2)),
    species: mix[0].species,
    mix,
    earthlike: EARTHLIKE.includes(rule.s),
  };

  const grass: GrassShape = rule.grass === false
    ? { ...GRASS_D, present: false }
    : jitterGrass({ ...GRASS_D, ...(rule.grass ?? {}) }, r);

  const flower: FlowerShape = rule.flower === false
    ? { ...FLOWER_D, present: false }
    : jitterFlower({ ...FLOWER_D, ...(rule.flower ?? {}) }, r);

  return { tree, grass, flower };
}

function jitterGrass(g: GrassShape, r: Rng): GrassShape {
  return {
    ...g,
    height: [g.height[0] * r.range(0.9, 1.1), g.height[1] * r.range(0.95, 1.2)],
    width: [g.width[0] * r.range(0.85, 1.15), g.width[1] * r.range(0.9, 1.2)],
    curve: g.curve * r.range(0.7, 1.3),
  };
}

function jitterFlower(f: FlowerShape, r: Rng): FlowerShape {
  return { ...f, radius: f.radius * r.range(0.85, 1.2) };
}
