/**
 * Dynamic torch lighting.
 *
 * Placed torches emit warm point light so the player can illuminate deep
 * mines. Rather than one THREE.PointLight per torch (which would blow the
 * WebGL light budget), we keep a small pool of lights and, every frame,
 * snap them onto the torches nearest the camera — with a gentle flame
 * flicker. Torches beyond the pool's reach simply fall dark until the
 * player walks closer, exactly like a limited "lit radius".
 */

import * as THREE from 'three';

// Keep this pool permanently visible so Three.js always compiles one stable
// NUM_POINT_LIGHTS shader variant during loading. Toggling PointLight.visible
// on the first torch used to recompile every world/weapon material mid-frame.
const POOL_SIZE = 6;       // simultaneous nearest lit torches
const RANGE = 13;          // light reach (blocks)
const BASE_INTENSITY = 2.4;
const COLOR = 0xffb552;    // warm torch flame

export class TorchLights {
  private lights: THREE.PointLight[] = [];
  /** every placed torch: key "x,y,z" -> { world pos, support cell key "sx,sy,sz" } */
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
    // compute flame position so the point light covers the flame, not the shaft base.
    // Matches the wall-attached geometry in mesher.ts (flame at top, tilted away).
    const dx = sx - x, dy = sy - y, dz = sz - z;
    let fx = x + 0.5, fy = y + 0.78, fz = z + 0.5;
    if (dy === -1) {
      // floor torch — flame centered, high up
      fx = x + 0.5; fy = y + 0.78; fz = z + 0.5;
    } else if (dx === 1) {
      // attached to east wall (+X) — flame leans west, near east edge but pulled inward
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

  /**
   * Pop every torch whose support block (the face it was placed against) is the
   * given cell. Returns the torch cell coords so the caller can clear the world
   * block + spawn a drop. This catches wall/side torches that the "strip the
   * block directly above" pass misses.
   */
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

  /** re-target the light pool onto the torches nearest the camera */
  update(dt: number, camera: THREE.Vector3): void {
    this.time += dt;

    if (this.torches.size === 0) {
      for (const l of this.lights) l.intensity = 0;
      return;
    }

    // pick the POOL_SIZE closest torches (small maps -> simple sort is fine)
    const near: { pos: THREE.Vector3; d: number }[] = [];
    for (const t of this.torches.values()) {
      const d = t.pos.distanceToSquared(camera);
      near.push({ pos: t.pos, d });
    }
    near.sort((a, b) => a.d - b.d);

    for (let i = 0; i < this.lights.length; i++) {
      const l = this.lights[i];
      const t = near[i];
      if (!t) { l.intensity = 0; continue; }
      l.position.copy(t.pos);
      // per-torch flame flicker (offset by index so they don't pulse in sync)
      const flick = 0.82 + 0.18 * Math.sin(this.time * 11 + i * 1.7)
        + 0.06 * Math.sin(this.time * 27 + i * 3.1);
      l.intensity = BASE_INTENSITY * flick;
    }
  }
}
