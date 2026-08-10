import * as THREE from 'three';

export interface PartDef {
  ax: number; ay: number; az: number;   // pivot, enemy-local (feet origin)
  sx: number; sy: number; sz: number;   // box size, always positive
  swing: 0 | 1 | -1 | 2 | -2;           // walk swing channel
  hang: 0 | 1;                          // box hangs below pivot
  tint: 0 | 1;                          // 0 = black body,  1 = red eye (unlit)
}

// All body parts use tint 0 (pure black, lit by Lambert).
// Eye parts use tint 1 (unlit bright red, rendered on the eye mesh).
// Gun is removed — all-black silhouette reads cleaner than a small dark rod.

const LOD0: PartDef[] = [
  // head
  { ax:  0.00, ay: 1.55, az: 0.00, sx: 0.34, sy: 0.30, sz: 0.34, swing: 0, hang: 0, tint: 0 },
  // torso
  { ax:  0.00, ay: 1.08, az: 0.00, sx: 0.42, sy: 0.52, sz: 0.24, swing: 0, hang: 0, tint: 0 },
  // arms
  { ax: -0.28, ay: 1.28, az: 0.00, sx: 0.14, sy: 0.58, sz: 0.14, swing:  2, hang: 1, tint: 0 },
  { ax:  0.28, ay: 1.28, az: 0.00, sx: 0.14, sy: 0.58, sz: 0.14, swing: -2, hang: 1, tint: 0 },
  // legs
  { ax: -0.12, ay: 0.80, az: 0.00, sx: 0.16, sy: 0.80, sz: 0.18, swing: -1, hang: 1, tint: 0 },
  { ax:  0.12, ay: 0.80, az: 0.00, sx: 0.16, sy: 0.80, sz: 0.18, swing:  1, hang: 1, tint: 0 },
  // eyes (tint 1 = unlit red) — sit on the front face of the head
  { ax: -0.10, ay: 1.60, az: 0.17, sx: 0.10, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
  { ax:  0.10, ay: 1.60, az: 0.17, sx: 0.10, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
];

const LOD1: PartDef[] = [
  // head
  { ax:  0.00, ay: 1.52, az: 0.00, sx: 0.34, sy: 0.30, sz: 0.34, swing: 0, hang: 0, tint: 0 },
  // merged torso + legs
  { ax:  0.00, ay: 1.08, az: 0.00, sx: 0.56, sy: 0.78, sz: 0.28, swing: 0, hang: 0, tint: 0 },
  { ax:  0.00, ay: 0.78, az: 0.00, sx: 0.42, sy: 0.78, sz: 0.22, swing: 1, hang: 1, tint: 0 },
  // eyes
  { ax: -0.09, ay: 1.57, az: 0.17, sx: 0.10, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
  { ax:  0.09, ay: 1.57, az: 0.17, sx: 0.10, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
];

const LOD2: PartDef[] = [
  // single body slab
  { ax: 0.00, ay: 0.90, az: 0.00, sx: 0.50, sy: 1.80, sz: 0.34, swing: 0, hang: 0, tint: 0 },
  // eyes (small so they stay readable at distance)
  { ax: -0.09, ay: 1.20, az: 0.17, sx: 0.09, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
  { ax:  0.09, ay: 1.20, az: 0.17, sx: 0.09, sy: 0.05, sz: 0.03, swing: 0, hang: 0, tint: 1 },
];

export const LOD_PARTS: PartDef[][] = [LOD0, LOD1, LOD2];

export const PRESET_SCALE: Record<string, number> = {
  grunt:  1.00,
  runner: 0.90,
  heavy:  1.22,
};

// Single black palette (tint 0). Eye color is baked into the eye mesh material.
export const BLACK_COLOR = new THREE.Color(0x0a0a0a);
