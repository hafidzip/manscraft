
import { Rng, derive } from './rng';
import type { PlanetPalette, PlanetType } from './palettes';
import { Biome } from '../world/biomes';
import { SEA_LEVEL } from '../core/constants';
import type { PlanetSpec, StarSpec } from './galaxy';
import { PLANET_PALETTES } from './palettes';

export interface PlanetTheme {
  seed: bigint;
  type: PlanetType;
  biome: Biome;
  seaLevel: number;
  hillAmp: number;
  skyHex: number;
  lava: boolean;
  spec: PlanetSpec;
  star: StarSpec;
  tint: Record<string, [number, number, number]>;
  [k: string]: unknown;
}

export interface PlanetHome {
  star: StarSpec;
  planet: PlanetSpec;
}

const PLAINS = Biome.PLAINS;
const FOREST = Biome.FOREST;
const DESERT = Biome.DESERT;
const SNOW = Biome.SNOW;
const MOUNT = Biome.MOUNTAINS;

interface Rule {
  biome: Biome;
  sea: number;
  hillAmp: number;
  sky?: number;
  lava?: boolean;
}

const RULES: Record<PlanetType, Rule> = {
  terran:      { biome: PLAINS, sea:   0, hillAmp: 1.00 },
  ocean:       { biome: PLAINS, sea: +10, hillAmp: 0.70, sky: 0x6fd6f0 },
  desert:      { biome: DESERT, sea: -24, hillAmp: 1.25, sky: 0xf0b070 },
  ice:         { biome: SNOW,   sea:  -2, hillAmp: 0.95, sky: 0xcdeaff },
  oceanic_ice: { biome: SNOW,   sea:  +8, hillAmp: 0.60, sky: 0xa8d8f0 },
  volcanic:    { biome: MOUNT,  sea:  -8, hillAmp: 1.55, sky: 0x53221a, lava: true },
  lava:        { biome: MOUNT,  sea:  +4, hillAmp: 1.35, sky: 0x7a1f10, lava: true },
  barren:      { biome: MOUNT,  sea: -30, hillAmp: 1.15, sky: 0x1b1c22 },
  alien:       { biome: FOREST, sea:  -2, hillAmp: 1.20, sky: 0x9d5cff },
  jungle:      { biome: FOREST, sea:  +3, hillAmp: 1.05, sky: 0x7fe0b0 },
  savanna:     { biome: PLAINS, sea:  -9, hillAmp: 0.85, sky: 0xe8c070 },
  tundra:      { biome: SNOW,   sea:  -4, hillAmp: 0.75, sky: 0xa9c4d8 },
  crimson:     { biome: DESERT, sea: -18, hillAmp: 1.30, sky: 0xc0402f },
  neon:        { biome: FOREST, sea:  -6, hillAmp: 1.40, sky: 0x25f0d0 },
};

function skyFromAtmo(hex: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * 0.72 + 46));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * 0.72 + 52));
  const b = Math.min(255, Math.round((hex & 255) * 0.78 + 60));
  return (r << 16) | (g << 8) | b;
}

export function themeFromPalette(pal: PlanetPalette, seed: bigint): PlanetTheme {
  const rule = RULES[pal.key] ?? RULES.terran;
  const r = new Rng(derive(seed, 0x7e));
  return {
    seed,
    type: pal.key,
    biome: rule.biome,
    seaLevel: Math.max(2, Math.round(SEA_LEVEL + rule.sea + r.range(-2, 2))),
    hillAmp: rule.hillAmp * r.range(0.92, 1.08),
    skyHex: rule.sky ?? skyFromAtmo(pal.atmoHex),
    lava: rule.lava ?? pal.lava,
    spec: undefined as unknown as PlanetSpec,
    star: undefined as unknown as StarSpec,
    tint: {},
  };
}

export function themeFromPlanet(planet: PlanetSpec, star: StarSpec): PlanetTheme {
  const pal = PLANET_PALETTES[planet.type] ?? PLANET_PALETTES.terran;
  const base = themeFromPalette(pal, planet.seed);
  return { ...base, spec: planet, star };
}

export function homeFromTheme(theme: { spec?: PlanetSpec; star?: StarSpec } | null): PlanetHome | null {
  if (theme?.spec && theme.star) return { star: theme.star, planet: theme.spec };
  return null;
}
