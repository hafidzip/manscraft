import * as THREE from 'three';
import type { WorldLike } from '../../World';
import type { Effects } from '../../effects';
import type { AudioSynth } from '../../audio';

export type EnemyState = 'spawn' | 'idle' | 'patrol' | 'chase' | 'attack' | 'dead';

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
  /** Behavior type: 'patrol' = moves between patrol points, 'idle' = stays at post */
  behavior: 'patrol' | 'idle';
}

/** 'config' = each class uses its own attackRange (see presets below). */
export const ENEMY_FIRE_MODE: 'config' | 'distance' = 'config';
/** Global fallback range used when ENEMY_FIRE_MODE === 'distance'. */
export const ENEMY_FIRE_RANGE = 28;

export const ENEMY_PRESETS: Record<string, EnemyConfig> = {
  grunt: {
    id: 'grunt', name: 'GRUNT', hp: 40, speed: 3.0, sightRange: 9999, attackRange: 26,
    preferredRange: 12, attackCooldown: 1.6, burst: 3, burstDelay: 0.16,
    accuracy: 0.72, damage: 7, skin: '#c98f5f', shirt: '#4a5d3a', pants: '#3a3f4a', seed: 12,
    behavior: 'patrol',
  },
  runner: {
    id: 'runner', name: 'RUNNER', hp: 26, speed: 4.4, sightRange: 9999, attackRange: 20,
    preferredRange: 7, attackCooldown: 1.1, burst: 4, burstDelay: 0.11,
    accuracy: 0.6, damage: 5, skin: '#a9764b', shirt: '#7a3030', pants: '#2c2c30', seed: 31,
    behavior: 'patrol',
  },
  heavy: {
    id: 'heavy', name: 'HEAVY', hp: 90, speed: 2.1, sightRange: 9999, attackRange: 34,
    preferredRange: 16, attackCooldown: 2.1, burst: 6, burstDelay: 0.13,
    accuracy: 0.8, damage: 10, skin: '#b9825a', shirt: '#2f3a4a', pants: '#23262c', seed: 55,
    behavior: 'idle',
  },
};

/** minimal player surface enemies need */
export interface EnemyPlayer {
  pos: THREE.Vector3;
}

export interface EnemyDeps {
  world: WorldLike;
  effects: Effects;
  audio: AudioSynth;
  camera: THREE.Object3D;
  onPlayerHit(dmg: number, from: THREE.Vector3): void;
  onEnemyKilled(e: any): void;
}

export interface EnemyHit {
  enemy: any;
  point: THREE.Vector3;
  headshot: boolean;
  dist: number;
}

/**
 * Shared per-frame pathfinding budget. The manager refills it each frame so
 * only a couple of A* searches ever run in a single frame.
 */
export const pathBudget = { tokens: 0 };

