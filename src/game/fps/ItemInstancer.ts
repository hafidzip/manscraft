import * as THREE from 'three';
import type { DroppedItem } from './ItemDrop';

const START_CAP = 64;

interface Group {
  mesh: THREE.InstancedMesh;
  owners: (DroppedItem | null)[];
  count: number;
  dirty: boolean;
}

/** One InstancedMesh per distinct dropped block id. */
export class ItemInstancer {
  readonly stats = { groups: 0, instances: 0, grows: 0, writes: 0 };
  private groups = new Map<number, Group>();
  private m = new THREE.Matrix4();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly geometryFor: (blockId: number) => THREE.BufferGeometry,
    private readonly materialFor: () => THREE.Material,
  ) {}

  private groupFor(blockId: number): Group {
    let g = this.groups.get(blockId);
    if (g) return g;
    g = this.make(blockId, START_CAP);
    this.groups.set(blockId, g);
    this.stats.groups = this.groups.size;
    return g;
  }

  private make(blockId: number, cap: number): Group {
    const mesh = new THREE.InstancedMesh(this.geometryFor(blockId), this.materialFor(), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.count = 0;
    this.scene.add(mesh);
    return { mesh, owners: new Array(cap).fill(null), count: 0, dirty: false };
  }

  private grow(blockId: number, g: Group): void {
    const cap = g.mesh.instanceMatrix.count * 2;
    const next = this.make(blockId, cap);
    (next.mesh.instanceMatrix.array as Float32Array)
      .set(g.mesh.instanceMatrix.array as Float32Array);
    next.count = g.count;
    next.mesh.count = g.count;
    for (let i = 0; i < g.count; i++) next.owners[i] = g.owners[i];
    next.dirty = true;
    this.scene.remove(g.mesh);
    g.mesh.dispose();
    this.groups.set(blockId, next);
    g.mesh = next.mesh; g.owners = next.owners; g.count = next.count; g.dirty = true;
    this.stats.grows++;
  }

  acquire(it: DroppedItem): number {
    const g = this.groupFor(it.blockId);
    if (g.count >= g.mesh.instanceMatrix.count) this.grow(it.blockId, g);
    const slot = g.count++;
    g.owners[slot] = it;
    g.mesh.count = g.count;
    g.dirty = true;
    this.stats.instances++;
    return slot;
  }

  release(it: DroppedItem): void {
    const g = this.groups.get(it.blockId);
    if (!g || it.inst < 0) return;
    const last = --g.count;
    if (it.inst !== last) {
      g.mesh.getMatrixAt(last, this.m);
      g.mesh.setMatrixAt(it.inst, this.m);
      const moved = g.owners[last];
      g.owners[it.inst] = moved;
      if (moved) moved.inst = it.inst;
    }
    g.owners[last] = null;
    g.mesh.count = g.count;
    g.dirty = true;
    this.stats.instances--;
  }

  set(it: DroppedItem, x: number, y: number, z: number, ry: number): void {
    const g = this.groups.get(it.blockId);
    if (!g || it.inst < 0) return;
    const c = Math.cos(ry), s = Math.sin(ry);
    this.m.set(
      c, 0, s, x,
      0, 1, 0, y,
     -s, 0, c, z,
      0, 0, 0, 1,
    );
    g.mesh.setMatrixAt(it.inst, this.m);
    g.dirty = true;
    this.stats.writes++;
  }

  flush(): void {
    for (const g of this.groups.values()) {
      if (!g.dirty) continue;
      g.mesh.instanceMatrix.needsUpdate = true;
      g.dirty = false;
    }
  }

  dispose(): void {
    for (const g of this.groups.values()) {
      this.scene.remove(g.mesh);
      g.mesh.dispose();
    }
    this.groups.clear();
  }
}
