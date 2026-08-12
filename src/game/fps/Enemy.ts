import type * as THREE from 'three';
import type { WorldLike } from './World';
import type { Tier } from './tiers';
import type { FlowField, FlowSample } from './FlowField';

export type EnemyState = 'spawn' | 'idle' | 'patrol' | 'chase' | 'attack' | 'dead';
export type EnemyBehavior = 'patrol' | 'idle';

export interface EnemyConfig {
  id: string;
  name: string;
  hp: number;
  speed: number;
  sightRange: number;
  attackRange: number;
  preferredRange: number;
  attackCooldown: number;
  burst: number;
  burstDelay: number;
  accuracy: number;
  damage: number;
  skin: string;
  shirt: string;
  pants: string;
  seed: number;
  behavior: EnemyBehavior;
  peaceful?: boolean;
}

export type EnemyPlayer = { pos: THREE.Vector3; state: string; dead: boolean };

export type EnemyDeps = {
  world: WorldLike;
  getPlayer: () => EnemyPlayer;
  sound?: any;
  getFlowField?: (tier: Tier) => FlowField | null;
  flowField?: FlowField;
};

const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/Enemy.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const ENEMY_FIRE_MODE: typeof _mod.ENEMY_FIRE_MODE = _mod.ENEMY_FIRE_MODE;
export const ENEMY_FIRE_RANGE: typeof _mod.ENEMY_FIRE_RANGE = _mod.ENEMY_FIRE_RANGE;
export const ENEMY_PRESETS: typeof _mod.ENEMY_PRESETS = _mod.ENEMY_PRESETS;
export const Enemy: typeof _mod.Enemy = _mod.Enemy;
