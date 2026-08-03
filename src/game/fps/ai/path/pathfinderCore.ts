// A* data structures: pooled min-heap + standability helpers for voxel pathfinding.
import * as THREE from 'three';
import { WORLD_SIZE, WORLD_HEIGHT, type WorldLike } from '../../World';

export const SIZE = WORLD_SIZE;
export const HEIGHT = WORLD_HEIGHT;
export const LAYER = SIZE * SIZE;

export const packKey = (x: number, y: number, z: number) => (y * SIZE + z) * SIZE + x;

export class MinHeap {
  private keys: number[] = [];
  private prio: number[] = [];
  size = 0;

  clear() { this.size = 0; }

  push(key: number, p: number) {
    let i = this.size++;
    this.keys[i] = key; this.prio[i] = p;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (this.prio[par] <= this.prio[i]) break;
      this.swap(i, par); i = par;
    }
  }

  pop(): number {
    const top = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.keys[0] = this.keys[this.size]; this.prio[0] = this.prio[this.size];
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < this.size && this.prio[l] < this.prio[s]) s = l;
        if (r < this.size && this.prio[r] < this.prio[s]) s = r;
        if (s === i) break;
        this.swap(i, s); i = s;
      }
    }
    return top;
  }

  private swap(a: number, b: number) {
    const tk = this.keys[a], tp = this.prio[a];
    this.keys[a] = this.keys[b]; this.prio[a] = this.prio[b];
    this.keys[b] = tk; this.prio[b] = tp;
  }
}

// pooled search state (single-threaded, one search at a time)
export const heap = new MinHeap();
export const gScore = new Map<number, number>();
export const cameFrom = new Map<number, number>();
export const closed = new Set<number>();

export interface PathOptions {
  maxNodes?: number;
  maxFall?: number;
  maxJump?: number;
  reachRadius?: number;
}

/** Can a 2-block-tall entity stand with its feet at (x,y,z)? */
export function canStand(world: WorldLike, x: number, y: number, z: number): boolean {
  if (y < 1 || y >= HEIGHT - 1) return false;
  if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return false;
  return world.solid(x, y - 1, z) && !world.solid(x, y, z) && !world.solid(x, y + 1, z);
}

/** Can a 2-block-tall entity pass through (x,y,z) — no floor requirement. */
export function passable(world: WorldLike, x: number, y: number, z: number): boolean {
  if (y < 0 || y >= HEIGHT - 1 || x < 0 || z < 0 || x >= SIZE || z >= SIZE) return false;
  return !world.solid(x, y, z) && !world.solid(x, y + 1, z);
}

/** Snap a position to the nearest standable voxel (scans down, then up). */
export function snapToGround(world: WorldLike, x: number, y: number, z: number, range = 8): number {
  if (canStand(world, x, y, z)) return y;
  for (let d = 1; d <= range; d++) {
    if (canStand(world, x, y - d, z)) return y - d;
    if (canStand(world, x, y + d, z)) return y + d;
  }
  return -1;
}

export const NEIGHBORS: [number, number][] = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

void THREE; // imported for consumers

