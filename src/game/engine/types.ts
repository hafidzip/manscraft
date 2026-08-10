import * as THREE from 'three';
import type { Spring1 } from '../fps/anim';
import type { PlanetTheme } from '../space/theme';

export interface Target {
  group: THREE.Group;
  board: THREE.Mesh;
  boardMat: THREE.MeshLambertMaterial;
  wobbleX: Spring1;
  wobbleZ: Spring1;
  flash: number;
}

export interface HotbarItem {
  id: number | string;
  name: string;
  icon: string;
  count?: number;
}

export interface HudStats {
  fps: number;
  x: number;
  y: number;
  z: number;
  biome: string;
  time: number;
  underwater: boolean;
  muted: boolean;
  isDay: boolean;
  piloting: boolean;
  shipSpeed: number;
  shipAlt: number;
  shipNear: boolean;
  hp: number;
  maxHp: number;
  kills: number;
  campsTotal: number;
  campsCleared: number;
  enemiesAlive: number;
  dead: boolean;
  respawnIn: number;
  toolMode: 'weapon' | 'laser' | 'block' | 'food';
  weaponId: string;
  weaponName: string;
  ammo: number;
  mag: number;
  reloading: boolean;
  reloadT: number;
  inventoryOpen: boolean;
  craftingOpen: boolean;
  furnaceOpen: boolean;
  furnaceBurn: number;
  furnaceCook: number;
  slot: number;
  enemiesEnabled: boolean;
  mineCharge: number;
  heldBlockId: number | null;
  scoped: boolean;
  ads: number;
  hitSeq: number;
  damageSeq: number;
  dmgAngle: number;
  demolition: number;
  blocksMined: number;
  targetsHit: number;
  session: number;
  switchAt: number;
  spread: number;
  coins: number;
  coinSeq: number;
  lastCoinGain: number;
  nearMerchant: boolean;
  shopOpen: boolean;
  shopMerchantName: string | null;
  shopStock: { itemId: string; quantity: number; maxQuantity: number }[];
  shopSellOpen: boolean;
}

export interface EngineEvents {
  onProgress: (p: number, label: string) => void;
  onReady: (items: HotbarItem[], seed: number) => void;
  onLock: (locked: boolean) => void;
  onSelect: (index: number) => void;
  onStats: (s: HudStats) => void;
  onEnterSpace?: (theme: PlanetTheme | null) => void;
}
