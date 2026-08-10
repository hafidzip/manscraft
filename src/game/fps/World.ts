import type * as THREE from 'three';

export const B = {
  AIR: 0,
  GRASS: 1,
  DIRT: 2,
  STONE: 3,
  SAND: 4,
  SANDSTONE: 5,
  LOG: 6,
  LEAVES: 7,
  CACTUS: 8,
  PLANK: 9,
  ORE: 10,
  COBBLE: 11,
  WOOL: 12,
  BEDROCK: 13,
  CRAFTING_TABLE: 14,
  GLASS: 15,
  FURNACE: 16,
  COAL: 58,
  STICK: 59,
  TORCH: 60,
  CONVEYOR: 61,
  INSERTER: 62,
  LASER_MINER: 63,
  TURRET: 64,
} as const;

export const BLOCK_COLORS: Record<number, number> = {
  [B.GRASS]: 0x5faa3c,
  [B.DIRT]: 0x7a5a38,
  [B.STONE]: 0x82858a,
  [B.SAND]: 0xddd3a0,
  [B.SANDSTONE]: 0xd8cd9c,
  [B.LOG]: 0x6b5136,
  [B.LEAVES]: 0x3f7a2b,
  [B.CACTUS]: 0x3f8f3f,
  [B.PLANK]: 0xa1814f,
  [B.ORE]: 0xe8b93c,
  [B.COBBLE]: 0x7d7f82,
  [B.WOOL]: 0xe8e6df,
  [B.BEDROCK]: 0x333336,
  [B.CRAFTING_TABLE]: 0xa48150,
  [B.GLASS]: 0xcee8f5,
  [B.FURNACE]: 0x7c7c80,
  [B.CONVEYOR]: 0x484854,
  [B.INSERTER]: 0x505058,
  [B.LASER_MINER]: 0x9aa0a8,
  [B.TURRET]: 0x8c939c,
};

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  block: number;
  x: number;
  y: number;
  z: number;
  dist: number;
}

export interface WorldLike {
  group: THREE.Group;
  spawn: THREE.Vector3;
  solid(x: number, y: number, z: number): boolean;
  get(x: number, y: number, z: number): number;
  peekBlock(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number, markDirty?: boolean): void;
  highestY(x: number, z: number): number;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist?: number): RayHit | null;
}