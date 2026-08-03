import { derive, Rng, v3, type Vec3d } from './rng';
import { pickPlanetType, type PlanetType } from './palettes';

// ---------------------------------------------------------------------------
// Seed chain:
//   UNIVERSE_SEED -> galaxy(gx,gy,gz) -> sector(sx,sy,sz) -> star(index)
//                 -> planet(index) -> chunk(face,lod,cx,cy)
//
// A star's ID is its address {sx,sy,sz,index} — never a stored record.
// Sector coords are unbounded signed integers, so the universe is infinite
// in every direction. Galaxies emerge from a spiral density field, which
// means voids, arms and dense cores all appear naturally.
// ---------------------------------------------------------------------------

export const UNIVERSE_SEED = 0x564F58454C534B59n; // "VOXELSKY"
// Reduced from 5200 (previous value * 0.75) — still keeps systems clearly
// isolated in interstellar space, but shortens travel time between them.
export const SECTOR_SIZE = 3900; // universe units per sector edge
export const GALAXY_SPAN = 64; // sectors per galaxy cell edge

export interface SystemAddress {
  sx: number;
  sy: number;
  sz: number;
  index: number;
}

export interface GalaxySpec {
  gx: number;
  gy: number;
  gz: number;
  seed: bigint;
  name: string;
  type: string;
  arms: number;
  twist: number;
  coreColor: number;
  richness: number;
}

export interface StarSpec {
  address: SystemAddress;
  pos: Vec3d;
  radius: number;
  color: number;
  spectral: string;
  planetCount: number;
  seed: bigint;
  name: string;
}

export interface PlanetSpec {
  seed: bigint;
  index: number;
  orbitRadius: number;
  orbitAngle: number;
  orbitSpeed: number;
  inclination: number;
  radius: number;
  type: PlanetType;
  terrainAmp: number;
  terrainFreq: number;
  oceanLevel: number;
  noiseOff: number;
  spin: number;
  hasRings: boolean;
  hasMoons: boolean;
  axialTilt: number;
  name: string;
}

export function starKey(a: SystemAddress): string {
  return `${a.sx}|${a.sy}|${a.sz}|${a.index}`;
}

// ---- galaxy layer ---------------------------------------------------------

export function galaxyCoordOf(s: number): number {
  return Math.floor(s / GALAXY_SPAN);
}

const GAL_TYPES = ['Spiral', 'Barred Spiral', 'Elliptical', 'Irregular', 'Lenticular'];
const CORE_COLORS = [0xffd9a0, 0xffc4d8, 0xa8c8ff, 0xffe9b8, 0xd8b8ff];

// Galaxy cells are hit constantly (twice per sector during streaming, and
// once per frame for the HUD). Memoize — it is a pure function of coords,
// so caching can never change the result.
const GAL_MEMO = new Map<string, GalaxySpec>();

export function galaxySpec(gx: number, gy: number, gz: number): GalaxySpec {
  const k = `${gx}|${gy}|${gz}`;
  const hit = GAL_MEMO.get(k);
  if (hit) return hit;
  const spec = computeGalaxy(gx, gy, gz);
  if (GAL_MEMO.size > 512) GAL_MEMO.clear();
  GAL_MEMO.set(k, spec);
  return spec;
}

function computeGalaxy(gx: number, gy: number, gz: number): GalaxySpec {
  const seed = derive(UNIVERSE_SEED, gx, gy, gz);
  const r = new Rng(seed);
  const t = Math.floor(r.range(0, GAL_TYPES.length));
  return {
    gx,
    gy,
    gz,
    seed,
    name: galaxyName(seed),
    type: GAL_TYPES[t],
    arms: 2 + Math.floor(r.range(0, 4)),
    twist: r.range(0.18, 0.55),
    coreColor: CORE_COLORS[Math.floor(r.range(0, CORE_COLORS.length))],
    richness: r.range(0.45, 1.0),
  };
}

export function galaxyOfSector(sx: number, sy: number, sz: number): GalaxySpec {
  return galaxySpec(galaxyCoordOf(sx), galaxyCoordOf(sy), galaxyCoordOf(sz));
}

/**
 * Spiral-arm density field in [0,1] for a sector. Produces galactic cores,
 * spiral arms, a thin disc and empty intergalactic voids — all analytic,
 * so it works at any coordinate with no storage.
 */
export function sectorDensity(sx: number, sy: number, sz: number): number {
  const g = galaxyOfSector(sx, sy, sz);
  const half = GALAXY_SPAN / 2;
  // local position within the galaxy cell, centered
  const lx = sx - (g.gx * GALAXY_SPAN + half);
  const ly = sy - (g.gy * GALAXY_SPAN + half);
  const lz = sz - (g.gz * GALAXY_SPAN + half);

  const rad = Math.hypot(lx, lz) / half; // 0 at core, 1 at rim
  if (rad > 1) return 0; // intergalactic void

  // thin disc: vertical falloff (elliptical galaxies are puffier)
  const thick = g.type === 'Elliptical' ? 0.85 : 0.22;
  const disc = Math.exp(-((ly / half) * (ly / half)) / (2 * thick * thick));

  // radial falloff with a bright dense core
  const core = Math.exp(-rad * rad * 7) * 1.15;
  const halo = Math.exp(-rad * 2.1);

  let arms = 1;
  if (g.type !== 'Elliptical' && g.type !== 'Irregular') {
    const theta = Math.atan2(lz, lx);
    const phase = theta - Math.log(Math.max(rad, 0.05)) / g.twist;
    arms = 0.42 + 0.58 * (0.5 + 0.5 * Math.cos(phase * g.arms));
  } else if (g.type === 'Irregular') {
    arms = 0.5 + 0.5 * Math.sin(lx * 0.7 + lz * 0.5 + ly * 0.3);
  }

  const d = (core + halo * arms) * disc * g.richness;
  return Math.max(0, Math.min(1, d));
}

export function sectorSeed(sx: number, sy: number, sz: number): bigint {
  return derive(galaxyOfSector(sx, sy, sz).seed, sx, sy, sz);
}

/** How many stars live in a sector. 0 in voids, up to 4 in dense arms/cores. */
export function starCountInSector(sx: number, sy: number, sz: number): number {
  const d = sectorDensity(sx, sy, sz);
  if (d <= 0.02) return 0;
  const r = new Rng(sectorSeed(sx, sy, sz));
  if (r.next() > d) return 0;
  return 1 + Math.floor(r.next() * d * 3.99);
}

export function starSeedOf(a: SystemAddress): bigint {
  return derive(sectorSeed(a.sx, a.sy, a.sz), a.index);
}

export function planetSeedOf(starSeed: bigint, index: number): bigint {
  return derive(starSeed, index);
}

/** Terrain chunk seed — face of the cube-sphere, LOD level, chunk coords. */
export function chunkSeed(
  planetSeed: bigint,
  face: number,
  lod: number,
  cx: number,
  cy: number
): bigint {
  return derive(planetSeed, face, lod, cx, cy);
}

interface SpectralClass {
  name: string;
  color: number;
  rMin: number;
  rMax: number;
  pMax: number;
  w: number;
}

const SPECTRAL: SpectralClass[] = [
  // standard Morgan–Keenan sequence
  { name: 'O',  color: 0x9ab8ff, rMin: 15, rMax: 24, pMax: 6, w: 0.03 },
  { name: 'B',  color: 0xb0c4ff, rMin: 13, rMax: 20, pMax: 5, w: 0.09 },
  { name: 'A',  color: 0xd8e2ff, rMin: 11, rMax: 17, pMax: 5, w: 0.15 },
  { name: 'F',  color: 0xf8f4ff, rMin: 9,  rMax: 15, pMax: 4, w: 0.17 },
  { name: 'G',  color: 0xfff0c0, rMin: 8,  rMax: 12, pMax: 4, w: 0.17 },
  { name: 'K',  color: 0xffd090, rMin: 7,  rMax: 11, pMax: 3, w: 0.17 },
  { name: 'M',  color: 0xffb060, rMin: 6,  rMax: 10, pMax: 3, w: 0.15 },
  // rare exotic classes
  { name: 'W',  color: 0xc0d8ff, rMin: 5,  rMax: 9,  pMax: 2, w: 0.01 },  // Wolf–Rayet (hot blue)
  { name: 'L',  color: 0xff8040, rMin: 6,  rMax: 9,  pMax: 2, w: 0.02 },  // cool brown dwarf
  { name: 'T',  color: 0xff5e20, rMin: 5,  rMax: 7,  pMax: 1, w: 0.01 },  // methane dwarf
  { name: 'Y',  color: 0xc06050, rMin: 4,  rMax: 6,  pMax: 0, w: 0.005 }, // ultra-cool dwarf
  { name: 'N',  color: 0xff80a0, rMin: 20, rMax: 32, pMax: 6, w: 0.01 },  // red supergiant
  { name: 'D',  color: 0xfffcf0, rMin: 4,  rMax: 7,  pMax: 2, w: 0.01 },  // white dwarf
];

/** Everything about a star derives from its address. Deterministic forever. */
export function starSpec(a: SystemAddress): StarSpec {
  const seed = starSeedOf(a);
  const r = new Rng(seed);
  let roll = r.range(0, 1);
  let cls = SPECTRAL[SPECTRAL.length - 1];
  for (const c of SPECTRAL) {
    roll -= c.w;
    if (roll <= 0) {
      cls = c;
      break;
    }
  }
  const radius = r.range(cls.rMin, cls.rMax);
  const planetCount = Math.floor(r.range(0, cls.pMax + 0.999));
  const half = SECTOR_SIZE / 2;
  const pos = v3(
    sx0(a.sx) + r.range(-0.72, 0.72) * half,
    sx0(a.sy) + r.range(-0.72, 0.72) * half,
    sx0(a.sz) + r.range(-0.72, 0.72) * half
  );
  return {
    address: a,
    pos,
    radius,
    color: cls.color,
    spectral: cls.name,
    planetCount,
    seed,
    name: starName(seed) + (a.index > 0 ? ' ' + GREEK[a.index % GREEK.length] : ''),
  };
}

function sx0(s: number): number {
  return s * SECTOR_SIZE + SECTOR_SIZE / 2;
}

/** Enumerate EVERY star in a sector. This is what makes flight infinite. */
export function starsInSector(sx: number, sy: number, sz: number): StarSpec[] {
  const n = starCountInSector(sx, sy, sz);
  const out: StarSpec[] = [];
  for (let i = 0; i < n; i++) out.push(starSpec({ sx, sy, sz, index: i }));
  return out;
}

/** The dense central sector of the galaxy cell containing a sector. */
export function galaxyCoreSector(sx: number, sy: number, sz: number): SectorCo {
  const half = Math.floor(GALAXY_SPAN / 2);
  return {
    x: galaxyCoordOf(sx) * GALAXY_SPAN + half,
    y: galaxyCoordOf(sy) * GALAXY_SPAN + half,
    z: galaxyCoordOf(sz) * GALAXY_SPAN + half,
  };
}

export interface SectorCo {
  x: number;
  y: number;
  z: number;
}

  function shellSearch(
    sx: number,
    sy: number,
    sz: number,
    maxR: number,
    minPlanets = 0
  ): StarSpec | null {
    for (let r = 0; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dz = -r; dz <= r; dz++) {
            if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== r) continue;
            const stars = starsInSector(sx + dx, sy + dy, sz + dz);
            for (const s of stars) {
              if (s.planetCount >= minPlanets) return s;
            }
          }
        }
      }
    }
    return null;
  }

  export interface FindOpts {
    /** Reject stars with fewer planets than this. Default 0 (accept any star). */
    minPlanets?: number;
    /** Chebyshev shell radius searched before falling back to the galaxy core. */
    maxR?: number;
  }

  /**
   * Spiral outward for a populated sector. If the target sits in an
   * intergalactic void, fall back to the dense core of the nearest galaxy
   * rather than brute-forcing across empty space.
   *
   * Accepts either loose sector coords or a SectorCo, so it composes directly
   * with galaxyCoreSector(). Both forms stay fully deterministic.
   */
  export function findNearestPopulated(sector: SectorCo, opts?: FindOpts): StarSpec;
  export function findNearestPopulated(
    sx: number,
    sy: number,
    sz: number,
    maxR?: number,
    opts?: FindOpts
  ): StarSpec;
  export function findNearestPopulated(
    a: number | SectorCo,
    b?: number | FindOpts,
    c?: number,
    d?: number,
    e?: FindOpts
  ): StarSpec {
    let sx: number;
    let sy: number;
    let sz: number;
    let opts: FindOpts;
    let maxR: number;

    if (typeof a === 'object') {
      sx = a.x;
      sy = a.y;
      sz = a.z;
      opts = (b as FindOpts | undefined) ?? {};
      maxR = opts.maxR ?? 5;
    } else {
      sx = a;
      sy = b as number;
      sz = c as number;
      opts = e ?? {};
      maxR = d ?? opts.maxR ?? 5;
    }
    const minPlanets = opts.minPlanets ?? 0;

    const local = shellSearch(sx, sy, sz, maxR, minPlanets);
    if (local) return local;

    // void: jump to the galactic core, which is always dense
    const co = galaxyCoreSector(sx, sy, sz);
    const core = shellSearch(co.x, co.y, co.z, 6, minPlanets);
    if (core) return core;

    // relax the planet filter before giving up entirely
    if (minPlanets > 0) {
      const any = shellSearch(co.x, co.y, co.z, 6, 0);
      if (any) return any;
    }

    // last resort: force a star to exist at the core sector
    return starSpec({ sx: co.x, sy: co.y, sz: co.z, index: 0 });
  }

  // ---- the home system ------------------------------------------------------
  // One fixed address in the whole infinite universe: the star whose first
  // planet IS the voxel world you walk around on. Everything downstream
  // (terrain palette, block colors, sky) hangs off homePlanet().seed, so this
  // must never depend on runtime state — only on UNIVERSE_SEED.

  let HOME_STAR: StarSpec | null = null;

  /**
   * The deterministic home star: nearest populated system to the core of
   * galaxy (0,0,0). minPlanets:1 guarantees planet index 0 actually exists
   * in-system, so the home world can always be orbited and landed on.
   */
  export function homeStar(): StarSpec {
    if (!HOME_STAR) {
      HOME_STAR = findNearestPopulated(galaxyCoreSector(0, 0, 0), { minPlanets: 1 });
    }
    return HOME_STAR;
  }

  /** The home planet — planet index 0 of the home star. The voxel world. */
  export function homePlanet(): PlanetSpec {
    return planetSpec(homeStar().seed, 0);
  }

  /**
   * Where a planet sits in universe space for a given orbital angle. Shared by
   * the scene's per-frame orbit update and by orbital spawn placement, so a
   * spawn point can never drift from where the planet is actually drawn.
   */
  export function planetPositionAt(
    starPos: Vec3d,
    spec: PlanetSpec,
    angle: number = spec.orbitAngle
  ): Vec3d {
    const R = spec.orbitRadius;
    const inc = spec.inclination;
    return v3(
      starPos.x + Math.cos(angle) * R,
      starPos.y + Math.sin(angle) * R * Math.sin(inc),
      starPos.z + Math.sin(angle) * R * Math.cos(inc)
    );
  }

export function planetSpec(starSeed: bigint, index: number): PlanetSpec {
  const seed = planetSeedOf(starSeed, index);
  const r = new Rng(seed);
  const radius = r.powerLaw(14, 26, 1.5);
  const orbitRadius = 140 + index * 62 + r.range(0, 70);
  const orbitAngle = r.range(0, Math.PI * 2);
  const orbitSpeed = r.range(0.02, 0.07);
  const inclination = Math.max(-0.4, Math.min(0.4, r.normal(0, 0.16)));
  const type = pickPlanetType(seed);
  // fractional radius displacement — signed fBm now has full contrast so
  // continents, basins and ridges actually cross the palette thresholds
  const terrainAmp = r.range(0.055, 0.11);
  const terrainFreq = r.range(1.5, 2.4);
  const oceanLevel = r.range(0, 0.3);
  const noiseOff = r.range(0, 1e6);
  const spin = r.range(0.02, 0.09);
  const hasRings = r.next() < 0.28;
  const hasMoons = r.next() < 0.7;
  const axialTilt = 0.14 + r.range(0, 0.18);
  return {
    seed,
    index,
    orbitRadius,
    orbitAngle,
    orbitSpeed,
    inclination,
    radius,
    type,
    terrainAmp,
    terrainFreq,
    oceanLevel,
    noiseOff,
    spin,
    hasRings,
    hasMoons,
    axialTilt,
    name: bodyName(seed) + ' ' + ROMAN[index % ROMAN.length],
  };
}

// ---- deterministic name synthesis ----------------------------------------

const PRE = ['A', 'Be', 'Ce', 'Dra', 'E', 'Fer', 'Ga', 'Hy', 'I', 'Ka', 'Lu', 'Ma', 'No', 'Or', 'Pa', 'Qu', 'Ra', 'Si', 'Ta', 'Va', 'Xe', 'Zy'];
const MID = ['l', 'r', 'n', 's', 'th', 'v', 'x', 'k', 'm', 'd'];
const SUF = ['a', 'is', 'us', 'on', 'ar', 'os', 'ia', 'e', 'um', 'or'];
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
const GREEK = ['Alpha', 'Beta', 'Gamma', 'Delta'];
const GAL_SUF = ['Cloud', 'Nebula', 'Whirl', 'Veil', 'Expanse', 'Reach', 'Halo', 'Spiral'];

export function starName(seed: bigint): string {
  const r = new Rng(derive(seed, 7));
  return (
    PRE[(r.next() * PRE.length) | 0] +
    MID[(r.next() * MID.length) | 0] +
    SUF[(r.next() * SUF.length) | 0]
  );
}

export function bodyName(seed: bigint): string {
  const r = new Rng(derive(seed, 11));
  return (
    PRE[(r.next() * PRE.length) | 0] +
    MID[(r.next() * MID.length) | 0] +
    SUF[(r.next() * SUF.length) | 0]
  );
}

export function galaxyName(seed: bigint): string {
  const r = new Rng(derive(seed, 13));
  return (
    PRE[(r.next() * PRE.length) | 0] +
    MID[(r.next() * MID.length) | 0] +
    SUF[(r.next() * SUF.length) | 0] +
    ' ' +
    GAL_SUF[(r.next() * GAL_SUF.length) | 0]
  );
}
