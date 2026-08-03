import * as THREE from 'three';

interface P {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
}

/**
 * Shared additive particle pool used for engine exhaust and effects.
 */
export class Particles {
  readonly points: THREE.Points;
  private pool: P[] = [];
  private geo: THREE.BufferGeometry;
  private positions: Float32Array;
  private colors: Float32Array;
  private max: number;
  private cursor = 0;

  constructor(scene: THREE.Scene, max = 1200) {
    this.max = max;
    this.positions = new Float32Array(max * 3);
    this.colors = new Float32Array(max * 3);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    for (let i = 0; i < max; i++) {
      this.pool.push({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0, maxLife: 1 });
    }
    const mat = new THREE.PointsMaterial({
      size: 0.9,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      map: makeDot(),
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.geo.setDrawRange(0, 0);
    scene.add(this.points);
  }

  /**
   * Spawn `count` particles at (x,y,z).
   *
   * With no `dir`, velocities are small and fully random (engine exhaust,
   * impact sparks, etc — the original behaviour, unchanged).
   *
   * With `dir` supplied, velocities are biased along that direction and
   * scaled by `speed`, with `spread` controlling the random cone width —
   * used for the hyperjump burst so sparks streak past the ship instead of
   * drifting like exhaust.
   */
  burst(
    x: number,
    y: number,
    z: number,
    colors: number[],
    count: number,
    life: number,
    speed = 1,
    dir?: THREE.Vector3,
    spread = 1
  ) {
    const col = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % this.max;
      const p = this.pool[idx];
      p.x = x;
      p.y = y;
      p.z = z;
      if (dir) {
        p.vx = (dir.x + (Math.random() - 0.5) * spread) * speed;
        p.vy = (dir.y + (Math.random() - 0.5) * spread) * speed;
        p.vz = (dir.z + (Math.random() - 0.5) * spread) * speed;
      } else {
        p.vx = (Math.random() - 0.5) * 2 * speed;
        p.vy = (Math.random() - 0.5) * 2 * speed;
        p.vz = (Math.random() - 0.5) * 2 * speed;
      }
      p.life = life * (0.6 + Math.random() * 0.4);
      p.maxLife = p.life;
      col.setHex(colors[(Math.random() * colors.length) | 0]);
      this.colors[idx * 3] = col.r;
      this.colors[idx * 3 + 1] = col.g;
      this.colors[idx * 3 + 2] = col.b;
    }
  }

  update(dt: number) {
    for (let i = 0; i < this.max; i++) {
      const p = this.pool[i];
      if (p.life <= 0) {
        // keep offscreen
        this.positions[i * 3 + 1] = 1e6;
        continue;
      }
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.positions[i * 3] = p.x;
      this.positions[i * 3 + 1] = p.y;
      this.positions[i * 3 + 2] = p.z;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    this.geo.setDrawRange(0, this.max);
  }
}

function makeDot(): THREE.CanvasTexture {
  const S = 32;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return new THREE.CanvasTexture(cv);
}
