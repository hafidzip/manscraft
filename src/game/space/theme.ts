// ---------------------------------------------------------------------------
// PlanetPalette -> voxel-world theme. The single bridge between the space
// renderer's planet classes and the Minecraft-style terrain generator.
// Pure + deterministic: same (palette, seed) always yields the same theme.
// ---------------------------------------------------------------------------

import { Rng, derive } from './rng';
import type { PlanetPalette, PlanetType } from './palettes';
import { Biome } from '../world/biomes';
import { SEA_LEVEL } from '../core/constants';
import type { PlanetSpec, StarSpec } from './galaxy';
import { PLANET_PALETTES } from './palettes';

export interface PlanetTheme {
  seed: bigint;
  type: PlanetType;
  /** dominant biome the whole world is forced toward ('terran' = normal variety) */
  biome: Biome;
  seaLevel: number;
  /** multiplier on per-biome hill amplitude */
  hillAmp: number;
  skyHex: number;
  lava: boolean;
  /** round-trip identity: the system this world represents */
  spec: PlanetSpec;
  star: StarSpec;
  /** per-atlas-tile RGB multipliers — filled by the texture tint pass (Task 5) */
  tint: Record<string, [number, number, number]>;
  [k: string]: unknown;
}

/** The (star, planet) pair that identifies a system the voxel world represents. */
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
  /** blocks added to the base sea level (negative = drier world) */
  sea: number;
  hillAmp: number;
  /** optional sky override; defaults to a lifted pal.atmoHex */
  sky?: number;
  lava?: boolean;
}

const RULES: Record<PlanetType, Rule> = {
  // temperate default — full biome variety, stock terrain
  terran:      { biome: PLAINS, sea:   0, hillAmp: 1.00 },
  // drowned world: high seas, gentle relief, few islands
  ocean:       { biome: PLAINS, sea: +10, hillAmp: 0.70, sky: 0x6fd6f0 },
  // all sand, no water at all, big rolling dunes
  desert:      { biome: DESERT, sea: -24, hillAmp: 1.25, sky: 0xf0b070 },
  // snow everywhere over frozen seas
  ice:         { biome: SNOW,   sea:  -2, hillAmp: 0.95, sky: 0xcdeaff },
  // frozen ocean world: snow shell, high (frozen) sea
  oceanic_ice: { biome: SNOW,   sea:  +8, hillAmp: 0.60, sky: 0xa8d8f0 },
  // dark rock + molten pools
  volcanic:    { biome: MOUNT,  sea:  -8, hillAmp: 1.55, sky: 0x53221a, lava: true },
  lava:        { biome: MOUNT,  sea:  +4, hillAmp: 1.35, sky: 0x7a1f10, lava: true },
  // dead rock: no seas, sharp craters, black sky
  barren:      { biome: MOUNT,  sea: -30, hillAmp: 1.15, sky: 0x1b1c22 },
  // toxic violet biosphere
  alien:       { biome: FOREST, sea:  -2, hillAmp: 1.20, sky: 0x9d5cff },
  // dense wet forest, warm shallow seas
  jungle:      { biome: FOREST, sea:  +3, hillAmp: 1.05, sky: 0x7fe0b0 },
  // dry grass plains dotted with sand
  savanna:     { biome: PLAINS, sea:  -9, hillAmp: 0.85, sky: 0xe8c070 },
  // cold scrub, patchy snow, low relief
  tundra:      { biome: SNOW,   sea:  -4, hillAmp: 0.75, sky: 0xa9c4d8 },
  // red iron world
  crimson:     { biome: DESERT, sea: -18, hillAmp: 1.30, sky: 0xc0402f },
  // neon crystal world under an electric sky
  neon:        { biome: FOREST, sea:  -6, hillAmp: 1.40, sky: 0x25f0d0 },
};

/** brighten/tint an atmosphere colour into a usable ground-level sky colour */
function skyFromAtmo(hex: number): number {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * 0.72 + 46));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * 0.72 + 52));
  const b = Math.min(255, Math.round((hex & 255) * 0.78 + 60));
  return (r << 16) | (g << 8) | b;
}

/**
 * Map a space-side planet palette onto voxel-world terrain parameters.
 * Covers all 14 PlanetTypes; unknown keys fall back to the terran rule.
 */
export function themeFromPalette(pal: PlanetPalette, seed: bigint): PlanetTheme {
  const rule = RULES[pal.key] ?? RULES.terran;
  // small deterministic per-planet jitter so two worlds of the same class
  // still feel distinct, without ever leaving the class's character
  const r = new Rng(derive(seed, 0x7e));
  return {
    seed,
    type: pal.key,
    biome: rule.biome,
    seaLevel: Math.max(2, Math.round(SEA_LEVEL + rule.sea + r.range(-2, 2))),
    hillAmp: rule.hillAmp * r.range(0.92, 1.08),
    skyHex: rule.sky ?? skyFromAtmo(pal.atmoHex),
    lava: rule.lava ?? pal.lava,
    // round-trip identity is filled in by themeFromPlanet; placeholder here
    spec: undefined as unknown as PlanetSpec,
    star: undefined as unknown as StarSpec,
    tint: {},
  };
}

/**
 * Build the voxel-world theme for a planet orbiting `star`, carrying the
 * full round-trip identity (spec + star + tint).
 */
export function themeFromPlanet(planet: PlanetSpec, star: StarSpec): PlanetTheme {
  const pal = PLANET_PALETTES[planet.type] ?? PLANET_PALETTES.terran;
  const base = themeFromPalette(pal, planet.seed);
  return { ...base, spec: planet, star };
}

/** Extract the (star, planet) home back out of a theme. */
export function homeFromTheme(theme: { spec?: PlanetSpec; star?: StarSpec } | null): PlanetHome | null {
  if (theme?.spec && theme.star) return { star: theme.star, planet: theme.spec };
  return null;
}
