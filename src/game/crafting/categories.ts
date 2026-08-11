
// Crafting runs entirely in the FPS/arena id space (src/game/fps/World.ts's `B`).
// Cross-space translation to the main voxel-world id space (src/game/world/blocks.ts)
// already lives in `src/game/engine/constants.ts` (`TO_FPS` / `FROM_FPS`) — this module
// does NOT duplicate that bridge. Its job is the *other* axis: grouping several block
// ids into one family so recipes can accept "a log" or "a stone-like block" instead of
// one exact id, and so crafted outputs can inherit the origin tag of their inputs.
import { B } from '../fps/World';

export type BlockCategory =
  | 'log' | 'planks' | 'leaves' | 'stone' | 'sand' | 'dirt' | 'grass' | 'snow'
  | 'glass' | 'coal' | 'stick' | 'cactus';

/** Block id -> family. Stone and Cobblestone intentionally share 'stone' (cobble substitutes). */
const CATEGORY: Readonly<Record<number, BlockCategory>> = {
  [B.LOG]: 'log',
  [B.PLANK]: 'planks',
  [B.LEAVES]: 'leaves',
  [B.STONE]: 'stone',
  [B.COBBLE]: 'stone',
  [B.SAND]: 'sand',
  [B.SANDSTONE]: 'sand',
  [B.DIRT]: 'dirt',
  [B.GRASS]: 'grass',
  [B.SNOW]: 'snow',
  [B.GLASS]: 'glass',
  [B.COAL]: 'coal',
  [B.STICK]: 'stick',
  [B.CACTUS]: 'cactus',
};

/** Family -> canonical member, used for recipe outputs and recipe-book ghost icons. */
const CANONICAL: Record<BlockCategory, number> = {
  log: B.LOG, planks: B.PLANK, leaves: B.LEAVES, stone: B.STONE, sand: B.SAND,
  dirt: B.DIRT, grass: B.GRASS, snow: B.SNOW, glass: B.GLASS, coal: B.COAL,
  stick: B.STICK, cactus: B.CACTUS,
};

export function categoryOf(blockId: number): BlockCategory | null {
  return CATEGORY[blockId] ?? null;
}

export const canonicalOf = (c: BlockCategory): number => CANONICAL[c];
