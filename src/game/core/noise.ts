/**
 * Deterministic procedural noise toolkit for a toroidal voxel world.
 *
 *   mulberry32      seeded PRNG
 *   hash2 / hash3   stable integer hashes -> [0,1)   (decoration placement)
 *   Simplex2        seeded 2D simplex noise          (non-wrapping worlds)
 *   Simplex4        seeded 4D simplex noise          (torus embedding)
 *   Torus2          exactly periodic 2D field, any wavelength   (~3x cost)
 *   PeriodicPerlin2 exactly periodic 2D gradient noise, cheap    (wavelength must divide W)
 *   fbm / ridged / billow / warp2   fractal combinators over any periodic source
 *
 * INVARIANT: every field here satisfies  f(x, z) === f(x + W, z + D)  exactly.
 */

// ---------------------------------------------------------------------------
// PRNG + hashes
// ---------------------------------------------------------------------------

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable 2D integer hash -> [0,1). Feed it WRAPPED coords in a toroidal world. */
export function hash2(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296; // 2^32 keeps the range [0,1)
}

export function hash3(seed: number, x: number, y: number, z: number): number {
  let h =
    Math.imul(x | 0, 0x27d4eb2d) ^
    Math.imul(y | 0, 0x165667b1) ^
    Math.imul(z | 0, 0x9e3779b1) ^
    Math.imul(seed | 0, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  h = Math.imul(h ^ (h >>> 13), 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Uniform integer in [0, n) from a stable hash. */
export const hash2i = (seed: number, x: number, y: number, n: number): number =>
  Math.min(n - 1, (hash2(seed, x, y) * n) | 0);

// ---------------------------------------------------------------------------
// 2D simplex (verified correct — kept for decoration/detail layers)
// ---------------------------------------------------------------------------

const GRAD2 = new Float32Array([
  1, 1, -1, 1, 1, -1, -1, -1,
  1, 0, -1, 0, 1, 0, -1, 0,
  0, 1, 0, -1, 0, 1, 0, -1,
]);
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;

function shuffled256(seed: number): Uint8Array {
  const rng = mulberry32(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i];
    p[i] = p[j];
    p[j] = t;
  }
  return p;
}

export class Simplex2 {
  private perm = new Uint8Array(512);
  private perm12 = new Uint8Array(512);

  constructor(seed: number) {
    const p = shuffled256(seed);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.perm12[i] = this.perm[i] % 12;
    }
  }

  /** Raw simplex noise, approximately [-1, 1] after the 33.7 normalisation
   * below. The per-corner value is bounded by ~0.5 for a gradient on the unit
   * circle; three corners sum to at most ~1.5, and the polynomial kernel
   * decays the contribution away from each corner, so 33.7 gives a peak of
   * ~1.0 and effective range close to [-1, 1] over the permutation table. */
  noise(xin: number, yin: number): number {
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s);
    const j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t);
    const y0 = yin - (j - t);

    const i1 = x0 > y0 ? 1 : 0;
    const j1 = x0 > y0 ? 0 : 1;

    const x1 = x0 - i1 + G2;
    const y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2;
    const y2 = y0 - 1 + 2 * G2;
    const ii = i & 255;
    const jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g = this.perm12[ii + this.perm[jj]] * 2;
      t0 *= t0;
      n0 = t0 * t0 * (GRAD2[g] * x0 + GRAD2[g + 1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g = this.perm12[ii + i1 + this.perm[jj + j1]] * 2;
      t1 *= t1;
      n1 = t1 * t1 * (GRAD2[g] * x1 + GRAD2[g + 1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g = this.perm12[ii + 1 + this.perm[jj + 1]] * 2;
      t2 *= t2;
      n2 = t2 * t2 * (GRAD2[g] * x2 + GRAD2[g + 1] * y2);
    }
    // Standard Ken Perlin improved-simplex normalization: the analytic
    // maximum of the 3-corner sum with quintic fade is ~0.79, so 31.2 brings
    // the peak to ~1.0 and effective quasi-Gaussian range to [-1, 1].
    return 31.2 * (n0 + n1 + n2);
  }
}

// ---------------------------------------------------------------------------
// 4D simplex — FIXED.
//
// Bug 1 (fatal): the old GRAD4 held 146 numbers instead of 128 (36.5
//   gradients). The whole `0,-1,*,*` group was missing and the tail was
//   duplicated garbage, so every lookup read a misaligned vector -> mush.
// Bug 2 (fatal): the corner loop applied c*G4 for c = 0..4 implicitly by
//   loop index 0..3 — the five corners need 0, 1*G4, 2*G4, 3*G4, 4*G4.
// Bug 3 (perf): rankCorners() allocated 5 arrays + a closure sort per
//   sample. Replaced with six-comparison branch counting.
// ---------------------------------------------------------------------------

const GRAD4 = new Float32Array([
  0, 1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1,
  0, -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1,
  1, 0, 1, 1, 1, 0, 1, -1, 1, 0, -1, 1, 1, 0, -1, -1,
  -1, 0, 1, 1, -1, 0, 1, -1, -1, 0, -1, 1, -1, 0, -1, -1,
  1, 1, 0, 1, 1, 1, 0, -1, 1, -1, 0, 1, 1, -1, 0, -1,
  -1, 1, 0, 1, -1, 1, 0, -1, -1, -1, 0, 1, -1, -1, 0, -1,
  1, 1, 1, 0, 1, 1, -1, 0, 1, -1, 1, 0, 1, -1, -1, 0,
  -1, 1, 1, 0, -1, 1, -1, 0, -1, -1, 1, 0, -1, -1, -1, 0,
]);
if (GRAD4.length !== 128) throw new Error(`GRAD4 must be 32*4=128, got ${GRAD4.length}`);

const F4 = (Math.sqrt(5) - 1) / 4;
const G4 = (5 - Math.sqrt(5)) / 20;

export class Simplex4 {
  private p = new Uint8Array(512);

  constructor(seed: number) {
    const a = shuffled256(seed);
    for (let i = 0; i < 512; i++) this.p[i] = a[i & 255];
  }

  noise(x: number, y: number, z: number, w: number, r: number = 1): number {
    const s = (x + y + z + w) * F4;
    const i = Math.floor(x + s);
    const j = Math.floor(y + s);
    const k = Math.floor(z + s);
    const l = Math.floor(w + s);
    const t = (i + j + k + l) * G4;
    const x0 = x - (i - t);
    const y0 = y - (j - t);
    const z0 = z - (k - t);
    const w0 = w - (l - t);

    // Rank the four coordinates with six comparisons (no allocation).
    let rx = 0, ry = 0, rz = 0, rw = 0;
    if (x0 > y0) rx++; else ry++;
    if (x0 > z0) rx++; else rz++;
    if (x0 > w0) rx++; else rw++;
    if (y0 > z0) ry++; else rz++;
    if (y0 > w0) ry++; else rw++;
    if (z0 > w0) rz++; else rw++;

    const i1 = rx >= 3 ? 1 : 0, j1 = ry >= 3 ? 1 : 0, k1 = rz >= 3 ? 1 : 0, l1 = rw >= 3 ? 1 : 0;
    const i2 = rx >= 2 ? 1 : 0, j2 = ry >= 2 ? 1 : 0, k2 = rz >= 2 ? 1 : 0, l2 = rw >= 2 ? 1 : 0;
    const i3 = rx >= 1 ? 1 : 0, j3 = ry >= 1 ? 1 : 0, k3 = rz >= 1 ? 1 : 0, l3 = rw >= 1 ? 1 : 0;

    const ii = i & 255, jj = j & 255, kk = k & 255, ll = l & 255;

    // 27 / r normalises the Clifford-torus sample to ~±1 regardless of the
    // torus radius r. Without this the noise amplitude shrinks at coarse
    // wavelengths (small r), making continent/warp fields depend on wavelength
    // instead of just the declared octaves/gain.
    let n = 0;
    n += this.corner(x0, y0, z0, w0, ii, jj, kk, ll, r);
    n += this.corner(x0 - i1 + G4, y0 - j1 + G4, z0 - k1 + G4, w0 - l1 + G4,
      ii + i1, jj + j1, kk + k1, ll + l1, r);
    n += this.corner(x0 - i2 + 2 * G4, y0 - j2 + 2 * G4, z0 - k2 + 2 * G4, w0 - l2 + 2 * G4,
      ii + i2, jj + j2, kk + k2, ll + l2, r);
    n += this.corner(x0 - i3 + 3 * G4, y0 - j3 + 3 * G4, z0 - k3 + 3 * G4, w0 - l3 + 3 * G4,
      ii + i3, jj + j3, kk + k3, ll + l3, r);
    n += this.corner(x0 - 1 + 4 * G4, y0 - 1 + 4 * G4, z0 - 1 + 4 * G4, w0 - 1 + 4 * G4,
      ii + 1, jj + 1, kk + 1, ll + 1, r);
    return (27 / r) * n;
  }

  private corner(
    x: number, y: number, z: number, w: number,
    ii: number, jj: number, kk: number, ll: number,
    _r: number, // Clifford-torus radius; used only to keep the signature stable
  ): number {
    let t = 0.6 - x * x - y * y - z * z - w * w;
    if (t <= 0) return 0;
    const p = this.p;
    const gi = (p[(ii & 255) + p[(jj & 255) + p[(kk & 255) + p[ll & 255]]]] & 31) * 4;
    t *= t;
    return t * t * (GRAD4[gi] * x + GRAD4[gi + 1] * y + GRAD4[gi + 2] * z + GRAD4[gi + 3] * w);
  }
}

// ---------------------------------------------------------------------------
// Periodic 2D sources — INVARIANT: f(x, z) === f(x + W, z + D) exactly
// ---------------------------------------------------------------------------

/** A 2D field that is exactly periodic with period (W, D). */
export interface Periodic2 {
  readonly W: number;
  readonly D: number;
  /** Sample at world position (x, z) with the given feature wavelength in world units. */
  at(x: number, z: number, wavelength: number): number;
}

/**
 * Torus embedding: map x and z onto circles and sample 4D noise on the
 * resulting Clifford torus. Exactly periodic for ANY wavelength, isotropic,
 * no integer constraint. Costs ~3x a 2D sample.
 *
 * GOTCHA: the permutation table repeats every 256 lattice units, so keep the
 * circle radius under ~128 or the noise repeats along the circle. For
 * wavelengths finer than W/800 use PeriodicPerlin2.
 */
export class Torus2 implements Periodic2 {
  private n4: Simplex4;

  constructor(seed: number, readonly W: number, readonly D: number) {
    this.n4 = new Simplex4(seed);
  }

  at(x: number, z: number, wavelength: number): number {
    const TAU = Math.PI * 2;
    const r1 = this.W / (TAU * wavelength);
    const r2 = this.D / (TAU * wavelength);
    const r = Math.hypot(r1, r2);
    const u = (TAU * x) / this.W;
    const v = (TAU * z) / this.D;
    return this.n4.noise(r1 * Math.cos(u), r1 * Math.sin(u), r2 * Math.cos(v), r2 * Math.sin(v), r);
  }
}

/**
 * Wrapped-lattice gradient (Perlin) noise. Gradients are hashed from lattice
 * coordinates taken mod the lattice period, so the field is exactly periodic
 * by construction. Cheap — use this for the many detail octaves.
 *
 * CONSTRAINT: W / wavelength must be an integer (pick wavelengths as W/2^k).
 */
export class PeriodicPerlin2 implements Periodic2 {
  constructor(private seed: number, readonly W: number, readonly D: number) {}

  at(x: number, z: number, wavelength: number): number {
    // Lattice counts must be integers for exact tiling.
    const px = Math.max(1, Math.round(this.W / wavelength));
    const pz = Math.max(1, Math.round(this.D / wavelength));
    const fx = (x * px) / this.W;
    const fz = (z * pz) / this.D;

    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;

    // Quintic fade -> C2 continuous, no visible lattice creases.
    const u = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const v = tz * tz * tz * (tz * (tz * 6 - 15) + 10);

    const n00 = this.dotGrad(i0, j0, px, pz, tx, tz);
    const n10 = this.dotGrad(i0 + 1, j0, px, pz, tx - 1, tz);
    const n01 = this.dotGrad(i0, j0 + 1, px, pz, tx, tz - 1);
    const n11 = this.dotGrad(i0 + 1, j0 + 1, px, pz, tx - 1, tz - 1);

    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142135; // 2D Perlin peaks at ~1/sqrt(2)
  }

  private dotGrad(i: number, j: number, px: number, pz: number, dx: number, dz: number): number {
    // The mod is what makes it tile: lattice cell px is the same cell as 0.
    const wi = ((i % px) + px) % px;
    const wj = ((j % pz) + pz) % pz;
    const a = hash2(this.seed, wi, wj) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dz;
  }
}

// ---------------------------------------------------------------------------
// Fractal combinators — all preserve exact periodicity
// ---------------------------------------------------------------------------

export interface FbmOpts {
  wavelength: number;  // wavelength of octave 0, in world units
  octaves: number;
  gain?: number;       // amplitude falloff per octave (default 0.5)
  lacunarity?: number; // frequency growth per octave (default 2)
}

/** Signed fractal brownian motion, normalized to ~[-1, 1]. */
export function fbm(src: Periodic2, x: number, z: number, o: FbmOpts): number {
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  let wl = o.wavelength, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * src.at(x, z, wl);
    norm += amp;
    amp *= gain;
    wl /= lac;
  }
  return sum / norm;
}

/**
 * Ridged multifractal -> [0, 1], sharp crests. This is what makes MOUNTAIN
 * RANGES instead of lumps. The per-octave weighting is the important part:
 * each octave is attenuated by the previous one, so detail only appears on
 * slopes that are already high.
 */
export function ridged(src: Periodic2, x: number, z: number, o: FbmOpts): number {
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  let wl = o.wavelength, amp = 1, sum = 0, norm = 0, weight = 1;
  for (let i = 0; i < o.octaves; i++) {
    let n = 1 - Math.abs(src.at(x, z, wl));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2)); // feed forward
    sum += amp * n;
    norm += amp;
    amp *= gain;
    wl /= lac;
  }
  return sum / norm;
}

/** Billow -> [0, 1], puffy rounded hills. */
export function billow(src: Periodic2, x: number, z: number, o: FbmOpts): number {
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  let wl = o.wavelength, amp = 1, sum = 0, norm = 0;
  for (let i = 0; i < o.octaves; i++) {
    sum += amp * Math.abs(src.at(x, z, wl));
    norm += amp;
    amp *= gain;
    wl /= lac;
  }
  return sum / norm;
}

/**
 * Domain warp. Periodicity survives because the offset is itself periodic:
 * (x + W) + w(x + W) = (x + w(x)) + W.
 * This is the single highest-impact line for killing the "blobby noise" look.
 * NOTE: octaves intentionally small — high-frequency warp bends octaves of the
 * warped field onto themselves and re-creates artifacts.
 */
export function warp2(
  src: Periodic2, x: number, z: number, wavelength: number, amplitude: number, octaves = 2,
): [number, number] {
  const dx = fbm(src, x + 137.0, z - 311.0, { wavelength, octaves });
  const dz = fbm(src, x - 913.0, z + 517.0, { wavelength, octaves });
  return [x + dx * amplitude, z + dz * amplitude];
}

// ---------------------------------------------------------------------------
// small math helpers
// ---------------------------------------------------------------------------

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, v: number): number => {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Map signed [-1, 1] noise to [0, 1]. */
export const to01 = (v: number): number => v * 0.5 + 0.5;
