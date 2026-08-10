
import type { SlotItem } from '../fps/Inventory';
import { B } from '../fps/World';

export interface Ingredient {
  kind: 'block';
  blockId: number;
}

export interface Recipe {
  id: string;
  name: string;
  grid: 2 | 3;
  shaped?: (Ingredient | null)[][];
  shapeless?: Ingredient[];
  output: SlotItem;
  group: RecipeGroupId;
}

export type RecipeGroupId = 'building' | 'glass' | 'nature' | 'redstone';

export interface RecipeGroup {
  id: RecipeGroupId;
  label: string;
  icon: number;
}

export const RECIPE_GROUPS: RecipeGroup[] = [
  { id: 'building', label: 'Building Blocks', icon: B.PLANK },
  { id: 'glass', label: 'Glass & Light', icon: B.GLASS },
  { id: 'nature', label: 'Nature', icon: B.LEAVES },
  { id: 'redstone', label: 'Machines', icon: B.CONVEYOR },
];

const blk = (blockId: number): Ingredient => ({ kind: 'block', blockId });

const P = {
  LOG: blk(B.LOG),
  PLANK: blk(B.PLANK),
  SAND: blk(B.SAND),
  STONE: blk(B.STONE),
  GLASS: blk(B.GLASS),
  TABLE: blk(B.CRAFTING_TABLE),
  LEAVES: blk(B.LEAVES),
  COBBLE: blk(B.COBBLE),
  COAL: blk(B.COAL),
  STICK: blk(B.STICK),
};

const DIRT = blk(B.DIRT);

export const RECIPES: Recipe[] = [
  {
    id: 'planks', name: 'Oak Planks', grid: 2, group: 'building',
    shapeless: [P.LOG],
    output: { kind: 'block', blockId: B.PLANK, count: 4 },
  },
  {
    id: 'crafting_table', name: 'Crafting Table', grid: 2, group: 'building',
    shaped: [
      [P.PLANK, P.PLANK],
      [P.PLANK, P.PLANK],
    ],
    output: { kind: 'block', blockId: B.CRAFTING_TABLE, count: 1 },
  },
  {
    id: 'furnace', name: 'Furnace', grid: 3, group: 'building',
    shaped: [
      [P.COBBLE, P.COBBLE, P.COBBLE],
      [P.COBBLE, null,     P.COBBLE],
      [P.COBBLE, P.COBBLE, P.COBBLE],
    ],
    output: { kind: 'block', blockId: B.FURNACE, count: 1 },
  },
  {
    id: 'bench', name: 'Reinforced Bench', grid: 3, group: 'building',
    shaped: [
      [P.PLANK, P.PLANK, P.PLANK],
      [P.PLANK, P.LOG,    P.PLANK],
      [P.PLANK, P.PLANK, P.PLANK],
    ],
    output: { kind: 'block', blockId: B.CRAFTING_TABLE, count: 3 },
  },
  {
    id: 'stick', name: 'Sticks', grid: 3, group: 'building',
    shaped: [
      [P.PLANK],
      [P.PLANK],
    ],
    output: { kind: 'block', blockId: B.STICK, count: 4 },
  },
  {
    id: 'torch', name: 'Torch', grid: 3, group: 'glass',
    shaped: [
      [P.COAL],
      [P.STICK],
    ],
    output: { kind: 'block', blockId: B.TORCH, count: 4 },
  },
  {
    id: 'glass', name: 'Glass', grid: 2, group: 'glass',
    shaped: [
      [P.SAND, P.SAND],
      [P.SAND, P.SAND],
    ],
    output: { kind: 'block', blockId: B.GLASS, count: 1 },
  },
  {
    id: 'glass_batch', name: 'Glass Batch', grid: 3, group: 'glass',
    shaped: [
      [P.SAND, P.SAND, P.SAND],
      [P.SAND, P.SAND, P.SAND],
      [P.SAND, P.SAND, P.SAND],
    ],
    output: { kind: 'block', blockId: B.GLASS, count: 4 },
  },
  {
    id: 'compost', name: 'Compost', grid: 2, group: 'nature',
    shapeless: [P.LEAVES, P.LEAVES, DIRT],
    output: { kind: 'block', blockId: B.DIRT, count: 2 },
  },
  {
    id: 'mulch', name: 'Leaf Mulch', grid: 3, group: 'nature',
    shaped: [
      [P.LEAVES, P.LEAVES, P.LEAVES],
      [P.LEAVES, DIRT,    P.LEAVES],
      [P.LEAVES, P.LEAVES, P.LEAVES],
    ],
    output: { kind: 'block', blockId: B.DIRT, count: 6 },
  },
  {
    id: 'conveyor', name: 'Conveyor Belt', grid: 3, group: 'redstone',
    shaped: [
      [P.STONE,  P.STONE,  P.STONE],
      [P.STICK,  P.COBBLE, P.STICK],
      [P.STONE,  P.STONE,  P.STONE],
    ],
    output: { kind: 'block', blockId: B.CONVEYOR, count: 6 },
  },
  {
    id: 'inserter', name: 'Inserter', grid: 3, group: 'redstone',
    shaped: [
      [null,   P.PLANK, null  ],
      [P.STICK, P.COBBLE, P.STICK],
      [P.STICK, null,  P.STICK],
    ],
    output: { kind: 'block', blockId: B.INSERTER, count: 2 },
  },
  {
    id: 'laser_miner', name: 'Laser Miner', grid: 3, group: 'redstone',
    shaped: [
      [P.GLASS,  P.COAL,   P.GLASS ],
      [P.STONE,  P.STONE,  P.STONE ],
      [P.COBBLE, P.COBBLE, P.COBBLE],
    ],
    output: { kind: 'block', blockId: B.LASER_MINER, count: 1 },
  },
];

export function recipeIngredients(r: Recipe): Ingredient[] {
  if (r.shaped) return r.shaped.flat().filter((c): c is Ingredient => !!c);
  return r.shapeless ?? [];
}


const sameIngredient = (a: Ingredient, b: Ingredient) =>
  a.kind === b.kind && a.blockId === b.blockId;

interface Cell { x: number; y: number; ing: Ingredient }

function cellsOf(grid: (SlotItem | null)[], size: number): Cell[] | null {
  const out: Cell[] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const it = grid[y * size + x];
      if (!it) continue;
      if (it.kind !== 'block') return null;
      out.push({ x, y, ing: { kind: 'block', blockId: it.blockId } });
    }
  }
  return out;
}

function matchShaped(cells: Cell[], size: number, pattern: (Ingredient | null)[][]): boolean {
  const h = pattern.length;
  const w = pattern[0].length;
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.x > maxX) maxX = c.x;
    if (c.y > maxY) maxY = c.y;
  }
  if (maxX - minX + 1 !== w || maxY - minY + 1 !== h) return false;
  for (const c of cells) {
    const p = pattern[c.y - minY][c.x - minX];
    if (!p || !sameIngredient(p, c.ing)) return false;
  }
  return cells.length === w * h - pattern.flat().filter((p) => !p).length;
}

function matchShapeless(cells: Cell[], ings: Ingredient[]): boolean {
  if (cells.length !== ings.length) return false;
  const remaining = ings.slice();
  for (const c of cells) {
    const i = remaining.findIndex((r) => sameIngredient(r, c.ing));
    if (i < 0) return false;
    remaining.splice(i, 1);
  }
  return true;
}

export function matchCraft(grid: (SlotItem | null)[], size: number): Recipe | null {
  const cells = cellsOf(grid, size);
  if (!cells || cells.length === 0) return null;
  for (const r of RECIPES) {
    if (size < r.grid) continue;
    if (r.shaped && matchShaped(cells, size, r.shaped)) return r;
    if (r.shapeless && matchShapeless(cells, r.shapeless)) return r;
  }
  return null;
}

export function craftableCount(grid: (SlotItem | null)[], size: number, _recipe?: Recipe): number {
  let n = Infinity;
  for (let i = 0; i < size * size; i++) {
    const it = grid[i];
    if (it && it.kind === 'block') n = Math.min(n, it.count);
  }
  return n === Infinity ? 0 : n;
}
