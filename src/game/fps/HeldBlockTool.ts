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
  private punch = 0;
  visible = false;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera, mat?: THREE.MeshLambertMaterial) {
    scene.add(camera);

    this.mat = mat ?? new THREE.MeshLambertMaterial({ map: buildAtlas() });

    this.blockMesh = new THREE.Mesh(this.getGeometry(B.DIRT), this.mat);
    this.blockMesh.castShadow = false;
    this.blockMesh.frustumCulled = false;
    this.blockMesh.rotation.set(0.32, -0.62, 0.12);
    this.group.add(this.blockMesh);

    this.torchModel = this.buildTorchModel();
    this.torchModel.visible = false;
    this.group.add(this.torchModel);

    this.group.position.set(0.34, -0.3, -0.52);
    this.group.visible = false;
    camera.add(this.group);
  }

  private buildTorchModel(): THREE.Group {
    const g = buildExtrudedItem(paintTorch, 0.018, 0.034);

    g.traverse((obj: any) => {
      if (!obj.isMesh) return;
      const c: THREE.Color = obj.material?.color;
      if (!c) return;
      const isFlame = c.r > 0.85 && c.g > 0.45 && c.b < 0.65;
      if (isFlame) {
        const basic = new THREE.MeshBasicMaterial({ color: c.clone() });
        obj.material = basic;
      }
    });

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

  setGeometry(geo: THREE.BufferGeometry) {
    this.currentBlockId = -1;
    this.torchModel.visible = false;
    this.blockMesh.visible = true;
    this.blockMesh.geometry = geo;
  }

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

    const bob = Math.min(1, speedN / 5);
    const swayX = Math.sin(this.t * 4.8) * 0.004 * (0.4 + bob);
    const swayY = -Math.abs(Math.cos(this.t * 4.8)) * 0.005 * (0.4 + bob);

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

    if (this.torchModel.visible) {
      const f = 0.90 + 0.10 * Math.sin(this.t * 16) + 0.05 * Math.sin(this.t * 31);
      this.torchModel.traverse((obj: any) => {
        if (!obj.isMesh || !obj.material?.isMeshBasicMaterial) return;
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
