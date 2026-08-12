import type * as THREE from 'three';

export interface BodyRig {
  group: THREE.Group;
  update(phase: number, speedNorm: number, airborne: boolean): void;
}

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

export interface WeaponRig {
  def: WeaponDef;
  root: THREE.Group;
  gun: THREE.Group;
  bones: Map<string, THREE.Object3D>;
  rest: Map<string, { p: THREE.Vector3; r: THREE.Euler }>;
  sight: THREE.Object3D;
  muzzle: THREE.Object3D;
  eject: THREE.Object3D;
  armL: any;
  armR: any;
  anchorL: THREE.Object3D;
  anchorR: THREE.Object3D;
  magMesh: THREE.Object3D;
  magHandMesh: THREE.Object3D;
  warheadMesh?: THREE.Object3D;
  warheadHandMesh?: THREE.Object3D;
}

const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/models.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const MATS: typeof _mod.MATS = _mod.MATS;
export const box: typeof _mod.box = _mod.box;
export const buildHand: typeof _mod.buildHand = _mod.buildHand;
export const ArmLink: typeof _mod.ArmLink = _mod.ArmLink;
export const buildBody: typeof _mod.buildBody = _mod.buildBody;
export const WEAPON_ORDER: typeof _mod.WEAPON_ORDER = _mod.WEAPON_ORDER;
export const WEAPONS: typeof _mod.WEAPONS = _mod.WEAPONS;
export const buildWeapon: typeof _mod.buildWeapon = _mod.buildWeapon;
