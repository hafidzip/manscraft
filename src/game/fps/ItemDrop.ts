/**
 * Dropped voxel items.
 *
 * Physical model (no magnet): a drop pops out of the block it came from, falls
 * under gravity, collides with terrain on all three axes and then rests on the
 * ground until the player physically walks over it. Blocks render with the
 * exact same tile textures the world uses.
 *
 * Conveyor belts transport resting drops: a belt under an item drives it along
 * its facing direction and gently centers it in the lane, so chains of belts
 * form working item pipelines.
 */
import * as THREE from 'three';
import { BLOCK_COLORS, B, type WorldLike } from './World';
import { Inventory } from './Inventory';
import { AudioSynth } from './audio';
import { getAtlas, blockCubeGeometry } from './textures';
import { minImageF } from '../core/constants';
import { conveyorDir } from '../world/blocks';

const tmpV = new THREE.Vector3();

/** seconds of "pop" before the item is allowed to be picked up */
const POP_TIME = 0.28;
/** collection radius (player must walk into the item) */
const PICKUP_DIST = 1.25;
/** half-extent of the item's collision box */
const HALF = 0.13;
const GRAVITY = 20;
/** belt transport speed in blocks/second */
const BELT_SPEED = 2.6;
/** how hard the belt re-centers an item in its lane */
const BELT_CENTERING = 6;

export interface DroppedItem {
  mesh: THREE.Mesh;
  blockId: number;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  time: number;
  grounded: boolean;
  /** spin phase so a pile of drops never rotates in lockstep */
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

  /** Cook every drop variant and reserve entities before control is enabled. */
  prewarm(blockIds: Iterable<number>, poolSize = 32): void {
    for (const id of blockIds) this.getGeometry(id);
    const mat = this.getMaterial();
    while (this.meshPool.length < poolSize) {
      const mesh = new THREE.Mesh(this.getGeometry(B.STONE), mat);
      mesh.visible = false;
      this.meshPool.push(mesh);
    }
  }

  /** Spawn a dropped block item popping out from a destroyed voxel position. */
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

  /**
   * Grab the grounded item nearest (x,z) within `radius` (vertical tolerance
   * 0.6). Used by inserters to scoop drops off the ground — the item's mesh
   * returns to the pool and the caller owns the blockId from here on.
   */
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

  /** solid test that treats unloaded chunks as empty (drops must never stick) */
  private solidAt(x: number, y: number, z: number): boolean {
    return this.world.solid(Math.floor(x), Math.floor(y), Math.floor(z));
  }

  /** does the item's AABB overlap terrain at this position? */
  private blocked(x: number, y: number, z: number): boolean {
    for (const ox of [-HALF, HALF])
      for (const oz of [-HALF, HALF])
        for (const oy of [0, HALF * 2])
          if (this.solidAt(x + ox, y + oy, z + oz)) return true;
    return false;
  }

  update(dt: number, playerPos: THREE.Vector3) {
    // Long frames (tab-out, chunk hitch) must not tunnel items through terrain.
    const step = Math.min(dt, 1 / 30);

    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      item.time += dt;
      const p = item.pos;

      // ---------------- vertical ----------------
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
        // leaving the ground (walked off a ledge / belt end)
        if (!this.solidAt(p.x, p.y - 0.06, p.z)) item.grounded = false;
      }

      // ---------------- conveyor transport ----------------
      let onBelt = false;
      if (item.grounded) {
        const bx = Math.floor(p.x);
        const by = Math.floor(p.y - 0.06);
        const bz = Math.floor(p.z);
        const dir = conveyorDir(this.world.get(bx, by, bz));
        if (dir) {
          onBelt = true;
          const k = Math.min(1, 10 * step);
          // drive along the belt
          item.vel.x += (dir[0] * BELT_SPEED - item.vel.x) * k;
          item.vel.z += (dir[1] * BELT_SPEED - item.vel.z) * k;
          // ...and slide toward the middle of the lane on the cross axis so
          // items track the belt instead of grinding along a wall.
          if (dir[0] === 0) {
            const centerX = bx + 0.5;
            item.vel.x += (centerX - p.x) * BELT_CENTERING * step;
          } else {
            const centerZ = bz + 0.5;
            item.vel.z += (centerZ - p.z) * BELT_CENTERING * step;
          }
        }
      }

      // ---------------- horizontal (axis separated) ----------------
      const nx = p.x + item.vel.x * step;
      if (this.blocked(nx, p.y, p.z)) item.vel.x = 0;
      else p.x = nx;

      const nz = p.z + item.vel.z * step;
      if (this.blocked(p.x, p.y, nz)) item.vel.z = 0;
      else p.z = nz;

      // friction: belts keep their grip, loose ground drags items to a stop
      if (!onBelt) {
        const drag = item.grounded ? 9 : 1.2;
        const f = Math.max(0, 1 - drag * step);
        item.vel.x *= f;
        item.vel.z *= f;
      }

      // ---------------- presentation ----------------
      item.spin += step * 2.4;
      item.mesh.position.set(p.x, p.y + 0.12 + Math.sin(item.time * 3 + item.spin) * 0.035, p.z);
      item.mesh.rotation.y = item.spin;

      // ---------------- pickup: player must walk into it ----------------
      if (item.time < POP_TIME) continue;
      tmpV.set(playerPos.x, playerPos.y + 0.9, playerPos.z);
      const dx = minImageF(tmpV.x - p.x);
      const dz = minImageF(tmpV.z - p.z);
      const dy = tmpV.y - p.y;
      // generous vertical reach (the player is ~1.8 blocks tall), tight radius
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
