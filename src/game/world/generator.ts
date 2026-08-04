/**
 * Terrain generator — the landscape recipe.
 *
 * Every source is exactly periodic on the world torus (Torus2 / PeriodicPerlin2),
 * so F(x, z) === F(x ± W, z ± W) holds analytically for every field.
 *
 * Recipe (addresses the "cottage cheese" problem — raw fbm alone can never
 * produce geography):
 *   continentalness  low-freq fbm, smoothstep-remapped to a land-biased
 *                    distribution -> oceans with real basins, coastlines,
 *                    big walkable continents and flat inland plains
 *   mountains        ridged multifractal (weighted octaves) -> coherent
 *                    RANGES with crests and saddles, masked by smoothstep;
 *                    a peaks-and-valleys layer modulates crest jaggedness
 *   hills            billow octaves -> rounded, rolling detail scaled per-biome
 *   domain warp      2-octave warp bends every landform field -> breaks the
 *                    blobby radial symmetry of plain fbm
 *   climate          temp/humid sampled on SEPARATE lattices (decorrelated
 *                    biomes) -> plains / forest / desert / taiga / mountains
 *
 * Trees are evaluated in a 2-block margin around each chunk from canonical
 * coordinates, so trunks and canopies are stable across chunk borders and
 * across the torus seam.
 */

import { CHUNK_SIZE as S, WORLD_HEIGHT as H, SEA_LEVEL, WORLD_SIZE, wrapBlock, chunkIndex } from '../core/constants';
import {
  Torus2, PeriodicPerlin2, fbm, ridged, billow, warp2,
  smoothstep, to01, hash2, type Periodic2,
} from '../core/noise';
import { B, DEFS } from './blocks';
import { Biome, BIOME_DEFS, pickBiome } from './biomes';

const TREE_SALT = 0x5eed;
const W = WORLD_SIZE; // world edge length in blocks

/**
 * Densest tree roll any biome can pass. The tree pass visits 400 columns per
 * chunk; testing this constant first rejects ~95% of them with one hash and
 * zero terrain-field work.
 */
const MAX_TREE_DENSITY = Object.values(BIOME_DEFS)
  .reduce((m, d) => Math.max(m, d.trees), 0);

/** Structural subset of TASK 4's PlanetTheme that terrain cares about.
 *  Index signature keeps it assignable from the full space/palettes type. */
export interface PlanetTheme {
  seed: bigint | string | number;
  name?: string;
  /** force a single-biome world (null/undefined = normal climate biomes) */
  biome?: Biome | null;
  hillAmp?: number;       // multiplier on rolling hill detail   (default 1)
  mountainAmp?: number;   // multiplier on mountain massifs      (default 1)
  seaLevel?: number;      // absolute override of SEA_LEVEL
  oceanCoverage?: number; // 0 = dry world, 0.5 = default, 1 = drowned
  [k: string]: unknown;
}

/** BigInt planet seed -> stable 31-bit noise seed (never Math.random) */
export function planetSeedToWorldSeed(seed: bigint | string | number): number {
  const b = typeof seed === 'bigint' ? seed : BigInt(seed);
  const s = b < 0n ? -b : b;
  const lo = Number(s & 0xffffffffn);
  const hi = Number((s >> 32n) & 0xffffffffn);
  return ((lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0) % 0x7fffffff || 1;
}

/** ambient theme so World/TerrainGenerator construction sites need no signature change */
let ACTIVE_THEME: PlanetTheme | null = null;
export function setActivePlanetTheme(t: PlanetTheme | null | undefined): void { ACTIVE_THEME = t ?? null; }
export function getActivePlanetTheme(): PlanetTheme | null { return ACTIVE_THEME; }

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

interface FieldSet {
  cont: number;  // continentalness ~[-1, 1]  (land-biased)
  mount: number; // ridged mountain signal [0, 1]
  hills: number; // billow rolling detail ~[-1, 1]
  pv: number;    // peaks/valleys crest jaggedness ~[-1, 1]
}

export class TerrainGenerator {
  readonly theme: PlanetTheme | null;
  /** effective sea level and its delta vs. the default constant */
  readonly sea: number;
  private dSea: number;
  private base: number;      // continent base height, sea-relative
  private hillAmp: number;
  private mountAmp: number;
  private contLo: number;    // ocean-coverage-shifted remap window
  private contHi: number;
  private forced: Biome | null;

  // independent lattices (xor-salted) -> decorrelated layers
  private srcCont: Periodic2;
  private srcMount: Periodic2;
  private srcHill: Periodic2;   // cheap wrapped-Perlin for 3 billow octaves
  private srcWarp: Periodic2;
  private srcTemp: Periodic2;
  private srcHumid: Periodic2;
  private srcPv: Periodic2;

  constructor(public readonly seed: number, theme: PlanetTheme | null = ACTIVE_THEME) {
    this.theme = theme;
    this.sea = clamp(Math.round(theme?.seaLevel ?? SEA_LEVEL), 4, H - 24);
    this.dSea = this.sea - SEA_LEVEL;
    this.base = 35 + this.dSea;
    this.hillAmp = Math.max(0, theme?.hillAmp ?? 1);
    this.mountAmp = Math.max(0, theme?.mountainAmp ?? 1);
    this.forced = theme?.biome ?? null;
    // coverage 0 -> land everywhere, 1 -> mostly ocean (0.5 reproduces the classic window)
    const shift = (clamp(theme?.oceanCoverage ?? 0.5, 0, 1) - 0.5) * 0.9;
    this.contLo = -0.62 + shift;
    this.contHi = 0.55 + shift;

    this.srcCont = new Torus2(seed ^ 0x1a2b3c, W, W);
    this.srcMount = new Torus2(seed ^ 0x4d5e6f, W, W);
    this.srcHill = new PeriodicPerlin2(seed ^ 0x7a8b9c, W, W);
    this.srcWarp = new Torus2(seed ^ 0x0f1e2d, W, W);
    this.srcTemp = new Torus2(seed ^ 0x3c4d5e, W, W);
    this.srcHumid = new Torus2(seed ^ 0x2b3a49, W, W);
    this.srcPv = new Torus2(seed ^ 0x596a7b, W, W);
  }

  private decoHash(salt: number, px: number, pz: number): number {
    return hash2(this.seed ^ salt, px, pz);
  }

  /** climate: separate unwarped lattice pair so biomes are decorrelated from relief */
  private climate(px: number, pz: number): { temp: number; humid: number } {
    return {
      temp: to01(fbm(this.srcTemp, px + 614.9, pz - 293.1, { wavelength: 300, octaves: 2 })),
      humid: to01(fbm(this.srcHumid, px - 1213.6, pz + 881.2, { wavelength: 340, octaves: 2 })),
    };
  }

  /** landforms: every field sampled through the same domain warp */
  private fields(px: number, pz: number): FieldSet {
    const [wx, wz] = warp2(this.srcWarp, px, pz, 128, 16, 2);
    const contRaw = fbm(this.srcCont, wx, wz, { wavelength: 320, octaves: 4 });
    // smoothstep re-map: mean-shifted -> ~70% land, deep basins below ~30%
    const cont = smoothstep(this.contLo, this.contHi, contRaw) * 2 - 1;
    return {
      cont,
      mount: ridged(this.srcMount, wx, wz, { wavelength: 210, octaves: 4 }),
      hills: billow(this.srcHill, wx, wz, { wavelength: 64, octaves: 3 }) * 2 - 1,
      pv: fbm(this.srcPv, px + 71.3, pz - 55.7, { wavelength: 150, octaves: 2 }),
    };
  }

  // ---------------------------------------------------------- column memo
  // `fields()` + `climate()` cost ~21 noise octaves per column, and both
  // heightAt() and biomeAt() used to evaluate them independently — so one
  // chunk paid for ~1,300 full field evaluations (256 terrain columns + 400
  // tree-margin columns, each sampled twice). That single hotspot produced
  // the multi-frame hitches when the streamer activated a new chunk.
  //
  // The world torus is only 512×512 columns, so we memoize the *entire*
  // column field in two flat typed arrays (768 KB). Every later query —
  // re-meshing, camps, AI ground snapping, spawn scans, revisiting a chunk
  // after eviction — becomes a single array read.
  private colHeight: Int16Array | null = null;
  private colBiome: Uint8Array | null = null;

  private computeColumn(px: number, pz: number): number {
    let hCache = this.colHeight;
    let bCache = this.colBiome;
    if (!hCache || !bCache) {
      hCache = this.colHeight = new Int16Array(W * W).fill(-1);
      bCache = this.colBiome = new Uint8Array(W * W);
    }
    const k = pz * W + px;
    const cached = hCache[k];
    if (cached >= 0) return k;

    const f = this.fields(px, pz);
    let biome: Biome;
    if (this.forced !== null) biome = this.forced;
    else {
      const { temp, humid } = this.climate(px, pz);
      biome = pickBiome(temp, humid, f.mount, f.cont);
    }
    const bDef = BIOME_DEFS[biome];

    let h = this.base + f.cont * 6;                // continent raise
    if (f.cont < -0.18) h += (f.cont + 0.18) * 22; // descend into ocean basins
    h += f.hills * bDef.hill * this.hillAmp;       // rounded biome detail

    // mountain ranges: masked ridged signal, squared for sharp massifs,
    // peaks/valleys modulate crest jaggedness
    const m = smoothstep(0.55, 0.86, f.mount);
    if (m > 0) h += this.mountAmp * (m * m * 26 + m * f.hills * 3 + m * Math.abs(f.pv) * 7);

    hCache[k] = Math.max(3, Math.min(H - 16, Math.floor(h)));
    bCache[k] = biome;
    return k;
  }

  biomeAt(x: number, z: number): Biome {
    if (this.forced !== null) return this.forced;
    const k = this.computeColumn(wrapBlock(x), wrapBlock(z));
    return this.colBiome![k] as Biome;
  }

  biomeDefAt(x: number, z: number) {
    return BIOME_DEFS[this.biomeAt(x, z)];
  }

  heightAt(x: number, z: number): number {
    const k = this.computeColumn(wrapBlock(x), wrapBlock(z));
    return this.colHeight![k];
  }

  /**
   * Single-column evaluation — the ONE place populateChunk asks about a
   * column, so biome + height consistently share the same field sample.
   */
  columnAt(x: number, z: number): { h: number; biome: Biome; surface: number } {
    const h = this.heightAt(x, z);
    const biome = this.biomeAt(x, z);
    return { h, biome, surface: this.surfaceBlock(biome, h) };
  }

  /** surface block for a column (biome + altitude + beach/snow-cap rules) */
  private surfaceBlock(biome: Biome, h: number): number {
    if (h <= this.sea + 1) return B.SAND;      // beaches & seabeds
    if (h > 56 + this.dSea) return B.SNOW;     // snow caps
    if (h > 50 + this.dSea) return B.STONE;    // rocky ridgelines
    return BIOME_DEFS[biome].surface;
  }

  /**
   * Choose a pleasant spawn: spiral-scan outward from near the origin,
   * scoring for dry land, moderate altitude and friendly biomes.
   */
  findSpawn(): [number, number] {
    let best: [number, number] = [8, 8];
    let bestScore = Infinity;
    for (let r = 0; r <= 180; r += 8) {
      const steps = r === 0 ? 1 : Math.max(6, Math.floor(r / 6));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const px = wrapBlock(8 + Math.cos(a) * r);
        const pz = wrapBlock(8 + Math.sin(a) * r);
        const h = this.heightAt(px, pz);
        if (h <= this.sea + 1 || h > 52 + this.dSea) continue;
        const biome = this.biomeAt(px, pz);
        const biomePenalty =
          this.forced !== null ? 0 :
          biome === Biome.PLAINS || biome === Biome.FOREST ? 0 :
          biome === Biome.DESERT ? 6 :
          biome === Biome.SNOW ? 10 : 14;
        const score = biomePenalty + Math.abs(h - (37 + this.dSea)) * 0.35 + r * 0.06;
        if (score < bestScore) {
          bestScore = score;
          best = [px, pz];
        }
      }
      if (bestScore < Infinity && bestScore < 4 && r > 24) break;
    }
    if (bestScore === Infinity) {
      // fully oceanic theme: stand on the highest seabed near origin
      let bh = -1;
      for (let r = 0; r <= 180; r += 6) {
        for (let i = 0; i < 12; i++) {
          const a = (i / 12) * Math.PI * 2;
          const px = wrapBlock(8 + Math.cos(a) * r), pz = wrapBlock(8 + Math.sin(a) * r);
          const h = this.heightAt(px, pz);
          if (h > bh) { bh = h; best = [px, pz]; }
        }
      }
    }
    return best;
  }

  populateChunk(data: Uint8Array, cx: number, cz: number): void {
    const baseX = cx * S;
    const baseZ = cz * S;

    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const px = wrapBlock(baseX + lx);
        const pz = wrapBlock(baseZ + lz);
        const { h, biome, surface } = this.columnAt(px, pz);
        const bDef = BIOME_DEFS[biome];
        // Compare against this planet's own sea level. Using the global
        // default desynchronizes themed coastlines and leaves floating water
        // slabs beside grass on high-sea planets.
        const underwater = h < this.sea;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) id = B.BEDROCK;
          else if (y === 1 && this.decoHash(0xbed, px, pz) < 0.5) id = B.BEDROCK;
          else if (y === h) {
            id = underwater && this.decoHash(0x6a1, px, pz) < 0.3 ? B.GRAVEL : surface;
          } else if (y > h - 3) {
            id = underwater || h <= this.sea + 1 ? B.SAND : bDef.sub;
          } else id = B.STONE;
          data[chunkIndex(lx, y, lz)] = id;
        }

        // ocean column
        if (underwater) {
          for (let y = h + 1; y <= this.sea; y++) data[chunkIndex(lx, y, lz)] = B.WATER;
        }

        // ---- gemstone ore generation: each gem has its own depth range ----
        // deeper = rarer and more valuable. Uses deterministic per-column hash
        // so ores are stable across chunk reloads.
        for (let y = 2; y < Math.min(h, H - 8); y++) {
          if (data[chunkIndex(lx, y, lz)] !== B.STONE) continue;
          const oreRoll = this.decoHash(0x07e0 + y, px, pz);
          // Luminescence (rarest, deepest): Y 2-15
          if (y <= 15 && oreRoll < 0.008) {
            data[chunkIndex(lx, y, lz)] = B.ORE_LUMINESCENCE;
            continue;
          }
          // Diamond: Y 5-20
          if (y <= 20 && y >= 5 && oreRoll < 0.012) {
            data[chunkIndex(lx, y, lz)] = B.ORE_DIAMOND;
            continue;
          }
          // Emerald: Y 8-25
          if (y <= 25 && y >= 8 && oreRoll < 0.010) {
            data[chunkIndex(lx, y, lz)] = B.ORE_EMERALD;
            continue;
          }
          // Ruby: Y 10-30
          if (y <= 30 && y >= 10 && oreRoll < 0.014) {
            data[chunkIndex(lx, y, lz)] = B.ORE_RUBY;
            continue;
          }
          // Gold: Y 15-35
          if (y <= 35 && y >= 15 && oreRoll < 0.016) {
            data[chunkIndex(lx, y, lz)] = B.ORE_GOLD;
            continue;
          }
          // Jade: Y 18-40
          if (y <= 40 && y >= 18 && oreRoll < 0.018) {
            data[chunkIndex(lx, y, lz)] = B.ORE_JADE;
            continue;
          }
          // Silver: Y 20-45
          if (y <= 45 && y >= 20 && oreRoll < 0.020) {
            data[chunkIndex(lx, y, lz)] = B.ORE_SILVER;
            continue;
          }
          // Amber (most common, shallowest): Y 25-50
          if (y <= 50 && y >= 25 && oreRoll < 0.022) {
            data[chunkIndex(lx, y, lz)] = B.ORE_AMBER;
          }
        }

        // decorations on dry land
        if (!underwater) {
          const r = this.decoHash(0xdec0, px, pz);
          const onGrass = surface === B.GRASS && h > this.sea + 1;
          if (onGrass && r < bDef.flowers) {
            const flower = this.decoHash(0xf10, px, pz) < 0.5 ? B.FLOWER_RED : B.FLOWER_YELLOW;
            data[chunkIndex(lx, h + 1, lz)] = flower;
          } else if (onGrass && r < bDef.flowers + bDef.grass) {
            data[chunkIndex(lx, h + 1, lz)] = B.TALLGRASS;
          } else if (bDef.cactus > 0 && surface === B.SAND && h > this.sea + 1 && r < bDef.cactus) {
            const ch = 2 + Math.floor(this.decoHash(0xcac, px, pz) * 2);
            for (let y = h + 1; y <= Math.min(h + ch, H - 1); y++) data[chunkIndex(lx, y, lz)] = B.CACTUS;
          }
        }
      }
    }

    // trees: canonical coords in a 2-block margin -> stable across chunks & the seam
    // The cheap deterministic hash gate runs FIRST: >95% of the 400 margin
    // columns are rejected before any terrain field is touched, and the
    // setter closure is hoisted out of the loop instead of being rebuilt for
    // every trunk.
    const set = this.makeSetter(data, baseX, baseZ);
    for (let tx = -2; tx < S + 2; tx++) {
      for (let tz = -2; tz < S + 2; tz++) {
        const px = wrapBlock(baseX + tx);
        const pz = wrapBlock(baseZ + tz);
        const roll = hash2(this.seed ^ TREE_SALT, px, pz);
        if (roll >= MAX_TREE_DENSITY) continue;
        const biome = this.biomeAt(px, pz);
        const bDef = BIOME_DEFS[biome];
        if (!bDef.tree || bDef.trees <= 0) continue;
        if (roll >= bDef.trees) continue;
        const h = this.heightAt(px, pz);
        if (h <= this.sea + 1) continue;
        const surface = this.surfaceBlock(biome, h);
        // never place trees on snowy ground (snow block, snow cap, or taiga floor)
        if (surface !== B.GRASS) continue;
        if (bDef.tree === 'spruce') this.placeSpruce(set, px, h, pz);
        else this.placeOak(set, px, h, pz);
      }
    }
  }

  /** returns a writer that only mutates `data` inside this chunk's footprint (wrap-aware) */
  private makeSetter(data: Uint8Array, baseX: number, baseZ: number) {
    return (wx: number, y: number, wz: number, id: number, force: boolean) => {
      const lx = wrapBlock(wx) - baseX;
      const lz = wrapBlock(wz) - baseZ;
      if (lx < 0 || lx >= S || lz < 0 || lz >= S || y < 1 || y >= H) return;
      const i = chunkIndex(lx, y, lz);
      if (!force && data[i] !== B.AIR) return;
      data[i] = id;
    };
  }

  private placeOak(
    set: (x: number, y: number, z: number, id: number, force: boolean) => void,
    wx: number, h: number, wz: number
  ): void {
    const trunkH = 7 + Math.floor(hash2(this.seed ^ 0xa7ee, wx, wz) * 3);
    const top = h + trunkH;
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const rad = ly <= top - 1 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) {
            if (hash2(this.seed ^ 0x1eaf, wx * 31 + dx, ly * 7 + dz) < 0.6) continue;
          }
          set(wx + dx, ly, wz + dz, B.LEAVES, false);
        }
      }
    }
    for (let y = h + 1; y <= top; y++) set(wx, y, wz, B.LOG, true);
  }

  private placeSpruce(
    set: (x: number, y: number, z: number, id: number, force: boolean) => void,
    wx: number, h: number, wz: number
  ): void {
    const trunkH = 9 + Math.floor(hash2(this.seed ^ 0x59, wx, wz) * 3);
    const top = h + trunkH;
    for (let ly = h + 2; ly <= top; ly++) {
      const fromTop = top - ly;
      let rad: number;
      if (fromTop === 0) rad = 0;
      else if (fromTop <= 2) rad = 1;
      else rad = ly % 2 === 0 ? 2 : 1;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          if (dx === 0 && dz === 0) continue;
          if (rad === 2 && Math.abs(dx) === 2 && Math.abs(dz) === 2) continue;
          set(wx + dx, ly, wz + dz, B.LEAVES, false);
        }
      }
    }
    set(wx, top + 1, wz, B.LEAVES, false);
    for (let y = h + 1; y <= top; y++) set(wx, y, wz, B.LOG, true);
  }
}

/** quick scan used to find a safe spawn height */
export function firstSolidBelow(get: (y: number) => number, fallback: number = SEA_LEVEL): number {
  for (let y = H - 1; y > 0; y--) {
    const id = get(y);
    if (id !== B.AIR && id !== B.WATER && DEFS[id].solid) return y;
  }
  return fallback;
}
