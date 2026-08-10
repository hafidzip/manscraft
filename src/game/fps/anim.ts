import * as THREE from 'three';

export type EaseName = 'linear' | 'smooth' | 'in' | 'out' | 'inout' | 'snap' | 'back' | 'elastic';

export const EASE: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
  in: (t) => t * t,
  out: (t) => 1 - (1 - t) * (1 - t),
  inout: (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  snap: (t) => 1 - Math.pow(1 - t, 4),
  back: (t) => { const c = 1.9; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); },
  elastic: (t) => (t === 0 || t === 1) ? t : Math.pow(2, -8 * t) * Math.sin((t * 8 - 0.75) * (2 * Math.PI) / 3) + 1,
};

export interface Key {
  t: number;
  p?: [number, number, number];
  r?: [number, number, number];
  e?: EaseName;
}

export interface Track {
  node: string;
  keys: Key[];
}

export interface TimelineEvent {
  t: number;
  fn: () => void;
}

export interface TimelineDef {
  duration: number;
  tracks: Track[];
  events?: TimelineEvent[];
}

const D2R = Math.PI / 180;
export const deg = (d: number) => d * D2R;

export function K(t: number, p?: [number, number, number], r?: [number, number, number], e: EaseName = 'smooth'): Key {
  return { t, p, r, e };
}

function sampleTrack(keys: Key[], t: number): Key[] {
  if (t <= keys[0].t) return [keys[0], keys[0]];
  if (t >= keys[keys.length - 1].t) { const l = keys[keys.length - 1]; return [l, l]; }
  for (let i = 0; i < keys.length - 1; i++) {
    if (t >= keys[i].t && t <= keys[i + 1].t) return [keys[i], keys[i + 1]];
  }
  const l = keys[keys.length - 1];
  return [l, l];
}

export class Timeline {
  t = 0;
  private firedEvt: boolean[];
  constructor(
    public def: TimelineDef,
    private bones: Map<string, THREE.Object3D>
  ) {
    this.firedEvt = (def.events ?? []).map(() => false);
    for (const tr of def.tracks) tr.keys.sort((a, b) => a.t - b.t);
  }

  update(dt: number): boolean {
    this.t += dt;
    const evts = this.def.events ?? [];
    for (let i = 0; i < evts.length; i++) {
      if (!this.firedEvt[i] && this.t >= evts[i].t) {
        this.firedEvt[i] = true;
        evts[i].fn();
      }
    }
    this.sample();
    return this.t < this.def.duration;
  }

  sample() {
    const t = Math.min(this.t, this.def.duration);
    for (const tr of this.def.tracks) {
      const bone = this.bones.get(tr.node);
      if (!bone || tr.keys.length === 0) continue;
      const [k0, k1] = sampleTrack(tr.keys, t);
      let local: number;
      if (k0 === k1 || k1.t === k0.t) local = 1;
      else {
        const raw = THREE.MathUtils.clamp((t - k0.t) / (k1.t - k0.t), 0, 1);
        local = EASE[k1.e ?? 'smooth'](raw);
      }
      if (k0.p || k1.p) {
        const p0 = k0.p ?? k1.p!, p1 = k1.p ?? k0.p!;
        bone.position.set(
          p0[0] + (p1[0] - p0[0]) * local,
          p0[1] + (p1[1] - p0[1]) * local,
          p0[2] + (p1[2] - p0[2]) * local
        );
      }
      if (k0.r || k1.r) {
        const r0 = k0.r ?? k1.r!, r1 = k1.r ?? k0.r!;
        bone.rotation.set(
          r0[0] + (r1[0] - r0[0]) * local,
          r0[1] + (r1[1] - r0[1]) * local,
          r0[2] + (r1[2] - r0[2]) * local
        );
      }
    }
  }

  get done(): boolean { return this.t >= this.def.duration; }
}

export class Spring3 {
  v = new THREE.Vector3();
  vel = new THREE.Vector3();
  constructor(public k = 220, public d = 16) {}
  update(dt: number): THREE.Vector3 {
    this.vel.x += (-this.v.x * this.k - this.vel.x * this.d) * dt;
    this.vel.y += (-this.v.y * this.k - this.vel.y * this.d) * dt;
    this.vel.z += (-this.v.z * this.k - this.vel.z * this.d) * dt;
    this.v.x += this.vel.x * dt; this.v.y += this.vel.y * dt; this.v.z += this.vel.z * dt;
    return this.v;
  }
  impulse(x: number, y: number, z: number) { this.vel.x += x; this.vel.y += y; this.vel.z += z; }
}

export class Spring1 {
  v = 0; vel = 0;
  constructor(public k = 200, public d = 14, public target = 0) {}
  update(dt: number): number {
    this.vel += ((this.target - this.v) * this.k - this.vel * this.d) * dt;
    return (this.v += this.vel * dt);
  }
  impulse(i: number) { this.vel += i; }
}
