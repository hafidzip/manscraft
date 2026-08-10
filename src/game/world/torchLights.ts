
import * as THREE from 'three';

const POOL_SIZE = 6;
const RANGE = 13;
const BASE_INTENSITY = 2.4;
const COLOR = 0xffb552;

export class TorchLights {
  private lights: THREE.PointLight[] = [];
  private torches = new Map<string, { pos: THREE.Vector3; support: string }>();
  private time = 0;

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(COLOR, 0, RANGE, 1.8);
      l.visible = true;
      l.position.set(0, -1000, 0);
      scene.add(l);
      this.lights.push(l);
    }
  }

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

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
  }

  remove(x: number, y: number, z: number): void {
    this.torches.delete(this.key(x, y, z));
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
    return removed;
  }

  clear(): void {
    this.torches.clear();
    for (const l of this.lights) l.intensity = 0;
  }

  private nearBuf: { pos: THREE.Vector3; d: number }[] = [];
  private sortT = 0;

  update(dt: number, camera: THREE.Vector3): void {
    this.time += dt;

    if (this.torches.size === 0) {
      for (const l of this.lights) l.intensity = 0;
      return;
    }

    this.sortT -= dt;
    if (this.sortT <= 0) {
      this.sortT = 0.15;
      this.nearBuf.length = 0;
      for (const t of this.torches.values()) {
        const d = t.pos.distanceToSquared(camera);
        this.nearBuf.push({ pos: t.pos, d });
      }
      if (this.nearBuf.length > POOL_SIZE) {
        for (let i = 0; i < Math.min(POOL_SIZE, this.nearBuf.length); i++) {
          let min = i;
          for (let j = i + 1; j < this.nearBuf.length; j++) {
            if (this.nearBuf[j].d < this.nearBuf[min].d) min = j;
          }
          if (min !== i) {
            const tmp = this.nearBuf[i];
            this.nearBuf[i] = this.nearBuf[min];
            this.nearBuf[min] = tmp;
          }
        }
      } else {
        this.nearBuf.sort((a, b) => a.d - b.d);
      }
    }

    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const t = this.nearBuf[i];
      if (!t) { l.intensity = 0; continue; }
      l.position.copy(t.pos);
      const flick = 0.82 + 0.18 * Math.sin(this.time * 11 + i * 1.7)
        + 0.06 * Math.sin(this.time * 27 + i * 3.1);
      l.intensity = BASE_INTENSITY * flick;
    }
  }
}
