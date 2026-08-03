// Held block viewmodel carried in the right hand, textured with the exact
// same atlas tiles the world voxels use (grass top/side, log rings, etc.).
import * as THREE from 'three';
import { B } from './World';
import { buildAtlas, blockCubeGeometry } from './textures';

const HELD_SIZE = 0.19;

export class HeldBlockTool {
  group = new THREE.Group();
  private blockMesh: THREE.Mesh;
  private geoCache = new Map<number, THREE.BufferGeometry>();
  private mat: THREE.MeshLambertMaterial;
  private currentBlockId: number = B.DIRT;

  private t = Math.random() * 100;
  private punch = 0; // place-block punch animation
  visible = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, mat?: THREE.MeshLambertMaterial) {
    scene.add(camera);

    // one shared atlas material -> textures identical to the world
    // (the unified engine passes its own world atlas material)
    this.mat = mat ?? new THREE.MeshLambertMaterial({ map: buildAtlas() });

    this.blockMesh = new THREE.Mesh(this.getGeometry(B.DIRT), this.mat);
    this.blockMesh.castShadow = false;
    this.blockMesh.frustumCulled = false;
    // slight tilt so three faces are visible, like Minecraft's held block
    this.blockMesh.rotation.set(0.32, -0.62, 0.12);
    this.group.add(this.blockMesh);

    this.group.position.set(0.34, -0.3, -0.52);
    this.group.visible = false;
    camera.add(this.group);
  }

  private getGeometry(blockId: number): THREE.BufferGeometry {
    let geo = this.geoCache.get(blockId);
    if (!geo) {
      geo = blockCubeGeometry(blockId, HELD_SIZE);
      this.geoCache.set(blockId, geo);
    }
    return geo;
  }

  setBlock(blockId: number) {
    if (this.currentBlockId !== blockId) {
      this.currentBlockId = blockId;
      this.blockMesh.geometry = this.getGeometry(blockId);
    }
  }

  /** unified engine: swap in a cube built from the world's own atlas tiles */
  setGeometry(geo: THREE.BufferGeometry) {
    this.currentBlockId = -1;
    this.blockMesh.geometry = geo;
  }

  triggerPlace() {
    this.punch = 1;
  }

  update(dt: number, visible: boolean, speedN: number) {
    this.visible = visible;
    this.group.visible = visible;
    if (!visible) return;

    this.t += dt;
    this.punch = Math.max(0, this.punch - dt * 9);

    // idle sway + walk bob
    const bob = Math.min(1, speedN / 5);
    const swayX = Math.sin(this.t * 4.8) * 0.004 * (0.4 + bob);
    const swayY = -Math.abs(Math.cos(this.t * 4.8)) * 0.005 * (0.4 + bob);

    // punch: shove forward-down then settle (Minecraft place swing)
    const p = Math.sin(this.punch * Math.PI);
    this.group.position.set(
      0.34 + swayX - p * 0.05,
      -0.3 + swayY - p * 0.07,
      -0.52 - p * 0.06
    );
    this.blockMesh.rotation.set(
      0.32 + p * 0.5,
      -0.62 + p * 0.25,
      0.12
    );
  }
}
