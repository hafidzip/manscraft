/**
 * Global game configuration.
 * Everything tunable lives here so modules never hard-code magic numbers.
 */

export const CHUNK_SIZE = 16; // 2^4
export const CHUNK_LOG2 = 4;
export const CHUNK_MASK = 15;
export const WORLD_HEIGHT = 80;
export const SEA_LEVEL = 30;

/** Chunk render radius around the player */
export const VIEW_DISTANCE = 5;
/** Hysteresis: evict meshes only beyond this radius */
export const EVICT_DISTANCE = 7;

// ---- Toroidal topology (hard constraints) ----
// Trip space (camera/player/sim/rendering) is UNBOUNDED and never wraps.
// Only torus space (voxel storage, meshes, caches) wraps — always.
// WORLD_CHUNKS = 2^5 satisfies N ≥ 2R+1: no chunk ever visible twice.
export const WORLD_CHUNKS = 32;
export const WORLD_CHUNKS_MASK = 31;
export const WORLD_SIZE = WORLD_CHUNKS * CHUNK_SIZE; // 512 blocks per edge
export const WORLD_HALF = WORLD_SIZE / 2;

/** canonical chunk coordinate (& mask — negatives are safe) */
export const wrapChunk = (c: number): number => c & WORLD_CHUNKS_MASK;

/** canonical block coordinate in [0, WORLD_SIZE) */
export const wrapBlock = (x: number): number => ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

/** shortest signed delta on a ring of circumference m (in (-m/2, m/2]) */
export const wrapDelta = (d: number, m: number): number => {
  const w = ((d % m) + m) % m;
  return w > m / 2 ? w - m : w;
};

/** minimum-image convention for floats (render/entity deltas, in blocks) */
export const minImageF = (d: number): number => d - WORLD_SIZE * Math.round(d / WORLD_SIZE);

// ---- Player physics ----
export const GRAVITY = 26;
export const JUMP_VELOCITY = 8.6;
export const WALK_SPEED = 4.4;
export const SPRINT_SPEED = 6.6;
export const SWIM_SPEED = 3.4;
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const REACH = 6;

// ---- Atmosphere ----
export const DAY_LENGTH = 300; // seconds for a full day/night cycle

/** Index into a chunk's Uint8Array for local coordinates */
export const chunkIndex = (x: number, y: number, z: number): number =>
  (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
