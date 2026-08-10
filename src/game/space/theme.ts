
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

interface Rule { biome: Biome; sea: number; hillAmp: number; sky?: number; lava?: boolean }

const R = (biome: Biome, sea: number, hillAmp: number, sky?: number, lava?: boolean): Rule =>
  ({ biome, sea, hillAmp, sky, lava });

const RULES: Record<PlanetType, Rule> = {
  terran: R(Biome.PLAINS, 0, 1), ocean: R(Biome.PLAINS, 10, 0.7, 0x6fd6f0),
  desert: R(Biome.DESERT, -24, 1.25, 0xf0b070), ice: R(Biome.SNOW, -2, 0.95, 0xcdeaff),
  oceanic_ice: R(Biome.SNOW, 8, 0.6, 0xa8d8f0), volcanic: R(Biome.MOUNTAINS, -8, 1.55, 0x53221a, true),
  lava: R(Biome.MOUNTAINS, 4, 1.35, 0x7a1f10, true), barren: R(Biome.MOUNTAINS, -30, 1.15, 0x1b1c22),
  alien: R(Biome.FOREST, -2, 1.2, 0x9d5cff), jungle: R(Biome.FOREST, 3, 1.05, 0x7fe0b0),
  savanna: R(Biome.PLAINS, -9, 0.85, 0xe8c070), tundra: R(Biome.SNOW, -4, 0.75, 0xa9c4d8),
  crimson: R(Biome.DESERT, -18, 1.3, 0xc0402f), neon: R(Biome.FOREST, -6, 1.4, 0x25f0d0),
};

const skyFromAtmo = (hex: number): number => {
  const ch = (s: number, m: number, a: number) => Math.min(255, Math.round(((hex >> s) & 255) * m + a));
  return (ch(16, 0.72, 46) << 16) | (ch(8, 0.72, 52) << 8) | ch(0, 0.78, 60);
};

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
