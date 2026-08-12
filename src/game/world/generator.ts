import { CHUNK_SIZE as S, WORLD_HEIGHT as H, SEA_LEVEL, WORLD_SIZE, wrapBlock, wrapDelta, chunkIndex } from '../core/constants';
import {
  Torus2, PeriodicPerlin2, fbm, ridged, billow, warp2,
  smoothstep, to01, hash2, clamp, type Periodic2,
} from '../core/noise';
import { B, DEFS, isLeaves } from './blocks';
import { Biome, BIOME_DEFS, type BiomeDef, pickBiome } from './biomes';
import { floraFor, type Flora, type TreeShape } from '../space/flora';
import { resolveSpecies, winterPalette, type TreePalette, type SpeciesMix } from './treeSpecies';
import { NO_ORIGIN, type OriginTag } from '../core/origin';
import type { PlanetType } from '../space/palettes';

const TREE_SALT = 0x5eed;
const W = WORLD_SIZE;
/** How far outside a chunk we still plant trunks so their canopy can own in-chunk leaves. */
const TREE_HALO = 10;
/** Max XZ distance² at which a leaf is claimed by a trunk (covers mega / clustered canopies). */
const TREE_OWNER_R2 = 12 * 12;

interface PlantedTree {
  x: number;
  z: number;
  leaves: number;
}

const MAX_TREE_DENSITY = Object.values(BIOME_DEFS)
  .reduce((m, d) => Math.max(m, d.trees), 0);
const THEME_TREE_FLOOR = 0.004;

export const ORE_SURFACE_CLEARANCE = 6;

export interface PlanetTheme {
  seed: bigint | string | number;
  name?: string;
  biome?: Biome | null;
  hillAmp?: number;
  mountainAmp?: number;
  seaLevel?: number;
  oceanCoverage?: number;
  type?: PlanetType;
  originTag?: OriginTag;
  tree?: TreeShape;
  [k: string]: unknown;
}

export function planetSeedToWorldSeed(seed: bigint | string | number): number {
  const b = typeof seed === 'bigint' ? seed : BigInt(seed);
  const s = b < 0n ? -b : b;
  const lo = Number(s & 0xffffffffn);
  const hi = Number((s >> 32n) & 0xffffffffn);
  return ((lo ^ Math.imul(hi, 0x9e3779b1)) >>> 0) % 0x7fffffff || 1;
}

let ACTIVE_THEME: PlanetTheme | null = null;
export function setActivePlanetTheme(t: PlanetTheme | null | undefined): void { ACTIVE_THEME = t ?? null; }
export function getActivePlanetTheme(): PlanetTheme | null { return ACTIVE_THEME; }

const FALLBACK_FLORA: Flora = floraFor('terran', 0n);
const asBigInt = (s: bigint | number | string): bigint => {
  try { return BigInt(s as never); } catch { return 0n; }
};
export function activeOriginTag(): OriginTag { return ACTIVE_THEME?.originTag ?? NO_ORIGIN; }
export function activeFlora(): Flora {
  const t = ACTIVE_THEME;
  if (t?.tree) return { tree: t.tree, grass: (t.grass as Flora['grass']) ?? FALLBACK_FLORA.grass, flower: (t.flower as Flora['flower']) ?? FALLBACK_FLORA.flower };
  return t?.type ? floraFor(t.type, asBigInt(t.seed)) : FALLBACK_FLORA;
}

export enum TerrainArea {
  WATER = 0,
  FLAT = 1,
  HILLS = 2,
  MOUNTAIN = 3,
}

const FLAT_MAX_STEP = 2;
const MOUNTAIN_MASK_MIN = 115;

interface FieldSet {
  cont: number;
  mount: number;
  hills: number;
  pv: number;
}

export class TerrainGenerator {
  readonly theme: PlanetTheme | null;
  readonly flora: Flora;
  readonly originTag: OriginTag;
  readonly sea: number;
  private dSea: number;
  private base: number;
  private hillAmp: number;
  private mountAmp: number;
  private contLo: number;
  private contHi: number;
  private forced: Biome | null;

  private srcCont: Periodic2;
  private srcMount: Periodic2;
  private srcHill: Periodic2;
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
    this.flora = theme
      ? (theme.tree
          ? { tree: theme.tree, grass: (theme.grass as Flora['grass']) ?? FALLBACK_FLORA.grass, flower: (theme.flower as Flora['flower']) ?? FALLBACK_FLORA.flower }
          : floraFor(theme.type ?? 'terran', asBigInt(theme.seed)))
      : FALLBACK_FLORA;
    this.originTag = theme?.originTag ?? NO_ORIGIN;
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

  private climate(px: number, pz: number): { temp: number; humid: number } {
    return {
      temp: to01(fbm(this.srcTemp, px + 614.9, pz - 293.1, { wavelength: 300, octaves: 2 })),
      humid: to01(fbm(this.srcHumid, px - 1213.6, pz + 881.2, { wavelength: 340, octaves: 2 })),
    };
  }

  private fields(px: number, pz: number): FieldSet {
    const [wx, wz] = warp2(this.srcWarp, px, pz, 128, 10, 2);
    const contRaw = fbm(this.srcCont, wx, wz, { wavelength: 320, octaves: 4 });
    const cont = smoothstep(this.contLo, this.contHi, contRaw) * 2 - 1;
    return {
      cont,
      mount: ridged(this.srcMount, wx, wz, { wavelength: 210, octaves: 4 }),
      hills: billow(this.srcHill, wx, wz, { wavelength: 64, octaves: 3 }) * 2 - 1,
      pv: fbm(this.srcPv, px + 71.3, pz - 55.7, { wavelength: 150, octaves: 2 }),
    };
  }

  private static readonly COL_N = W * W;
  private readonly colBuf = new ArrayBuffer(TerrainGenerator.COL_N * 5);
  private readonly colState = new Uint8Array(this.colBuf, 0, TerrainGenerator.COL_N);
  private readonly colBiome = new Uint8Array(this.colBuf, TerrainGenerator.COL_N, TerrainGenerator.COL_N);
  private readonly colHeight = new Int16Array(this.colBuf, TerrainGenerator.COL_N * 2, TerrainGenerator.COL_N);
  private readonly colMount = new Uint8Array(this.colBuf, TerrainGenerator.COL_N * 4, TerrainGenerator.COL_N);
  private colArea: Uint8Array | null = null;

  private computeScalar(px: number, pz: number): { h: number; biome: Biome; mount: number } {
    const f = this.fields(px, pz);
    let biome: Biome;
    if (this.forced !== null) biome = this.forced;
    else {
      const { temp, humid } = this.climate(px, pz);
      biome = pickBiome(temp, humid, f.mount, f.cont);
    }
    const bDef = BIOME_DEFS[biome];

    let h = this.base + f.cont * 4;
    if (f.cont < -0.18) h += (f.cont + 0.18) * 22;
    h += f.hills * bDef.hill * this.hillAmp * 0.4;

    const m = smoothstep(0.64, 0.9, f.mount);
    if (m > 0) h += this.mountAmp * (m * m * 12 + m * f.hills * 2 + m * Math.abs(f.pv) * 5);

    return {
      h: Math.max(3, Math.min(H - 16, Math.floor(h))),
      biome,
      mount: Math.min(255, Math.round(m * 255)),
    };
  }

  private fillColumnRow(px0: number, pz: number): void {
    const k0 = pz * W + px0;
    for (let i = 0; i < S; i++) {
      const r = this.computeScalar(px0 + i, pz);
      const k = k0 + i;
      this.colHeight[k] = r.h;
      this.colBiome[k]  = r.biome;
      this.colMount[k]  = r.mount;
      this.colState[k]  = 1;
    }
  }

  private computeColumn(px: number, pz: number): number {
    const k = pz * W + px;
    if (this.colState[k] !== 0) return k;
    this.fillColumnRow(px & ~(S - 1), pz);
    return k;
  }

  biomeAt(x: number, z: number): Biome {
    if (this.forced !== null) return this.forced;
    const k = this.computeColumn(wrapBlock(x), wrapBlock(z));
    return this.colBiome[k] as Biome;
  }

  biomeDefAt(x: number, z: number) {
    return BIOME_DEFS[this.biomeAt(x, z)];
  }

  heightAt(x: number, z: number): number {
    const k = this.computeColumn(wrapBlock(x), wrapBlock(z));
    return this.colHeight[k];
  }

  oreCeiling(h: number): number {
    return Math.min(h - ORE_SURFACE_CLEARANCE, this.sea - 2, H - 8);
  }

  areaAt(x: number, z: number): TerrainArea {
    const px = wrapBlock(x), pz = wrapBlock(z);
    const k = pz * W + px;
    let aCache = this.colArea;
    if (!aCache) aCache = this.colArea = new Uint8Array(W * W);
    const cached = aCache[k];
    if (cached !== 0) return (cached - 1) as TerrainArea;

    this.computeColumn(px, pz);
    const h = this.colHeight[k];
    let area: TerrainArea;

    if (h < this.sea) {
      area = TerrainArea.WATER;
    } else if (this.colMount[k] >= MOUNTAIN_MASK_MIN || h > 50 + this.dSea) {
      area = TerrainArea.MOUNTAIN;
    } else {
      const s = 2;
      const dxa = Math.abs(this.heightAt(px + s, pz) - h);
      const dxb = Math.abs(this.heightAt(px - s, pz) - h);
      const dza = Math.abs(this.heightAt(px, pz + s) - h);
      const dzb = Math.abs(this.heightAt(px, pz - s) - h);
      const maxStep = Math.max(dxa, dxb, dza, dzb);
      area = maxStep <= FLAT_MAX_STEP ? TerrainArea.FLAT : TerrainArea.HILLS;
    }

    aCache[k] = area + 1;
    return area;
  }

  isWaterAt(x: number, z: number): boolean {
    return this.areaAt(x, z) === TerrainArea.WATER;
  }

  isFlatAt(x: number, z: number): boolean {
    return this.areaAt(x, z) === TerrainArea.FLAT;
  }

  isMountainAt(x: number, z: number): boolean {
    return this.areaAt(x, z) === TerrainArea.MOUNTAIN;
  }

  findNearestFlat(x: number, z: number, maxR = 48): [number, number] | null {
    const ox = wrapBlock(x), oz = wrapBlock(z);
    if (this.areaAt(ox, oz) === TerrainArea.FLAT) return [ox, oz];
    for (let r = 2; r <= maxR; r += 2) {
      const steps = Math.max(8, Math.floor(r * 1.5));
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const px = wrapBlock(ox + Math.round(Math.cos(a) * r));
        const pz = wrapBlock(oz + Math.round(Math.sin(a) * r));
        if (this.areaAt(px, pz) === TerrainArea.FLAT) return [px, pz];
      }
    }
    return null;
  }

  columnAt(x: number, z: number): { h: number; biome: Biome; surface: number } {
    const h = this.heightAt(x, z);
    const biome = this.biomeAt(x, z);
    return { h, biome, surface: this.surfaceBlock(biome, h) };
  }

  private surfaceBlock(biome: Biome, h: number): number {
    if (h <= this.sea + 1) return B.SAND;
    if (h > 56 + this.dSea) return B.SNOW;
    if (h > 50 + this.dSea) return B.STONE;
    return BIOME_DEFS[biome].surface;
  }

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

        if (underwater) {
          for (let y = h + 1; y <= this.sea; y++) data[chunkIndex(lx, y, lz)] = B.WATER;
        }

        const oreMaxY = this.oreCeiling(h);
        for (let y = 2; y <= oreMaxY; y++) {
          if (data[chunkIndex(lx, y, lz)] !== B.STONE) continue;
          const oreRoll = this.decoHash(0x07e0 + y, px, pz);
          const coalRoll = this.decoHash(0x0c0a + y, px, pz);
          if (y >= 3 && coalRoll < 0.045) {
            data[chunkIndex(lx, y, lz)] = B.COAL_ORE;
            continue;
          }
          if (y <= 5 && oreRoll < 0.008) {
            data[chunkIndex(lx, y, lz)] = B.ORE_LUMINESCENCE;
            continue;
          }
          if (y >= 4 && y <= 8 && oreRoll < 0.012) {
            data[chunkIndex(lx, y, lz)] = B.ORE_DIAMOND;
            continue;
          }
          if (y >= 6 && y <= 10 && oreRoll < 0.010) {
            data[chunkIndex(lx, y, lz)] = B.ORE_EMERALD;
            continue;
          }
          if (y >= 8 && y <= 15 && oreRoll < 0.014) {
            data[chunkIndex(lx, y, lz)] = B.ORE_RUBY;
            continue;
          }
          if (y >= 10 && y <= 18 && oreRoll < 0.016) {
            data[chunkIndex(lx, y, lz)] = B.ORE_GOLD;
            continue;
          }
          if (y >= 12 && y <= 20 && oreRoll < 0.018) {
            data[chunkIndex(lx, y, lz)] = B.ORE_JADE;
            continue;
          }
          if (y >= 14 && y <= 25 && oreRoll < 0.020) {
            data[chunkIndex(lx, y, lz)] = B.ORE_SILVER;
            continue;
          }
          if (y >= 16 && oreRoll < 0.022) {
            data[chunkIndex(lx, y, lz)] = B.ORE_AMBER;
          }
        }

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

    const set = this.makeSetter(data, baseX, baseZ);
    const planted: PlantedTree[] = [];
    for (let tx = -TREE_HALO; tx < S + TREE_HALO; tx++) {
      for (let tz = -TREE_HALO; tz < S + TREE_HALO; tz++) {
        const px = wrapBlock(baseX + tx);
        const pz = wrapBlock(baseZ + tz);
        const roll = hash2(this.seed ^ TREE_SALT, px, pz);
        const biome = this.biomeAt(px, pz);
        const bDef = BIOME_DEFS[biome];
        if (!bDef.tree) continue;
        const shape = this.flora.tree;
        if (shape.silhouette === 'none' || shape.densityMul <= 0) continue;
        const density = Math.max(bDef.trees, THEME_TREE_FLOOR) * shape.densityMul;
        if (density <= 0 || roll >= density) continue;
        if (roll >= Math.max(MAX_TREE_DENSITY, THEME_TREE_FLOOR)) continue;
        const h = this.heightAt(px, pz);
        if (h <= this.sea + 1) continue;
        const surface = this.surfaceBlock(biome, h);
        if (surface !== bDef.surface) continue;
        const pal = this.placeTree(set, px, h, pz, bDef);
        planted.push({ x: px, z: pz, leaves: pal.leaves });
      }
    }
    this.unifyCanopyLeaves(data, baseX, baseZ, planted);
  }

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

  private j(wx: number, wz: number, salt: number): number { return hash2(this.seed ^ salt, wx, wz); }
  private jn(wx: number, wz: number, salt: number, i: number): number {
    return hash2(this.seed ^ salt, wx * 31 + i * 7, wz * 17 + i * 13);
  }
  private pickI(range: [number, number], t: number): number {
    return range[0] + Math.floor(t * Math.max(1, range[1] - range[0] + 1));
  }

  private treeMixFor(bDef: BiomeDef | undefined, s: TreeShape): readonly SpeciesMix[] {
    if (s.earthlike && bDef?.treeMix?.length) return bDef.treeMix;
    return s.mix;
  }

  private pickPalette(wx: number, wz: number, mix: readonly SpeciesMix[]): TreePalette {
    const groveT = hash2(this.seed ^ 0x67a0, Math.floor(wx / 24), Math.floor(wz / 24));
    return resolveSpecies(mix, groveT);
  }

  private placeTree(set: SetFn, wx: number, h: number, wz: number, bDef?: BiomeDef): TreePalette {
    const s = this.flora.tree;
    let pal = this.pickPalette(wx, wz, this.treeMixFor(bDef, s));
    if (bDef?.surface === B.SNOW) pal = winterPalette(pal);
    switch (s.silhouette) {
      case 'conifer':   this.tConifer(set, wx, h, wz, s, pal); break;
      case 'palm':      this.tPalm(set, wx, h, wz, s, pal); break;
      case 'spire':     this.tSpire(set, wx, h, wz, s, pal); break;
      case 'crystal':   this.tCrystal(set, wx, h, wz, s, pal); break;
      case 'succulent': this.tSucculent(set, wx, h, wz, s, pal); break;
      case 'umbrella':  this.tUmbrella(set, wx, h, wz, s, pal); break;
      case 'fungal':    this.tFungal(set, wx, h, wz, s, pal); break;
      case 'mega':      this.tMega(set, wx, h, wz, s, pal); break;
      case 'none':      break;
      default:          this.tBroadleaf(set, wx, h, wz, s, pal); break;
    }
    return pal;
  }

  /**
   * Overlapping canopies at snow/grass borders used to interleave green and white
   * leaves (first-writer-wins on air). Reassign every leaf to the nearest trunk
   * so each tree is a single color.
   */
  private unifyCanopyLeaves(
    data: Uint8Array,
    baseX: number,
    baseZ: number,
    planted: PlantedTree[],
  ): void {
    if (planted.length === 0) return;
    let mixed = false;
    for (let i = 1; i < planted.length; i++) {
      if (planted[i].leaves !== planted[0].leaves) { mixed = true; break; }
    }
    if (!mixed) return;

    for (let lx = 0; lx < S; lx++) {
      for (let lz = 0; lz < S; lz++) {
        const wx = wrapBlock(baseX + lx);
        const wz = wrapBlock(baseZ + lz);
        for (let y = 1; y < H; y++) {
          const i = chunkIndex(lx, y, lz);
          const id = data[i];
          if (!isLeaves(id)) continue;
          let bestD = TREE_OWNER_R2 + 1;
          let bestLeaves = id;
          for (let t = 0; t < planted.length; t++) {
            const p = planted[t];
            const dx = wrapDelta(wx - p.x, W);
            const dz = wrapDelta(wz - p.z, W);
            const d = dx * dx + dz * dz;
            if (d < bestD) {
              bestD = d;
              bestLeaves = p.leaves;
            }
          }
          if (bestD <= TREE_OWNER_R2 && bestLeaves !== id) data[i] = bestLeaves;
        }
      }
    }
  }


  private leafAt(set: SetFn, x: number, y: number, z: number, pal: TreePalette): void {
    set(x, y, z, pal.leaves, false);
  }

  private growCanopy(
    set: SetFn,
    cx: number, cy: number, cz: number,
    rx: number, ry: number, rz: number,
    density: number, salt: number, pal: TreePalette,
  ): void {
    const rx2 = Math.max(1, rx * rx);
    const ry2 = Math.max(1, ry * ry);
    const rz2 = Math.max(1, rz * rz);
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        for (let dz = -rz; dz <= rz; dz++) {
          const n = hash2(this.seed ^ salt, cx * 13 + dx, cz * 29 + dz + dy * 17);
          const wob = 0.68 + n * 0.52;
          const d = (dx * dx) / rx2 + (dy * dy) / ry2 + (dz * dz) / rz2;
          if (d > wob) continue;
          if (d > wob * 0.52 && hash2(this.seed ^ (salt + 0x51), cx * 31 + dx, (cy + dy) * 7 + dz) > density) {
            continue;
          }
          this.leafAt(set, cx + dx, cy + dy, cz + dz, pal);
        }
      }
    }
  }

  private trunk(set: SetFn, wx: number, h: number, wz: number, len: number, pal: TreePalette): number {
    const top = h + Math.max(1, len);
    for (let y = h + 1; y <= top; y++) set(wx, y, wz, pal.log, true);
    return top;
  }

  private tBroadleaf(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0xa7ee));
    const top = this.trunk(set, wx, h, wz, trunkH, pal);
    const r = Math.max(2, this.pickI(s.canopyR, this.j(wx, wz, 0xa2)));
    const ch = Math.max(2, s.canopyH);

    this.growCanopy(set, wx, top, wz, r, Math.max(1, ch >> 1), r, s.leafDensity, 0x1eaf, pal);
    this.growCanopy(set, wx, top + 1, wz, Math.max(1, r - 1), 1, Math.max(1, r - 1), s.leafDensity * 0.9, 0x1eb0, pal);

    const clusters = 2 + Math.floor(this.j(wx, wz, 0xa3) * 3);
    for (let k = 0; k < clusters; k++) {
      const la = this.jn(wx, wz, 0xa4, k) * 6.283;
      const reach = 1 + Math.floor(this.jn(wx, wz, 0xa6, k) * Math.max(1, r - 1));
      const ly = top - Math.floor(this.jn(wx, wz, 0xa5, k) * Math.max(1, ch * 0.35));
      const bx = wx + Math.round(Math.cos(la) * reach);
      const bz = wz + Math.round(Math.sin(la) * reach);
      this.growCanopy(
        set, bx, ly, bz,
        Math.max(1, r - 1), Math.max(1, (ch >> 1) - 1), Math.max(1, r - 1),
        s.leafDensity * 0.92, 0x1eb1 + k, pal,
      );
    }
  }

  private tConifer(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0xc0f1));
    const top = this.trunk(set, wx, h, wz, trunkH + 1, pal);
    const rMax = Math.max(2, s.canopyR[1]);
    const bare = Math.max(2, Math.round(trunkH * (0.24 + this.j(wx, wz, 0xc0f3) * 0.16)));
    const base = h + bare;
    const tipY = top;
    const span = Math.max(1, tipY - base);
    const twist = this.j(wx, wz, 0xc0f4) * 6.283;

    for (let ly = base; ly <= tipY; ly++) {
      const t = (ly - base) / span;
      const whorl = (ly - base) % 3;
      const flare = whorl === 0 ? 1 : whorl === 1 ? 0.62 : 0.28;
      const rad = Math.round((rMax * (1 - t) + 0.4) * flare);
      if (rad <= 0) { this.leafAt(set, wx, ly, wz, pal); continue; }
      const spin = twist + (ly - base) * 0.45;
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > rad * rad + rad) continue;
          const ang = Math.atan2(dz, dx) - spin;
          const scallop = 1 + 0.12 * Math.sin(ang * 5);
          if (d2 > (rad * scallop) * (rad * scallop) + rad) continue;
          if (d2 > (rad - 1) * (rad - 1) &&
              hash2(this.seed ^ 0xc0f2, wx * 31 + dx, ly * 7 + dz) > s.leafDensity) continue;
          if (dx === 0 && dz === 0 && ly <= top) continue;
          this.leafAt(set, wx + dx, ly, wz + dz, pal);
        }
      }
    }
    this.leafAt(set, wx, tipY + 1, wz, pal);
  }

  private tPalm(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0x9a1));
    const top = this.trunk(set, wx, h, wz, trunkH, pal);
    const fronds = Math.max(5, s.branches);
    const baseLen = this.pickI(s.canopyR, this.j(wx, wz, 0x9a3)) + 1;
    const spin = this.j(wx, wz, 0x9a4) * 0.9;

    for (let f = 0; f < fronds; f++) {
      const fa = (f / fronds) * Math.PI * 2 + spin;
      const dx = Math.cos(fa), dz = Math.sin(fa);
      const len = Math.max(2, baseLen - (this.jn(wx, wz, 0x9a6, f) < 0.4 ? 1 : 0));
      for (let i = 1; i <= len; i++) {
        const t = i / len;
        const drop = Math.round(s.droop * t * t * len);
        const px = wx + Math.round(dx * i);
        const pz = wz + Math.round(dz * i);
        this.leafAt(set, px, top - drop + (i === 1 ? 1 : 0), pz, pal);
        if (i < len && this.jn(wx, wz, 0x9a5, f * 8 + i) < s.leafDensity) {
          this.leafAt(set, px + Math.round(-dz), top - drop, pz + Math.round(dx), pal);
          this.leafAt(set, px + Math.round(dz), top - drop, pz + Math.round(-dx), pal);
        }
      }
    }
    this.leafAt(set, wx, top + 1, wz, pal);
    if (pal.fruit !== undefined && this.j(wx, wz, 0x9a7) < 0.5) {
      const ca = this.j(wx, wz, 0x9a8) * Math.PI * 2;
      set(wx + Math.round(Math.cos(ca)), top - 1, wz + Math.round(Math.sin(ca)), pal.fruit, false);
    }
  }

  private tSpire(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0x5a1));
    const top = this.trunk(set, wx, h, wz, trunkH, pal);
    const blobs = Math.max(1, s.branches);
    for (let n = 0; n < blobs; n++) {
      const y = h + Math.round(((n + 1) / (blobs + 1)) * trunkH);
      const shrink = 1 - (n / Math.max(1, blobs)) * 0.35;
      const r = Math.max(1, Math.round(this.pickI(s.canopyR, this.jn(wx, wz, 0x5a3, n)) * shrink));
      const ang = this.jn(wx, wz, 0x5a4, n) * 6.283;
      const off = 1 + Math.floor(this.jn(wx, wz, 0x5a6, n) * 2);
      this.growCanopy(
        set,
        wx + Math.round(Math.cos(ang) * off),
        y,
        wz + Math.round(Math.sin(ang) * off),
        r, r, r, s.leafDensity, 0x5a5 + n, pal,
      );
    }
    this.growCanopy(set, wx, top + 1, wz, 1, 2, 1, 1, 0x5a9, pal);
  }

  private tCrystal(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const coreH = this.pickI(s.trunkH, this.j(wx, wz, 0x1c1));
    this.trunk(set, wx, h, wz, coreH, pal);
    const shards = Math.max(2, s.branches);
    for (let k = 0; k < shards; k++) {
      const ka = (k / shards) * Math.PI * 2 + this.j(wx, wz, 0x1c2) * 1.2;
      const dist = 1 + this.jn(wx, wz, 0x1c3, k);
      const bx = wx + Math.round(Math.cos(ka) * dist);
      const bz = wz + Math.round(Math.sin(ka) * dist);
      const hgt = 2 + Math.floor(this.jn(wx, wz, 0x1c4, k) * s.canopyH);
      for (let ly = 0; ly < hgt; ly++) {
        const rad = ly < hgt * 0.5 ? 1 : 0;
        for (let dx = -rad; dx <= rad; dx++) {
          for (let dz = -rad; dz <= rad; dz++) {
            if (rad === 1 && dx !== 0 && dz !== 0 && ly > hgt * 0.3) continue;
            this.leafAt(set, bx + dx, h + 1 + ly, bz + dz, pal);
          }
        }
      }
    }
    this.growCanopy(set, wx, h + coreH + 1, wz, 1, 2, 1, 1, 0x1c5, pal);
  }

  private tSucculent(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const stemH = this.pickI(s.trunkH, this.j(wx, wz, 0xd51));
    this.trunk(set, wx, h, wz, stemH, pal);
    if (s.leafDensity > 0.25) this.leafAt(set, wx, h + stemH + 1, wz, pal);
    const nubs = Math.max(0, Math.min(3, s.branches - 1));
    for (let k = 0; k < nubs; k++) {
      const ka = (k / Math.max(1, nubs)) * Math.PI * 2 + this.j(wx, wz, 0xd52) * 1.5;
      const dx = Math.round(Math.cos(ka));
      const dz = Math.round(Math.sin(ka));
      if (!dx && !dz) continue;
      const atY = h + 2 + Math.floor(this.jn(wx, wz, 0xd53, k) * Math.max(1, stemH - 3));
      this.leafAt(set, wx + dx, atY, wz + dz, pal);
    }
  }

  private tUmbrella(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0x8b1));
    const top = this.trunk(set, wx, h, wz, trunkH, pal);
    const r = Math.max(2, this.pickI(s.canopyR, this.j(wx, wz, 0x8b3)));
    const pads = 1 + (this.j(wx, wz, 0x8b5) < 0.45 ? 1 : 0);

    const crowns: Array<[number, number, number, number]> = [[wx, top, wz, 0]];
    for (let k = 0; k < pads; k++) {
      const fa = this.jn(wx, wz, 0x8b6, k) * 6.283;
      const reach = 1 + Math.floor(this.jn(wx, wz, 0x8b7, k) * 2);
      crowns.push([
        wx + Math.round(Math.cos(fa) * reach),
        top,
        wz + Math.round(Math.sin(fa) * reach),
        1,
      ]);
    }
    for (const [cx, cy, cz, shrink] of crowns) {
      for (let ly = 0; ly < Math.max(1, s.canopyH); ly++) {
        const rad = r - ly - shrink;
        if (rad <= 0) break;
        for (let dx = -rad; dx <= rad; dx++) {
          for (let dz = -rad; dz <= rad; dz++) {
            const d2 = dx * dx + dz * dz;
            if (d2 > rad * rad) continue;
            if (d2 > (rad - 1) * (rad - 1) &&
                this.jn(wx, wz, 0x8b4, dx * 13 + dz + cx) > s.leafDensity) continue;
            this.leafAt(set, cx + dx, cy + 1 + ly, cz + dz, pal);
          }
        }
      }
    }
  }

  private tFungal(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const stalkH = this.pickI(s.trunkH, this.j(wx, wz, 0xf01));
    const top = this.trunk(set, wx, h, wz, stalkH, pal);
    const r = this.pickI(s.canopyR, this.j(wx, wz, 0xf03));

    for (let dy = 0; dy <= Math.max(1, s.canopyH - 1); dy++) {
      const rad = Math.round(r * Math.cos((dy / Math.max(1, s.canopyH)) * (Math.PI / 2)));
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dz = -rad; dz <= rad; dz++) {
          const d2 = dx * dx + dz * dz;
          if (d2 > rad * rad) continue;
          if (dy === 0 && d2 < (rad - 1) * (rad - 1)) continue;
          this.leafAt(set, wx + dx, top + dy, wz + dz, pal);
        }
      }
    }
    const skirt = Math.round(s.droop * r * 2);
    for (let i = 0; i < skirt; i++) {
      const ga = this.jn(wx, wz, 0xf04, i) * Math.PI * 2;
      this.leafAt(set, wx + Math.round(Math.cos(ga) * r), top - 1, wz + Math.round(Math.sin(ga) * r), pal);
    }
  }

  private tMega(set: SetFn, wx: number, h: number, wz: number, s: TreeShape, pal: TreePalette) {
    const trunkH = this.pickI(s.trunkH, this.j(wx, wz, 0x3e01)) + 4;
    const top = this.trunk(set, wx, h, wz, trunkH, pal);
    const r = Math.max(3, s.canopyR[1] + 2);

    this.growCanopy(set, wx, top, wz, r, 2, r, s.leafDensity, 0x3e02, pal);
    this.growCanopy(set, wx, top + 2, wz, Math.max(2, r - 2), 1, Math.max(2, r - 2), s.leafDensity * 0.9, 0x3e03, pal);

    const strands = 4 + Math.floor(this.j(wx, wz, 0x3e04) * 5);
    for (let k = 0; k < strands; k++) {
      const va = this.jn(wx, wz, 0x3e05, k) * 6.283;
      const vx = wx + Math.round(Math.cos(va) * r);
      const vz = wz + Math.round(Math.sin(va) * r);
      const drop = 2 + Math.floor(this.jn(wx, wz, 0x3e06, k) * 5);
      for (let d = 0; d < drop; d++) this.leafAt(set, vx, top - 1 - d, vz, pal);
    }
  }
}

type SetFn = (x: number, y: number, z: number, id: number, force: boolean) => void;

export function firstSolidBelow(get: (y: number) => number, fallback: number = SEA_LEVEL): number {
  for (let y = H - 1; y > 0; y--) {
    const id = get(y);
    if (id !== B.AIR && id !== B.WATER && DEFS[id].solid) return y;
  }
  return fallback;
}
