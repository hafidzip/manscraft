import * as THREE from 'three';
import { box, MATS } from '../../models';
import { faceTexture, pixelTexture } from '../../textures';
import type { EnemyConfig } from './enemyTypes';

/**
 * Build the voxel-style humanoid enemy model: head, torso, arms, legs, weapon, HP bar.
 * Returns the body root + limb groups + weapon components for animation.
 */
export function buildEnemyModel(parent: THREE.Group, c: EnemyConfig) {
  const bodyRoot = new THREE.Group();
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  const armL = new THREE.Group();
  const armR = new THREE.Group();
  const weapon = new THREE.Group();
  const bolt = new THREE.Group();
  const muzzle = new THREE.Object3D();

  const skinMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.skin, 14, 16, c.seed) });
  const faceMat = new THREE.MeshLambertMaterial({ map: faceTexture(c.skin, c.seed) });
  const shirtMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.shirt, 16, 16, c.seed + 1) });
  const pantsMat = new THREE.MeshLambertMaterial({ map: pixelTexture(c.pants, 14, 16, c.seed + 2) });
  const bodyMats = [skinMat, shirtMat, pantsMat];

  parent.add(bodyRoot);

  // legs
  legL.position.set(-0.13, 0.78, 0);
  legR.position.set(0.13, 0.78, 0);
  box(legL, 0.2, 0.78, 0.22, 0, -0.39, 0, pantsMat);
  box(legR, 0.2, 0.78, 0.22, 0, -0.39, 0, pantsMat);
  box(legL, 0.21, 0.1, 0.3, 0, -0.75, 0.04, MATS.boot);
  box(legR, 0.21, 0.1, 0.3, 0, -0.75, 0.04, MATS.boot);
  bodyRoot.add(legL, legR);

  // torso
  box(bodyRoot, 0.46, 0.56, 0.24, 0, 1.06, 0, shirtMat);
  box(bodyRoot, 0.48, 0.14, 0.26, 0, 0.85, 0, MATS.black);
  box(bodyRoot, 0.44, 0.2, 0.27, 0, 1.18, 0, MATS.vest);

  // neck + head
  box(bodyRoot, 0.16, 0.13, 0.16, 0, 1.38, 0, skinMat);
  const head = new THREE.Group();
  head.position.set(0, 1.34, 0);
  bodyRoot.add(head);
  const headMesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.42, 0.42),
    [skinMat, skinMat, skinMat, skinMat, faceMat, skinMat]
  );
  headMesh.position.y = 0.21;
  head.add(headMesh);

  // arms
  armL.position.set(-0.28, 1.28, -0.015);
  box(armL, 0.18, 0.62, 0.18, 0, -0.28, 0, shirtMat);
  box(armL, 0.16, 0.16, 0.16, 0, -0.62, 0, skinMat);
  bodyRoot.add(armL);

  armR.position.set(0.28, 1.28, -0.015);
  box(armR, 0.18, 0.62, 0.18, 0, -0.28, 0, shirtMat);
  box(armR, 0.16, 0.16, 0.16, 0, -0.62, 0, skinMat);
  bodyRoot.add(armR);

  // weapon (SMG rig)
  weapon.position.set(0, 1.16, 0.32);
  bodyRoot.add(weapon);
  box(weapon, 0.14, 0.115, 0.42, 0, 0, 0.12, MATS.gun);
  box(weapon, 0.15, 0.028, 0.39, 0, 0.07, 0.12, MATS.black);
  for (let i = 0; i < 5; i++) box(weapon, 0.16, 0.014, 0.022, 0, 0.09, -0.02 + i * 0.075, MATS.gun2);
  box(weapon, 0.125, 0.1, 0.28, 0, -0.005, 0.43, MATS.poly);
  box(weapon, 0.065, 0.055, 0.25, 0, 0, 0.67, MATS.black);
  box(weapon, 0.1, 0.09, 0.075, 0, 0, 0.81, MATS.black);
  box(weapon, 0.15, 0.13, 0.27, 0, -0.005, -0.28, MATS.poly);
  box(weapon, 0.16, 0.16, 0.04, 0, -0.005, -0.43, MATS.black);
  box(weapon, 0.1, 0.26, 0.11, 0, -0.16, 0.08, MATS.gun2, THREE.MathUtils.degToRad(-8));
  box(weapon, 0.11, 0.19, 0.09, 0, -0.14, -0.09, MATS.poly, THREE.MathUtils.degToRad(-13));
  box(weapon, 0.1, 0.15, 0.08, 0, -0.14, 0.4, MATS.gun2, THREE.MathUtils.degToRad(6));

  // reflex sight + ejection port
  box(weapon, 0.1, 0.026, 0.11, 0, 0.115, 0.06, MATS.black);
  box(weapon, 0.014, 0.095, 0.022, -0.04, 0.16, 0.06, MATS.black);
  box(weapon, 0.014, 0.095, 0.022, 0.04, 0.16, 0.06, MATS.black);
  box(weapon, 0.1, 0.014, 0.022, 0, 0.205, 0.06, MATS.black);
  box(weapon, 0.018, 0.018, 0.008, 0, 0.16, 0.047, MATS.redGlow);
  box(weapon, 0.075, 0.055, 0.13, 0.078, 0.01, 0.02, MATS.black);
  bolt.position.set(0.079, 0.01, 0.02);
  box(bolt, 0.02, 0.035, 0.1, 0, 0, 0, MATS.gun2);
  weapon.add(bolt);

  muzzle.position.set(0, 0.01, 0.86);
  weapon.add(muzzle);

  // health bar billboard
  const hpBar = new THREE.Group();
  hpBar.position.set(0, 2.25, 0);
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.72, 0.1),
    new THREE.MeshBasicMaterial({ color: '#14060f', transparent: true, opacity: 0.85, depthWrite: false })
  );
  const hpFill = new THREE.Mesh(
    new THREE.PlaneGeometry(0.66, 0.055),
    new THREE.MeshBasicMaterial({ color: '#e84fc0', depthWrite: false })
  );
  hpFill.position.z = 0.001;
  hpBar.add(bg, hpFill);
  parent.add(hpBar);

  parent.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) { m.frustumCulled = true; m.castShadow = true; }
  });

  return { bodyRoot, legL, legR, armL, armR, weapon, bolt, muzzle, hpBar, hpFill, bodyMats };
}

