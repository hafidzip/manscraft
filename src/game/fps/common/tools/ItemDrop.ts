// Floating 3D voxel item drops that spin, bob, and magnetize to the player.
// Block drops render with the exact same tile textures the world uses.
import * as THREE from 'three';
import { BLOCK_COLORS, B, type WorldLike } from '../../World';
import { Inventory } from '../../Inventory';
import { AudioSynth } from '../../audio';
import { buildAtlas, blockCubeGeometry } from '../../textures';

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();

export interface DroppedItem {
  mesh: THREE.Mesh;
  blockId: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  time: number;
  grounded: boolean;
}

export class ItemDropManager {
  items: DroppedItem[] = [];
  private geoCache = new Map<number, THREE.BufferGeometry>();
  private mat: THREE.MeshLambertMaterial | null = null;
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
    if (!this.mat) this.mat = new THREE.MeshLambertMaterial({ map: buildAtlas() });
    return this.mat;
  }

  /** Spawn a dropped block item popping out from a destroyed voxel position. */
  spawn(blockId: number, pos: THREE.Vector3) {
    if (blockId === B.AIR || blockId === B.BEDROCK) return;

    const mesh = new THREE.Mesh(this.getGeometry(blockId), this.getMaterial());
    mesh.position.copy(pos);
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    this.scene.add(mesh);

    const vel = new THREE.Vector3(
      (Math.random() - 0.5) * 2.2,
      2.5 + Math.random() * 1.5,
      (Math.random() - 0.5) * 2.2
    );

    this.items.push({
      mesh,
      blockId,
      pos: pos.clone(),
      vel,
      time: Math.random() * 10,
      grounded: false,
    });
  }

  update(dt: number, playerPos: THREE.Vector3) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.time += dt;

      // Distance to player
      tmpV.copy(playerPos).add(tmpV2.set(0, 0.8, 0)); // aim at torso
      const d = item.pos.distanceTo(tmpV);

      // Magnetism toward player
      if (d < 3.2) {
        const pullSpeed = Math.min(12, (3.2 - d) * 6);
        tmpV2.copy(tmpV).sub(item.pos).normalize().multiplyScalar(pullSpeed);
        item.vel.lerp(tmpV2, dt * 8);
        item.grounded = false;
      } else if (!item.grounded) {
        item.vel.y -= 14 * dt; // gravity
      }

      // Physics integration
      if (!item.grounded || d < 3.2) {
        item.pos.addScaledVector(item.vel, dt);
        const bx = Math.floor(item.pos.x);
        const by = Math.floor(item.pos.y - 0.11);
        const bz = Math.floor(item.pos.z);

        if (this.world.solid(bx, by, bz) && item.vel.y < 0 && d >= 3.2) {
          item.pos.y = by + 1.12;
          item.vel.set(0, 0, 0);
          item.grounded = true;
        }
      }

      // Visual spin and bobbing
      item.mesh.position.copy(item.pos);
      item.mesh.position.y += Math.sin(item.time * 4) * 0.05;
      item.mesh.rotation.y += dt * 3;

      // Collect when close
      if (d < 0.95) {
        const added = this.inv.addBlock(item.blockId, 1);
        if (added) {
          this.audio.foley('snap');
          this.onPickup?.(item.blockId);
          this.scene.remove(item.mesh);
          this.items.splice(i, 1);
        }
      }
    }
  }

  clear() {
    for (const item of this.items) {
      this.scene.remove(item.mesh);
    }
    this.items = [];
  }
}
