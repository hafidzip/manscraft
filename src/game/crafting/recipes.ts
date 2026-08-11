
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

const b = (blockId: number): Ingredient => ({ kind: 'block', blockId });
const out = (blockId: number, count: number): SlotItem => ({ kind: 'block', blockId, count });
const row = (...cells: (Ingredient | null)[]) => cells;
const fill = (n: number, ing: Ingredient): (Ingredient | null)[] => Array(n).fill(ing);
const ring = (edge: Ingredient, center: Ingredient | null = null): (Ingredient | null)[][] => [
  fill(3, edge), [edge, center, edge], fill(3, edge),
];

const P = {
  LOG: b(B.LOG), PLANK: b(B.PLANK), SAND: b(B.SAND), STONE: b(B.STONE),
  GLASS: b(B.GLASS), TABLE: b(B.CRAFTING_TABLE), LEAVES: b(B.LEAVES),
  COBBLE: b(B.COBBLE), COAL: b(B.COAL), STICK: b(B.STICK), DIRT: b(B.DIRT),
};

const R = (
  id: string, name: string, grid: 2 | 3, group: RecipeGroupId,
  shape: { shaped?: (Ingredient | null)[][]; shapeless?: Ingredient[] },
  output: SlotItem,
): Recipe => ({ id, name, grid, group, ...shape, output });

export const RECIPES: Recipe[] = [
  R('planks', 'Oak Planks', 2, 'building', { shapeless: [P.LOG] }, out(B.PLANK, 4)),
  R('crafting_table', 'Crafting Table', 2, 'building', {
    shaped: [row(P.PLANK, P.PLANK), row(P.PLANK, P.PLANK)],
  }, out(B.CRAFTING_TABLE, 1)),
  R('furnace', 'Furnace', 3, 'building', { shaped: ring(P.COBBLE) }, out(B.FURNACE, 1)),
  R('bench', 'Reinforced Bench', 3, 'building', { shaped: ring(P.PLANK, P.LOG) }, out(B.CRAFTING_TABLE, 3)),
  R('stick', 'Sticks', 3, 'building', { shaped: [[P.PLANK], [P.PLANK]] }, out(B.STICK, 4)),
  R('torch', 'Torch', 3, 'glass', { shaped: [[P.COAL], [P.STICK]] }, out(B.TORCH, 4)),
  R('glass', 'Glass', 2, 'glass', {
    shaped: [row(P.SAND, P.SAND), row(P.SAND, P.SAND)],
  }, out(B.GLASS, 1)),
  R('glass_batch', 'Glass Batch', 3, 'glass', {
    shaped: [fill(3, P.SAND), fill(3, P.SAND), fill(3, P.SAND)],
  }, out(B.GLASS, 4)),
  R('compost', 'Compost', 2, 'nature', { shapeless: [P.LEAVES, P.LEAVES, P.DIRT] }, out(B.DIRT, 2)),
  R('mulch', 'Leaf Mulch', 3, 'nature', { shaped: ring(P.LEAVES, P.DIRT) }, out(B.DIRT, 6)),
  R('conveyor', 'Conveyor Belt', 3, 'redstone', {
    shaped: [fill(3, P.STONE), row(P.STICK, P.COBBLE, P.STICK), fill(3, P.STONE)],
  }, out(B.CONVEYOR, 6)),
  R('inserter', 'Inserter', 3, 'redstone', {
    shaped: [row(null, P.PLANK, null), row(P.STICK, P.COBBLE, P.STICK), row(P.STICK, null, P.STICK)],
  }, out(B.INSERTER, 2)),
  R('laser_miner', 'Laser Miner', 3, 'redstone', {
    shaped: [row(P.GLASS, P.COAL, P.GLASS), fill(3, P.STONE), fill(3, P.COBBLE)],
  }, out(B.LASER_MINER, 1)),
  R('turret', 'Turret', 3, 'redstone', {
    shaped: [
      row(null, P.STICK, null),
      row(P.STONE, P.COBBLE, P.STONE),
      row(P.COBBLE, P.COAL, P.COBBLE),
    ],
  }, out(B.TURRET, 1)),
];

export function recipeIngredients(r: Recipe): Ingredient[] {
  if (r.shaped) return r.shaped.flat().filter((c): c is Ingredient => !!c);
  return r.shapeless ?? [];
}

export const RECIPE_IDS: readonly string[] = RECIPES.map((r) => r.id);
export const AUTOMATABLE_RECIPE_IDS: readonly string[] = RECIPES
  .filter((r) => r.output.kind === 'block')
  .map((r) => r.id);


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
