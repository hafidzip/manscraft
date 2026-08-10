
import * as THREE from 'three';

const K = 6;                 // POOL_SIZE
const LIGHT_R = 13;          // must match PointLight.distance
const LIGHT_R2 = LIGHT_R * LIGHT_R;
const BASE_INTENSITY = 2.4;
const COLOR = 0xffb552;

// Camera travel needed to trigger a re-rank.
const RESCAN_MOVE2 = 0.75 * 0.75;

// Fixed top-K selection buffer, ascending by squared distance. Zero allocation.
const SEL_D = new Float64Array(K);
const SEL_IDX = new Int32Array(K);

export class TorchLights {
  private lights: THREE.PointLight[] = [];
  private torches = new Map<string, { pos: THREE.Vector3; support: string }>();
  private time = 0;

  // Flat xyz triples of every torch. Torches never move once placed, so this
  // is rebuilt only when the torch set changes (markDirty on add/remove).
  private flat = new Float32Array(0);
  private flatN = 0;
  private listDirty = true;

  private scanX = 0;
  private scanY = 0;
  private scanZ = 0;
  private nearCount = 0;
  private sortT = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < K; i++) {
      const l = new THREE.PointLight(COLOR, 0, LIGHT_R, 1.8);
      l.visible = true;
      l.position.set(0, -1000, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  private markDirty(): void { this.listDirty = true; }

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
    const dx = sx - x, dy = sy - y, dz = sz - z;
    let fx = x + 0.5, fy = y + 0.78, fz = z + 0.5;
    if (dy === -1) {
      fx = x + 0.5; fy = y + 0.78; fz = z + 0.5;
    } else if (dx === 1) {
      fx = x + 0.63; fy = y + 0.72; fz = z + 0.5;
    } else if (dx === -1) {
      fx = x + 0.37; fy = y + 0.72; fz = z + 0.5;
    } else if (dz === 1) {
      fx = x + 0.5; fy = y + 0.72; fz = z + 0.63;
    } else if (dz === -1) {
      fx = x + 0.5; fy = y + 0.72; fz = z + 0.37;
    }
    this.torches.set(this.key(x, y, z), {
      pos: new THREE.Vector3(fx, fy, fz),
      support: `${sx},${sy},${sz}`,
    });
    this.markDirty();
  }

  remove(x: number, y: number, z: number): void {
    if (this.torches.delete(this.key(x, y, z))) this.markDirty();
  }

  detachSupportedBy(bx: number, by: number, bz: number): [number, number, number][] {
    const target = `${bx},${by},${bz}`;
    const removed: [number, number, number][] = [];
    for (const [k, t] of this.torches) {
      if (t.support === target) {
        removed.push(k.split(',').map(Number) as [number, number, number]);
        this.torches.delete(k);
      }
    }
    if (removed.length) this.markDirty();
    return removed;
  }

  clear(): void {
    this.torches.clear();
    for (const l of this.lights) l.intensity = 0;
    this.markDirty();
  }

  private rebuildFlat(): void {
    const n = this.torches.size;
    if (this.flat.length < n * 3) this.flat = new Float32Array(Math.max(16, n * 3));
    let o = 0;
    for (const t of this.torches.values()) {
      this.flat[o++] = t.pos.x;
      this.flat[o++] = t.pos.y;
      this.flat[o++] = t.pos.z;
    }
    this.flatN = n;
    this.listDirty = false;
  }

  update(dt: number, camera: THREE.Vector3): void {
    this.time += dt;

    if (this.torches.size === 0) {
      for (const l of this.lights) {
        if (l.intensity !== 0) l.intensity = 0;
        if (l.visible) l.visible = false;
      }
      this.nearCount = 0;
      return;
    }

    // The 150 ms timer is a throttle, not a trigger: a stationary player with
    // an unchanged torch set does no work; placing a torch re-ranks at once.
    const dx = camera.x - this.scanX, dy = camera.y - this.scanY, dz = camera.z - this.scanZ;
    const camMoved = dx * dx + dy * dy + dz * dz > RESCAN_MOVE2;
    this.sortT -= dt;
    if (this.listDirty || (this.sortT <= 0 && camMoved)) {
      this.sortT = 0.15;
      this.scanX = camera.x; this.scanY = camera.y; this.scanZ = camera.z;
      if (this.listDirty) this.rebuildFlat();

      const f = this.flat, n = this.flatN;
      const cx = camera.x, cy = camera.y, cz = camera.z;
      let count = 0;
      let worst = 0;

      for (let t = 0, o = 0; t < n; t++, o += 3) {
        const ddx = f[o] - cx, ddy = f[o + 1] - cy, ddz = f[o + 2] - cz;
        const d = ddx * ddx + ddy * ddy + ddz * ddz;
        if (d > LIGHT_R2) continue;                // can't contribute: cull
        if (count === K && d >= worst) continue;   // O(1) reject

        let i = count < K ? count : K - 1;
        while (i > 0 && SEL_D[i - 1] > d) {
          SEL_D[i] = SEL_D[i - 1];
          SEL_IDX[i] = SEL_IDX[i - 1];
          i--;
        }
        SEL_D[i] = d; SEL_IDX[i] = t;
        if (count < K) count++;
        worst = SEL_D[count - 1];
      }
      this.nearCount = count;
    }

    for (let i = 0; i < K; i++) {
      const l = this.lights[i];
      if (i < this.nearCount) {
        const o = SEL_IDX[i] * 3;
        l.position.set(this.flat[o], this.flat[o + 1], this.flat[o + 2]);
        const flick = 0.82 + 0.18 * Math.sin(this.time * 11 + i * 1.7)
          + 0.06 * Math.sin(this.time * 27 + i * 3.1);
        l.intensity = BASE_INTENSITY * flick;
        if (!l.visible) l.visible = true;
      } else {
        if (l.intensity !== 0) l.intensity = 0;
        if (l.visible) l.visible = false;
      }
    }
  }
}
