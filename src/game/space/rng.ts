// ---------------------------------------------------------------------------
// Deterministic universe core.
// Everything (galaxies, systems, planets, terrain) derives from a 64-bit seed
// chain: universe -> galaxy -> sector -> star system -> body -> chunk.
// No Math.random() is used anywhere in generation code.
// ---------------------------------------------------------------------------

const M = 0xFFFFFFFFFFFFFFFFn;

/** splitmix64 — fast, well-distributed, deterministic */
function mix64(x: bigint): bigint {
  let z = (x + 0x9E3779B97F4A7C15n) & M;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & M;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & M;
  return (z ^ (z >> 31n)) & M;
}

/** Derive a child seed from a parent seed + integer coords. Order matters. */
export function derive(seed: bigint, ...coords: number[]): bigint {
  let h = seed;
  for (const c of coords) h = mix64(h ^ mix64(BigInt(Math.trunc(c)) & M));
  return h;
}

/** Stateful stream of doubles in [0,1) from a seed. */
export class Rng {
  private s: bigint;
  constructor(seed: bigint) {
    this.s = mix64(seed) || 1n;
  }
  next(): number {
    this.s = mix64(this.s);
    return Number(this.s >> 11n) / 9007199254740992;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  /** Normal via Box-Muller — use for inclinations, eccentricities, etc. */
  normal(mu = 0, sigma = 1) {
    const u = Math.max(this.next(), 1e-12), v = this.next();
    return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Power law — use for body radii (small bodies far more common). */
  powerLaw(min: number, max: number, alpha: number) {
    const u = this.next(), a = 1 - alpha;
    return Math.pow(u * (max ** a - min ** a) + min ** a, 1 / a);
  }
}

// ---------------------------------------------------------------------------
// Universe positions are ALWAYS double (JS number) meters, never float32.
// ---------------------------------------------------------------------------

export interface Vec3d {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3d {
  return { x, y, z };
}

export function vdist(a: Vec3d, b: Vec3d): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/**
 * Converts universe (double) coordinates into render space by subtracting a
 * camera-anchored origin. Everything on the GPU goes through this, so float32
 * precision never shatters no matter how far the player travels.
 */
export class Frame {
  origin: Vec3d = { x: 0, y: 0, z: 0 };
  static REBASE = 1e4; // meters of drift before origin snaps to camera

  toRender(p: Vec3d): [number, number, number] {
    return [p.x - this.origin.x, p.y - this.origin.y, p.z - this.origin.z];
  }

  update(cameraUniverse: Vec3d) {
    const d = Math.hypot(
      cameraUniverse.x - this.origin.x,
      cameraUniverse.y - this.origin.y,
      cameraUniverse.z - this.origin.z
    );
    if (d > Frame.REBASE) this.origin = { ...cameraUniverse };
  }
}
