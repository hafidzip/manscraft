import * as THREE from 'three';
import { buildVoxels, hash3, lerpColor, type VoxelSpec } from './voxel';
import { makeGlowTexture } from './billboard';
import type { StarSpec } from './galaxy';

/** Deterministically voxelizes a star sphere from its seed. */
export function buildStarVoxels(radius: number, seed: bigint): THREE.InstancedMesh {
  const R = Math.round(radius);
  const o1 = Number(seed & 0xFFFFn);
  const o2 = Number((seed >> 16n) & 0xFFFFn);
  const voxels: VoxelSpec[] = [];
  // Analytic band walk — the star crust is only 1.7 units thick, so scanning
  // the full (2R+1)^3 cube wasted ~95% of the iterations.
  const innerR = R - 1.7;
  const lo2 = innerR * innerR;
  const hi2 = R * R;
  const EPS = 1e-9;
  const bands: number[] = [0, 0, 0, 0];

  for (let x = -R; x <= R; x++) {
    const x2 = x * x;
    if (x2 > hi2) continue;
    for (let y = -R; y <= R; y++) {
      const rxy = x2 + y * y;
      if (rxy > hi2) continue;

      const zOuter = Math.sqrt(hi2 - rxy);
      let bandCount: number;
      if (rxy < lo2) {
        const zInner = Math.sqrt(lo2 - rxy);
        bands[0] = -zOuter; bands[1] = -zInner;
        bands[2] = zInner;  bands[3] = zOuter;
        bandCount = 2;
      } else {
        bands[0] = -zOuter; bands[1] = zOuter;
        bandCount = 1;
      }

      for (let b = 0; b < bandCount; b++) {
        const zA = Math.max(bands[b * 2], -R);
        const zB = Math.min(bands[b * 2 + 1], R);
        if (zA > zB) continue;
        let z = Math.ceil(zA - EPS);
        for (; z <= zB + EPS; z++) {
          const d = Math.sqrt(rxy + z * z);
          if (d > R || d < innerR) continue;
          const n = hash3(x + o1, y + o2, z - o1);
          voxels.push({ x, y, z, color: lerpColor(0xff7a1a, 0xfff2b0, n) });
        }
      }
    }
  }
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
  return buildVoxels(voxels, mat);
}

/**
 * A voxel star: emissive blocky sphere with animated surface "plasma"
 * flicker plus a corona glow sprite. The system light lives on the scene
 * (only one star is ever meshed — the one you are orbiting).
 */
export class StarBody {
  readonly group = new THREE.Group();
  readonly spec: StarSpec;
  private mesh: THREE.InstancedMesh;
  private glow: THREE.Sprite;
  private baseColors: THREE.Color[] = [];
  private t = 0;

  constructor(spec: StarSpec) {
    this.spec = spec;
    this.mesh = buildStarVoxels(spec.radius, spec.seed);
    const c = new THREE.Color();
    for (let i = 0; i < this.mesh.count; i++) {
      this.mesh.getColorAt(i, c);
      this.baseColors.push(c.clone());
    }
    this.group.add(this.mesh);

    this.glow = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: spec.color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      })
    );
    this.glow.scale.setScalar(spec.radius * 7);
    this.group.add(this.glow);
  }

  private flickerAccum = 0;

  update(dt: number) {
    this.t += dt;
    this.group.rotation.y += dt * 0.02;
    const pulse = 1 + Math.sin(this.t * 1.5) * 0.08;
    this.glow.scale.setScalar(this.spec.radius * 7 * pulse);

    // Plasma flicker only ~15 Hz — uploading the whole instanceColor
    // buffer every frame for every visible star was another big FPS cost.
    this.flickerAccum += dt;
    if (this.flickerAccum < 0.066) return;
    this.flickerAccum = 0;
    const c = new THREE.Color();
    const n = this.mesh.count;
    for (let i = 0; i < n; i += 3) {
      const flick =
        0.72 +
        0.5 * Math.sin(this.t * 3 + i * 0.11) * (0.45 + hash3(i, i >> 4, i >> 8));
      c.copy(this.baseColors[i]).multiplyScalar(Math.max(0.6, flick));
      this.mesh.setColorAt(i, c);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    });
  }
}
