import * as THREE from 'three';
import { BLOCK_COLORS, B, type WorldLike } from './World';
import { Inventory } from './Inventory';
import { AudioSynth } from './audio';
import { getAtlas, blockCubeGeometry } from './textures';
import { minImageF } from '../core/constants';
import { conveyorDir, isInserter, isLaserMiner } from '../world/blocks';

const tmpV = new THREE.Vector3();

const POP_TIME = 0.28;
const PICKUP_DIST = 1.25;
const HALF = 0.13;
const GRAVITY = 20;
const BELT_SPEED = 2.6;
const BELT_CENTERING = 6;

export interface DroppedItem {
  mesh: THREE.Mesh;
  blockId: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  time: number;
  grounded: boolean;
  spin: number;
}

export class ItemDropManager {
  items: DroppedItem[] = [];
  private geoCache = new Map<number, THREE.BufferGeometry>();
  private mat: THREE.MeshLambertMaterial | null = null;
  private meshPool: THREE.Mesh[] = [];
  private scene: THREE.Scene;
  private world: WorldLike;
  private inv: Inventory;
  private audio: AudioSynth;
  private onPickup?: (blockId: number) => void;

  constructor(scene: THREE.Scene, world: WorldLike, inv: Inventory, audio: AudioSynth, onPickup?: (blockId: number) => void) {
    this.scene = scene;
    this.world = world;
    this.inv = inv;
    this.audio = audio;
    this.onPickup = onPickup;
    void BLOCK_COLORS;
  }

  private getGeometry(blockId: number): THREE.BufferGeometry {
    let geo = this.geoCache.get(blockId);
    if (!geo) {
      geo = blockCubeGeometry(blockId, 0.22);
      this.geoCache.set(blockId, geo);
    }
    return geo;
  }

  private getMaterial(): THREE.MeshLambertMaterial {
    if (!this.mat) this.mat = new THREE.MeshLambertMaterial({ map: getAtlas() });
    return this.mat;
  }

  prewarm(blockIds: Iterable<number>, poolSize = 32): void {
    for (const id of blockIds) this.getGeometry(id);
    const mat = this.getMaterial();
    while (this.meshPool.length < poolSize) {
      const mesh = new THREE.Mesh(this.getGeometry(B.STONE), mat);
      mesh.visible = false;
      this.meshPool.push(mesh);
    }
  }

  spawn(blockId: number, pos: THREE.Vector3, velocity?: THREE.Vector3) {
    if (blockId === B.AIR || blockId === B.BEDROCK) return;

    const mesh = this.meshPool.pop() ?? new THREE.Mesh(this.getGeometry(blockId), this.getMaterial());
    mesh.geometry = this.getGeometry(blockId);
    mesh.material = this.getMaterial();
    mesh.position.copy(pos);
    mesh.visible = true;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.scene.add(mesh);

    const vel = velocity ?? new THREE.Vector3(
      (Math.random() - 0.5) * 2.6,
      2.4 + Math.random() * 1.4,
      (Math.random() - 0.5) * 2.6
    );

    this.items.push({
      mesh,
      blockId,
      pos: pos.clone(),
      vel,
      time: 0,
      grounded: false,
      spin: Math.random() * Math.PI * 2,
    });
  }

  takeAt(x: number, y: number, z: number, radius = 0.55): DroppedItem | null {
    let best = -1;
    let bestD2 = radius * radius;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (!it.grounded || it.time < POP_TIME) continue;
      const dy = it.pos.y - y;
      if (Math.abs(dy) > 0.6) continue;
      const dx = it.pos.x - x;
      const dz = it.pos.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    if (best < 0) return null;
    const it = this.items[best];
    this.scene.remove(it.mesh);
    it.mesh.visible = false;
    this.meshPool.push(it.mesh);
    this.items.splice(best, 1);
    return it;
  }

  private solidAt(x: number, y: number, z: number): boolean {
    return this.world.solid(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  /**
   * Item-vs-world collision. Real solid cubes block, and so do ghost machine
   * cells (inserter / laser miner): they have no cube of their own but items
   * must NOT be able to slide inside them, otherwise a conveyor pushes drops
   * into the inserter's own cell and the inserter can never pick them up
   * (it grabs from the cell BEHIND itself, not from its own cell).
   */
  private blocksItemAt(x: number, y: number, z: number): boolean {
    const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
    if (this.world.solid(bx, by, bz)) return true;
    const id = this.world.get(bx, by, bz);
    return isInserter(id) || isLaserMiner(id);
  }

  private blocked(x: number, y: number, z: number): boolean {
    for (const ox of [-HALF, HALF])
      for (const oz of [-HALF, HALF])
        for (const oy of [0, HALF * 2])
          if (this.blocksItemAt(x + ox, y + oy, z + oz)) return true;
    return false;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    const step = Math.min(dt, 1 / 30);

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.time += dt;
      const p = item.pos;

      item.vel.y -= GRAVITY * step;
      if (item.vel.y < -30) item.vel.y = -30;
      const ny = p.y + item.vel.y * step;
      if (item.vel.y < 0 && this.blocked(p.x, ny, p.z)) {
        p.y = Math.floor(ny) + 1;
        item.vel.y = 0;
        item.grounded = true;
      } else if (item.vel.y > 0 && this.blocked(p.x, ny + HALF * 2, p.z)) {
        item.vel.y = 0;
      } else {
        p.y = ny;
        if (!this.solidAt(p.x, p.y - 0.06, p.z)) item.grounded = false;
      }

      let onBelt = false;
      if (item.grounded) {
        const bx = Math.floor(p.x);
        const by = Math.floor(p.y - 0.06);
        const bz = Math.floor(p.z);
        const dir = conveyorDir(this.world.get(bx, by, bz));
        if (dir) {
          onBelt = true;
          const k = Math.min(1, 10 * step);
          item.vel.x += (dir[0] * BELT_SPEED - item.vel.x) * k;
          item.vel.z += (dir[1] * BELT_SPEED - item.vel.z) * k;
          if (dir[0] === 0) {
            const centerX = bx + 0.5;
            item.vel.x += (centerX - p.x) * BELT_CENTERING * step;
          } else {
            const centerZ = bz + 0.5;
            item.vel.z += (centerZ - p.z) * BELT_CENTERING * step;
          }
        }
      }

      // If an item is already overlapping a blocker (e.g. a machine was just
      // placed on top of it), let it move freely so it can escape instead of
      // being trapped forever.
      const stuck = this.blocked(p.x, p.y, p.z);

      const nx = p.x + item.vel.x * step;
      if (!stuck && this.blocked(nx, p.y, p.z)) item.vel.x = 0;
      else p.x = nx;

      const nz = p.z + item.vel.z * step;
      if (!stuck && this.blocked(p.x, p.y, nz)) item.vel.z = 0;
      else p.z = nz;

      if (!onBelt) {
        const drag = item.grounded ? 9 : 1.2;
        const f = Math.max(0, 1 - drag * step);
        item.vel.x *= f;
        item.vel.z *= f;
      }

      item.spin += step * 2.4;
      item.mesh.position.set(p.x, p.y + 0.12 + Math.sin(item.time * 3 + item.spin) * 0.035, p.z);
      item.mesh.rotation.y = item.spin;

      if (item.time < POP_TIME) continue;
      tmpV.set(playerPos.x, playerPos.y + 0.9, playerPos.z);
      const dx = minImageF(tmpV.x - p.x);
      const dz = minImageF(tmpV.z - p.z);
      const dy = tmpV.y - p.y;
      if (Math.abs(dy) > 1.6) continue;
      if (dx * dx + dz * dz > PICKUP_DIST * PICKUP_DIST) continue;

      if (this.inv.addBlock(item.blockId, 1)) {
        this.audio.foley('snap');
        this.onPickup?.(item.blockId);
        this.scene.remove(item.mesh);
        item.mesh.visible = false;
        this.meshPool.push(item.mesh);
        this.items.splice(i, 1);
      }
    }
  }

  clear() {
    for (const item of this.items) {
      this.scene.remove(item.mesh);
      item.mesh.visible = false;
      this.meshPool.push(item.mesh);
    }
    this.items = [];
  }
}
