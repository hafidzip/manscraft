import { PLANET_PALETTES, rampAt255, type PlanetType } from '../space/palettes';
import { TINT_REF, GROUP_H, TINT_LO, TINT_HI, strengthFor, type RGB } from './tintGroups';

export type OriginTag = number;
export type TintMap = Record<string, RGB>;

export { TINT_REF, GROUP_H };

export const NO_ORIGIN: OriginTag = 0;

export const PLANET_TYPE_ORDER: readonly PlanetType[] = [
  'terran', 'ocean', 'desert', 'ice', 'volcanic', 'alien', 'barren',
  'jungle', 'savanna', 'tundra', 'lava', 'oceanic_ice', 'crimson', 'neon',
];

export const VARIANT_COUNT = PLANET_TYPE_ORDER.length;
const TYPE_INDEX = new Map<PlanetType, number>(PLANET_TYPE_ORDER.map((t, i) => [t, i]));


export function packOrigin(type: PlanetType, hueBucket: number): OriginTag {
  const ti = TYPE_INDEX.get(type) ?? 0;
  const hb = ((hueBucket % 16) + 16) % 16;
  return (((ti + 1) & 0x0f) | (hb << 4)) & 0xff;
}

export function originTypeIndex(tag: OriginTag): number {
  return (tag & 0x0f) - 1;
}

export function originType(tag: OriginTag): PlanetType | null {
  const i = originTypeIndex(tag);
  return i >= 0 && i < PLANET_TYPE_ORDER.length ? PLANET_TYPE_ORDER[i] : null;
}

export function originHueBucket(tag: OriginTag): number {
  return (tag >> 4) & 0x0f;
}

export function originLabel(tag: OriginTag): string | null {
  const t = originType(tag);
  return t ? PLANET_PALETTES[t].name : null;
}

export function hueBucketFromSeed(seed: bigint): number {
  const M = 0xffffffffffffffffn;
  let h = BigInt.asUintN(64, seed);
  h = ((h ^ (h >> 30n)) * 0xbf58476d1ce4e5b9n) & M;
  h = ((h ^ (h >> 27n)) * 0x94d049bb133111ebn) & M;
  h ^= h >> 31n;
  return Number(h & 0x0fn);
}

export function hueBucketOffsets(b: number): { hue: number; sat: number; val: number } {
  return {
    hue: (b / 16 - 0.47) * 0.11,
    sat: 0.86 + (b % 5) * 0.07,
    val: 0.93 + ((b >> 2) & 3) * 0.045,
  };
}


const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function groupTargetRgb(type: PlanetType, group: string): RGB {
  const pal = PLANET_PALETTES[type];
  if (group === 'snow') {
    return [pal.pole[0] * 255, pal.pole[1] * 255, pal.pole[2] * 255];
  }
  return rampAt255(pal.stops, GROUP_H[group] ?? 0.12);
}


function rgb2hsv([r, g, b]: RGB): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx <= 0 ? 0 : d / mx, mx];
}

function hsv2rgb(h: number, s: number, v: number): RGB {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (((i % 6) + 6) % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return [r * 255, g * 255, b * 255];
}

function nudge(base: RGB, off: { hue: number; sat: number; val: number }): RGB {
  const [h, s, v] = rgb2hsv(base);
  return hsv2rgb(((h + off.hue) % 1 + 1) % 1, clamp01(s * off.sat), clamp01(v * off.val));
}

const tintCache = new Map<OriginTag, TintMap>();

export function originTints(tag: OriginTag): TintMap | null {
  if (!tag) return null;
  const hit = tintCache.get(tag);
  if (hit) return hit;
  const type = originType(tag);
  if (!type) return null;
  const off = hueBucketOffsets(originHueBucket(tag));
  const out: TintMap = {};
  for (const group of Object.keys(TINT_REF)) {
    const target = nudge(groupTargetRgb(type, group), off);
    const ref = TINT_REF[group];
    out[group] = [0, 1, 2].map((i) => {
      const raw = target[i] / Math.max(1, ref[i]);
      return clamp(1 + (raw - 1) * strengthFor(group), TINT_LO, TINT_HI);
    }) as unknown as RGB;
  }
  if (PLANET_PALETTES[type].lava) {
    for (const g of ['stone', 'dirt']) {
      const cur = out[g];
      if (!cur) continue;
      out[g] = [
        clamp(cur[0] * 1.14, TINT_LO, TINT_HI),
        cur[1],
        clamp(cur[2] * 0.86, TINT_LO, TINT_HI),
      ] as RGB;
    }
  }
  tintCache.set(tag, out);
  return out;
}

export function originColorMul(tag: OriginTag, group: string | undefined): RGB {
  const t = group ? originTints(tag)?.[group] : null;
  return t ? [clamp(t[0], 0, 2), clamp(t[1], 0, 2), clamp(t[2], 0, 2)] : [1, 1, 1];
}

export function relativeColorMul(voxelTag: OriginTag, nativeTag: OriginTag, group: string | undefined): RGB {
  if (!group || voxelTag === nativeTag) return [1, 1, 1];
  const own = originColorMul(voxelTag, group);
  const native = originColorMul(nativeTag, group);
  return [
    clamp(own[0] / Math.max(0.05, native[0]), TINT_LO, TINT_HI),
    clamp(own[1] / Math.max(0.05, native[1]), TINT_LO, TINT_HI),
    clamp(own[2] / Math.max(0.05, native[2]), TINT_LO, TINT_HI),
  ];
}

export function originGroupHex(tag: OriginTag, group: string): number {
  const type = originType(tag);
  const base = type
    ? nudge(groupTargetRgb(type, group), hueBucketOffsets(originHueBucket(tag)))
    : (TINT_REF[group] ?? [255, 255, 255]);
  const [r, g, b] = base.map((v) => clamp(Math.round(v), 0, 255));
  return (r << 16) | (g << 8) | b;
}

export function waterHexFor(tag: OriginTag): number {
  return originGroupHex(tag, 'water');
}
