

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash2(seed: number, x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
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

export const hash2i = (seed: number, x: number, y: number, n: number): number =>
  Math.min(n - 1, (hash2(seed, x, y) * n) | 0);


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
    return 31.2 * (n0 + n1 + n2);
  }
}


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
    _r: number,
  ): number {
    let t = 0.6 - x * x - y * y - z * z - w * w;
    if (t <= 0) return 0;
    const p = this.p;
    const gi = (p[(ii & 255) + p[(jj & 255) + p[(kk & 255) + p[ll & 255]]]] & 31) * 4;
    t *= t;
    return t * t * (GRAD4[gi] * x + GRAD4[gi + 1] * y + GRAD4[gi + 2] * z + GRAD4[gi + 3] * w);
  }
}


export interface Periodic2 {
  readonly W: number;
  readonly D: number;
  at(x: number, z: number, wavelength: number): number;
}

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

export class PeriodicPerlin2 implements Periodic2 {
  constructor(private seed: number, readonly W: number, readonly D: number) {}

  at(x: number, z: number, wavelength: number): number {
    const px = Math.max(1, Math.round(this.W / wavelength));
    const pz = Math.max(1, Math.round(this.D / wavelength));
    const fx = (x * px) / this.W;
    const fz = (z * pz) / this.D;

    const i0 = Math.floor(fx), j0 = Math.floor(fz);
    const tx = fx - i0, tz = fz - j0;

    const u = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const v = tz * tz * tz * (tz * (tz * 6 - 15) + 10);

    const n00 = this.dotGrad(i0, j0, px, pz, tx, tz);
    const n10 = this.dotGrad(i0 + 1, j0, px, pz, tx - 1, tz);
    const n01 = this.dotGrad(i0, j0 + 1, px, pz, tx, tz - 1);
    const n11 = this.dotGrad(i0 + 1, j0 + 1, px, pz, tx - 1, tz - 1);

    const a = n00 + u * (n10 - n00);
    const b = n01 + u * (n11 - n01);
    return (a + v * (b - a)) * 1.4142135;
  }

  private dotGrad(i: number, j: number, px: number, pz: number, dx: number, dz: number): number {
    const wi = ((i % px) + px) % px;
    const wj = ((j % pz) + pz) % pz;
    const a = hash2(this.seed, wi, wj) * Math.PI * 2;
    return Math.cos(a) * dx + Math.sin(a) * dz;
  }
}


export interface FbmOpts {
  wavelength: number;
  octaves: number;
  gain?: number;
  lacunarity?: number;
}

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

export function ridged(src: Periodic2, x: number, z: number, o: FbmOpts): number {
  const gain = o.gain ?? 0.5;
  const lac = o.lacunarity ?? 2;
  let wl = o.wavelength, amp = 1, sum = 0, norm = 0, weight = 1;
  for (let i = 0; i < o.octaves; i++) {
    let n = 1 - Math.abs(src.at(x, z, wl));
    n *= n;
    n *= weight;
    weight = Math.min(1, Math.max(0, n * 2));
    sum += amp * n;
    norm += amp;
    amp *= gain;
    wl /= lac;
  }
  return sum / norm;
}

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

export function warp2(
  src: Periodic2, x: number, z: number, wavelength: number, amplitude: number, octaves = 2,
): [number, number] {
  const dx = fbm(src, x + 137.0, z - 311.0, { wavelength, octaves });
  const dz = fbm(src, x - 913.0, z + 517.0, { wavelength, octaves });
  return [x + dx * amplitude, z + dz * amplitude];
}


export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (e0: number, e1: number, v: number): number => {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
export const to01 = (v: number): number => v * 0.5 + 0.5;
