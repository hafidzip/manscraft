
import * as THREE from 'three';

const MAX = 512;

interface Particle {
  alive: boolean;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number;
  maxLife: number;
  scale: number;
}

export class Particles {
  private mesh: THREE.InstancedMesh;
  private parts: Particle[] = [];
  private cursor = 0;
  private mat4 = new THREE.Matrix4();
  private quat = new THREE.Quaternion();
  private vec = new THREE.Vector3();
  private scl = new THREE.Vector3();
  private col = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshLambertMaterial();
    this.mesh = new THREE.InstancedMesh(geo, mat, MAX);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;

    for (let i = 0; i < MAX; i++) {
      this.parts.push({
        alive: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, scale: 0,
      });
      this.mat4.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.mat4);
      this.mesh.setColorAt(i, this.col.setRGB(1, 1, 1));
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    scene.add(this.mesh);
  }

  burst(x: number, y: number, z: number, colors: number[], count = 24, power = 3.4): void {
    for (let n = 0; n < count; n++) {
      const p = this.parts[this.cursor];
      this.cursor = (this.cursor + 1) % MAX;
      p.alive = true;
      p.x = x + (Math.random() - 0.5) * 0.7;
      p.y = y + (Math.random() - 0.5) * 0.7;
      p.z = z + (Math.random() - 0.5) * 0.7;
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * 0.9 + 0.4;
      const r = Math.random() * power;
      p.vx = Math.cos(a) * r;
      p.vz = Math.sin(a) * r;
      p.vy = up * power;
      p.maxLife = 0.45 + Math.random() * 0.5;
      p.life = p.maxLife;
      p.scale = 0.05 + Math.random() * 0.09;
      this.col.setHex(colors[(Math.random() * colors.length) | 0]);
      this.mesh.setColorAt(this.cursor === 0 ? MAX - 1 : this.cursor - 1, this.col);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt: number): void {
    let dirty = false;
    for (let i = 0; i < MAX; i++) {
      const p = this.parts[i];
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        p.alive = false;
        this.mat4.makeScale(0, 0, 0);
        this.mesh.setMatrixAt(i, this.mat4);
        dirty = true;
        continue;
      }
      p.vy -= 20 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      const s = p.scale * Math.min(1, (p.life / p.maxLife) * 2.5);
      this.vec.set(p.x, p.y, p.z);
      this.scl.set(s, s, s);
      this.mat4.compose(this.vec, this.quat, this.scl);
      this.mesh.setMatrixAt(i, this.mat4);
      dirty = true;
    }
    if (dirty) this.mesh.instanceMatrix.needsUpdate = true;
  }
}
