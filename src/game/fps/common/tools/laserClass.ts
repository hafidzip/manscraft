import * as THREE from 'three';
import {
  LaserState, BODY_PARTS, GLOW_PARTS, VOX, UP,
  buildInstanced, makeGlowTexture, makeBeamTexture,
} from './laserModel';

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
      m.visible = false; m.frustumCulled = false; m.renderOrder = 20; scene.add(m);
    }

    const glowTex = makeGlowTexture();
    this.impact = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xff5a1e, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.impactCore = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: 0xffa050, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    for (const s of [this.impact, this.impactCore, this.flare]) { s.visible = false; s.renderOrder = 21; scene.add(s); }
    this.light = new THREE.PointLight(0xff6622, 0, 8, 2);
    scene.add(this.light);
  }

  private alignBeam(a: THREE.Vector3, b: THREE.Vector3, width: number): void {
    this.tmpDir.copy(b).sub(a);
    const len = Math.max(0.001, this.tmpDir.length());
    this.tmpDir.divideScalar(len);
    this.tmpMid.copy(a).add(b).multiplyScalar(0.5);
    this.tmpQ.setFromUnitVectors(UP, this.tmpDir);
    this.beamCore.position.copy(this.tmpMid); this.beamCore.quaternion.copy(this.tmpQ); this.beamCore.scale.set(width, len, width);
    this.beamGlow.position.copy(this.tmpMid); this.beamGlow.quaternion.copy(this.tmpQ); this.beamGlow.scale.set(width, len, width);
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
      this.group.position.set(0.34 + swayX, -0.33 + swayY + jitter * 0.4, -0.5 + this.recoil + jitter);
      this.group.rotation.set(0.05 + jitter * 0.5, 0.16, 0);
      const pulse = st.firing ? 0.72 + 0.28 * Math.sin(this.t * 22) : 0.42 + 0.1 * Math.sin(this.t * 3);
      const heat = st.firing ? st.charge * 0.35 : 0;
      this.glowMat.color.setRGB(Math.min(1, 0.5 + 0.5 * pulse + heat), Math.min(1, 0.14 + 0.55 * pulse + heat * 0.5), Math.min(1, 0.1 + 0.34 * pulse));
    }
    const wantBeam = st.visible && st.firing && st.target !== null;
    this.beamVis += ((wantBeam ? 1 : 0) - this.beamVis) * Math.min(1, 16 * dt);
    const show = this.beamVis > 0.03 && st.target !== null;
    this.beamCore.visible = this.beamGlow.visible = show;
    this.impact.visible = this.impactCore.visible = show;
    this.flare.visible = show;
    if (!show || !st.target) { this.light.intensity = 0; return; }
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
