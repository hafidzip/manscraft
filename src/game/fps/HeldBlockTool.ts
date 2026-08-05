// Held block viewmodel carried in the right hand, textured with the exact
// same atlas tiles the world voxels use (grass top/side, log rings, etc.).
// Torches get a dedicated extruded-voxel model that matches the drumstick
// (Minecraft's flat-item renderer: each opaque pixel -> a tiny cube).
import * as THREE from 'three';
import { B } from './World';
import { buildAtlas, blockCubeGeometry, buildExtrudedItem, paintTorch } from './textures';

const HELD_SIZE = 0.19;

export class HeldBlockTool {
  group = new THREE.Group();
  private blockMesh: THREE.Mesh;
  private torchModel: THREE.Group;
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

    // dedicated torch viewmodel: extruded pixel-art, like drumstick
    this.torchModel = this.buildTorchModel();
    this.torchModel.visible = false;
    this.group.add(this.torchModel);

    this.group.position.set(0.34, -0.3, -0.52);
    this.group.visible = false;
    camera.add(this.group);
  }

  /** Minecraft-style extruded torch — same technique as drumstick */
  private buildTorchModel(): THREE.Group {
    // buildExtrudedItem already returns a THREE.Group where each pixel is a
    // MeshLambertMaterial cube, so the flame reads as a lit voxel cluster.
    const g = buildExtrudedItem(paintTorch, 0.018, 0.034);

    // Make the flame voxels emissive (glow in the dark) — replace any
    // warm-coloured flame material with MeshBasicMaterial so it is self-lit,
    // matching how Minecraft's torch item feels brighter than surrounding.
    g.traverse((obj: any) => {
      if (!obj.isMesh) return;
      const c: THREE.Color = obj.material?.color;
      if (!c) return;
      // flame colours are orange/yellow/white in HSV: high R, medium-high G
      const isFlame = c.r > 0.85 && c.g > 0.45 && c.b < 0.65;
      if (isFlame) {
        const basic = new THREE.MeshBasicMaterial({ color: c.clone() });
        obj.material = basic;
      }
    });

    // centre it like the drumstick: the extruded builder centres the 16×16
    // grid at origin, so the torch sits upright. Scale slightly bigger than a
    // block so it reads clearly in FP.
    g.scale.setScalar(1.15);
    g.position.set(0, 0.02, 0);
    return g;
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
    this.torchModel.visible = false;
    this.blockMesh.visible = true;
    if (this.currentBlockId !== blockId) {
      this.currentBlockId = blockId;
      this.blockMesh.geometry = this.getGeometry(blockId);
    }
  }

  /** unified engine: swap in a cube built from the world's own atlas tiles */
  setGeometry(geo: THREE.BufferGeometry) {
    this.currentBlockId = -1;
    this.torchModel.visible = false;
    this.blockMesh.visible = true;
    this.blockMesh.geometry = geo;
  }

  /** show the dedicated torch model (hides the cube) */
  showTorch() {
    this.currentBlockId = -1;
    this.blockMesh.visible = false;
    this.torchModel.visible = true;
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
    const rx = 0.32 + p * 0.5;
    const ry = -0.62 + p * 0.25;
    const rz = 0.12;
    this.blockMesh.rotation.set(rx, ry, rz);
    this.torchModel.rotation.set(rx, ry, rz);

    // subtle flame flicker on the held torch — tint the basic mats
    if (this.torchModel.visible) {
      const f = 0.90 + 0.10 * Math.sin(this.t * 16) + 0.05 * Math.sin(this.t * 31);
      this.torchModel.traverse((obj: any) => {
        if (!obj.isMesh || !obj.material?.isMeshBasicMaterial) return;
        // keep hue, just pulse brightness
        const base = obj.material.userData.baseColor as THREE.Color | undefined;
        if (!base) {
          obj.material.userData.baseColor = obj.material.color.clone();
          obj.material.color.multiplyScalar(f);
        } else {
          obj.material.color.copy(base).multiplyScalar(f);
        }
      });
    }
  }
}
