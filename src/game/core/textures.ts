import * as THREE from 'three';
import { mulberry32 } from './noise';
import { PLANET_PALETTES, type PlanetType } from '../space/palettes';
import type { PlanetTheme } from '../space/theme';

export const TILE = 16;
export const TPR = 8;

const TILE_NAMES = [
  'grass_top', 'grass_side', 'dirt', 'stone', 'sand', 'gravel',
  'log_side', 'log_top', 'leaves', 'planks', 'glass', 'snow',
  'snow_side', 'bedrock', 'flower_red', 'flower_yellow', 'tallgrass',
  'cactus_side', 'cactus_top', 'water',
  'craft_top', 'craft_side', 'craft_bottom',
  'furnace_front', 'furnace_front_lit', 'furnace_side', 'furnace_top',
  'cobble',
  'ore_ruby', 'ore_amber', 'ore_luminescence', 'ore_diamond',
  'ore_gold', 'ore_silver', 'ore_jade', 'ore_emerald',
  'coal_ore', 'coal', 'stick', 'torch',
  'conveyor_top_n', 'conveyor_top_e', 'conveyor_top_s', 'conveyor_top_w',
  'conveyor_side',
  'inserter_top_n', 'inserter_top_e', 'inserter_top_s', 'inserter_top_w',
  'inserter_side',
] as const;

type TileName = (typeof TILE_NAMES)[number];

export const TILES: Record<string, number> = {};
TILE_NAMES.forEach((n, i) => (TILES[n] = i));

export const ATLAS_COLS = TPR;
export const ATLAS_ROWS = Math.ceil(TILE_NAMES.length / TPR);
export const ATLAS_W = ATLAS_COLS * TILE;
export const ATLAS_H = ATLAS_ROWS * TILE;

/* ══════════════════════════════════════════════════════════════
   1. colour math
   ══════════════════════════════════════════════════════════════ */

type RGB = readonly [number, number, number];
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const rgb = (r: number, g: number, b: number): RGB => [clampByte(r), clampByte(g), clampByte(b)] as const;
const map3 = (b: RGB, f: (c: number, i: number) => number): RGB => rgb(f(b[0], 0), f(b[1], 1), f(b[2], 2));
const shadeMul = (b: RGB, f: number): RGB => map3(b, (c) => c * f);
const mix = (a: RGB, b: RGB, t: number): RGB =>
  rgb(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
const hex2rgb = (h: number): RGB => rgb((h >> 16) & 255, (h >> 8) & 255, h & 255);

function rgb2hsv(c: RGB): [number, number, number] {
  const r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, mx <= 0 ? 0 : d / mx, mx];
}

function hsv2rgb(h: number, s: number, v: number): RGB {
  h = ((h % 1) + 1) % 1;
  s = Math.max(0, Math.min(1, s));
  v = Math.max(0, Math.min(1, v));
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  const [r, g, b] =
    i % 6 === 0 ? [v, t, p] :
    i % 6 === 1 ? [q, v, p] :
    i % 6 === 2 ? [p, v, t] :
    i % 6 === 3 ? [p, q, v] :
    i % 6 === 4 ? [t, p, v] : [v, p, q];
  return rgb(r * 255, g * 255, b * 255);
}

/** Quantise so the ramp reads as *painted*, not photographic. */
const quantC = (c: RGB, step: number): RGB =>
  step <= 1 ? c : map3(c, (v) => Math.round(v / step) * step);

/** Classic pixel-art ramp: shadows shift cool, highlights shift warm. */
export interface Ramp { sh: RGB; dk: RGB; mid: RGB; lt: RGB; hi: RGB }

function makeRamp(
  base: RGB,
  o: { spread?: number; hueShift?: number; sat?: number; val?: number; quant?: number } = {},
): Ramp {
  const spread = o.spread ?? 1;
  const hs = (o.hueShift ?? 0.035) * spread;
  const q = o.quant ?? 6;
  let [h, s, v] = rgb2hsv(base);
  s = Math.min(1, s * (o.sat ?? 1));
  v = Math.min(1, Math.max(0.06, v * (o.val ?? 1)));
  const step = (dv: number, ds: number, dh: number) =>
    quantC(hsv2rgb(h + dh, Math.min(1, s * ds), Math.min(1, Math.max(0.03, v * dv))), q);
  return {
    sh: step(1 - 0.56 * spread, 1 + 0.20 * spread, -hs * 1.6),
    dk: step(1 - 0.30 * spread, 1 + 0.09 * spread, -hs * 0.7),
    mid: step(1, 1, 0),
    lt: step(1 + 0.17 * spread, 1 - 0.10 * spread, hs * 0.7),
    hi: step(1 + 0.36 * spread, 1 - 0.26 * spread, hs * 1.5),
  };
}

/* ══════════════════════════════════════════════════════════════
   2. Tile16 — scratch surface (inspectable before blit)
   ══════════════════════════════════════════════════════════════ */

class Tile16 {
  readonly d = new Uint8ClampedArray(TILE * TILE * 4); // starts fully transparent

  set(x: number, y: number, c: RGB | null, a = 255): void {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return;
    const i = (y * TILE + x) * 4;
    if (!c || a <= 0) { this.d[i] = this.d[i + 1] = this.d[i + 2] = this.d[i + 3] = 0; return; }
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = a;
  }

  /** wrapped set — keeps motifs seamless across tile edges */
  wset(x: number, y: number, c: RGB | null, a = 255): void { this.set(x & 15, y & 15, c, a); }

  get(x: number, y: number): RGB | null {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return null;
    const i = (y * TILE + x) * 4;
    return this.d[i + 3] === 0 ? null : ([this.d[i], this.d[i + 1], this.d[i + 2]] as const);
  }

  alphaAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= TILE || y >= TILE) return 0;
    return this.d[(y * TILE + x) * 4 + 3];
  }

  fill(fn: (x: number, y: number) => RGB | null, a = 255): void {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) this.set(x, y, fn(x, y), a);
  }

  shade(x: number, y: number, f: number): void {
    const c = this.get(x, y);
    if (c) this.set(x, y, shadeMul(c, f), this.alphaAt(x, y));
  }

  line(x0: number, y0: number, x1: number, y1: number, c: RGB, wrap = false): void {
    let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      wrap ? this.wset(x0, y0, c) : this.set(x0, y0, c);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
  }

  disc(cx: number, cy: number, rad: number, c: RGB): void {
    const r2 = rad * rad;
    for (let y = Math.floor(cy - rad); y <= Math.ceil(cy + rad); y++)
      for (let x = Math.floor(cx - rad); x <= Math.ceil(cx + rad); x++) {
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
  }

  opaqueCount(): number {
    let n = 0;
    for (let i = 3; i < this.d.length; i += 4) if (this.d[i] > 128) n++;
    return n;
  }

  meanLuma(): number {
    let s = 0, n = 0;
    for (let i = 0; i < this.d.length; i += 4)
      if (this.d[i + 3] > 128) { s += 0.299 * this.d[i] + 0.587 * this.d[i + 1] + 0.114 * this.d[i + 2]; n++; }
    return n === 0 ? 0 : s / n;
  }

  mul(f: number): void {
    for (let i = 0; i < this.d.length; i += 4) {
      if (this.d[i + 3] === 0) continue;
      this.d[i] = clampByte(this.d[i] * f);
      this.d[i + 1] = clampByte(this.d[i + 1] * f);
      this.d[i + 2] = clampByte(this.d[i + 2] * f);
    }
  }

  blit(img: ImageData, tile: number): void {
    const ox = (tile % TPR) * TILE, oy = Math.floor(tile / TPR) * TILE;
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const s = (y * TILE + x) * 4, t = ((oy + y) * img.width + ox + x) * 4;
        img.data[t] = this.d[s]; img.data[t + 1] = this.d[s + 1]; img.data[t + 2] = this.d[s + 2]; img.data[t + 3] = this.d[s + 3];
      }
  }
}

function put(d: Uint8ClampedArray, w: number, x: number, y: number, c: RGB, a = 255): void {
  const i = (y * w + x) * 4;
  d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = a;
}

/* ══════════════════════════════════════════════════════════════
   3. deterministic noise
   ══════════════════════════════════════════════════════════════ */

function pixelHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x1b87, 0xc2b2ae35) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const bayer = (x: number, y: number) => BAYER4[((y & 3) << 2) | (x & 3)] / 16;

/** wrapped value noise — `cells` lattice points across the 16px tile ⇒ tiles seamlessly */
function vnoise(x: number, y: number, cells: number, salt: number): number {
  const c = Math.max(1, Math.round(cells));
  const fx = (x * c) / TILE, fy = (y * c) / TILE;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const w = (t: number) => t * t * (3 - 2 * t);
  const sx = w(tx), sy = w(ty);
  const m = (i: number) => ((i % c) + c) % c;
  const a = pixelHash(m(x0), m(y0), salt), b = pixelHash(m(x0 + 1), m(y0), salt);
  const p = pixelHash(m(x0), m(y0 + 1), salt), q = pixelHash(m(x0 + 1), m(y0 + 1), salt);
  const t0 = a + (b - a) * sx, t1 = p + (q - p) * sx;
  return t0 + (t1 - t0) * sy;
}

function fbm(x: number, y: number, cells: number, salt: number, oct = 2): number {
  let v = 0, amp = 1, tot = 0, c = cells;
  for (let i = 0; i < oct; i++) {
    v += vnoise(x, y, c, salt + i * 977) * amp;
    tot += amp;
    amp *= 0.5;
    c *= 2;
  }
  return v / tot;
}

const vary = (base: RGB, amt: number, r: () => number): RGB =>
  map3(base, (c) => c + Math.floor((r() * 2 - 1) * amt));
const varyH = (base: RGB, amt: number, h: number): RGB =>
  map3(base, (c) => c + Math.floor((h * 2 - 1) * amt));

/* ══════════════════════════════════════════════════════════════
   4. per-planet-type motif styles
   ══════════════════════════════════════════════════════════════ */

export type MotifStyle =
  | 'meadow' | 'lush' | 'coastal' | 'arid' | 'dry' | 'frozen' | 'boreal'
  | 'ash' | 'regolith' | 'alien' | 'fungal' | 'crimson';

interface PlanetStyle {
  motif: MotifStyle;
  clump: number; // lattice cells for grass/leaf clumping (low = big blobs)
  tufts: [number, number];
  bladeLen: number;
  pock: number; // dirt holes punched into grass_top
  lip: [number, number]; // grass_side overhang min/max
  drip: number;
  leafHole: number;
  leafClump: number;
  barkDark: number;
  ringJitter: number;
  tallBlades: [number, number];
  frost: number;
  ember: number;
  glowDots: number;
  accentHue: number;
  accentSat: number;
  warmHue: number;
  petal: 'daisy' | 'lupine' | 'orchid' | 'bell' | 'spore' | 'thorn';
  ripple: number;
  cracks: number;
  quant: number;
  spread: number;
}

const S = (o: Partial<PlanetStyle> & { motif: MotifStyle }): PlanetStyle => ({
  clump: 4, tufts: [7, 11], bladeLen: 4, pock: 0.05, lip: [2, 5], drip: 0.35,
  leafHole: 0.15, leafClump: 4, barkDark: 0.28, ringJitter: 0.6, tallBlades: [7, 9],
  frost: 0, ember: 0, glowDots: 0, accentHue: 0.76, accentSat: 0.42, warmHue: 0.13,
  petal: 'daisy', ripple: 0, cracks: 3, quant: 6, spread: 1,
  ...o,
});

const STYLES: Record<PlanetType, PlanetStyle> = {
  terran: S({ motif: 'meadow', clump: 4, tufts: [9, 13], pock: 0.04, lip: [2, 5], accentHue: 0.755, accentSat: 0.40, petal: 'lupine', leafHole: 0.16 }),
  ocean: S({ motif: 'coastal', clump: 3, tufts: [6, 9], lip: [2, 4], accentHue: 0.52, accentSat: 0.34, petal: 'bell', ripple: 0.5, spread: 0.9 }),
  desert: S({ motif: 'arid', clump: 6, tufts: [3, 5], bladeLen: 3, pock: 0.14, lip: [1, 3], drip: 0.1, leafHole: 0.24, accentHue: 0.09, accentSat: 0.55, petal: 'thorn', ripple: 1, cracks: 5, spread: 0.75 }),
  ice: S({ motif: 'frozen', clump: 5, tufts: [4, 7], bladeLen: 3, lip: [3, 5], drip: 0.12, frost: 0.55, accentHue: 0.55, accentSat: 0.30, petal: 'bell', quant: 8, spread: 0.7 }),
  oceanic_ice: S({ motif: 'frozen', clump: 3, tufts: [3, 5], bladeLen: 2, lip: [3, 6], frost: 0.72, accentHue: 0.56, accentSat: 0.26, quant: 9, spread: 0.62 }),
  volcanic: S({ motif: 'ash', clump: 5, tufts: [4, 7], pock: 0.16, lip: [1, 3], drip: 0.1, ember: 0.22, cracks: 6, accentHue: 0.04, accentSat: 0.7, petal: 'thorn', spread: 1.15 }),
  lava: S({ motif: 'ash', clump: 5, tufts: [3, 6], pock: 0.2, lip: [1, 3], drip: 0.08, ember: 0.38, cracks: 7, accentHue: 0.03, accentSat: 0.8, petal: 'thorn', spread: 1.25 }),
  barren: S({ motif: 'regolith', clump: 6, tufts: [2, 4], pock: 0.2, lip: [1, 2], drip: 0.05, cracks: 4, accentSat: 0.12, quant: 8, spread: 0.6 }),
  alien: S({ motif: 'alien', clump: 3, tufts: [8, 12], bladeLen: 5, lip: [3, 6], drip: 0.5, leafHole: 0.2, glowDots: 0.5, accentHue: 0.80, accentSat: 0.62, petal: 'orchid', warmHue: 0.33, spread: 1.1 }),
  jungle: S({ motif: 'lush', clump: 3, tufts: [11, 15], bladeLen: 5, pock: 0.02, lip: [3, 6], drip: 0.6, leafHole: 0.10, leafClump: 3, tallBlades: [8, 11], accentHue: 0.88, accentSat: 0.48, petal: 'orchid', spread: 1.1 }),
  savanna: S({ motif: 'dry', clump: 5, tufts: [6, 9], bladeLen: 5, pock: 0.09, lip: [2, 4], drip: 0.2, leafHole: 0.2, accentHue: 0.11, accentSat: 0.5, petal: 'daisy', tallBlades: [6, 9], ripple: 0.3, spread: 0.85 }),
  tundra: S({ motif: 'boreal', clump: 4, tufts: [5, 8], bladeLen: 3, pock: 0.08, lip: [2, 4], frost: 0.3, accentHue: 0.60, accentSat: 0.22, petal: 'bell', tallBlades: [4, 6], spread: 0.8 }),
  crimson: S({ motif: 'crimson', clump: 4, tufts: [7, 10], bladeLen: 4, pock: 0.1, lip: [2, 5], drip: 0.45, leafHole: 0.18, accentHue: 0.98, accentSat: 0.72, petal: 'thorn', warmHue: 0.03, ember: 0.08, spread: 1.2 }),
  neon: S({ motif: 'fungal', clump: 3, tufts: [8, 12], bladeLen: 5, lip: [2, 5], drip: 0.5, leafHole: 0.13, glowDots: 0.9, accentHue: 0.46, accentSat: 0.85, petal: 'spore', warmHue: 0.86, tallBlades: [8, 12], quant: 5, spread: 1.25 }),
};

/* ══════════════════════════════════════════════════════════════
   5. PlanetPaintContext
   ══════════════════════════════════════════════════════════════ */

const TINT_REF: Record<string, RGB> = {
  grass: [96, 162, 54], dirt: [121, 85, 58], stone: [128, 128, 128], sand: [219, 207, 163],
  leaves: [56, 120, 40], log: [104, 76, 44], planks: [164, 129, 80], snow: [238, 246, 248],
  water: [58, 102, 222], cactus: [62, 138, 56],
};

const GROUP_H: Record<string, number> = {
  grass: 0.14, leaves: 0.22, dirt: 0.08, sand: 0.04, stone: 0.5, log: 0.3, planks: 0.36, water: -0.2, cactus: 0.18,
};

const THEME_KEY: Record<string, string> = { leaves: 'leaf' };

function rampAt(stops: Array<[number, [number, number, number]]>, h: number): RGB {
  let i = 0;
  for (let k = 0; k < stops.length - 1; k++) {
    if (h > stops[k + 1][0]) i = k + 1;
    else break;
  }
  const a = stops[i], b = stops[Math.min(i + 1, stops.length - 1)];
  const span = b[0] - a[0];
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (h - a[0]) / span));
  return rgb(
    (a[1][0] + (b[1][0] - a[1][0]) * t) * 255,
    (a[1][1] + (b[1][1] - a[1][1]) * t) * 255,
    (a[1][2] + (b[1][2] - a[1][2]) * t) * 255,
  );
}

function baseFor(theme: PlanetTheme | null | undefined, group: string): RGB {
  const key = THEME_KEY[group] ?? group;
  const hex = theme?.colors ? (theme.colors as unknown as Record<string, number>)[key] : undefined;
  if (typeof hex === 'number' && hex > 0) return hex2rgb(hex);
  const pal = theme ? PLANET_PALETTES[theme.type] : null;
  if (pal) {
    if (group === 'snow') return rgb(pal.pole[0] * 255, pal.pole[1] * 255, pal.pole[2] * 255);
    return rampAt(pal.stops, GROUP_H[group] ?? 0.12);
  }
  return TINT_REF[group] ?? ([128, 128, 128] as const);
}

export interface PlanetPaintContext {
  type: PlanetType;
  style: PlanetStyle;
  salt: number;
  glow: number;
  grassPresent: boolean;
  flowerPresent: boolean;
  bladeRange: [number, number];
  lava: boolean;
  accent: RGB;
  accent2: RGB;
  warm: RGB;
  pal: Record<'grass' | 'dirt' | 'stone' | 'sand' | 'leaves' | 'log' | 'planks' | 'snow' | 'water' | 'cactus', Ramp>;
}

function saltFromTheme(theme?: PlanetTheme | null): number {
  if (!theme) return 0x1337beef;
  const lo = Number(BigInt.asUintN(32, theme.seed));
  const hi = Number(BigInt.asUintN(32, theme.seed >> 32n));
  const tIdx = Object.keys(STYLES).indexOf(theme.type) + 1;
  return (lo ^ Math.imul(hi, 0x9e3779b1) ^ ((theme.originTag & 0xff) << 16) ^ Math.imul(tIdx, 0x85ebca6b)) >>> 0;
}

export function buildPaintContext(theme?: PlanetTheme | null): PlanetPaintContext {
  const type: PlanetType = theme?.type && STYLES[theme.type] ? theme.type : 'terran';
  const style = STYLES[type];
  const salt = saltFromTheme(theme);
  // small per-planet hue jitter so two terrans are not identical
  const jit = (pixelHash(salt & 255, (salt >> 8) & 255, 0x5eed) - 0.5) * 0.06;
  const ramp = (g: string, o: Parameters<typeof makeRamp>[1] = {}) =>
    makeRamp(baseFor(theme, g), { quant: style.quant, spread: style.spread, ...o });
  const accent = hsv2rgb(style.accentHue + jit, style.accentSat, 0.88);
  const accent2 = hsv2rgb(style.accentHue + 0.07 + jit, style.accentSat * 0.72, 0.99);
  const warm = hsv2rgb(style.warmHue + jit * 0.5, Math.min(1, style.accentSat + 0.34), 0.93);
  return {
    type, style, salt,
    glow: Math.max(theme?.grass?.glow ?? 0, theme?.flower?.glow ?? 0, style.glowDots),
    grassPresent: theme?.grass?.present !== false,
    flowerPresent: theme?.flower?.present !== false,
    bladeRange: (theme?.grass?.blades as [number, number]) ?? style.tallBlades,
    lava: !!theme?.lava,
    accent, accent2, warm,
    pal: {
      grass: ramp('grass', { sat: 1.04 }),
      dirt: ramp('dirt', { hueShift: 0.02 }),
      stone: ramp('stone', { hueShift: 0.02, spread: style.spread * 0.85 }),
      sand: ramp('sand', { spread: style.spread * 0.8 }),
      leaves: ramp('leaves', { sat: 1.06 }),
      log: ramp('log', { hueShift: 0.025 }),
      planks: ramp('planks', { hueShift: 0.025, val: 1.06 }),
      snow: ramp('snow', { hueShift: 0.05, spread: style.spread * 0.55 }),
      water: ramp('water', { hueShift: 0.04 }),
      cactus: ramp('cactus'),
    },
  };
}

/* ══════════════════════════════════════════════════════════════
   6. shared motif helpers
   ══════════════════════════════════════════════════════════════ */

type PPainter = (t: Tile16, r: () => number, c: PlanetPaintContext) => void;

/** 4-tone clumped organic base — the backbone of every natural tile. */
function clumpBase(t: Tile16, P: Ramp, cells: number, salt: number, dith = 0.07): void {
  t.fill((x, y) => {
    const v = fbm(x, y, cells, salt, 2) + (bayer(x, y) - 0.5) * dith;
    if (v < 0.33) return P.dk;
    if (v < 0.52) return P.mid;
    if (v < 0.76) return P.lt;
    return P.hi;
  });
}

function speckle(t: Tile16, r: () => number, col: RGB, n: number, a = 255): void {
  for (let i = 0; i < n; i++) t.set(Math.floor(r() * 16), Math.floor(r() * 16), col, a);
}

function frostPass(t: Tile16, c: PlanetPaintContext, salt: number): void {
  const f = c.style.frost;
  if (f <= 0) return;
  const F = c.pal.snow;
  t.fill((x, y) => {
    const cur = t.get(x, y);
    if (!cur) return null;
    const n = fbm(x, y, 3, salt ^ 0x1ce, 2);
    if (n > 1 - f * 0.8) return F.hi;
    if (n > 1 - f) return mix(cur, F.lt, 0.6);
    if (n > 1 - f * 1.35) return mix(cur, F.mid, 0.25);
    return cur;
  });
}

function emberPass(t: Tile16, r: () => number, c: PlanetPaintContext): void {
  const e = c.style.ember + (c.lava ? 0.06 : 0);
  if (e <= 0) return;
  const hot = hsv2rgb(0.045, 0.95, 1.0), warmC = hsv2rgb(0.02, 1.0, 0.62);
  const n = Math.round(e * 22);
  for (let i = 0; i < n; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    t.set(x, y, r() < 0.35 ? hot : warmC);
    if (r() < 0.4) t.set(x + 1, y, warmC);
  }
}

function glowPass(t: Tile16, r: () => number, c: PlanetPaintContext, n = 6): void {
  if (c.style.glowDots <= 0) return;
  const k = Math.round(n * c.style.glowDots);
  for (let i = 0; i < k; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    if (t.alphaAt(x, y) === 0) continue;
    t.set(x, y, c.accent2);
    if (r() < 0.5) t.set(x, y + 1, c.accent);
  }
}

function paintStoneBase(t: Tile16, r: () => number, c: PlanetPaintContext, f = 1): void {
  const P = c.pal.stone;
  clumpBase(t, P, 3, c.salt ^ 0x570e, 0.05);
  // crack walkers
  for (let w = 0; w < c.style.cracks; w++) {
    let x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    const steps = 5 + Math.floor(r() * 8);
    for (let s = 0; s < steps; s++) {
      t.wset(x, y, P.sh);
      if (r() < 0.3) t.wset(x + 1, y, P.dk);
      if (r() < 0.5) x += r() < 0.5 ? -1 : 1;
      else y += r() < 0.5 ? -1 : 1;
    }
  }
  speckle(t, r, P.hi, 5);
  if (f !== 1) t.mul(f);
}

/* ══════════════════════════════════════════════════════════════
   7. planet-aware organic painters
   ══════════════════════════════════════════════════════════════ */

const paintGrassTop: PPainter = (t, r, c) => {
  const st = c.style;
  const P = c.pal.grass;
  clumpBase(t, P, st.clump, c.salt ^ 0x9a55, 0.08);
  // blade streaks — wrapped so tiles butt seamlessly
  const n = st.tufts[0] + Math.floor(r() * (st.tufts[1] - st.tufts[0] + 1));
  for (let i = 0; i < n; i++) {
    const bx = Math.floor(r() * 16), by = Math.floor(r() * 16);
    const len = 2 + Math.floor(r() * st.bladeLen);
    const dx = r() < 0.5 ? -1 : 1;
    const col = r() < 0.6 ? P.hi : P.lt;
    for (let k = 0; k < len; k++) {
      t.wset(bx + ((dx * k) >> 1), by - k, col);
      if (k === len - 1 && r() < 0.4) t.wset(bx + ((dx * k) >> 1) + dx, by - k, P.lt);
    }
    t.wset(bx - dx, by + 1, P.dk); // contact shadow → hand-drawn weight
  }
  // dirt pocks
  const pk = Math.round(st.pock * 40);
  for (let i = 0; i < pk; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    const D = c.pal.dirt;
    t.wset(x, y, D.dk);
    if (r() < 0.5) t.wset(x + 1, y, D.mid);
    if (r() < 0.35) t.wset(x, y + 1, D.sh);
  }

  // motif accents
  switch (st.motif) {
    case 'meadow': speckle(t, r, c.accent, 4); speckle(t, r, c.warm, 2); break;
    case 'lush': speckle(t, r, c.accent, 3); speckle(t, r, P.sh, 6); break;
    case 'dry': for (let i = 0; i < 10; i++) t.wset(Math.floor(r() * 16), Math.floor(r() * 16), c.warm); break;
    case 'alien': for (let i = 0; i < 3; i++) {
        const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
        t.disc(x, y, 1.4, mix(P.mid, c.accent, 0.55)); t.set(x, y, c.accent2);
      } break;
    case 'fungal': for (let i = 0; i < 5; i++) {
        const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
        t.set(x, y, c.accent2); t.set(x + 1, y, c.accent); t.set(x, y + 1, c.accent);
      } break;
    case 'crimson': for (let i = 0; i < 7; i++) {
        const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
        t.wset(x, y, P.sh); t.wset(x, y - 1, c.accent);
      } break;
    case 'regolith': case 'ash': speckle(t, r, c.pal.stone.dk, 12); break;
    default: break;
  }
  frostPass(t, c, c.salt ^ 0x3f);
  emberPass(t, r, c);
  glowPass(t, r, c, 5);
};

const paintGrassSide: PPainter = (t, r, c) => {
  const G = c.pal.grass, D = c.pal.dirt, st = c.style;
  // dirt body
  clumpBase(t, D, 4, c.salt ^ 0xd127, 0.06);
  for (let i = 0; i < 7; i++) { // pebbles
    const x = Math.floor(r() * 15), y = 4 + Math.floor(r() * 11);
    t.set(x, y, D.lt); t.set(x + 1, y, D.mid); t.set(x, y + 1, D.sh);
  }
  speckle(t, r, D.sh, 9);

  // jagged grass overhang
  const [lo, hi] = st.lip;
  const edge: number[] = [];
  let e = lo + Math.floor(r() * (hi - lo + 1));
  for (let x = 0; x < TILE; x++) {
    e += r() < 0.42 ? (r() < 0.5 ? -1 : 1) : 0;
    edge[x] = Math.max(lo, Math.min(hi, e));
  }
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < edge[x]; y++) {
      const v = fbm(x, y, st.clump, c.salt ^ 0x9a55, 2);
      t.set(x, y, y === 0 ? (v > 0.5 ? G.hi : G.lt) : v < 0.4 ? G.dk : v < 0.68 ? G.mid : G.lt);
    }
    // drips of grass hanging past the lip
    if (r() < st.drip) { t.set(x, edge[x], G.dk); if (r() < 0.35) t.set(x, edge[x] + 1, G.sh); }
    // contact shadow under the lip
    else t.shade(x, edge[x], 0.82);
  }
  frostPass(t, c, c.salt ^ 0x3f);
  emberPass(t, r, c);
  glowPass(t, r, c, 3);
};

const paintDirt: PPainter = (t, r, c) => {
  const D = c.pal.dirt;
  clumpBase(t, D, 4, c.salt ^ 0xd127, 0.09);
  for (let i = 0; i < 9; i++) { // pebbles w/ highlight + drop shadow
    const x = Math.floor(r() * 15), y = Math.floor(r() * 15);
    t.set(x, y, D.lt); t.set(x + 1, y, D.mid); t.set(x, y + 1, D.sh); t.set(x + 1, y + 1, D.dk);
  }
  speckle(t, r, D.sh, 14);
  speckle(t, r, D.hi, 4);
  if (c.style.motif === 'ash' || c.lava) emberPass(t, r, c);
  frostPass(t, c, c.salt ^ 0x77);
};

const paintStone: PPainter = (t, r, c) => paintStoneBase(t, r, c);

const paintCobble: PPainter = (t, r, c) => {
  const P = c.pal.stone;
  t.fill((x, y) => {
    const row = (y / 5) | 0;
    const cell = ((x + (row % 2) * 3) / 5) | 0;
    if (x % 5 === 4 || y % 5 === 4) return P.sh;
    const tone = (cell + row + ((c.salt >> (row & 7)) & 1)) % 3;
    return varyH(tone === 0 ? P.lt : tone === 1 ? P.mid : P.dk, 9, pixelHash(x, y, c.salt));
  });
  speckle(t, r, P.hi, 6);
  speckle(t, r, P.sh, 6);
};

const paintGravel: PPainter = (t, r, c) => {
  const P = c.pal.stone;
  const tones = [P.mid, P.lt, P.dk, P.hi];
  t.fill((x, y) => {
    const i = Math.floor(vnoise(x, y, 8, c.salt ^ 0x9ab) * tones.length) % tones.length;
    return varyH(tones[i], 8, pixelHash(x, y, c.salt ^ 3));
  });
  speckle(t, r, P.sh, 18);
};

const paintSand: PPainter = (t, r, c) => {
  const P = c.pal.sand, st = c.style;
  t.fill((x, y) => {
    let v = fbm(x, y, 5, c.salt ^ 0x5a4d, 2) + (bayer(x, y) - 0.5) * 0.1;
    if (st.ripple > 0) v += Math.sin((x * 0.8 + y * 2.1 + (c.salt & 7)) * 0.9) * 0.12 * st.ripple;
    return v < 0.36 ? P.dk : v < 0.58 ? P.mid : v < 0.82 ? P.lt : P.hi;
  });
  speckle(t, r, P.sh, 6);
  frostPass(t, c, c.salt ^ 0xa1);
};

const paintLeaves: PPainter = (t, r, c) => {
  const P = c.pal.leaves, st = c.style;
  t.fill((x, y) => {
    const n = fbm(x, y, st.leafClump, c.salt ^ 0x1eaf, 2);
    const h = pixelHash(x, y, c.salt ^ 0x40e1);
    // holes cluster at the low-density edges → reads like a canopy, not static
    if (n < 0.30 + st.leafHole * 0.6 && h < 0.55 + st.leafHole) return null;
    if (h < 0.05) return null;
    return n < 0.42 ? P.dk : n < 0.6 ? P.mid : n < 0.82 ? P.lt : P.hi;
  });
  // veins / darker leaf seams
  for (let i = 0; i < 5; i++) {
    const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
    if (t.alphaAt(x, y)) { t.set(x, y, P.sh); if (t.alphaAt(x + 1, y + 1)) t.set(x + 1, y + 1, P.sh); }
  }
  // berries / spores / frost
  if (st.motif === 'lush' || st.motif === 'meadow' || st.motif === 'alien')
    for (let i = 0; i < 3; i++) {
      const x = Math.floor(r() * 16), y = Math.floor(r() * 16);
      if (t.alphaAt(x, y)) t.set(x, y, c.accent);
    }
  frostPass(t, c, c.salt ^ 0xb2);
  glowPass(t, r, c, 6);
};

const paintLogSide: PPainter = (t, r, c) => {
  const P = c.pal.log, st = c.style;
  const cols: RGB[] = [];
  for (let x = 0; x < TILE; x++) {
    const v = vnoise(x, 0, 6, c.salt ^ 0x109);
    cols[x] = x % 4 === 0 || v < st.barkDark ? P.dk : v > 0.78 ? P.lt : P.mid;
  }
  t.fill((x, y) => varyH(cols[x], 7, pixelHash(x, y, c.salt ^ 0x10)));
  // bark cracks
  for (let i = 0; i < 4; i++) {
    let x = Math.floor(r() * 16);
    const y0 = Math.floor(r() * 10);
    for (let y = y0; y < y0 + 4 + Math.floor(r() * 6); y++) {
      t.wset(x, y, P.sh);
      if (r() < 0.25) x += r() < 0.5 ? -1 : 1;
    }
  }
  // knot
  if (r() < 0.55) {
    const kx = 3 + Math.floor(r() * 10), ky = 3 + Math.floor(r() * 10);
    t.disc(kx, ky, 2.2, P.dk); t.disc(kx, ky, 1.2, P.sh); t.set(kx, ky, P.lt);
  }
  glowPass(t, r, c, 3);
};

const paintLogTop: PPainter = (t, r, c) => {
  const P = c.pal.log, st = c.style;
  t.fill((x, y) => {
    const dx = x - 7.5, dy = y - 7.5;
    const d = Math.sqrt(dx * dx + dy * dy) + (vnoise(x, y, 4, c.salt ^ 0x71) - 0.5) * st.ringJitter * 2;
    if (Math.max(Math.abs(dx), Math.abs(dy)) > 6.6) return P.dk; // bark rim
    if (d < 1.2) return P.sh;
    return Math.floor(d) % 2 === 0 ? P.lt : P.mid;
  });
  speckle(t, r, P.hi, 3);
};

const paintPlanks: PPainter = (t, r, c) => {
  const P = c.pal.planks;
  t.fill((x, y) => {
    if (y % 4 === 3) return P.dk;
    const joint = Math.floor(y / 4) % 2 === 0 ? x === 11 : x === 4;
    if (joint) return P.dk;
    const g = vnoise(x, y, 6, c.salt ^ 0x9146);
    return g < 0.33 ? P.mid : g > 0.8 ? P.hi : P.lt;
  });
  speckle(t, r, P.sh, 5);
};

/** never returns an empty tile — see also guardTile() */
const paintTallgrass: PPainter = (t, r, c) => {
  const P = c.pal.grass, st = c.style;
  const [b0, b1] = c.bladeRange;
  const n = Math.max(5, Math.min(12, b0 + Math.floor(r() * Math.max(1, b1 - b0 + 1))));
  for (let i = 0; i < n; i++) {
    const bx = 1 + Math.floor(r() * 14);
    const h = 7 + Math.floor(r() * 8);
    const lean = r() < 0.5 ? -1 : 1;
    const curve = st.motif === 'crimson' || st.motif === 'frozen' ? 0 : 1;
    const tip = r() < 0.5 ? P.hi : P.lt;
    for (let k = 0; k < h; k++) {
      const y = TILE - 1 - k;
      const x = bx + (curve ? Math.floor((k / h) * 2.4) * lean : 0);
      const col = k > h - 3 ? tip : k < 3 ? P.dk : P.mid;
      t.set(x, y, col);
      // thicken the lower third so alphaTest 0.4 keeps real coverage
      if (k < Math.floor(h * 0.45)) t.set(x + lean, y, k < 2 ? P.sh : P.dk);
    }
    if (st.glowDots > 0 && r() < 0.6) t.set(bx, TILE - h, c.accent2);
  }
  // guaranteed tuft base
  for (let x = 3; x <= 12; x++) {
    const hgt = 1 + Math.floor(vnoise(x, 0, 5, c.salt ^ 0x7a11) * 3);
    for (let k = 0; k < hgt; k++) t.set(x, TILE - 1 - k, k === 0 ? P.sh : P.dk);
  }
  frostPass(t, c, c.salt ^ 0xcc);
};

function paintFlower(t: Tile16, r: () => number, c: PlanetPaintContext, petal: RGB, core: RGB): void {
  const G = c.pal.grass, st = c.style;
  // stem + leaves
  for (let y = 6; y < TILE; y++) { t.set(7, y, G.mid); t.set(8, y, G.dk); }
  t.set(6, 9, G.dk); t.set(5, 10, G.dk); t.set(9, 8, G.mid); t.set(10, 9, G.dk);
  for (let x = 5; x <= 10; x++) t.set(x, 15, G.sh); // ground contact

  const px = 7.5, py = 4;
  const light = mix(petal, [255, 255, 255] as const, 0.3);
  const dark = shadeMul(petal, 0.68);

  switch (st.petal) {
    case 'lupine': // stacked spike of blooms — reference meadow look
      for (let k = 0; k < 5; k++) {
        const y = 1 + k * 1.4, w = 1 + k * 0.35;
        t.disc(px, y, w, k % 2 ? petal : light);
      }
      t.set(7, 0, light); t.set(8, 1, dark);
      break;
    case 'orchid':
      t.disc(px, py, 2.6, petal);
      t.disc(px - 1, py - 1, 1.2, light);
      t.set(6, 6, dark); t.set(9, 6, dark);
      t.disc(px, py, 0.9, core);
      break;
    case 'bell':
      for (let y = 2; y <= 6; y++) for (let x = 6; x <= 9; x++)
        if (!(y === 2 && (x === 6 || x === 9))) t.set(x, y, y > 5 ? dark : x < 8 ? light : petal);
      t.set(7, 7, core); t.set(8, 7, core);
      break;
    case 'spore':
      t.disc(px, py, 2.8, petal);
      t.disc(px, py - 0.8, 1.6, light);
      for (let i = 0; i < 6; i++) t.set(Math.floor(r() * 10) + 3, Math.floor(r() * 6), c.accent2);
      break;
    case 'thorn':
      t.line(7, 6, 4, 1, petal); t.line(8, 6, 11, 1, petal);
      t.line(7, 6, 7, 0, light); t.set(7, 5, dark); t.set(8, 5, core);
      break;
    default: // daisy
      t.disc(px, py, 2.4, petal);
      t.set(6, 2, light); t.set(9, 2, light); t.set(6, 5, dark); t.set(9, 5, dark);
      t.disc(px, py, 0.9, core);
      break;
  }
  if (st.glowDots > 0) { t.set(7, 3, c.accent2); t.set(8, 4, c.accent2); }
}

const paintFlowerRed: PPainter = (t, r, c) => {
  // lush worlds bias to lavender/lilac; crimson keeps true red
  const petal =
    c.style.motif === 'crimson' || c.style.motif === 'ash' ? hsv2rgb(0.99, 0.78, 0.82)
    : c.style.motif === 'meadow' ? mix(c.accent, hsv2rgb(0.75, 0.38, 0.9), 0.5)
    : c.accent;
  paintFlower(t, r, c, petal, mix(c.warm, [255, 240, 170] as const, 0.5));
};

const paintFlowerYellow: PPainter = (t, r, c) =>
  paintFlower(t, r, c, c.warm, shadeMul(c.warm, 0.6));

const paintSnow: PPainter = (t, r, c) => {
  const P = c.pal.snow;
  t.fill((x, y) => {
    const v = fbm(x, y, 4, c.salt ^ 0x5000, 2) + (bayer(x, y) - 0.5) * 0.08;
    return v < 0.38 ? P.mid : v < 0.72 ? P.lt : P.hi;
  });
  speckle(t, r, P.dk, 5);
  speckle(t, r, [255, 255, 255] as const, 3);
};

const paintSnowSide: PPainter = (t, r, c) => {
  const S2 = c.pal.snow, D = c.pal.dirt;
  clumpBase(t, D, 4, c.salt ^ 0xd127, 0.06);
  const edge: number[] = [];
  let e = 3;
  for (let x = 0; x < TILE; x++) { e += r() < 0.4 ? (r() < 0.5 ? -1 : 1) : 0; edge[x] = Math.max(2, Math.min(6, e)); }
  for (let x = 0; x < TILE; x++) {
    for (let y = 0; y < edge[x]; y++) t.set(x, y, y === 0 ? S2.hi : y < 2 ? S2.lt : S2.mid);
    if (r() < 0.3) t.set(x, edge[x], S2.dk); else t.shade(x, edge[x], 0.85);
  }
};

const paintWaterTile: PPainter = (t, r, c) => {
  const P = c.pal.water;
  t.fill((x, y) => {
    const w = Math.sin((x + y * 3 + (c.salt & 15)) * 0.6) + vnoise(x, y, 4, c.salt ^ 0x2a) * 1.2;
    return w > 1.15 ? P.hi : w > 0.7 ? P.lt : w < -0.5 ? P.dk : P.mid;
  });
  speckle(t, r, P.hi, 4);
};

const paintCactusSide: PPainter = (t, r, c) => {
  const P = c.pal.cactus;
  t.fill((x, y) => (x % 4 === 1 ? P.dk : varyH(P.mid, 7, pixelHash(x, y, c.salt))));
  speckle(t, r, P.hi, 7);
  speckle(t, r, c.accent, 2);
};
const paintCactusTop: PPainter = (t, _r, c) => {
  const P = c.pal.cactus;
  t.fill((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return P.dk;
    if (x === 7 || x === 8 || y === 7 || y === 8) return P.mid;
    return varyH(P.lt, 6, pixelHash(x, y, c.salt ^ 9));
  });
};

const paintBedrock: PPainter = (t, r, c) => {
  const P = c.pal.stone;
  t.fill((x, y) => {
    const v = fbm(x, y, 6, c.salt ^ 0xbed, 2);
    return v < 0.35 ? shadeMul(P.sh, 0.6) : v < 0.7 ? shadeMul(P.dk, 0.7) : shadeMul(P.mid, 0.7);
  });
  speckle(t, r, shadeMul(P.sh, 0.4), 12);
};

const paintGlass: PPainter = (t, _r, c) => {
  const tintC = mix([206, 232, 245] as const, c.pal.water.lt, 0.28);
  t.fill((x, y) => {
    const border = x === 0 || y === 0 || x === 15 || y === 15;
    if (border) return tintC;
    if (x === y + 6 || x === y + 7 || (x < 6 && x === y - 3)) return mix(tintC, [255, 255, 255] as const, 0.5);
    return null;
  });
};

/* ══════════════════════════════════════════════════════════════
   8. machines / ores / items  (universal, lightly planet-graded)
   ══════════════════════════════════════════════════════════════ */

function paintBeltTop(img: ImageData, tile: number, rot: number, phase: number): void {
  const t = new Tile16();
  const N = TILE;
  t.fill((px, py) => {
    let x = px, y = py;
    if (rot === 1) { x = py; y = N - 1 - px; }
    else if (rot === 2) { x = N - 1 - px; y = N - 1 - py; }
    else if (rot === 3) { x = N - 1 - py; y = px; }
    if (y === 0 || y === N - 1) return varyH([44, 44, 50], 5, pixelHash(x, y, 11));
    if (y === 1 || y === N - 2) return varyH([88, 88, 96], 7, pixelHash(x, y, 12));
    const wx = (((x - phase) % N) + N) % N;
    if (wx % 4 === 0) return varyH([50, 50, 56], 6, pixelHash(wx, y, 13));
    const dx = (wx % 8) - 5;
    if (dx >= -2 && dx <= 0) {
      const spread = -dx, off = Math.abs(y - 7.5);
      if (off >= spread - 0.5 && off <= spread + 1.5) return varyH([226, 146, 34], 12, pixelHash(wx, y, 14));
    }
    return varyH([74, 74, 80], 9, pixelHash(wx, y, 15));
  });
  t.blit(img, tile);
}

function paintInserterTop(t: Tile16, rot: number, r: () => number): void {
  const N = TILE;
  t.fill((px, py) => {
    let x = px, y = py;
    if (rot === 1) { x = py; y = N - 1 - px; }
    else if (rot === 2) { x = N - 1 - px; y = N - 1 - py; }
    else if (rot === 3) { x = N - 1 - py; y = px; }
    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) return vary([36, 36, 42], 5, r);
    if (x === 1 || y === 1 || x === N - 2 || y === N - 2) return vary([60, 60, 68], 7, r);
    const dx = x - 7.5, dz = y - 7.5, d = Math.sqrt(dx * dx + dz * dz);
    if (d < 2.2) return vary([28, 28, 32], 4, r);
    if (d < 3.4) return vary([98, 98, 106], 8, r);
    if (x >= 10 && x <= 13 && Math.abs(y - 7.5) <= x - 10 + 1 && Math.abs(y - 7.5) > x - 10 - 1)
      return vary([226, 146, 34], 10, r);
    return vary([72, 72, 80], 9, r);
  });
}

/** ores inherit the planet stone matrix, then overlay a universal crystal motif */
function oreTile(gem: [RGB, RGB], mod: [number, number, number]): PPainter {
  return (t, r, c) => {
    paintStoneBase(t, r, c, 0.94);
    for (let y = 0; y < TILE; y++)
      for (let x = 0; x < TILE; x++) {
        const isC = (x * mod[0] + y * mod[1]) % mod[2] < 3 && pixelHash(x, y, c.salt ^ 0x0ea1) < 0.5;
        if (!isC) continue;
        const bright = r() < 0.35;
        t.set(x, y, bright ? gem[0] : gem[1]);
        if (bright && r() < 0.4) t.set(x, y + 1, shadeMul(gem[1], 0.75));
      }
  };
}

/* ══════════════════════════════════════════════════════════════
   9. painter registry
   ══════════════════════════════════════════════════════════════ */

const PAINTERS: Partial<Record<TileName, PPainter>> = {
  grass_top: paintGrassTop, grass_side: paintGrassSide, dirt: paintDirt, stone: paintStone,
  cobble: paintCobble, gravel: paintGravel, sand: paintSand, leaves: paintLeaves,
  log_side: paintLogSide, log_top: paintLogTop, planks: paintPlanks, tallgrass: paintTallgrass,
  flower_red: paintFlowerRed, flower_yellow: paintFlowerYellow, snow: paintSnow, snow_side: paintSnowSide,
  water: paintWaterTile, cactus_side: paintCactusSide, cactus_top: paintCactusTop, bedrock: paintBedrock,
  glass: paintGlass,
  craft_top: (t, r, c) => {
    const P = c.pal.planks;
    t.fill((x, y) => {
      if (x === 0 || y === 0 || x === 15 || y === 15) return P.dk;
      if (x === 7 || x === 8 || y === 7 || y === 8) return P.sh;
      return varyH(P.lt, 9, pixelHash(x, y, c.salt));
    });
    speckle(t, r, P.hi, 4);
  },
  craft_side: (t, r, c) => {
    const P = c.pal.planks;
    t.fill((x, y) => {
      if (y < 2) return P.mid;
      if (y >= 4 && y <= 9 && x >= 4 && x <= 11) return y === 4 || y === 9 || x === 4 || x === 11 ? P.sh : P.mid;
      return x % 4 === 0 ? P.dk : varyH(P.lt, 9, pixelHash(x, y, c.salt ^ 1));
    });
    speckle(t, r, P.sh, 4);
  },
  craft_bottom: (t, _r, c) => {
    const P = c.pal.planks;
    t.fill((x, y) => (y % 4 === 3 ? P.dk : varyH(P.mid, 9, pixelHash(x, y, c.salt ^ 2))));
  },
  furnace_top: (t, r, c) => {
    paintStoneBase(t, r, c, 0.98);
    t.fill((x, y) => {
      if (x === 0 || y === 0 || x === 15 || y === 15) return c.pal.stone.dk;
      if (x >= 5 && x <= 10 && y >= 5 && y <= 10) return c.pal.stone.sh;
      return t.get(x, y);
    });
  },
  furnace_side: (t, r, c) => paintStoneBase(t, r, c, 0.96),
  furnace_front: (t, r, c) => {
    paintStoneBase(t, r, c, 0.96);
    t.fill((x, y) => {
      if (x === 0 || y === 0 || x === 15 || y === 15) return c.pal.stone.dk;
      if (x >= 3 && x <= 12) {
        if (y >= 4 && y <= 6) return shadeMul(c.pal.stone.sh, 0.8);
        if (y >= 7 && y <= 11) return [22, 22, 24] as const;
        if (y === 12) return c.pal.stone.dk;
      }
      return t.get(x, y);
    });
  },
  furnace_front_lit: (t, r, c) => {
    paintStoneBase(t, r, c, 0.96);
    t.fill((x, y) => {
      if (x === 0 || y === 0 || x === 15 || y === 15) return c.pal.stone.dk;
      if (x >= 3 && x <= 12) {
        if (y >= 4 && y <= 6) return shadeMul(c.pal.stone.sh, 0.8);
        if (y >= 7 && y <= 11) {
          const h = 11 - y, flame = (x * 7 + h * 3) % 5;
          if (h >= 3) return flame < 2 ? ([255, 214, 92] as const) : ([28, 24, 22] as const);
          if (h === 2) return flame < 3 ? ([255, 160, 40] as const) : ([120, 40, 16] as const);
          return [228, 88, 24] as const;
        }
        if (y === 12) return c.pal.stone.dk;
      }
      return t.get(x, y);
    });
  },
  ore_ruby: oreTile([[255, 80, 90], [180, 30, 40]], [3, 7, 11]),
  ore_amber: oreTile([[255, 200, 60], [200, 140, 30]], [5, 3, 9]),
  ore_luminescence: oreTile([[140, 255, 220], [60, 180, 150]], [7, 5, 10]),
  ore_diamond: oreTile([[180, 240, 255], [80, 180, 220]], [4, 6, 10]),
  ore_gold: oreTile([[255, 220, 80], [200, 160, 40]], [6, 4, 8]),
  ore_silver: oreTile([[230, 235, 240], [170, 175, 180]], [5, 7, 9]),
  ore_jade: oreTile([[140, 220, 160], [70, 150, 90]], [4, 5, 9]),
  ore_emerald: oreTile([[80, 255, 120], [30, 160, 80]], [6, 4, 10]),
  coal_ore: oreTile([[64, 64, 68], [26, 26, 30]], [5, 3, 9]),
  coal: (t, r) => t.fill((x, y) => {
    const dx = x - 8, dy = y - 8, d = Math.sqrt(dx * dx + dy * dy);
    if (d > 6.2) return null;
    if (d < 2.2 && r() < 0.6) return vary([70, 70, 76], 12, r);
    return vary([28, 28, 32], 10, r);
  }),
  stick: (t, r) => t.fill((x, y) => {
    const k = Math.abs(x - (15 - y));
    if (k <= 1) return vary([138, 100, 58], 14, r);
    if (k === 2) return vary([96, 68, 38], 10, r);
    return null;
  }),
  torch: (t) => t.fill((x, y) => {
    const cx = x >= 6 && x <= 9;
    if (cx && y >= 6) return y === 6 ? ([120, 88, 50] as const) : x === 6 ? ([96, 68, 38] as const) : x === 9 ? ([80, 56, 32] as const) : ([138, 100, 58] as const);
    if (cx && y >= 4 && y <= 5) return [40, 30, 24] as const;
    const fx = x - 7.5, fy = y - 2, df = Math.sqrt(fx * fx + fy * fy * 0.6);
    if (y <= 5) {
      if (df < 1.3) return [255, 246, 200] as const;
      if (df < 2.4) return [255, 200, 70] as const;
      if (df < 3.4) return [240, 130, 30] as const;
    }
    return null;
  }),
  conveyor_side: (t, r) => t.fill((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return vary([42, 42, 48], 5, r);
    if (y >= 5 && y <= 10 && (x <= 4 || x >= 11)) {
      const cx = x <= 4 ? 2.5 : 13.5, dx = x - cx, dy = y - 7.5;
      if (dx * dx + dy * dy < 5) return vary([100, 100, 106], 8, r);
    }
    if (y >= 3 && y <= 5) return vary([58, 58, 64], 6, r);
    return vary([66, 66, 72], 8, r);
  }),
  inserter_top_n: (t, r) => paintInserterTop(t, 0, r),
  inserter_top_e: (t, r) => paintInserterTop(t, 1, r),
  inserter_top_s: (t, r) => paintInserterTop(t, 2, r),
  inserter_top_w: (t, r) => paintInserterTop(t, 3, r),
  inserter_side: (t, r) => t.fill((x, y) => {
    if (x === 0 || y === 0 || x === 15 || y === 15) return vary([40, 40, 46], 5, r);
    if (x >= 5 && x <= 10 && y >= 2) {
      if (x === 5 || x === 10) return vary([100, 100, 108], 8, r);
      if (y === 8 || y === 9) return vary([226, 146, 34], 10, r);
      return vary([62, 62, 70], 8, r);
    }
    if (y >= 12 && y <= 14 && x % 3 !== 0) return vary([30, 30, 34], 4, r);
    return vary([56, 56, 62], 8, r);
  }),
};

/* ══════════════════════════════════════════════════════════════
   10. GUARDS — the blank-grass killer
   ══════════════════════════════════════════════════════════════ */

const MIN_PX = { tallgrass: 34, flower: 22, leaves: 140 } as const;
const MIN_LUMA = { grass: 34, cutout: 30 } as const;

function fillHoles(t: Tile16, col: RGB): void {
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) if (t.alphaAt(x, y) < 255) t.set(x, y, col);
}

function fallbackTuft(t: Tile16, c: PlanetPaintContext): void {
  const P = c.pal.grass;
  const H = [9, 12, 7, 14, 10, 13, 8, 11, 9];
  for (let i = 0; i < H.length; i++) {
    const x = 3 + i;
    for (let k = 0; k < H[i]; k++) {
      const y = TILE - 1 - k;
      t.set(x, y, k > H[i] - 3 ? P.hi : k < 3 ? P.dk : P.mid);
      if (k < 4) t.set(x, y, P.dk);
    }
  }
  for (let x = 2; x <= 13; x++) t.set(x, 15, P.sh);
}

function guardTile(name: TileName, t: Tile16, _r: () => number, c: PlanetPaintContext): void {
  switch (name) {
    case 'grass_top':
      fillHoles(t, c.pal.grass.mid);
      if (t.meanLuma() < MIN_LUMA.grass) t.mul(MIN_LUMA.grass / Math.max(1, t.meanLuma()));
      break;
    case 'grass_side': case 'dirt': case 'stone': case 'sand': case 'snow': case 'snow_side':
    case 'cobble': case 'gravel': case 'planks': case 'log_side': case 'log_top': case 'water': case 'bedrock':
      fillHoles(t, c.pal.dirt.mid);
      break;
    case 'tallgrass':
      if (t.opaqueCount() < MIN_PX.tallgrass) fallbackTuft(t, c);
      if (t.meanLuma() < MIN_LUMA.cutout) t.mul(MIN_LUMA.cutout / Math.max(1, t.meanLuma()));
      break;
    case 'flower_red': case 'flower_yellow':
      if (t.opaqueCount() < MIN_PX.flower) {
        const P = c.pal.grass;
        for (let y = 6; y < TILE; y++) t.set(7, y, P.mid);
        t.disc(7.5, 4, 2.4, name === 'flower_red' ? c.accent : c.warm);
      }
      break;
    case 'leaves':
      if (t.opaqueCount() < MIN_PX.leaves) {
        const L = c.pal.leaves;
        for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++)
          if (t.alphaAt(x, y) === 0 && pixelHash(x, y, c.salt ^ 0xfeed) > 0.35) t.set(x, y, ((x + y) & 1) === 0 ? L.mid : L.dk);
      }
      break;
    default: break;
  }
}

/* ══════════════════════════════════════════════════════════════
   11. legacy tint API (kept for blocks.ts vertex colours)
   ══════════════════════════════════════════════════════════════ */

export type TintMap = Record<string, RGB>;
const TINT_STRENGTH = 0.28; // ↓ from 0.85 — textures now carry identity
const clampMul = (v: number) => Math.max(0.35, Math.min(1.9, v));

export function tintsFromTheme(theme?: PlanetTheme | null): TintMap | null {
  if (!theme || !PLANET_PALETTES[theme.type]) return null;
  const out: TintMap = {};
  for (const g of Object.keys(TINT_REF)) {
    const ref = TINT_REF[g], tgt = baseFor(theme, g); // both 0..255 now — bug fixed
    const m: number[] = [];
    for (let k = 0; k < 3; k++) {
      const raw = clampMul(tgt[k] / Math.max(1, ref[k]));
      m[k] = 1 + (raw - 1) * TINT_STRENGTH;
    }
    if (theme.lava && (g === 'stone' || g === 'dirt')) { m[0] *= 1.1; m[1] *= 0.95; m[2] *= 0.88; }
    out[g] = [m[0], m[1], m[2]] as const;
  }
  return out;
}

const MACHINE_GRADE = 0.22;
const MACHINE_TILES: TileName[] = [
  'furnace_front', 'furnace_front_lit', 'furnace_side', 'furnace_top',
  'conveyor_top_n', 'conveyor_top_e', 'conveyor_top_s', 'conveyor_top_w', 'conveyor_side',
  'inserter_top_n', 'inserter_top_e', 'inserter_top_s', 'inserter_top_w', 'inserter_side',
];

function tintTile(img: ImageData, tile: number, m: RGB): void {
  if (m[0] === 1 && m[1] === 1 && m[2] === 1) return;
  const ox = (tile % TPR) * TILE, oy = Math.floor(tile / TPR) * TILE;
  const d = img.data;
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const i = ((oy + y) * img.width + ox + x) * 4;
      if (d[i + 3] === 0) continue;
      d[i] = clampByte(d[i] * m[0]); d[i + 1] = clampByte(d[i + 1] * m[1]); d[i + 2] = clampByte(d[i + 2] * m[2]);
    }
}

/* ══════════════════════════════════════════════════════════════
   12. conveyor animation (unchanged public API)
   ══════════════════════════════════════════════════════════════ */

const BELT_ANIM_PX_PER_SEC = 20;
let beltPhase = -1;

export function animateConveyorTiles(set: TextureSet, time: number): void {
  const phase = Math.floor(time * BELT_ANIM_PX_PER_SEC) % TILE;
  if (phase === beltPhase) return;
  beltPhase = phase;
  const img = set.atlasImg;
  paintBeltTop(img, TILES.conveyor_top_n, 0, phase);
  paintBeltTop(img, TILES.conveyor_top_e, 1, phase);
  paintBeltTop(img, TILES.conveyor_top_s, 2, phase);
  paintBeltTop(img, TILES.conveyor_top_w, 3, phase);
  const tiles = [TILES.conveyor_top_n, TILES.conveyor_top_e, TILES.conveyor_top_s, TILES.conveyor_top_w];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tiles) {
    const ox = (t % TPR) * TILE, oy = Math.floor(t / TPR) * TILE;
    x0 = Math.min(x0, ox); y0 = Math.min(y0, oy); x1 = Math.max(x1, ox + TILE); y1 = Math.max(y1, oy + TILE);
  }
  set.atlasCtx.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  set.atlas.needsUpdate = true;
}

/* ══════════════════════════════════════════════════════════════
   13. atlas assembly
   ══════════════════════════════════════════════════════════════ */

export interface TextureSet {
  atlas: THREE.CanvasTexture;
  water: THREE.CanvasTexture;
  cracks: THREE.CanvasTexture[];
  atlasCanvas: HTMLCanvasElement;
  atlasImg: ImageData;
  atlasCtx: CanvasRenderingContext2D;
  paint: PlanetPaintContext;
}

export function tileUV(tile: number): [number, number, number, number] {
  const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
  const e = 0.02;
  const u0 = (col * TILE + e) / ATLAS_W;
  const u1 = ((col + 1) * TILE - e) / ATLAS_W;
  const vTop = 1 - (row * TILE + e) / ATLAS_H;
  const vBottom = 1 - ((row + 1) * TILE - e) / ATLAS_H;
  return [u0, vBottom, u1, vTop];
}

function configure(tex: THREE.CanvasTexture, nearest = true): THREE.CanvasTexture {
  if (nearest) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; }
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCrackTexture(stage: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TILE; c.height = TILE;
  const ctx = c.getContext('2d')!;
  const r = mulberry32(9001 + stage * 137);
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.fillStyle = 'rgba(24, 20, 16, 0.92)';
  for (let w = 0; w < 2 + stage * 2; w++) {
    let x = 2 + Math.floor(r() * 12), y = 2 + Math.floor(r() * 12);
    const steps = 6 + stage * 4 + Math.floor(r() * 6);
    for (let s = 0; s < steps; s++) {
      ctx.fillRect(x, y, 1, 1);
      if (r() < 0.5) x += r() < 0.5 ? -1 : 1; else y += r() < 0.5 ? -1 : 1;
      x = Math.max(0, Math.min(TILE - 1, x)); y = Math.max(0, Math.min(TILE - 1, y));
    }
  }
  return configure(new THREE.CanvasTexture(c));
}

export function createTextures(theme?: PlanetTheme | null): TextureSet {
  const paint = buildPaintContext(theme);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W; canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ATLAS_W, ATLAS_H);

  TILE_NAMES.forEach((name, i) => {
    const painter = PAINTERS[name];
    const t = new Tile16();
    // deterministic per planet + per tile
    const r = mulberry32((paint.salt ^ Math.imul(i + 1, 7919) ^ 0x9e3779b9) >>> 0);
    if (painter) painter(t, r, paint);
    guardTile(name, t, r, paint);
    t.blit(img, TILES[name]);
  });

  // machines only: gentle planet grade so factories don't look alien to the world
  const tints = tintsFromTheme(theme);
  if (tints?.stone) {
    const m = tints.stone.map((v) => 1 + (v - 1) * MACHINE_GRADE) as unknown as RGB;
    for (const n of MACHINE_TILES) tintTile(img, TILES[n], m);
  }

  ctx.putImageData(img, 0, 0);

  // standalone animated-water texture uses the same planet painter
  const wc = document.createElement('canvas');
  wc.width = TILE; wc.height = TILE;
  const wctx = wc.getContext('2d')!;
  const wimg = wctx.createImageData(TILE, TILE);
  const wt = new Tile16();
  paintWaterTile(wt, mulberry32(paint.salt ^ 4242), paint);
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
    const c = wt.get(x, y) ?? paint.pal.water.mid;
    put(wimg.data, TILE, x, y, c);
  }
  wctx.putImageData(wimg, 0, 0);
  const water = configure(new THREE.CanvasTexture(wc));
  water.wrapS = THREE.RepeatWrapping; water.wrapT = THREE.RepeatWrapping;

  return {
    atlas: configure(new THREE.CanvasTexture(canvas)),
    water,
    cracks: [0, 1, 2, 3, 4].map(makeCrackTexture),
    atlasCanvas: canvas,
    atlasImg: img,
    atlasCtx: ctx,
    paint,
  };
}

/* ── icons (unchanged) ───────────────────────────────────────── */

export function makeIcon(atlasCanvas: HTMLCanvasElement, tile: number, size = 44): string {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(atlasCanvas, (tile % TPR) * TILE, Math.floor(tile / TPR) * TILE, TILE, TILE, 0, 0, size, size);
  return c.toDataURL();
}

export function makeBucketIcon(size = 44): string {
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const off = document.createElement('canvas');
  off.width = TILE; off.height = TILE;
  const octx = off.getContext('2d')!;
  const px = (x: number, y: number, col: string) => { octx.fillStyle = col; octx.fillRect(x, y, 1, 1); };
  const row = (x0: number, x1: number, y: number, col: string) => { octx.fillStyle = col; octx.fillRect(x0, y, x1 - x0 + 1, 1); };
  const SILVER = '#c8ced6', STEEL = '#8d969e', DARK = '#5c646c';
  px(4, 3, STEEL); px(5, 2, STEEL); px(6, 1, STEEL); px(7, 1, STEEL); px(8, 1, STEEL); px(9, 1, STEEL); px(10, 2, STEEL); px(11, 3, STEEL);
  row(4, 11, 4, SILVER);
  for (let y = 5; y <= 12; y++) {
    px(4, y, STEEL); px(11, y, DARK);
    for (let x = 5; x <= 10; x++) {
      if (y === 5) px(x, y, x === 6 || x === 9 ? '#6f93f2' : '#4a74e8');
      else if (y <= 9) px(x, y, '#4266d8');
      else px(x, y, '#3554b8');
    }
  }
  row(5, 10, 13, DARK); row(5, 10, 12, STEEL);
  for (let y = 6; y <= 11; y++) px(5, y, '#4f71db');
  ctx.drawImage(off, 0, 0, TILE, TILE, 0, 0, size, size);
  return c.toDataURL();
}

/** QA helper: 4× nearest-neighbour blow-up of the whole atlas as a data URL. */
export function atlasDebugSheet(set: TextureSet, scale = 4): string {
  const c = document.createElement('canvas');
  c.width = ATLAS_W * scale; c.height = ATLAS_H * scale;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(set.atlasCanvas, 0, 0, ATLAS_W, ATLAS_H, 0, 0, c.width, c.height);
  return c.toDataURL();
}
