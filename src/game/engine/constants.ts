import * as THREE from 'three';
import { B } from '../world/blocks';

export const SPACE_ALTITUDE = 170;

export const LOAD_LABELS = [
  'Baking pixel textures',
  'Carving mountains',
  'Growing forests',
  'Filling oceans',
  'Placing torches of the sun',
];

export const UNDERWATER_FOG = new THREE.Color(0x0a2a5e);

export const NIGHT_MIST = new THREE.Color(0x39465e);

export const LASER_NAME = "MK-7 'PROSPECTOR'";
export const DEATH_DURATION = 4;

export const CELESTIAL_SHADOW_SIZE = 2048;
export const CELESTIAL_SHADOW_HALF_EXTENT = 44;

export const GRASS_SHADOW_RADIUS = 0;

export const TO_FPS: Record<number, number> = {
  [B.GRASS]: 1, [B.DIRT]: 2, [B.STONE]: 3, [B.SAND]: 4,
  [B.LOG]: 6, [B.LEAVES]: 7, [B.CACTUS]: 8, [B.PLANKS]: 9,
  [B.CRAFTING_TABLE]: 14, [B.GLASS]: 15, [B.FURNACE]: 16, [B.FURNACE_LIT]: 16,
  [B.COBBLE]: 11,
  [B.COAL_ORE]: 58, [B.TORCH]: 60,
  [B.CONVEYOR_N]: 61, [B.CONVEYOR_E]: 61, [B.CONVEYOR_S]: 61, [B.CONVEYOR_W]: 61,
  [B.INSERTER_N]: 62, [B.INSERTER_E]: 62, [B.INSERTER_S]: 62, [B.INSERTER_W]: 62,
  [B.LASER_MINER_N]: 63, [B.LASER_MINER_E]: 63, [B.LASER_MINER_S]: 63, [B.LASER_MINER_W]: 63,
  [B.ORE_RUBY]: 50, [B.ORE_AMBER]: 51, [B.ORE_LUMINESCENCE]: 52,
  [B.ORE_DIAMOND]: 53, [B.ORE_GOLD]: 54, [B.ORE_SILVER]: 55,
  [B.ORE_JADE]: 56, [B.ORE_EMERALD]: 57,
};

export const FROM_FPS: Record<number, number> = Object.fromEntries(
  Object.entries(TO_FPS).map(([k, v]) => [v, Number(k)])
);
FROM_FPS[58] = B.COAL_ITEM;
FROM_FPS[59] = B.STICK_ITEM;
FROM_FPS[60] = B.TORCH;
FROM_FPS[61] = B.CONVEYOR_E;
FROM_FPS[62] = B.INSERTER_E;
FROM_FPS[63] = B.LASER_MINER_E;

export const B_COAL = 58;
export const B_STICK = 59;

export const GUN_ICON_COLORS = ['#9aa4ae', '#565b3c', '#3f4650', '#6b5136', '#5d6142', '#ff8a3c'];
