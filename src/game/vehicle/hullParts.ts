import type { Part } from '../vfx/laserTool';

const STEEL = 0x9aa4ae;
const STEEL_HI = 0xc9d1d9;
const HULL_DARK = 0x39404a;
const HAZARD = 0xe0a53c;
const CANOPY = 0x4fd8ec;
const GLOW = 0xffffff;

const p = (x: number, y: number, z: number, w: number, h: number, d: number, c: number): Part =>
  ({ x, y, z, w, h, d, c });

export const HULL_PARTS: Part[] = [
  p(0, 1.0, -0.2, 1.6, 0.9, 5.2, STEEL),
  p(0, 1.05, -3.1, 1.4, 0.7, 1.1, STEEL_HI),
  p(0, 1.0, -3.9, 0.85, 0.55, 0.8, STEEL_HI),
  p(0, 0.55, 0.1, 1.1, 0.5, 3.6, HULL_DARK),
  p(0, 1.56, -1.35, 1.5, 0.45, 1.5, HULL_DARK),
  p(-1.95, 0.92, 0.3, 2.4, 0.26, 1.7, STEEL),
  p(-3.15, 0.92, 1.05, 1.5, 0.24, 1.0, STEEL_HI),
  p(1.95, 0.92, 0.3, 2.4, 0.26, 1.7, STEEL),
  p(3.15, 0.92, 1.05, 1.5, 0.24, 1.0, STEEL_HI),
  p(-2.9, 1.08, 0.15, 0.9, 0.12, 0.9, HAZARD),
  p(2.9, 1.08, 0.15, 0.9, 0.12, 0.9, HAZARD),
  p(0, 1.85, 1.95, 0.24, 1.5, 1.1, STEEL),
  p(0, 2.4, 2.15, 0.24, 0.5, 0.6, HAZARD),
  p(-1.15, 0.95, 2.35, 0.95, 0.85, 1.7, HULL_DARK),
  p(1.15, 0.95, 2.35, 0.95, 0.85, 1.7, HULL_DARK),
  p(0, 0.9, 2.85, 1.2, 0.95, 1.0, HULL_DARK),
  ...([[-1.35, -0.9], [1.35, -0.9], [-1.35, 1.3], [1.35, 1.3]] as const).flatMap(([x, z]) => [
    p(x, 0.25, z, 0.18, 0.5, 0.18, HULL_DARK),
    p(x, -0.02, z, 0.34, 0.08, 0.34, STEEL_HI),
  ]),
];

export const GLOW_PARTS: Part[] = [
  p(0, 1.62, -1.45, 1.1, 0.34, 1.0, CANOPY),
  p(-1.15, 0.95, 3.25, 0.62, 0.5, 0.18, GLOW),
  p(1.15, 0.95, 3.25, 0.62, 0.5, 0.18, GLOW),
  p(0, 0.9, 3.42, 0.85, 0.6, 0.2, GLOW),
  p(0, 0.5, -2.2, 0.9, 0.12, 0.9, 0x6f8fd0),
];
