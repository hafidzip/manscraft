
import * as THREE from 'three';
import { Rng, derive } from './rng';

export type PlanetType =
  | 'terran'
  | 'ocean'
  | 'desert'
  | 'ice'
  | 'volcanic'
  | 'alien'
  | 'barren'
  | 'jungle'
  | 'savanna'
  | 'tundra'
  | 'lava'
  | 'oceanic_ice'
  | 'crimson'
  | 'neon';

export type MoonStyle = 'rock' | 'ice' | 'ash' | 'violet' | 'ruby' | 'emerald' | 'crimson';

export const PLANET_TYPES: PlanetType[] = [
  'terran',
  'ocean',
  'desert',
  'ice',
  'volcanic',
  'alien',
  'barren',
  'jungle',
  'savanna',
  'tundra',
  'lava',
  'oceanic_ice',
  'crimson',
  'neon',
];

export interface PlanetPalette {
  key: PlanetType;
  name: string;
  emoji: string;
  tagline: string;
  stops: Array<[number, [number, number, number]]>;
  pole: [number, number, number];
  poleAmount: number;
  atmoHex: number;
  atmoPower: number;
  atmoStrength: number;
  ringHex: number;
  clouds: null | { hex: number; opacity: number; threshold: number; freq: number };
  cityLights: boolean;
  lava: boolean;
  moon: MoonStyle;
}

export const PLANET_PALETTES: Record<PlanetType, PlanetPalette> = {
  terran: {
    key: 'terran', name: 'Terran', emoji: '🌍', tagline: 'water, forest & city glow',
    stops: [
      [-1.0, [0.012, 0.07, 0.16]],
      [-0.14, [0.02, 0.13, 0.32]],
      [-0.03, [0.09, 0.36, 0.52]],
      [0.04, [0.84, 0.75, 0.52]],
      [0.12, [0.569, 0.741, 0.349]],
      [0.22, [0.10, 0.33, 0.13]],
      [0.36, [0.46, 0.42, 0.37]],
      [1.0, [0.52, 0.48, 0.43]],
    ],
    pole: [0.93, 0.96, 0.98], poleAmount: 0.95,
    atmoHex: 0x6ea8ff, atmoPower: 3.6, atmoStrength: 1.35,
    ringHex: 0x9fc2e8,
    clouds: { hex: 0xffffff, opacity: 0.8, threshold: 0.16, freq: 1.7 },
    cityLights: true, lava: false, moon: 'rock',
  },
  ocean: {
    key: 'ocean', name: 'Ocean', emoji: '🌊', tagline: 'a world of shallow seas',
    stops: [
      [-1.0, [0.008, 0.045, 0.12]],
      [-0.08, [0.015, 0.10, 0.26]],
      [-0.01, [0.06, 0.30, 0.46]],
      [0.03, [0.80, 0.73, 0.52]],
      [0.10, [0.22, 0.44, 0.22]],
      [0.30, [0.45, 0.41, 0.36]],
      [1.0, [0.48, 0.44, 0.39]],
    ],
    pole: [0.72, 0.84, 0.92], poleAmount: 0.55,
    atmoHex: 0x4fd4e8, atmoPower: 3.9, atmoStrength: 1.15,
    ringHex: 0x9fd4e8,
    clouds: { hex: 0xffffff, opacity: 0.45, threshold: 0.22, freq: 1.9 },
    cityLights: false, lava: false, moon: 'rock',
  },
  desert: {
    key: 'desert', name: 'Desert', emoji: '🏜️', tagline: 'dunes under an orange haze',
    stops: [
      [-1.0, [0.32, 0.27, 0.22]],
      [-0.04, [0.45, 0.37, 0.27]],
      [0.02, [0.80, 0.68, 0.44]],
      [0.12, [0.88, 0.74, 0.46]],
      [0.28, [0.58, 0.46, 0.32]],
      [0.5, [0.66, 0.52, 0.36]],
      [1.0, [0.70, 0.56, 0.38]],
    ],
    pole: [0.92, 0.84, 0.66], poleAmount: 0.3,
    atmoHex: 0xff9c4a, atmoPower: 3.3, atmoStrength: 1.25,
    ringHex: 0xe0b264,
    clouds: null,
    cityLights: false, lava: false, moon: 'rock',
  },
  ice: {
    key: 'ice', name: 'Ice', emoji: '❄️', tagline: 'a frozen crystal shell',
    stops: [
      [-1.0, [0.02, 0.05, 0.14]],
      [-0.03, [0.10, 0.22, 0.35]],
      [0.02, [0.68, 0.82, 0.92]],
      [0.14, [0.85, 0.92, 0.96]],
      [0.30, [0.52, 0.54, 0.58]],
      [1.0, [0.56, 0.58, 0.62]],
    ],
    pole: [0.96, 0.98, 1.0], poleAmount: 0.9,
    atmoHex: 0xbfe8ff, atmoPower: 3.4, atmoStrength: 0.85,
    ringHex: 0xcfe8ff,
    clouds: null,
    cityLights: false, lava: false, moon: 'ice',
  },
  volcanic: {
    key: 'volcanic', name: 'Volcanic', emoji: '🌋', tagline: 'lava veins in black rock',
    stops: [
      [-1.0, [0.04, 0.035, 0.04]],
      [-0.05, [0.10, 0.085, 0.09]],
      [0.03, [0.24, 0.19, 0.17]],
      [0.16, [0.35, 0.27, 0.23]],
      [0.35, [0.44, 0.29, 0.21]],
      [0.6, [0.52, 0.33, 0.24]],
      [1.0, [0.55, 0.35, 0.25]],
    ],
    pole: [0.5, 0.48, 0.5], poleAmount: 0.25,
    atmoHex: 0xff5a33, atmoPower: 3.1, atmoStrength: 1.55,
    ringHex: 0xc96a4a,
    clouds: { hex: 0x3d3836, opacity: 0.55, threshold: 0.14, freq: 2.0 },
    cityLights: false, lava: true, moon: 'ash',
  },
  alien: {
    key: 'alien', name: 'Alien', emoji: '👽', tagline: 'toxic violet biosphere',
    stops: [
      [-1.0, [0.03, 0.05, 0.08]],
      [-0.05, [0.13, 0.26, 0.14]],
      [0.02, [0.30, 0.17, 0.40]],
      [0.12, [0.44, 0.25, 0.54]],
      [0.28, [0.56, 0.31, 0.48]],
      [0.5, [0.60, 0.40, 0.34]],
      [1.0, [0.63, 0.44, 0.36]],
    ],
    pole: [0.72, 0.78, 0.85], poleAmount: 0.35,
    atmoHex: 0x9d5cff, atmoPower: 3.4, atmoStrength: 1.3,
    ringHex: 0xc79fff,
    clouds: { hex: 0x9affa0, opacity: 0.5, threshold: 0.18, freq: 1.8 },
    cityLights: false, lava: false, moon: 'violet',
  },
  barren: {
    key: 'barren', name: 'Barren', emoji: '🪨', tagline: 'airless rock & dust',
    stops: [
      [-1.0, [0.14, 0.13, 0.13]],
      [-0.12, [0.26, 0.25, 0.24]],
      [0.0, [0.38, 0.36, 0.33]],
      [0.18, [0.50, 0.47, 0.42]],
      [0.45, [0.58, 0.54, 0.48]],
      [1.0, [0.62, 0.58, 0.52]],
    ],
    pole: [0.7, 0.68, 0.65], poleAmount: 0.25,
    atmoHex: 0x9aa4b8, atmoPower: 3.2, atmoStrength: 0.22,
    ringHex: 0xbbb6aa,
    clouds: null,
    cityLights: false, lava: false, moon: 'rock',
  },
  jungle: {
    key: 'jungle', name: 'Jungle', emoji: '🌴', tagline: 'steaming biosphere',
    stops: [
      [-1.0, [0.02, 0.08, 0.10]],
      [-0.04, [0.06, 0.22, 0.18]],
      [0.02, [0.18, 0.46, 0.26]],
      [0.10, [0.30, 0.60, 0.28]],
      [0.22, [0.12, 0.32, 0.10]],
      [0.40, [0.28, 0.20, 0.12]],
      [1.0, [0.50, 0.40, 0.26]],
    ],
    pole: [0.72, 0.88, 0.78], poleAmount: 0.20,
    atmoHex: 0x66d8a0, atmoPower: 3.4, atmoStrength: 1.15,
    ringHex: 0x7fd4a0,
    clouds: { hex: 0xe0ffe8, opacity: 0.85, threshold: 0.12, freq: 2.0 },
    cityLights: false, lava: false, moon: 'emerald',
  },
  savanna: {
    key: 'savanna', name: 'Savanna', emoji: '🌾', tagline: 'golden grasslands',
    stops: [
      [-1.0, [0.06, 0.10, 0.12]],
      [-0.04, [0.12, 0.22, 0.24]],
      [0.0, [0.18, 0.40, 0.40]],
      [0.08, [0.72, 0.66, 0.30]],
      [0.24, [0.82, 0.68, 0.28]],
      [0.45, [0.54, 0.42, 0.24]],
      [1.0, [0.62, 0.50, 0.32]],
    ],
    pole: [0.92, 0.88, 0.78], poleAmount: 0.15,
    atmoHex: 0xffd088, atmoPower: 3.3, atmoStrength: 1.05,
    ringHex: 0xd8b878,
    clouds: { hex: 0xfff0c8, opacity: 0.6, threshold: 0.2, freq: 1.7 },
    cityLights: false, lava: false, moon: 'rock',
  },
  tundra: {
    key: 'tundra', name: 'Tundra', emoji: '🌿', tagline: 'frozen steppe',
    stops: [
      [-1.0, [0.04, 0.08, 0.12]],
      [-0.03, [0.16, 0.26, 0.30]],
      [0.03, [0.44, 0.52, 0.50]],
      [0.12, [0.60, 0.66, 0.58]],
      [0.26, [0.54, 0.52, 0.46]],
      [1.0, [0.62, 0.58, 0.50]],
    ],
    pole: [0.96, 0.98, 1.0], poleAmount: 0.85,
    atmoHex: 0xb0d8e0, atmoPower: 3.5, atmoStrength: 0.70,
    ringHex: 0xc8dce0,
    clouds: { hex: 0xf0f8ff, opacity: 0.7, threshold: 0.18, freq: 1.9 },
    cityLights: false, lava: false, moon: 'ice',
  },
  lava: {
    key: 'lava', name: 'Lava', emoji: '🔥', tagline: 'molten world',
    stops: [
      [-1.0, [0.08, 0.02, 0.02]],
      [-0.06, [0.20, 0.06, 0.04]],
      [0.0, [0.50, 0.14, 0.05]],
      [0.08, [0.90, 0.35, 0.10]],
      [0.20, [0.30, 0.14, 0.08]],
      [0.50, [0.20, 0.10, 0.06]],
      [1.0, [0.25, 0.12, 0.08]],
    ],
    pole: [0.6, 0.30, 0.20], poleAmount: 0.10,
    atmoHex: 0xff5a22, atmoPower: 3.0, atmoStrength: 1.65,
    ringHex: 0xc04020,
    clouds: { hex: 0x2a1a14, opacity: 0.6, threshold: 0.12, freq: 2.2 },
    cityLights: false, lava: true, moon: 'crimson',
  },
  oceanic_ice: {
    key: 'oceanic_ice', name: 'Ocean-Ice', emoji: '🧊', tagline: 'frozen ocean',
    stops: [
      [-1.0, [0.02, 0.06, 0.16]],
      [-0.08, [0.05, 0.18, 0.42]],
      [0.0, [0.12, 0.40, 0.62]],
      [0.05, [0.78, 0.90, 0.98]],
      [0.18, [0.88, 0.95, 1.0]],
      [1.0, [0.92, 0.97, 1.0]],
    ],
    pole: [0.98, 1.0, 1.0], poleAmount: 1.0,
    atmoHex: 0x88c8ff, atmoPower: 3.8, atmoStrength: 1.0,
    ringHex: 0xaed8ff,
    clouds: { hex: 0xffffff, opacity: 0.75, threshold: 0.16, freq: 1.8 },
    cityLights: false, lava: false, moon: 'ice',
  },
  crimson: {
    key: 'crimson', name: 'Crimson', emoji: '🩸', tagline: 'red iron plains',
    stops: [
      [-1.0, [0.08, 0.02, 0.04]],
      [-0.05, [0.20, 0.05, 0.08]],
      [0.02, [0.48, 0.10, 0.14]],
      [0.12, [0.68, 0.18, 0.20]],
      [0.30, [0.52, 0.16, 0.18]],
      [0.60, [0.30, 0.10, 0.12]],
      [1.0, [0.38, 0.14, 0.16]],
    ],
    pole: [0.8, 0.5, 0.5], poleAmount: 0.22,
    atmoHex: 0xff5060, atmoPower: 3.1, atmoStrength: 1.2,
    ringHex: 0xd84050,
    clouds: { hex: 0xffc0c8, opacity: 0.4, threshold: 0.22, freq: 1.6 },
    cityLights: false, lava: false, moon: 'ruby',
  },
  neon: {
    key: 'neon', name: 'Neon', emoji: '💠', tagline: 'cyan bioluminescent seas',
    stops: [
      [-1.0, [0.0, 0.05, 0.12]],
      [-0.06, [0.02, 0.18, 0.32]],
      [-0.01, [0.04, 0.48, 0.66]],
      [0.04, [0.50, 0.90, 0.70]],
      [0.14, [0.18, 0.52, 0.88]],
      [0.30, [0.12, 0.22, 0.40]],
      [1.0, [0.20, 0.16, 0.32]],
    ],
    pole: [0.7, 1.0, 0.95], poleAmount: 0.55,
    atmoHex: 0x44f0ff, atmoPower: 3.5, atmoStrength: 1.45,
    ringHex: 0x66ccff,
    clouds: { hex: 0x90ffff, opacity: 0.6, threshold: 0.14, freq: 2.1 },
    cityLights: false, lava: false, moon: 'emerald',
  },
};

export const MOON_STOPS: Record<MoonStyle, Array<[number, [number, number, number]]>> = {
  rock: [
    [-1, [0.30, 0.28, 0.26]],
    [-0.2, [0.42, 0.39, 0.35]],
    [0.2, [0.52, 0.49, 0.45]],
    [1, [0.60, 0.57, 0.53]],
  ],
  ice: [
    [-1, [0.62, 0.72, 0.82]],
    [-0.1, [0.75, 0.83, 0.90]],
    [0.3, [0.86, 0.91, 0.95]],
    [1, [0.92, 0.95, 0.98]],
  ],
  ash: [
    [-1, [0.16, 0.15, 0.15]],
    [-0.2, [0.24, 0.22, 0.21]],
    [0.2, [0.33, 0.30, 0.28]],
    [1, [0.42, 0.38, 0.35]],
  ],
  violet: [
    [-1, [0.30, 0.20, 0.46]],
    [-0.2, [0.40, 0.26, 0.58]],
    [0.2, [0.50, 0.33, 0.66]],
    [1, [0.58, 0.40, 0.72]],
  ],
  ruby: [
    [-1, [0.25, 0.06, 0.08]],
    [-0.2, [0.45, 0.12, 0.16]],
    [0.2, [0.72, 0.22, 0.28]],
    [1, [0.82, 0.34, 0.38]],
  ],
  emerald: [
    [-1, [0.04, 0.22, 0.14]],
    [-0.2, [0.10, 0.40, 0.24]],
    [0.2, [0.18, 0.62, 0.36]],
    [1, [0.28, 0.78, 0.46]],
  ],
  crimson: [
    [-1, [0.18, 0.02, 0.08]],
    [-0.2, [0.32, 0.06, 0.16]],
    [0.2, [0.58, 0.10, 0.24]],
    [1, [0.72, 0.20, 0.30]],
  ],
};

type Stop = [number, [number, number, number]];

function sampleStops(stops: Stop[], h: number, out: THREE.Color): void {
  let i = 0;
  for (let k = 0; k < stops.length - 1; k++) {
    if (h > stops[k + 1][0]) i = k + 1;
    else break;
  }
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  const span = b[0] - a[0];
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (h - a[0]) / span));
  out.setRGB(
    a[1][0] + (b[1][0] - a[1][0]) * t,
    a[1][1] + (b[1][1] - a[1][1]) * t,
    a[1][2] + (b[1][2] - a[1][2]) * t,
  );
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const _rampColor = new THREE.Color();

export function rampAt255(stops: Array<[number, [number, number, number]]>, h: number): [number, number, number] {
  sampleStops(stops, h, _rampColor);
  return [_rampColor.r * 255, _rampColor.g * 255, _rampColor.b * 255];
}

export function biomeColorInto(
  h: number, lat: number, pal: PlanetPalette, out: THREE.Color, poleCol: THREE.Color,
): void {
  sampleStops(pal.stops, h, out);
  const polar = smoothstep(0.8, 0.95, lat);
  if (polar > 0 && pal.poleAmount > 0) out.lerp(poleCol, polar * pal.poleAmount);
}

export function moonColorInto(style: MoonStyle, h: number, out: THREE.Color): void {
  sampleStops(MOON_STOPS[style], h, out);
}

export function pickPlanetType(seed: bigint): PlanetType {
  const r = new Rng(derive(seed, 0x54595045));
  return PLANET_TYPES[Math.floor(r.next() * PLANET_TYPES.length)];
}
