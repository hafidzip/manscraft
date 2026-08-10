import {
  CHUNK_LOG2, CHUNK_MASK, WORLD_CHUNKS_MASK, WORLD_HEIGHT,
} from './constants';

export const packCell = (x: number, y: number, z: number): number =>
  (x & 511) | ((z & 511) << 9) | ((y & 127) << 18);

export const cellX = (k: number): number => k & 511;
export const cellZ = (k: number): number => (k >>> 9) & 511;
export const cellY = (k: number): number => (k >>> 18) & 127;

export const wrapI = (v: number): number => v & 511;

export const CHUNK_BUCKETS = (WORLD_CHUNKS_MASK + 1) * (WORLD_CHUNKS_MASK + 1);
export const packChunk = (cx: number, cz: number): number =>
  ((cx & WORLD_CHUNKS_MASK) << 5) | (cz & WORLD_CHUNKS_MASK);
export const chunkOfBlock = (v: number): number =>
  (v >> CHUNK_LOG2) & WORLD_CHUNKS_MASK;
export const chunkRadiusFor = (blockRadius: number): number =>
  (Math.ceil(blockRadius) + CHUNK_MASK) >> CHUNK_LOG2;

if (WORLD_HEIGHT > 128) {
  throw new Error('cellKey: WORLD_HEIGHT > 128 needs more Y bits in packCell');
}