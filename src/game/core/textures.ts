
import * as THREE from 'three';
import { mulberry32 } from './noise';
import { PLANET_PALETTES } from '../space/palettes';
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

export const TILES: Record<string, number> = {};
TILE_NAMES.forEach((n, i) => (TILES[n] = i));

export const ATLAS_COLS = TPR;
export const ATLAS_ROWS = Math.ceil(TILE_NAMES.length / TPR);
export const ATLAS_W = ATLAS_COLS * TILE;
export const ATLAS_H = ATLAS_ROWS * TILE;


type RGB = readonly [number, number, number];

function put(d: Uint8ClampedArray, w: number, x: number, y: number, c: RGB, a = 255): void {
  const i = (y * w + x) * 4;
  d[i] = c[0];
  d[i + 1] = c[1];
  d[i + 2] = c[2];
  d[i + 3] = a;
}

function vary(base: RGB, amt: number, r: () => number): RGB {
  const v = Math.floor((r() * 2 - 1) * amt);
  return [
    Math.max(0, Math.min(255, base[0] + v)),
    Math.max(0, Math.min(255, base[1] + v)),
    Math.max(0, Math.min(255, base[2] + v)),
  ] as const;
}


function rampAt(stops: Array<[number, [number, number, number]]>, h: number): RGB {
  let i = 0;
  for (let k = 0; k < stops.length - 1; k++) {
    if (h > stops[k + 1][0]) i = k + 1;
    else break;
  }
  const a = stops[i];
  const b = stops[Math.min(i + 1, stops.length - 1)];
  const span = b[0] - a[0];
  const t = span === 0 ? 0 : Math.min(1, Math.max(0, (h - a[0]) / span));
  return [
    a[1][0] + (b[1][0] - a[1][0]) * t,
    a[1][1] + (b[1][1] - a[1][1]) * t,
    a[1][2] + (b[1][2] - a[1][2]) * t,
  ] as const;
}

const TINT_REF: Record<string, RGB> = {
  grass: [96, 162, 54],
  dirt: [121, 85, 58],
  stone: [128, 128, 128],
  sand: [219, 207, 163],
  leaves: [56, 120, 40],
  log: [104, 76, 44],
  planks: [164, 129, 80],
  snow: [238, 246, 248],
  water: [58, 102, 222],
  cactus: [62, 138, 56],
};

const TILE_GROUP: Record<string, string> = {
  grass_top: 'grass', grass_side: 'grass', tallgrass: 'grass',
  dirt: 'dirt', snow_side: 'snow',
  stone: 'stone', gravel: 'stone', bedrock: 'stone', cobble: 'stone',
  furnace_top: 'stone', furnace_side: 'stone', furnace_front: 'stone',
  sand: 'sand', leaves: 'leaves',
  log_side: 'log', log_top: 'log', planks: 'planks',
  craft_top: 'planks', craft_side: 'planks', craft_bottom: 'planks',
  snow: 'snow', water: 'water', cactus_side: 'cactus', cactus_top: 'cactus',
};

export type TintMap = Record<string, RGB>;

const TINT_STRENGTH = 0.85;
const clampMul = (v: number) => Math.max(0.22, Math.min(2.4, v));

function targetFor(group: string, theme: PlanetTheme): RGB {
  const pal = PLANET_PALETTES[theme.type];
  const s = pal.stops;
  switch (group) {
    case 'grass':   return rampAt(s, 0.14);
    case 'leaves':  return rampAt(s, 0.22);
    case 'dirt':    return rampAt(s, 0.08);
    case 'sand':    return rampAt(s, 0.04);
    case 'stone':   return rampAt(s, 0.5);
    case 'log':     return rampAt(s, 0.3);
    case 'planks':  return rampAt(s, 0.36);
    case 'snow':    return pal.pole as unknown as RGB;
    case 'water':   return rampAt(s, -0.2);
    case 'cactus':  return rampAt(s, 0.18);
    default:        return rampAt(s, 0.12);
  }
}

export function tintsFromTheme(theme?: PlanetTheme | null): TintMap | null {
  if (!theme || !PLANET_PALETTES[theme.type]) return null;
  const out: TintMap = {};
  for (const g of Object.keys(TINT_REF)) {
    const ref = TINT_REF[g];
    const tgt = targetFor(g, theme);
    const m: number[] = [];
    for (let k = 0; k < 3; k++) {
      const raw = clampMul((tgt[k] * 255) / Math.max(1, ref[k]));
      m[k] = 1 + (raw - 1) * TINT_STRENGTH;
    }
    if (theme.lava && (g === 'stone' || g === 'dirt')) {
      m[0] *= 1.18; m[1] *= 0.9; m[2] *= 0.78;
    }
    out[g] = [m[0], m[1], m[2]] as const;
  }
  return out;
}

function tintTile(img: ImageData, tile: number, m: RGB): void {
  if (m[0] === 1 && m[1] === 1 && m[2] === 1) return;
  const ox = (tile % TPR) * TILE;
  const oy = Math.floor(tile / TPR) * TILE;
  const d = img.data;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const i = ((oy + y) * img.width + ox + x) * 4;
      if (d[i + 3] === 0) continue;
      d[i] = Math.max(0, Math.min(255, d[i] * m[0]));
      d[i + 1] = Math.max(0, Math.min(255, d[i + 1] * m[1]));
      d[i + 2] = Math.max(0, Math.min(255, d[i + 2] * m[2]));
    }
  }
}

function tileRegion(
  img: ImageData,
  tile: number,
  fn: (x: number, y: number) => RGB | null
): void {
  const ox = (tile % TPR) * TILE;
  const oy = Math.floor(tile / TPR) * TILE;
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const c = fn(x, y);
      if (c) put(img.data, img.width, ox + x, oy + y, c);
    }
  }
}


type Painter = (img: ImageData, r: () => number) => void;

const GRASS_BASE: RGB = [96, 162, 54];

function shadeMul(base: RGB, f: number): RGB {
  return [
    Math.max(0, Math.min(255, Math.floor(base[0] * f))),
    Math.max(0, Math.min(255, Math.floor(base[1] * f))),
    Math.max(0, Math.min(255, Math.floor(base[2] * f))),
  ] as const;
}

const paintDirt: Painter = (img, r) =>
  tileRegion(img, TILES.dirt, () => {
    const c = vary([121, 85, 58], 20, r);
    return r() < 0.08 ? vary([88, 62, 42], 10, r) : c;
  });

function pixelHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x + 0x9e37, 0x85ebca6b) ^ Math.imul(y + 0x1b87, 0xc2b2ae35) ^ salt;
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2f);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function varyH(base: RGB, amt: number, h: number): RGB {
  const v = Math.floor((h * 2 - 1) * amt);
  return [
    Math.max(0, Math.min(255, base[0] + v)),
    Math.max(0, Math.min(255, base[1] + v)),
    Math.max(0, Math.min(255, base[2] + v)),
  ] as const;
}

function paintBeltTop(img: ImageData, tile: number, rot: number, phase: number): void {
  const N = TILE;
  tileRegion(img, tile, (px, py) => {
    let x = px, y = py;
    if (rot === 1) { x = py; y = N - 1 - px; }
    else if (rot === 2) { x = N - 1 - px; y = N - 1 - py; }
    else if (rot === 3) { x = N - 1 - py; y = px; }

    if (y === 0 || y === N - 1) return varyH([44, 44, 50], 5, pixelHash(x, y, 11));
    if (y === 1 || y === N - 2) return varyH([88, 88, 96], 7, pixelHash(x, y, 12));

    const wx = ((x - phase) % N + N) % N;

    if (wx % 4 === 0) return varyH([50, 50, 56], 6, pixelHash(wx, y, 13));
    const cw = wx % 8;
    const dx = cw - 5;
    if (dx >= -2 && dx <= 0) {
      const spread = -dx;
      const off = Math.abs(y - 7.5);
      if (off >= spread - 0.5 && off <= spread + 1.5)
        return varyH([226, 146, 34], 12, pixelHash(wx, y, 14));
    }
    return varyH([74, 74, 80], 9, pixelHash(wx, y, 15));
  });
}

function paintInserterTop(img: ImageData, tile: number, rot: number, r: () => number): void {
  const N = TILE;
  tileRegion(img, tile, (px, py) => {
    let x = px, y = py;
    if (rot === 1) { x = py; y = N - 1 - px; }
    else if (rot === 2) { x = N - 1 - px; y = N - 1 - py; }
    else if (rot === 3) { x = N - 1 - py; y = px; }

    if (x === 0 || y === 0 || x === N - 1 || y === N - 1) return vary([36, 36, 42], 5, r);
    if (x === 1 || y === 1 || x === N - 2 || y === N - 2) return vary([60, 60, 68], 7, r);

    const dx = x - 7.5;
    const dz = y - 7.5;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 2.2) return vary([28, 28, 32], 4, r);
    if (d < 3.4) return vary([98, 98, 106], 8, r);

    if (x >= 10 && x <= 13 && Math.abs(y - 7.5) <= (x - 10) + 1 && Math.abs(y - 7.5) > (x - 10) - 1)
      return vary([226, 146, 34], 10, r);

    if ((x === 3 || x === 12) && Math.abs(y - 7.5) > 4 && (y === 3 + (Math.abs(x - 7.5) > 3 ? 1 : 0) || y === 12 - (Math.abs(x - 7.5) > 3 ? 1 : 0)))
      return vary([110, 110, 118], 8, r);

    return vary([72, 72, 80], 9, r);
  });
}


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

  const tiles = [
    TILES.conveyor_top_n, TILES.conveyor_top_e,
    TILES.conveyor_top_s, TILES.conveyor_top_w,
  ];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const t of tiles) {
    const ox = (t % TPR) * TILE;
    const oy = Math.floor(t / TPR) * TILE;
    x0 = Math.min(x0, ox); y0 = Math.min(y0, oy);
    x1 = Math.max(x1, ox + TILE); y1 = Math.max(y1, oy + TILE);
  }
  set.atlasCtx.putImageData(img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  set.atlas.needsUpdate = true;
}

const PAINTERS: Partial<Record<string, Painter>> = {
  grass_top: (img, r) =>
    tileRegion(img, TILES.grass_top, () => {
      let s = 0.78 + r() * 0.34;
      if (r() < 0.06) s *= 0.82;
      return shadeMul(GRASS_BASE, s);
    }),
  grass_side: (img, r) => {
    const edge: number[] = [];
    for (let x = 0; x < TILE; x++) edge[x] = 2 + Math.floor(r() * 3);
    tileRegion(img, TILES.grass_side, (x, y) => {
      if (y < edge[x]) {
        let s = 0.78 + r() * 0.34;
        if (r() < 0.06) s *= 0.82;
        return shadeMul(GRASS_BASE, s);
      }
      const c = vary([121, 85, 58], 20, r);
      return r() < 0.08 ? vary([88, 62, 42], 10, r) : c;
    });
  },
  dirt: paintDirt,
  stone: (img, r) =>
    tileRegion(img, TILES.stone, (x, y) => {
      const vein = Math.sin(x * 0.7 + y * 0.45) > 0.75 && r() < 0.6;
      return vein ? vary([104, 104, 108], 10, r) : vary([128, 128, 128], 12, r);
    }),
  sand: (img, r) =>
    tileRegion(img, TILES.sand, () =>
      r() < 0.1 ? vary([199, 184, 133], 8, r) : vary([219, 207, 163], 12, r)
    ),
  gravel: (img, r) => {
    const pebbles: RGB[] = [
      [128, 126, 123],
      [142, 135, 128],
      [104, 101, 98],
      [162, 151, 136],
    ];
    return tileRegion(img, TILES.gravel, () => {
      const p = pebbles[Math.floor(r() * pebbles.length)];
      return vary(p, 10, r);
    });
  },
  log_side: (img, r) => {
    const cols: RGB[] = [];
    for (let x = 0; x < TILE; x++) {
      const dark = x % 4 === 0 || r() < 0.18;
      cols[x] = dark ? [86, 60, 34] : [104, 76, 44];
    }
    return tileRegion(img, TILES.log_side, (x, y) =>
      vary(cols[x], 10 + ((y + x) % 3) * 2, r)
    );
  },
  log_top: (img, r) =>
    tileRegion(img, TILES.log_top, (x, y) => {
      const dx = x - 7.5;
      const dy = y - 7.5;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (d > 6.5) return vary([86, 60, 34], 10, r);
      const ring = Math.floor(d + r() * 0.6) % 2 === 0;
      return ring ? vary([176, 138, 90], 8, r) : vary([150, 114, 70], 8, r);
    }),
  leaves: (img, r) =>
    tileRegion(img, TILES.leaves, () => {
      if (r() < 0.14) return null;
      return r() < 0.4 ? vary([38, 96, 34], 14, r) : vary([52, 124, 44], 18, r);
    }),
  planks: (img, r) =>
    tileRegion(img, TILES.planks, (x, y) => {
      if (y % 4 === 3) return vary([96, 70, 40], 8, r);
      const joint = (Math.floor(y / 4) % 2 === 0 ? x === 11 : x === 4);
      if (joint) return vary([96, 70, 40], 8, r);
      return vary([164, 129, 76], 10, r);
    }),
  glass: (img) =>
    tileRegion(img, TILES.glass, (x, y) => {
      const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (border) return [206, 232, 245];
      if (x === y + 6 || x === y + 7 || (x < 6 && x === y - 3)) return [224, 244, 252];
      return null;
    }),
  snow: (img, r) =>
    tileRegion(img, TILES.snow, () =>
      r() < 0.12 ? vary([214, 232, 238], 6, r) : vary([238, 246, 248], 7, r)
    ),
  snow_side: (img, r) => {
    const edge: number[] = [];
    for (let x = 0; x < TILE; x++) edge[x] = 3 + Math.floor(r() * 2);
    return tileRegion(img, TILES.snow_side, (x, y) => {
      if (y < edge[x]) return vary([238, 246, 248], 7, r);
      return vary([121, 85, 58], 18, r);
    });
  },
  bedrock: (img, r) =>
    tileRegion(img, TILES.bedrock, () => {
      const v = r();
      return v < 0.4 ? vary([56, 56, 56], 10, r) : v < 0.75 ? vary([88, 88, 88], 10, r) : vary([30, 30, 30], 8, r);
    }),
  flower_red: (img, r) =>
    tileRegion(img, TILES.flower_red, (x, y) => {
      if (y >= 6 && (x === 7 || x === 8)) return vary([58, 122, 44], 10, r);
      if (y === 8 && (x === 6 || x === 9)) return vary([48, 100, 38], 8, r);
      const px = x - 7.5;
      const py = y - 3.5;
      const petal = Math.abs(px) <= 1.6 && Math.abs(py) <= 1.6 && !(Math.abs(px) === 1.5 && Math.abs(py) === 1.5);
      if (petal && y < 6) return vary([205, 47, 42], 18, r);
      if (Math.abs(px) < 0.6 && Math.abs(py) < 0.6 && y < 6) return [255, 214, 92];
      return y === 15 && x > 4 && x < 11 ? vary([58, 122, 44], 8, r) : null;
    }),
  flower_yellow: (img, r) =>
    tileRegion(img, TILES.flower_yellow, (x, y) => {
      if (y >= 6 && (x === 7 || x === 8)) return vary([58, 122, 44], 10, r);
      if (y === 9 && (x === 6 || x === 9)) return vary([48, 100, 38], 8, r);
      const px = x - 7.5;
      const py = y - 3.5;
      const petal = Math.abs(px) <= 1.6 && Math.abs(py) <= 1.6 && !(Math.abs(px) === 1.5 && Math.abs(py) === 1.5);
      if (petal && y < 6) return vary([228, 198, 66], 16, r);
      if (Math.abs(px) < 0.6 && Math.abs(py) < 0.6 && y < 6) return [180, 120, 40];
      return y === 15 && x > 4 && x < 11 ? vary([58, 122, 44], 8, r) : null;
    }),
  tallgrass: (img, r) => {
    const blades: { x: number; h: number; lean: number }[] = [];
    for (let i = 0; i < 7; i++) {
      blades.push({
        x: 1 + Math.floor(r() * 14),
        h: 6 + Math.floor(r() * 9),
        lean: r() < 0.5 ? -1 : 1,
      });
    }
    return tileRegion(img, TILES.tallgrass, (x, y) => {
      for (const b of blades) {
        const by = TILE - 1 - y;
        if (by < b.h) {
          const bx = b.x + Math.floor((by / b.h) * 2) * b.lean;
          if (x === bx) return shadeMul(GRASS_BASE, 0.86 + r() * 0.24);
        }
      }
      return null;
    });
  },
  cactus_side: (img, r) =>
    tileRegion(img, TILES.cactus_side, (x) => {
      const rib = x % 4 === 1;
      const c = rib ? vary([42, 106, 40], 8, r) : vary([62, 138, 56], 10, r);
      return r() < 0.04 ? [226, 236, 214] : c;
    }),
  cactus_top: (img, r) =>
    tileRegion(img, TILES.cactus_top, (x, y) => {
      const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (border) return vary([42, 106, 40], 8, r);
      if (x === 7 || x === 8 || y === 7 || y === 8) return vary([52, 122, 48], 8, r);
      return vary([62, 138, 56], 9, r);
    }),
  water: (img, r) =>
    tileRegion(img, TILES.water, (x, y) => {
      const wave = (x + y * 3) % 7 === 0;
      return wave ? vary([92, 138, 244], 8, r) : vary([58, 102, 222], 10, r);
    }),

  craft_top: (img, r) =>
    tileRegion(img, TILES.craft_top, (x, y) => {
      const seam = x === 7 || x === 8 || y === 7 || y === 8;
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([96, 70, 40], 8, r);
      if (seam) return vary([70, 50, 28], 6, r);
      return vary([164, 129, 76], 10, r);
    }),
  craft_side: (img, r) => {
    const base: RGB[] = [];
    for (let x = 0; x < TILE; x++) base[x] = x % 4 === 0 ? [96, 70, 40] : [164, 129, 76];
    return tileRegion(img, TILES.craft_side, (x, y) => {
      if (y < 2) return vary([120, 92, 54], 8, r);
      if (y >= 4 && y <= 9 && x >= 4 && x <= 11) {
        if (y === 4 || y === 9 || x === 4 || x === 11) return vary([70, 50, 28], 6, r);
        return vary([132, 102, 60], 8, r);
      }
      return vary(base[x], 10, r);
    });
  },
  craft_bottom: (img, r) =>
    tileRegion(img, TILES.craft_bottom, (_x, y) => {
      if (y % 4 === 3) return vary([96, 70, 40], 8, r);
      return vary([150, 118, 70], 10, r);
    }),

  cobble: (img, r) =>
    tileRegion(img, TILES.cobble, (x, y) => {
      const cell = ((x + (Math.floor(y / 5) % 2) * 3) / 5) | 0;
      const row = (y / 5) | 0;
      const edge = x % 5 === 4 || y % 5 === 4;
      if (edge) return vary([74, 74, 78], 8, r);
      const tone = (cell + row) % 3;
      const base: RGB = tone === 0 ? [140, 140, 144] : tone === 1 ? [118, 118, 122] : [100, 100, 104];
      return vary(base, 12, r);
    }),

  furnace_top: (img, r) =>
    tileRegion(img, TILES.furnace_top, (x, y) => {
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([88, 88, 92], 8, r);
      if (x >= 5 && x <= 10 && y >= 5 && y <= 10) return vary([62, 62, 66], 8, r);
      return vary([124, 124, 128], 12, r);
    }),
  furnace_side: (img, r) =>
    tileRegion(img, TILES.furnace_side, () =>
      Math.random() < 0.001 ? vary([100, 100, 104], 8, r) : vary([120, 120, 124], 14, r)
    ),
  furnace_front: (img, r) =>
    tileRegion(img, TILES.furnace_front, (x, y) => {
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([88, 88, 92], 8, r);
      if (x >= 3 && x <= 12) {
        if (y >= 4 && y <= 6) return vary([48, 48, 52], 6, r);
        if (y >= 7 && y <= 11) return vary([22, 22, 24], 5, r);
        if (y === 12) return vary([70, 70, 74], 6, r);
      }
      return vary([124, 124, 128], 12, r);
    }),
  furnace_front_lit: (img, r) =>
    tileRegion(img, TILES.furnace_front_lit, (x, y) => {
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([88, 88, 92], 8, r);
      if (x >= 3 && x <= 12) {
        if (y >= 4 && y <= 6) return vary([48, 48, 52], 6, r);
        if (y >= 7 && y <= 11) {
          const h = 11 - y;
          const flame = (x * 7 + h * 3) % 5;
          if (h >= 3) return flame < 2 ? vary([255, 214, 92], 18, r) : vary([28, 24, 22], 5, r);
          if (h === 2) return flame < 3 ? vary([255, 160, 40], 20, r) : vary([120, 40, 16], 12, r);
          return vary([228, 88, 24], 22, r);
        }
        if (y === 12) return vary([70, 70, 74], 6, r);
      }
      return vary([124, 124, 128], 12, r);
    }),

  ore_ruby: (img, r) =>
    tileRegion(img, TILES.ore_ruby, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const crystal = (x * 3 + y * 7) % 11 < 3 && r() < 0.5;
      if (crystal) {
        const bright = r() < 0.3;
        return bright ? vary([255, 80, 90], 15, r) : vary([180, 30, 40], 12, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_amber: (img, r) =>
    tileRegion(img, TILES.ore_amber, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const crystal = (x * 5 + y * 3) % 9 < 3 && r() < 0.45;
      if (crystal) {
        const bright = r() < 0.35;
        return bright ? vary([255, 200, 60], 18, r) : vary([200, 140, 30], 14, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_luminescence: (img, r) =>
    tileRegion(img, TILES.ore_luminescence, (x, y) => {
      if (r() < 0.08) return vary([52, 52, 58], 8, r);
      const crystal = (x * 7 + y * 5) % 10 < 3 && r() < 0.5;
      if (crystal) {
        const bright = r() < 0.4;
        return bright ? vary([140, 255, 220], 20, r) : vary([60, 180, 150], 16, r);
      }
      return vary([108, 108, 114], 14, r);
    }),
  ore_diamond: (img, r) =>
    tileRegion(img, TILES.ore_diamond, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const crystal = (x * 4 + y * 6) % 10 < 3 && r() < 0.4;
      if (crystal) {
        const bright = r() < 0.35;
        return bright ? vary([180, 240, 255], 18, r) : vary([80, 180, 220], 14, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_gold: (img, r) =>
    tileRegion(img, TILES.ore_gold, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const fleck = (x * 6 + y * 4) % 8 < 2 && r() < 0.5;
      if (fleck) {
        const bright = r() < 0.4;
        return bright ? vary([255, 220, 80], 20, r) : vary([200, 160, 40], 14, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_silver: (img, r) =>
    tileRegion(img, TILES.ore_silver, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const fleck = (x * 5 + y * 7) % 9 < 2 && r() < 0.5;
      if (fleck) {
        const bright = r() < 0.4;
        return bright ? vary([230, 235, 240], 15, r) : vary([170, 175, 180], 12, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_jade: (img, r) =>
    tileRegion(img, TILES.ore_jade, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const crystal = (x * 4 + y * 5) % 9 < 3 && r() < 0.45;
      if (crystal) {
        const bright = r() < 0.35;
        return bright ? vary([140, 220, 160], 16, r) : vary([70, 150, 90], 14, r);
      }
      return vary([118, 118, 124], 14, r);
    }),
  ore_emerald: (img, r) =>
    tileRegion(img, TILES.ore_emerald, (x, y) => {
      if (r() < 0.08) return vary([62, 62, 68], 8, r);
      const crystal = (x * 6 + y * 4) % 10 < 3 && r() < 0.4;
      if (crystal) {
        const bright = r() < 0.35;
        return bright ? vary([80, 255, 120], 18, r) : vary([30, 160, 80], 14, r);
      }
      return vary([118, 118, 124], 14, r);
    }),

  coal_ore: (img, r) =>
    tileRegion(img, TILES.coal_ore, (x, y) => {
      const chunk = (x * 5 + y * 3) % 9 < 3 && r() < 0.55;
      if (chunk) {
        const bright = r() < 0.25;
        return bright ? vary([64, 64, 68], 10, r) : vary([26, 26, 30], 8, r);
      }
      return vary([118, 118, 124], 14, r);
    }),

  coal: (img, r) =>
    tileRegion(img, TILES.coal, (x, y) => {
      const dx = x - 8, dy = y - 8;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 6.2) return null;
      if (d < 2.2 && r() < 0.6) return vary([70, 70, 76], 12, r);
      return vary([28, 28, 32], 10, r);
    }),

  stick: (img, r) =>
    tileRegion(img, TILES.stick, (x, y) => {
      if (Math.abs((x) - (15 - y)) <= 1) return vary([138, 100, 58], 14, r);
      if (Math.abs((x) - (15 - y)) === 2) return vary([96, 68, 38], 10, r);
      return null;
    }),

  torch: (img, r) => {
    void r;
    return tileRegion(img, TILES.torch, (x, y) => {
      const cx = x >= 6 && x <= 9;
      if (cx && y >= 6) {
        if (y === 6) return [120, 88, 50];
        return (x === 6) ? [96, 68, 38] : (x === 9 ? [80, 56, 32] : [138, 100, 58]);
      }
      if (x >= 6 && x <= 9 && y >= 4 && y <= 5) return [40, 30, 24];
      const fx = x - 7.5, fy = y - 2;
      const df = Math.sqrt(fx * fx + fy * fy * 0.6);
      if (y <= 5) {
        if (df < 1.3) return [255, 246, 200];
        if (df < 2.4) return [255, 200, 70];
        if (df < 3.4) return [240, 130, 30];
      }
      return null;
    });
  },

  conveyor_top_n: (img) => paintBeltTop(img, TILES.conveyor_top_n, 0, 0),
  conveyor_top_e: (img) => paintBeltTop(img, TILES.conveyor_top_e, 1, 0),
  conveyor_top_s: (img) => paintBeltTop(img, TILES.conveyor_top_s, 2, 0),
  conveyor_top_w: (img) => paintBeltTop(img, TILES.conveyor_top_w, 3, 0),
  conveyor_side: (img, r) =>
    tileRegion(img, TILES.conveyor_side, (x, y) => {
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([42, 42, 48], 5, r);
      if (y >= 5 && y <= 10 && (x <= 4 || x >= 11)) {
        const cx = x <= 4 ? 2.5 : 13.5;
        const dx = x - cx, dy = y - 7.5;
        if (dx * dx + dy * dy < 5) return vary([100, 100, 106], 8, r);
      }
      if (y >= 3 && y <= 5) return vary([58, 58, 64], 6, r);
      return vary([66, 66, 72], 8, r);
    }),

  inserter_top_n: (img, r) => paintInserterTop(img, TILES.inserter_top_n, 0, r),
  inserter_top_e: (img, r) => paintInserterTop(img, TILES.inserter_top_e, 1, r),
  inserter_top_s: (img, r) => paintInserterTop(img, TILES.inserter_top_s, 2, r),
  inserter_top_w: (img, r) => paintInserterTop(img, TILES.inserter_top_w, 3, r),
  inserter_side: (img, r) =>
    tileRegion(img, TILES.inserter_side, (x, y) => {
      const rim = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
      if (rim) return vary([40, 40, 46], 5, r);
      if (x >= 5 && x <= 10 && y >= 2) {
        if (x === 5 || x === 10) return vary([100, 100, 108], 8, r);
        if (y === 8 || y === 9) return vary([226, 146, 34], 10, r);
        return vary([62, 62, 70], 8, r);
      }
      if (y >= 12 && y <= 14 && x % 3 !== 0) return vary([30, 30, 34], 4, r);
      return vary([56, 56, 62], 8, r);
    }),
};


export interface TextureSet {
  atlas: THREE.CanvasTexture;
  water: THREE.CanvasTexture;
  cracks: THREE.CanvasTexture[];
  atlasCanvas: HTMLCanvasElement;
  atlasImg: ImageData;
  atlasCtx: CanvasRenderingContext2D;
}

export function tileUV(tile: number): [number, number, number, number] {
  const col = tile % ATLAS_COLS;
  const row = Math.floor(tile / ATLAS_COLS);
  const e = 0.02;
  const u0 = (col * TILE + e) / ATLAS_W;
  const u1 = ((col + 1) * TILE - e) / ATLAS_W;
  const vTop = 1 - (row * TILE + e) / ATLAS_H;
  const vBottom = 1 - ((row + 1) * TILE - e) / ATLAS_H;
  return [u0, vBottom, u1, vTop];
}

export function makeBucketIcon(size = 44): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const off = document.createElement('canvas');
  off.width = TILE;
  off.height = TILE;
  const octx = off.getContext('2d')!;
  const px = (x: number, y: number, col: string) => {
    octx.fillStyle = col;
    octx.fillRect(x, y, 1, 1);
  };
  const row = (x0: number, x1: number, y: number, col: string) => {
    octx.fillStyle = col;
    octx.fillRect(x0, y, x1 - x0 + 1, 1);
  };
  const SILVER = '#c8ced6';
  const STEEL = '#8d969e';
  const DARK = '#5c646c';
  px(4, 3, STEEL); px(5, 2, STEEL); px(6, 1, STEEL); px(7, 1, STEEL);
  px(8, 1, STEEL); px(9, 1, STEEL); px(10, 2, STEEL); px(11, 3, STEEL);
  row(4, 11, 4, SILVER);
  for (let y = 5; y <= 12; y++) {
    px(4, y, STEEL);
    px(11, y, DARK);
    for (let x = 5; x <= 10; x++) {
      if (y === 5) px(x, y, x === 6 || x === 9 ? '#6f93f2' : '#4a74e8');
      else if (y <= 9) px(x, y, '#4266d8');
      else if (y <= 12) px(x, y, '#3554b8');
    }
  }
  row(5, 10, 13, DARK);
  row(5, 10, 12, STEEL);
  for (let y = 6; y <= 11; y++) px(5, y, '#4f71db');
  ctx.drawImage(off, 0, 0, TILE, TILE, 0, 0, size, size);
  return c.toDataURL();
}

export function makeIcon(atlasCanvas: HTMLCanvasElement, tile: number, size = 44): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const sx = (tile % TPR) * TILE;
  const sy = Math.floor(tile / TPR) * TILE;
  ctx.drawImage(atlasCanvas, sx, sy, TILE, TILE, 0, 0, size, size);
  return c.toDataURL();
}

function configure(tex: THREE.CanvasTexture, nearest = true): THREE.CanvasTexture {
  if (nearest) {
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
  }
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCrackTexture(stage: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TILE;
  c.height = TILE;
  const ctx = c.getContext('2d')!;
  const r = mulberry32(9001 + stage * 137);
  ctx.clearRect(0, 0, TILE, TILE);
  ctx.fillStyle = 'rgba(24, 20, 16, 0.92)';
  const walkers = 2 + stage * 2;
  for (let w = 0; w < walkers; w++) {
    let x = 2 + Math.floor(r() * 12);
    let y = 2 + Math.floor(r() * 12);
    const steps = 6 + stage * 4 + Math.floor(r() * 6);
    for (let s = 0; s < steps; s++) {
      ctx.fillRect(x, y, 1, 1);
      if (r() < 0.5) x += r() < 0.5 ? -1 : 1;
      else y += r() < 0.5 ? -1 : 1;
      x = Math.max(0, Math.min(TILE - 1, x));
      y = Math.max(0, Math.min(TILE - 1, y));
    }
  }
  return configure(new THREE.CanvasTexture(c));
}

export function createTextures(theme?: PlanetTheme | null): TextureSet {
  const tints = tintsFromTheme(theme);
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_W;
  canvas.height = ATLAS_H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(ATLAS_W, ATLAS_H);

  TILE_NAMES.forEach((name, i) => {
    const painter = PAINTERS[name];
    if (painter) painter(img, mulberry32(1337 + i * 7919));
    if (tints) {
      const g = TILE_GROUP[name];
      if (g && tints[g]) tintTile(img, TILES[name], tints[g]);
    }
  });
  ctx.putImageData(img, 0, 0);

  const wc = document.createElement('canvas');
  wc.width = TILE;
  wc.height = TILE;
  const wctx = wc.getContext('2d')!;
  const wimg = wctx.createImageData(TILE, TILE);
  const wr = mulberry32(4242);
  const wm = tints?.water ?? ([1, 1, 1] as RGB);
  for (let y = 0; y < TILE; y++)
    for (let x = 0; x < TILE; x++) {
      const wave = (x + y * 3) % 7 === 0;
      const c = wave ? vary([92, 138, 244], 8, wr) : vary([58, 102, 222], 10, wr);
      put(wimg.data, TILE, x, y, [
        Math.max(0, Math.min(255, c[0] * wm[0])),
        Math.max(0, Math.min(255, c[1] * wm[1])),
        Math.max(0, Math.min(255, c[2] * wm[2])),
      ] as const);
    }
  wctx.putImageData(wimg, 0, 0);
  const water = configure(new THREE.CanvasTexture(wc));
  water.wrapS = THREE.RepeatWrapping;
  water.wrapT = THREE.RepeatWrapping;

  return {
    atlas: configure(new THREE.CanvasTexture(canvas)),
    water,
    cracks: [0, 1, 2, 3, 4].map(makeCrackTexture),
    atlasCanvas: canvas,
    atlasImg: img,
    atlasCtx: ctx,
  };
}
