// Voxel view-model factory: human hands (glove, fingers, thumb), forearm links
// that stretch to follow the hands, a full look-down body, and five
// fully-boned weapon rigs (handgun / smg / rifle / sniper / bazooka).
import * as THREE from 'three';
import { pixelTexture } from './textures';
import { deg } from './anim';

// ---------------------------------------------------------------- materials
export const MATS = {
  black: new THREE.MeshLambertMaterial({ map: pixelTexture('#22242a', 16, 16, 3) }),
  gun: new THREE.MeshLambertMaterial({ map: pixelTexture('#393d44', 20, 16, 4) }),
  gun2: new THREE.MeshLambertMaterial({ map: pixelTexture('#4a4f58', 20, 16, 5) }),
  poly: new THREE.MeshLambertMaterial({ map: pixelTexture('#2c2e33', 14, 16, 6) }),
  olive: new THREE.MeshLambertMaterial({ map: pixelTexture('#565b3c', 18, 16, 7) }),
  tan: new THREE.MeshLambertMaterial({ map: pixelTexture('#8a7350', 18, 16, 8) }),
  wood: new THREE.MeshLambertMaterial({ map: pixelTexture('#6e4f30', 18, 16, 9) }),
  skin: new THREE.MeshLambertMaterial({ map: pixelTexture('#d9a273', 14, 16, 10) }),
  glove: new THREE.MeshLambertMaterial({ map: pixelTexture('#26282d', 12, 16, 11) }),
  sleeve: new THREE.MeshLambertMaterial({ map: pixelTexture('#4d5740', 16, 16, 12) }),
  jeans: new THREE.MeshLambertMaterial({ map: pixelTexture('#3c4a6b', 16, 16, 13) }),
  boot: new THREE.MeshLambertMaterial({ map: pixelTexture('#2e2a26', 12, 16, 14) }),
  vest: new THREE.MeshLambertMaterial({ map: pixelTexture('#39412f', 16, 16, 15) }),
  brass: new THREE.MeshLambertMaterial({ map: pixelTexture('#caa142', 14, 8, 16) }),
  redGlow: new THREE.MeshBasicMaterial({ color: '#ff3b30' }),
  whiteGlow: new THREE.MeshBasicMaterial({ color: '#e8ffe0' }),
  glass: new THREE.MeshLambertMaterial({ color: '#1a2a4a', emissive: '#0d1a33' }),
  warhead: new THREE.MeshLambertMaterial({ map: pixelTexture('#5d6142', 16, 16, 17) }),
  warheadTip: new THREE.MeshLambertMaterial({ map: pixelTexture('#33352a', 12, 16, 18) }),
};

export function box(
  parent: THREE.Object3D,
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  mat: THREE.Material,
  rx = 0, ry = 0, rz = 0
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- hand
/** Empty grip target. The visible arm is rendered as one continuous cuboid. */
export function buildHand(right: boolean): THREE.Group {
  const g = new THREE.Group();
  void right;
  return g;
}

// ------------------------------------------------------------- forearm link
/** A two-segment forearm that stretches between a fixed anchor and a hand. */
export class ArmLink {
  group = new THREE.Group();
  private arm: THREE.Mesh;
  private a = new THREE.Vector3();
  private b = new THREE.Vector3();
  private mid = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private bWorld = new THREE.Vector3();
  private anchor: THREE.Object3D;
  private target: THREE.Object3D;

  constructor(parent: THREE.Object3D, anchor: THREE.Object3D, target: THREE.Object3D) {
    this.anchor = anchor;
    this.target = target;
    // One uninterrupted voxel arm: no palm, fingers, thumb, cuff, or second
    // hand block. The mesh stretches as the weapon pose changes.
    this.arm = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 1), MATS.skin);
    this.group.add(this.arm);
    parent.add(this.group);
    // orientation bookkeeping handled in update via lookAt
  }

  update() {
    this.anchor.getWorldPosition(this.a);
    this.target.getWorldPosition(this.bWorld);
    // convert to arm-group local space (group's parent == camera rig root)
    const root = this.group.parent!;
    root.worldToLocal(this.b.copy(this.bWorld));
    root.worldToLocal(this.a);
    this.dir.subVectors(this.b, this.a);
    const len = this.dir.length();
    if (len < 0.01) { this.group.visible = false; return; }
    this.group.visible = true;

    // A single rectangular prism spans the entire shoulder-to-grip distance.
    this.mid.copy(this.a).addScaledVector(this.dir, 0.5);
    this.arm.position.copy(this.mid);
    this.arm.scale.set(1, 1, Math.max(0.01, len));
    this.arm.lookAt(this.bWorld);
  }
}

// ---------------------------------------------------------------- body
export interface BodyRig {
  group: THREE.Group;
  update(phase: number, speedNorm: number, airborne: boolean): void;
}

/** Full voxel body seen when looking down: torso, vest, backpack, legs, boots. */
export function buildBody(): BodyRig {
  const g = new THREE.Group();

  const torso = new THREE.Group();
  torso.position.y = 1.32;
  g.add(torso);
  box(torso, 0.44, 0.5, 0.26, 0, -0.05, 0, MATS.sleeve);
  box(torso, 0.46, 0.34, 0.28, 0, 0.0, 0, MATS.vest);           // plate carrier
  box(torso, 0.3, 0.36, 0.14, 0, 0.02, 0.21, MATS.vest);        // backpack
  box(torso, 0.46, 0.1, 0.28, 0, -0.31, 0, MATS.black);         // belt
  box(torso, 0.12, 0.1, 0.05, 0, -0.31, -0.15, MATS.tan);       // belt pouch
  // shoulder pads (keep silhouette believable from above)
  box(torso, 0.14, 0.12, 0.2, -0.27, 0.16, 0, MATS.sleeve);
  box(torso, 0.14, 0.12, 0.2, 0.27, 0.16, 0, MATS.sleeve);

  // Minecraft head on top of the torso
  const head = new THREE.Group();
  head.position.set(0, 0.2, 0);
  torso.add(head);
  box(head, 0.22, 0.22, 0.22, 0, 0.11, 0, MATS.skin);
  box(head, 0.23, 0.08, 0.23, 0, 0.19, 0.005, MATS.black); // hair cap
  box(head, 0.04, 0.04, 0.04, 0, 0.1, -0.115, MATS.skin); // nose

  const mkLeg = (side: number) => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.13, 1.02, 0);
    box(leg, 0.17, 0.78, 0.2, 0, -0.4, 0, MATS.jeans);
    box(leg, 0.18, 0.1, 0.3, 0, -0.83, -0.04, MATS.boot);
    box(leg, 0.18, 0.06, 0.08, 0, -0.8, -0.2, MATS.boot);       // toe cap
    box(leg, 0.17, 0.12, 0.2, 0, -0.12, 0.005, MATS.black);     // knee pad
    g.add(leg);
    return leg;
  };
  const legL = mkLeg(-1);
  const legR = mkLeg(1);

  return {
    group: g,
    update(phase: number, speedNorm: number, airborne: boolean) {
      const swing = Math.sin(phase) * 0.75 * speedNorm;
      const swing2 = Math.sin(phase + Math.PI) * 0.75 * speedNorm;
      if (airborne) {
        legL.rotation.x = THREE.MathUtils.lerp(legL.rotation.x, 0.55, 0.2);
        legR.rotation.x = THREE.MathUtils.lerp(legR.rotation.x, -0.35, 0.2);
      } else {
        legL.rotation.x = swing2;
        legR.rotation.x = swing;
      }
      torso.rotation.x = speedNorm * 0.1;
    },
  };
}

// ---------------------------------------------------------------- weapons
export interface WeaponDef {
  id: string;
  name: string;
  slot: number;
  magSize: number;
  fireMode: 'semi' | 'auto' | 'bolt' | 'launcher';
  rpm: number;
  kick: { camP: [number, number]; camY: number; gunZ: number; gunRX: number; gunRZ: [number, number] };
  adsFov: number;
  scoped?: boolean;
  boltTime?: number;
  reloadKey: string;
  basePos: [number, number, number];
  baseRot: [number, number, number];
  sprintRot: [number, number, number];
  sprintPos: [number, number, number];
  sound: { freq: number; dur: number; gain: number; decay?: number; sub?: number };
}

export const WEAPON_ORDER = ['handgun', 'smg', 'rifle', 'sniper', 'bazooka'];

export const WEAPONS: Record<string, WeaponDef> = {
  handgun: {
    id: 'handgun', name: "P9 'SIDEKICK'", slot: 0, magSize: 12, fireMode: 'semi', rpm: 340,
    kick: { camP: [0.020, 0.028], camY: 0.008, gunZ: 0.052, gunRX: 0.10, gunRZ: [-0.02, 0.02] },
    adsFov: 58, reloadKey: 'reload_handgun',
    basePos: [0.17, -0.175, -0.32], baseRot: [0, 0.02, 0],
    sprintRot: [0.3, -0.5, 0.25], sprintPos: [0.0, -0.03, 0.04],
    sound: { freq: 1500, dur: 0.09, gain: 0.5, sub: 240 },
  },
  smg: {
    id: 'smg', name: "KV-9 'HORNET'", slot: 1, magSize: 32, fireMode: 'auto', rpm: 800,
    kick: { camP: [0.011, 0.017], camY: 0.007, gunZ: 0.038, gunRX: 0.065, gunRZ: [-0.022, 0.022] },
    adsFov: 56, reloadKey: 'reload_smg',
    basePos: [0.185, -0.185, -0.36], baseRot: [0, 0.02, 0],
    sprintRot: [0.34, -0.55, 0.3], sprintPos: [-0.01, -0.035, 0.05],
    sound: { freq: 1900, dur: 0.065, gain: 0.42, sub: 300 },
  },
  rifle: {
    id: 'rifle', name: "AR-77 'SENTINEL'", slot: 2, magSize: 30, fireMode: 'auto', rpm: 640,
    kick: { camP: [0.014, 0.021], camY: 0.009, gunZ: 0.055, gunRX: 0.085, gunRZ: [-0.02, 0.02] },
    adsFov: 54, reloadKey: 'reload_rifle',
    basePos: [0.185, -0.19, -0.38], baseRot: [0, 0.015, 0],
    sprintRot: [0.36, -0.6, 0.32], sprintPos: [-0.01, -0.04, 0.06],
    sound: { freq: 1150, dur: 0.11, gain: 0.58, sub: 150 },
  },
  sniper: {
    id: 'sniper', name: "LW-50 'LONGSTAR'", slot: 3, magSize: 5, fireMode: 'bolt', rpm: 46,
    kick: { camP: [0.075, 0.09], camY: 0.02, gunZ: 0.11, gunRX: 0.16, gunRZ: [-0.03, 0.03] },
    adsFov: 16, scoped: true, boltTime: 1.1, reloadKey: 'reload_sniper',
    basePos: [0.19, -0.2, -0.42], baseRot: [0, 0.012, 0],
    sprintRot: [0.4, -0.62, 0.34], sprintPos: [-0.01, -0.04, 0.06],
    sound: { freq: 750, dur: 0.32, gain: 0.85, sub: 80 },
  },
  bazooka: {
    id: 'bazooka', name: "RPG-9 'HAMMER'", slot: 4, magSize: 1, fireMode: 'launcher', rpm: 30,
    kick: { camP: [0.05, 0.06], camY: 0.02, gunZ: 0.14, gunRX: 0.2, gunRZ: [-0.05, 0.05] },
    adsFov: 50, reloadKey: 'reload_bazooka',
    basePos: [0.21, -0.19, -0.4], baseRot: [deg(5), deg(-9), deg(3)],
    sprintRot: [0.5, -0.7, 0.4], sprintPos: [-0.02, -0.05, 0.08],
    sound: { freq: 500, dur: 0.4, gain: 0.8, sub: 60 },
  },
};

export interface WeaponRig {
  def: WeaponDef;
  root: THREE.Group;            // added to camera
  gun: THREE.Group;             // animated by timelines
  bones: Map<string, THREE.Object3D>;
  rest: Map<string, { p: THREE.Vector3; r: THREE.Euler }>;
  sight: THREE.Object3D;
  muzzle: THREE.Object3D;
  eject: THREE.Object3D;
  armL: ArmLink;
  armR: ArmLink;
  anchorL: THREE.Object3D;
  anchorR: THREE.Object3D;
  magMesh: THREE.Object3D;
  magHandMesh: THREE.Object3D;
  warheadMesh?: THREE.Object3D;
  warheadHandMesh?: THREE.Object3D;
}

function trackBone(rig: WeaponRig, name: string, o: THREE.Object3D) {
  rig.bones.set(name, o);
  rig.rest.set(name, { p: o.position.clone(), r: o.rotation.clone() });
}

function finishRig(def: WeaponDef, root: THREE.Group, gun: THREE.Group): WeaponRig {
  const rig: WeaponRig = {
    def, root, gun,
    bones: new Map(), rest: new Map(),
    sight: new THREE.Object3D(), muzzle: new THREE.Object3D(), eject: new THREE.Object3D(),
    armL: null as unknown as ArmLink, armR: null as unknown as ArmLink,
    anchorL: new THREE.Object3D(), anchorR: new THREE.Object3D(),
    magMesh: new THREE.Object3D(), magHandMesh: new THREE.Object3D(),
  };
  gun.add(rig.sight, rig.muzzle, rig.eject);
  trackBone(rig, 'gun', gun);
  // arm anchors near bottom corners of view
  rig.anchorR.position.set(0.34, -0.4, 0.14);
  rig.anchorL.position.set(-0.26, -0.42, -0.05);
  root.add(rig.anchorR, rig.anchorL);
  return rig;
}

function attachHands(rig: WeaponRig, rp: [number, number, number], rr: [number, number, number], lp: [number, number, number], lr: [number, number, number]) {
  const rh = buildHand(true);
  rh.position.set(...rp); rh.rotation.set(...rr);
  const lh = buildHand(false);
  lh.position.set(...lp); lh.rotation.set(...lr);
  rig.gun.add(rh, lh);
  trackBone(rig, 'rhand', rh);
  trackBone(rig, 'lhand', lh);
  rig.armR = new ArmLink(rig.root, rig.anchorR, rh);
  rig.armL = new ArmLink(rig.root, rig.anchorL, lh);
}

// ---------------------------------------------------------------- handgun
function buildHandgun(): WeaponRig {
  const def = WEAPONS.handgun;
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const rig = finishRig(def, root, gun);

  // frame + rails
  box(gun, 0.042, 0.038, 0.19, 0, -0.004, -0.02, MATS.poly);
  box(gun, 0.03, 0.014, 0.05, 0, -0.024, -0.13, MATS.poly, deg(-6)); // dust cover
  // trigger guard + trigger
  box(gun, 0.008, 0.03, 0.008, 0, -0.045, -0.055, MATS.black);
  box(gun, 0.006, 0.026, 0.05, 0, -0.052, -0.078, MATS.black);
  box(gun, 0.008, 0.02, 0.008, 0, -0.045, -0.1, MATS.black);
  // grip
  box(gun, 0.038, 0.095, 0.05, 0, -0.07, 0.048, MATS.tan, deg(-14));
  box(gun, 0.04, 0.012, 0.052, 0, -0.117, 0.06, MATS.black, deg(-14));
  // hammer
  box(gun, 0.012, 0.02, 0.016, 0, 0.02, 0.072, MATS.gun2, deg(20));

  // slide (reciprocates on every shot)
  const slide = new THREE.Group();
  slide.position.set(0, 0.032, -0.015);
  gun.add(slide);
  box(slide, 0.046, 0.034, 0.2, 0, 0, 0, MATS.gun);
  // Layered slide profile, exposed barrel and a recessed ejection port.
  box(slide, 0.036, 0.012, 0.174, 0, 0.021, -0.008, MATS.gun2);
  box(slide, 0.025, 0.014, 0.058, 0, -0.012, -0.08, MATS.black);
  box(slide, 0.03, 0.014, 0.048, 0.012, 0.012, -0.006, MATS.black);
  box(slide, 0.012, 0.01, 0.042, 0.019, 0.01, -0.006, MATS.gun2);
  box(slide, 0.048, 0.012, 0.05, 0, 0.012, 0.076, MATS.black);           // serration block
  for (let i = 0; i < 4; i++) {
    box(slide, 0.05, 0.018, 0.004, 0, 0.002, 0.058 + i * 0.01, MATS.black);
  }
  box(slide, 0.028, 0.014, 0.02, 0, 0.026, 0.068, MATS.black);           // rear sight
  box(slide, 0.006, 0.005, 0.004, -0.008, 0.026, 0.058, MATS.whiteGlow); // rear dot L
  box(slide, 0.006, 0.005, 0.004, 0.008, 0.026, 0.058, MATS.whiteGlow);  // rear dot R
  box(slide, 0.006, 0.016, 0.01, 0, 0.024, -0.092, MATS.black);          // front post
  box(slide, 0.005, 0.005, 0.004, 0, 0.028, -0.097, MATS.whiteGlow);     // front dot
  trackBone(rig, 'slide', slide);

  // magazine (bone — animated out/in during reload)
  const mag = new THREE.Group();
  mag.position.set(0, -0.09, 0.052);
  mag.rotation.x = deg(-14);
  gun.add(mag);
  box(mag, 0.032, 0.075, 0.042, 0, 0, 0, MATS.gun2);
  box(mag, 0.038, 0.014, 0.05, 0, -0.04, 0, MATS.black);
  trackBone(rig, 'mag', mag);
  rig.magMesh = mag;

  const magHand = new THREE.Group();
  gun.add(magHand);
  box(magHand, 0.032, 0.075, 0.042, 0, 0, 0, MATS.gun2);
  box(magHand, 0.038, 0.014, 0.05, 0, -0.04, 0, MATS.black);
  magHand.visible = false;
  trackBone(rig, 'maghand', magHand);
  rig.magHandMesh = magHand;

  attachHands(rig,
    [0, -0.062, 0.055], [deg(-14), 0, 0],
    [-0.01, -0.095, 0.058], [deg(-30), deg(8), deg(6)]);

  rig.sight.position.set(0, 0.066, 0.06);
  rig.muzzle.position.set(0, 0.032, -0.14);
  rig.eject.position.set(0.03, 0.04, 0.0);
  return rig;
}

// ---------------------------------------------------------------- smg
function buildSMG(): WeaponRig {
  const def = WEAPONS.smg;
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const rig = finishRig(def, root, gun);

  box(gun, 0.05, 0.064, 0.3, 0, 0, -0.06, MATS.poly);                    // receiver
  box(gun, 0.054, 0.018, 0.27, 0, 0.041, -0.075, MATS.gun2);             // raised top rail
  for (let i = 0; i < 7; i++) box(gun, 0.058, 0.009, 0.014, 0, 0.055, -0.19 + i * 0.045, MATS.black);
  box(gun, 0.012, 0.026, 0.075, 0.029, 0.014, -0.065, MATS.black);        // ejection port
  box(gun, 0.01, 0.018, 0.055, 0.035, 0.012, -0.065, MATS.gun2);         // visible bolt
  box(gun, 0.044, 0.044, 0.1, 0, 0.004, -0.25, MATS.black);              // barrel shroud
  box(gun, 0.02, 0.02, 0.04, 0, 0.004, -0.31, MATS.gun);                 // muzzle
  box(gun, 0.046, 0.02, 0.24, 0, -0.036, -0.1, MATS.poly);               // lower rail
  box(gun, 0.04, 0.05, 0.16, 0, -0.005, 0.16, MATS.black);               // stock
  box(gun, 0.042, 0.07, 0.03, 0, -0.01, 0.25, MATS.poly);                // butt pad
  box(gun, 0.038, 0.09, 0.045, 0, -0.075, 0.055, MATS.gun, deg(-12));    // pistol grip
  for (let i = 0; i < 3; i++) box(gun, 0.041, 0.009, 0.048, 0, -0.05 - i * 0.024, 0.052 + i * 0.006, MATS.black, deg(-12));
  box(gun, 0.044, 0.08, 0.042, 0, -0.075, -0.205, MATS.poly, deg(4));     // vertical foregrip
  // ring front sight (homage to classic voxel FPS)
  box(gun, 0.006, 0.05, 0.006, -0.02, 0.055, -0.29, MATS.black);
  box(gun, 0.006, 0.05, 0.006, 0.02, 0.055, -0.29, MATS.black);
  box(gun, 0.046, 0.007, 0.006, 0, 0.083, -0.29, MATS.black);
  box(gun, 0.006, 0.006, 0.004, 0, 0.06, -0.292, MATS.redGlow);          // red dot
  box(gun, 0.03, 0.026, 0.04, 0, 0.05, 0.03, MATS.black);                // rear drum

  // curved magazine
  const mag = new THREE.Group();
  mag.position.set(0, -0.055, -0.1);
  gun.add(mag);
  box(mag, 0.036, 0.06, 0.044, 0, -0.028, 0, MATS.gun2, deg(6));
  box(mag, 0.036, 0.06, 0.044, 0, -0.083, 0.008, MATS.gun2, deg(18));
  box(mag, 0.038, 0.03, 0.046, 0, -0.133, 0.024, MATS.black, deg(26));
  trackBone(rig, 'mag', mag);
  rig.magMesh = mag;

  const magHand = new THREE.Group();
  gun.add(magHand);
  box(magHand, 0.036, 0.06, 0.044, 0, -0.028, 0, MATS.gun2, deg(6));
  box(magHand, 0.036, 0.06, 0.044, 0, -0.083, 0.008, MATS.gun2, deg(18));
  box(magHand, 0.038, 0.03, 0.046, 0, -0.133, 0.024, MATS.black, deg(26));
  magHand.visible = false;
  trackBone(rig, 'maghand', magHand);
  rig.magHandMesh = magHand;

  // charging handle
  const handle = new THREE.Group();
  handle.position.set(-0.032, 0.02, -0.2);
  gun.add(handle);
  box(handle, 0.02, 0.014, 0.05, 0, 0, 0, MATS.gun2);
  box(handle, 0.018, 0.024, 0.018, -0.01, 0, -0.02, MATS.black);
  trackBone(rig, 'handle', handle);

  attachHands(rig,
    [0, -0.072, 0.058], [deg(-12), 0, 0],
    [0, -0.075, -0.155], [deg(-55), 0, 0]);

  rig.sight.position.set(0, 0.062, 0.03);
  rig.muzzle.position.set(0, 0.004, -0.34);
  rig.eject.position.set(0.03, 0.02, -0.04);
  return rig;
}

// ---------------------------------------------------------------- rifle
function buildRifle(): WeaponRig {
  const def = WEAPONS.rifle;
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const rig = finishRig(def, root, gun);

  box(gun, 0.048, 0.056, 0.17, 0, -0.01, 0.02, MATS.poly);               // lower receiver
  box(gun, 0.048, 0.042, 0.36, 0, 0.032, -0.1, MATS.black);              // upper + rail
  box(gun, 0.012, 0.026, 0.09, 0.029, 0.034, -0.035, MATS.gun2);         // bolt carrier in port
  box(gun, 0.008, 0.034, 0.11, 0.034, 0.032, -0.035, MATS.black);        // ejection-port rim
  box(gun, 0.054, 0.054, 0.24, 0, 0.03, -0.28, MATS.poly);               // handguard
  box(gun, 0.058, 0.012, 0.2, 0, 0.062, -0.28, MATS.black);              // top rail
  for (let i = 0; i < 4; i++) box(gun, 0.056, 0.02, 0.03, 0, 0.03, -0.36 + i * 0.055, MATS.black);
  box(gun, 0.022, 0.022, 0.09, 0, 0.032, -0.445, MATS.gun);              // barrel
  box(gun, 0.034, 0.034, 0.06, 0, 0.032, -0.5, MATS.black);              // muzzle brake
  box(gun, 0.036, 0.008, 0.02, 0, 0.032, -0.5, MATS.gun2);
  // front sight triangle
  box(gun, 0.006, 0.05, 0.008, -0.014, 0.085, -0.37, MATS.gun, 0, 0, deg(-14));
  box(gun, 0.006, 0.05, 0.008, 0.014, 0.085, -0.37, MATS.gun, 0, 0, deg(14));
  box(gun, 0.005, 0.03, 0.006, 0, 0.09, -0.37, MATS.gun);
  // rear sight aperture
  box(gun, 0.008, 0.03, 0.01, -0.014, 0.08, 0.005, MATS.black);
  box(gun, 0.008, 0.03, 0.01, 0.014, 0.08, 0.005, MATS.black);
  box(gun, 0.036, 0.008, 0.01, 0, 0.097, 0.005, MATS.black);
  // Compact voxel reflex optic gives the rifle a distinctive silhouette.
  box(gun, 0.05, 0.012, 0.085, 0, 0.076, -0.085, MATS.black);
  box(gun, 0.008, 0.056, 0.014, -0.022, 0.108, -0.085, MATS.black);
  box(gun, 0.008, 0.056, 0.014, 0.022, 0.108, -0.085, MATS.black);
  box(gun, 0.052, 0.009, 0.014, 0, 0.137, -0.085, MATS.black);
  box(gun, 0.006, 0.006, 0.006, 0, 0.108, -0.094, MATS.redGlow);
  // stock
  box(gun, 0.044, 0.055, 0.17, 0, 0.02, 0.185, MATS.poly);
  box(gun, 0.048, 0.085, 0.03, 0, 0.015, 0.28, MATS.black);
  box(gun, 0.03, 0.03, 0.12, 0, -0.012, 0.17, MATS.poly);                // stock tube
  box(gun, 0.038, 0.095, 0.045, 0, -0.085, 0.06, MATS.gun, deg(-14));    // pistol grip
  box(gun, 0.008, 0.032, 0.008, 0, -0.052, -0.015, MATS.black);          // trigger

  // curved mag
  const mag = new THREE.Group();
  mag.position.set(0, -0.05, -0.03);
  gun.add(mag);
  box(mag, 0.04, 0.062, 0.05, 0, -0.03, 0, MATS.gun2, deg(8));
  box(mag, 0.04, 0.062, 0.05, 0, -0.09, 0.012, MATS.gun2, deg(20));
  box(mag, 0.042, 0.05, 0.05, 0, -0.14, 0.033, MATS.gun2, deg(30));
  box(mag, 0.044, 0.014, 0.052, 0, -0.167, 0.045, MATS.black, deg(34));
  trackBone(rig, 'mag', mag);
  rig.magMesh = mag;

  const magHand = new THREE.Group();
  gun.add(magHand);
  box(magHand, 0.04, 0.062, 0.05, 0, -0.03, 0, MATS.gun2, deg(8));
  box(magHand, 0.04, 0.062, 0.05, 0, -0.09, 0.012, MATS.gun2, deg(20));
  box(magHand, 0.042, 0.05, 0.05, 0, -0.14, 0.033, MATS.gun2, deg(30));
  magHand.visible = false;
  trackBone(rig, 'maghand', magHand);
  rig.magHandMesh = magHand;

  // charging handle
  const handle = new THREE.Group();
  handle.position.set(0, 0.048, 0.085);
  gun.add(handle);
  box(handle, 0.012, 0.012, 0.04, 0, 0, 0, MATS.gun2);
  box(handle, 0.036, 0.014, 0.016, 0, 0, 0.02, MATS.black);
  trackBone(rig, 'handle', handle);

  attachHands(rig,
    [0, -0.082, 0.062], [deg(-14), 0, 0],
    [0, -0.05, -0.245], [deg(-75), 0, 0]);

  rig.sight.position.set(0, 0.108, -0.085);
  rig.muzzle.position.set(0, 0.032, -0.54);
  rig.eject.position.set(0.032, 0.032, -0.02);
  return rig;
}

// ---------------------------------------------------------------- sniper
function buildSniper(): WeaponRig {
  const def = WEAPONS.sniper;
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const rig = finishRig(def, root, gun);

  box(gun, 0.054, 0.072, 0.24, 0, 0, -0.02, MATS.olive);                 // receiver
  box(gun, 0.026, 0.026, 0.52, 0, 0.012, -0.4, MATS.black);              // barrel
  // Fluted barrel blocks add depth without breaking the voxel language.
  for (let i = 0; i < 5; i++) box(gun, 0.032, 0.008, 0.05, 0, 0.025, -0.28 - i * 0.07, MATS.gun2);
  box(gun, 0.048, 0.048, 0.09, 0, 0.012, -0.68, MATS.black);             // muzzle brake
  box(gun, 0.05, 0.012, 0.03, 0, 0.012, -0.68, MATS.gun2);
  box(gun, 0.012, 0.05, 0.03, 0, 0.012, -0.66, MATS.gun2);
  // scope
  box(gun, 0.052, 0.052, 0.2, 0, 0.098, -0.06, MATS.black);
  box(gun, 0.06, 0.06, 0.05, 0, 0.098, -0.17, MATS.black);               // objective bell
  box(gun, 0.056, 0.056, 0.04, 0, 0.098, 0.05, MATS.black);              // ocular
  box(gun, 0.045, 0.045, 0.005, 0, 0.098, 0.073, MATS.glass);            // rear lens
  box(gun, 0.05, 0.05, 0.004, 0, 0.098, -0.196, MATS.glass);             // front glass
  box(gun, 0.01, 0.03, 0.03, 0, 0.14, -0.06, MATS.black);                // turret
  box(gun, 0.04, 0.018, 0.035, 0.032, 0.105, -0.06, MATS.gun2);          // windage knob
  box(gun, 0.012, 0.05, 0.04, -0.02, 0.06, -0.1, MATS.gun);              // mount front
  box(gun, 0.012, 0.05, 0.04, 0.02, 0.06, 0.03, MATS.gun);               // mount rear
  // stock
  box(gun, 0.05, 0.08, 0.32, 0, -0.02, 0.2, MATS.olive);
  box(gun, 0.046, 0.026, 0.16, 0, 0.045, 0.22, MATS.black);              // cheek riser
  box(gun, 0.054, 0.1, 0.03, 0, -0.02, 0.37, MATS.poly);                 // butt pad
  box(gun, 0.038, 0.095, 0.045, 0, -0.085, 0.07, MATS.poly, deg(-14));   // grip
  box(gun, 0.044, 0.03, 0.2, 0, -0.062, -0.16, MATS.olive);              // fore stock
  // folded bipod
  box(gun, 0.01, 0.01, 0.16, -0.02, -0.045, -0.5, MATS.gun2, deg(8));
  box(gun, 0.01, 0.01, 0.16, 0.02, -0.045, -0.5, MATS.gun2, deg(8));

  // bolt assembly (lift + pull during cycle)
  const bolt = new THREE.Group();
  bolt.position.set(0, 0.02, 0.045);
  gun.add(bolt);
  box(bolt, 0.022, 0.022, 0.1, 0, 0, 0, MATS.gun2);
  box(bolt, 0.036, 0.014, 0.014, 0.026, 0, 0.01, MATS.gun2, 0, 0, deg(-38));
  box(bolt, 0.026, 0.026, 0.026, 0.045, 0.014, 0.01, MATS.black);
  trackBone(rig, 'bolt', bolt);

  // straight box mag
  const mag = new THREE.Group();
  mag.position.set(0, -0.055, -0.02);
  gun.add(mag);
  box(mag, 0.04, 0.06, 0.1, 0, -0.03, 0, MATS.gun2);
  box(mag, 0.042, 0.012, 0.102, 0, -0.062, 0, MATS.black);
  trackBone(rig, 'mag', mag);
  rig.magMesh = mag;

  const magHand = new THREE.Group();
  gun.add(magHand);
  box(magHand, 0.04, 0.06, 0.1, 0, -0.03, 0, MATS.gun2);
  box(magHand, 0.042, 0.012, 0.102, 0, -0.062, 0, MATS.black);
  magHand.visible = false;
  trackBone(rig, 'maghand', magHand);
  rig.magHandMesh = magHand;

  attachHands(rig,
    [0, -0.085, 0.068], [deg(-14), 0, 0],
    [0, -0.095, -0.15], [deg(-70), 0, 0]);

  rig.sight.position.set(0, 0.098, 0.05);
  rig.muzzle.position.set(0, 0.012, -0.74);
  rig.eject.position.set(0.034, 0.03, 0.0);
  return rig;
}

// ---------------------------------------------------------------- bazooka
function buildBazooka(): WeaponRig {
  const def = WEAPONS.bazooka;
  const root = new THREE.Group();
  const gun = new THREE.Group();
  root.add(gun);
  const rig = finishRig(def, root, gun);

  box(gun, 0.072, 0.072, 0.66, 0, 0, -0.04, MATS.warhead);               // main tube
  box(gun, 0.058, 0.058, 0.5, 0, 0, -0.03, MATS.black);                  // dark inner tube core
  box(gun, 0.066, 0.066, 0.45, 0, 0, -0.06, MATS.warhead);               // squared outer shell
  box(gun, 0.08, 0.08, 0.035, 0, 0, -0.37, MATS.black);                  // front rim
  box(gun, 0.08, 0.08, 0.035, 0, 0, 0.18, MATS.black);                   // mid rim
  // rear flare (stepped cone)
  box(gun, 0.09, 0.09, 0.06, 0, 0, 0.26, MATS.warheadTip);
  box(gun, 0.11, 0.11, 0.05, 0, 0, 0.32, MATS.warheadTip);
  box(gun, 0.13, 0.13, 0.04, 0, 0, 0.38, MATS.black);
  box(gun, 0.105, 0.105, 0.012, 0, 0, 0.402, MATS.gun);                  // rear nozzle interior
  // wooden heat guard
  box(gun, 0.078, 0.05, 0.2, 0, 0.02, 0.02, MATS.wood);
  for (let i = 0; i < 4; i++) box(gun, 0.082, 0.012, 0.012, 0, 0.048, -0.05 + i * 0.045, MATS.tan);
  // grips + trigger
  box(gun, 0.036, 0.085, 0.045, 0, -0.08, 0.08, MATS.wood, deg(-10));
  box(gun, 0.008, 0.026, 0.008, 0, -0.05, 0.03, MATS.black);
  box(gun, 0.03, 0.03, 0.28, 0, -0.075, -0.1, MATS.wood);                // front handle bar
  box(gun, 0.04, 0.05, 0.05, 0, -0.075, -0.2, MATS.black);               // front grip cap
  // offset iron sights
  box(gun, 0.008, 0.05, 0.008, -0.055, 0.05, -0.28, MATS.black);
  box(gun, 0.03, 0.008, 0.008, -0.055, 0.075, -0.28, MATS.black);
  box(gun, 0.008, 0.04, 0.008, -0.055, 0.045, 0.12, MATS.black);
  box(gun, 0.012, 0.012, 0.012, -0.055, 0.068, -0.28, MATS.whiteGlow);
  // shoulder rest
  box(gun, 0.06, 0.05, 0.12, 0, -0.055, 0.14, MATS.warheadTip);

  // loaded warhead protruding from muzzle
  const warhead = new THREE.Group();
  gun.add(warhead);
  box(warhead, 0.052, 0.052, 0.1, 0, 0, -0.42, MATS.warhead);
  box(warhead, 0.092, 0.092, 0.07, 0, 0, -0.5, MATS.warhead);
  box(warhead, 0.06, 0.06, 0.05, 0, 0, -0.56, MATS.warheadTip);
  box(warhead, 0.032, 0.032, 0.05, 0, 0, -0.6, MATS.warheadTip);
  trackBone(rig, 'warhead', warhead);
  rig.warheadMesh = warhead;

  // Rocket carried in the left hand during reload.
  // Its nose section is an EXACT copy of the loaded warhead above, shifted
  // +0.30 in Z. The reload timeline seats this bone at z = -0.30, so on the
  // handoff frame the carried rocket and the loaded rocket occupy identical
  // world space — the swap is literally invisible (no pop, no blink).
  const warheadHand = new THREE.Group();
  gun.add(warheadHand);
  box(warheadHand, 0.052, 0.052, 0.1, 0, 0, -0.12, MATS.warhead);
  box(warheadHand, 0.092, 0.092, 0.07, 0, 0, -0.2, MATS.warhead);
  box(warheadHand, 0.06, 0.06, 0.05, 0, 0, -0.26, MATS.warheadTip);
  box(warheadHand, 0.032, 0.032, 0.05, 0, 0, -0.3, MATS.warheadTip);
  // Motor tube + fins. Kept under the 0.058 bore width so that once the rocket
  // is seated they vanish cleanly inside the launcher instead of poking out
  // through the side of the body.
  box(warheadHand, 0.05, 0.05, 0.2, 0, 0, 0.02, MATS.warheadTip);
  box(warheadHand, 0.012, 0.036, 0.05, 0, 0, 0.1, MATS.black);
  box(warheadHand, 0.036, 0.012, 0.05, 0, 0, 0.1, MATS.black);
  warheadHand.visible = false;
  trackBone(rig, 'warheadhand', warheadHand);
  rig.warheadHandMesh = warheadHand;

  attachHands(rig,
    [0, -0.085, 0.08], [deg(-10), 0, 0],
    [0, -0.11, -0.19], [deg(-90), 0, 0]);

  rig.sight.position.set(-0.055, 0.075, 0.0);
  rig.muzzle.position.set(0, 0, -0.6);
  rig.eject.position.set(0, 0, 0.42);
  return rig;
}

export function buildWeapon(id: string): WeaponRig {
  switch (id) {
    case 'handgun': return buildHandgun();
    case 'smg': return buildSMG();
    case 'rifle': return buildRifle();
    case 'sniper': return buildSniper();
    case 'bazooka': return buildBazooka();
    default: return buildHandgun();
  }
}
