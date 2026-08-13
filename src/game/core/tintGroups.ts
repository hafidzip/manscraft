export type RGB = readonly [number, number, number];

export const TINT_REF: Record<string, RGB> = {
  grass: [145, 189, 89],
  dirt: [121, 85, 58],
  stone: [128, 128, 128],
  sand: [219, 207, 163],
  leaves: [56, 120, 40],
  log: [104, 76, 44],
  planks: [164, 129, 80],
  snow: [238, 246, 248],
  water: [58, 102, 222],
  cactus: [62, 138, 56],

  leaves_birch: [105, 151, 60],
  leaves_spruce: [31, 79, 63],
  leaves_autumn: [180, 111, 30],
  leaves_jungle: [42, 113, 34],
  leaves_alien: [159, 60, 176],
  leaves_crimson: [153, 37, 40],
  leaves_neon: [43, 193, 162],
  leaves_crystal: [124, 182, 214],
  leaves_snow: [232, 240, 242],
  log_birch: [214, 210, 196],
  log_spruce: [74, 54, 38],
  log_palm: [122, 98, 62],
  log_alien: [96, 70, 124],
};

export const GROUP_H: Record<string, number> = {
  grass: 0.14,
  leaves: 0.22,
  dirt: 0.08,
  sand: 0.04,
  stone: 0.5,
  log: 0.3,
  planks: 0.36,
  water: -0.2,
  cactus: 0.18,

  leaves_birch: 0.26,
  leaves_spruce: 0.16,
  leaves_autumn: 0.44,
  leaves_jungle: 0.20,
  leaves_alien: 0.58,
  leaves_crimson: 0.66,
  leaves_neon: 0.72,
  leaves_crystal: 0.82,
  log_birch: 0.34,
  log_spruce: 0.26,
  log_palm: 0.30,
  log_alien: 0.52,
};

export const TINT_STRENGTH = 0.85;

export const TINT_LO = 0.22;
export const TINT_HI = 2.4;

export const GROUP_STRENGTH: Record<string, number> = {
  leaves: TINT_STRENGTH,
  leaves_birch: 0.30,
  leaves_spruce: 0.35,
  leaves_autumn: 0.20,
  leaves_jungle: 0.55,
  leaves_alien: 0.45,
  leaves_crimson: 0.30,
  leaves_neon: 0.35,
  leaves_crystal: 0.40,
  leaves_snow: 0.12,
  log_birch: 0.15,
  log_spruce: 0.35,
  log_palm: 0.40,
  log_alien: 0.50,
};

export const strengthFor = (group: string): number => GROUP_STRENGTH[group] ?? TINT_STRENGTH;
