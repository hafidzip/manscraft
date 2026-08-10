
export const CHUNK_SIZE = 16;
export const CHUNK_LOG2 = 4;
export const CHUNK_MASK = 15;
export const WORLD_HEIGHT = 80;
export const SEA_LEVEL = 30;

export const VIEW_DISTANCE = 5;
export const EVICT_DISTANCE = 7;

export const WORLD_CHUNKS = 32;
export const WORLD_CHUNKS_MASK = 31;
export const WORLD_SIZE = WORLD_CHUNKS * CHUNK_SIZE;
export const WORLD_HALF = WORLD_SIZE / 2;

export const wrapChunk = (c: number): number => c & WORLD_CHUNKS_MASK;

export const wrapBlock = (x: number): number => ((x % WORLD_SIZE) + WORLD_SIZE) % WORLD_SIZE;

export const wrapDelta = (d: number, m: number): number => {
  const w = ((d % m) + m) % m;
  return w > m / 2 ? w - m : w;
};

export const minImageF = (d: number): number => d - WORLD_SIZE * Math.round(d / WORLD_SIZE);

export const GRAVITY = 26;
export const JUMP_VELOCITY = 8.6;
export const WALK_SPEED = 4.4;
export const SPRINT_SPEED = 6.6;
export const SWIM_SPEED = 3.4;
export const PLAYER_HALF_WIDTH = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;
export const REACH = 6;

export const DAY_LENGTH = 300;

export const chunkIndex = (x: number, y: number, z: number): number =>
  (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
