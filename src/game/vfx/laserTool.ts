
import * as THREE from 'three';

export interface LaserState {
  visible: boolean;
  firing: boolean;
  target: THREE.Vector3 | null;
  charge: number;
  speed: number;
}

export interface Part {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  c: number;
}

const BODY_PARTS: Part[] = [
  { x: 0, y: 0.1, z: 3.6, w: 2.1, h: 3.6, d: 2.4, c: 0x4a3b28 },
  { x: 0, y: 1.4, z: 0.6, w: 3.0, h: 2.8, d: 7.2, c: 0x3a4148 },
  { x: 0, y: 3.05, z: 0.8, w: 2.2, h: 0.5, d: 5.4, c: 0x2c3238 },
  { x: -1.68, y: 1.4, z: 0.8, w: 0.4, h: 1.2, d: 4.6, c: 0x23282e },
  { x: 1.68, y: 1.4, z: 0.8, w: 0.4, h: 1.2, d: 4.6, c: 0x23282e },
  { x: 0, y: 1.5, z: -4.4, w: 2.0, h: 1.9, d: 3.6, c: 0x4d565f },
  { x: 0, y: 1.6, z: -6.35, w: 2.5, h: 2.5, d: 0.9, c: 0x23282e },
  { x: 0, y: 1.6, z: -6.15, w: 1.1, h: 1.1, d: 1.7, c: 0x15181c },
];

const GLOW_PARTS: Part[] = [
  { x: 0, y: 1.55, z: -2.2, w: 3.15, h: 1.5, d: 1.5, c: 0xffffff },
  { x: 0, y: 3.15, z: 2.4, w: 1.5, h: 0.7, d: 1.8, c: 0xffffff },
  { x: 0, y: 1.6, z: -6.95, w: 1.3, h: 1.3, d: 0.4, c: 0xffffff },
];

const VOX = 0.045;
const UP = new THREE.Vector3(0, 1, 0);

export function buildInstanced(parts: Part[], mat: THREE.Material): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, parts.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  parts.forEach((p, i) => {
    v.set(p.x, p.y, p.z);
    s.set(p.w, p.h, p.d);
    m.compose(v, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHex(p.c));
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeGlowTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,224,190,0.8)');
  g.addColorStop(0.55, 'rgba(255,150,60,0.28)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBeamTexture(): THREE.CanvasTexture {
  const w = 16;
  const h = 64;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const wave = 0.5 + 0.5 * Math.sin((y / h) * Math.PI * 8);
    const a = Math.floor((0.22 + 0.78 * wave * wave) * 255);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2.5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class LaserTool {
  private group = new THREE.Group();
  private tip = new THREE.Object3D();
  private glowMat = new THREE.MeshBasicMaterial();

  private beamCore: THREE.Mesh;
  private beamGlow: THREE.Mesh;
  private beamTex: THREE.CanvasTexture;
  private coreMat: THREE.MeshBasicMaterial;
  private glowBeamMat: THREE.MeshBasicMaterial;
  private impact: THREE.Sprite;
  private impactCore: THREE.Sprite;
  private flare: THREE.Sprite;
  private light: THREE.PointLight;

  private t = Math.random() * 100;
  private recoil = 0;
  private beamVis = 0;

  private tmpA = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private tmpDir = new THREE.Vector3();
  private tmpMid = new THREE.Vector3();
  private tmpQ = new THREE.Quaternion();

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    scene.add(camera);

    this.group.scale.setScalar(VOX);
    this.tip.position.set(0, 1.6, -7.6);
    this.group.add(buildInstanced(BODY_PARTS, new THREE.MeshLambertMaterial()));
    this.group.add(buildInstanced(GLOW_PARTS, this.glowMat));
    this.group.add(this.tip);
    this.group.position.set(0.34, -0.33, -0.5);
    this.group.rotation.set(0.05, 0.16, 0);
    camera.add(this.group);

    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff3df, transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.beamCore = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 1, 6, 1, true), this.coreMat);
    this.beamTex = makeBeamTexture();
    this.glowBeamMat = new THREE.MeshBasicMaterial({
      map: this.beamTex, color: 0xff4416, transparent: true, opacity: 0.5,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 8, 1, true), this.glowBeamMat);
    for (const m of [this.beamCore, this.beamGlow]) {
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 20;
      scene.add(m);
    }

    const glowTex = makeGlowTexture();
    this.impact = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff5a1e, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.impactCore = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.flare = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffa050, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    for (const s of [this.impact, this.impactCore, this.flare]) {
      s.visible = false;
      s.renderOrder = 21;
      scene.add(s);
    }

    this.light = new THREE.PointLight(0xff6622, 0, 8, 2);
    scene.add(this.light);
  }

  private alignBeam(a: THREE.Vector3, b: THREE.Vector3, width: number): void {
    this.tmpDir.copy(b).sub(a);
    const len = Math.max(0.001, this.tmpDir.length());
    this.tmpDir.divideScalar(len);
    this.tmpMid.copy(a).add(b).multiplyScalar(0.5);
    this.tmpQ.setFromUnitVectors(UP, this.tmpDir);
    this.beamCore.position.copy(this.tmpMid);
    this.beamCore.quaternion.copy(this.tmpQ);
    this.beamCore.scale.set(width, len, width);
    this.beamGlow.position.copy(this.tmpMid);
    this.beamGlow.quaternion.copy(this.tmpQ);
    this.beamGlow.scale.set(width, len, width);
  }

  update(dt: number, st: LaserState): void {
    this.t += dt;
    this.group.visible = st.visible;

    if (st.visible) {
      const swayAmt = 0.35 + Math.min(1, st.speed / 4.5) * 0.65;
      const swayX = Math.sin(this.t * 5.2) * 0.0016 * swayAmt;
      const swayY = -Math.abs(Math.cos(this.t * 5.2)) * 0.0018 * swayAmt;
      const rTarget = st.firing ? 0.05 : 0;
      this.recoil += (rTarget - this.recoil) * Math.min(1, 12 * dt);
      const jitter = st.firing ? Math.sin(this.t * 47) * 0.004 + Math.sin(this.t * 31) * 0.003 : 0;
      this.group.position.set(
        0.34 + swayX,
        -0.33 + swayY + jitter * 0.4,
        -0.5 + this.recoil + jitter
      );
      this.group.rotation.set(0.05 + jitter * 0.5, 0.16, 0);

      const pulse = st.firing
        ? 0.72 + 0.28 * Math.sin(this.t * 22)
        : 0.42 + 0.1 * Math.sin(this.t * 3);
      const heat = st.firing ? st.charge * 0.35 : 0;
      this.glowMat.color.setRGB(
        Math.min(1, 0.5 + 0.5 * pulse + heat),
        Math.min(1, 0.14 + 0.55 * pulse + heat * 0.5),
        Math.min(1, 0.1 + 0.34 * pulse)
      );
    }

    const wantBeam = st.visible && st.firing && st.target !== null;
    this.beamVis += ((wantBeam ? 1 : 0) - this.beamVis) * Math.min(1, 16 * dt);
    const show = this.beamVis > 0.03 && st.target !== null;

    this.beamCore.visible = this.beamGlow.visible = show;
    this.impact.visible = this.impactCore.visible = show;
    this.flare.visible = show;

    if (!show || !st.target) {
      this.light.intensity = 0;
      return;
    }

    this.tip.getWorldPosition(this.tmpA);
    this.tmpB.copy(st.target);
    this.tmpB.x += Math.sin(this.t * 57) * 0.012;
    this.tmpB.y += Math.cos(this.t * 49) * 0.012;

    const flick = 0.75 + 0.25 * Math.sin(this.t * 38) * Math.sin(this.t * 13.7);
    const vis = this.beamVis;
    this.alignBeam(this.tmpA, this.tmpB, vis * (0.85 + 0.25 * flick));

    this.beamTex.offset.y -= dt * 5;
    this.coreMat.opacity = vis * (0.55 + 0.3 * flick + st.charge * 0.3);
    this.glowBeamMat.opacity = vis * (0.3 + 0.25 * flick);

    this.impact.position.copy(this.tmpB);
    const impactScale = (0.42 + st.charge * 0.55 + Math.sin(this.t * 29) * 0.05) * vis;
    this.impact.scale.setScalar(Math.max(0.01, impactScale));
    this.impact.material.opacity = vis * (0.55 + 0.35 * flick);
    this.impactCore.position.copy(this.tmpB);
    this.impactCore.scale.setScalar(Math.max(0.01, impactScale * 0.45));
    this.impactCore.material.opacity = vis * (0.6 + 0.4 * flick);

    this.flare.position.copy(this.tmpA);
    this.flare.scale.setScalar(Math.max(0.01, (0.16 + 0.08 * flick) * vis));
    this.flare.material.opacity = vis * 0.65;

    this.light.position.copy(this.tmpB);
    this.light.intensity = vis * (8 + 4 * Math.sin(this.t * 43) + st.charge * 6);
  }
}
