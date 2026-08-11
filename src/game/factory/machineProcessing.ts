import type { SlotItem } from '../fps/Inventory';
import { wrapBlock } from '../core/constants';
import { isOreBlock } from '../world/blocks';
import { type FurnaceState, isFuel, smeltResult } from '../crafting/smelting';
import { RECIPES, recipeIngredients, type Recipe } from '../crafting/recipes';

export const machineKey = (x: number, y: number, z: number): string =>
  `${wrapBlock(x | 0)},${y | 0},${wrapBlock(z | 0)}`;

export function parseMachineKey(k: string): [number, number, number] | null {
  const p = k.split(',');
  if (p.length !== 3) return null;
  const x = Number(p[0]), y = Number(p[1]), z = Number(p[2]);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
  return [wrapBlock(x | 0), y | 0, wrapBlock(z | 0)];
}

export interface StackOut { id: number; count: number }
export interface MachineItemSink {
  emitAbove(x: number, y: number, z: number, itemId: number, count?: number): void;
}

export interface VoxelRead { getBlock(x: number, y: number, z: number): number }
export interface FrontCell { x: number; y: number; z: number }

export function frontCellOf(
  x: number, y: number, z: number, dx: number, dz: number,
): FrontCell {
  return { x: wrapBlock(x + dx), y, z: wrapBlock(z + dz) };
}

export function acquireFrontTarget(
  view: VoxelRead,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
  mineable: (id: number) => boolean,
): { cell: FrontCell; id: number } | null {
  const cell = frontCellOf(x, y, z, dx, dz);
  const id = view.getBlock(cell.x, cell.y, cell.z);
  return mineable(id) ? { cell, id } : null;
}

export interface HarvestOutcome { itemId: number; destroy: boolean }
export function harvestOutcome(
  worldId: number,
  toFps: Readonly<Record<number, number>>,
): HarvestOutcome | null {
  const itemId = toFps[worldId];
  if (itemId === undefined) return null;
  return { itemId, destroy: !isOreBlock(worldId) };
}

export type FurnaceInsertResult = 'input' | 'fuel' | 'rejected';

export function tryInsertFurnace(st: FurnaceState, itemId: number): FurnaceInsertResult {
  if (!Number.isFinite(itemId) || itemId <= 0) return 'rejected';
  if (smeltResult(itemId)) {
    if (st.input) return 'rejected';
    st.input = { kind: 'block', blockId: itemId, count: 1 };
    return 'input';
  }
  if (isFuel(itemId)) {
    if (st.fuel) return 'rejected';
    st.fuel = { kind: 'block', blockId: itemId, count: 1 };
    return 'fuel';
  }
  return 'rejected';
}

export function spillFurnace(st: FurnaceState): StackOut[] {
  const out: StackOut[] = [];
  const push = (s: SlotItem | null): void => {
    if (s?.kind === 'block' && s.count > 0) out.push({ id: s.blockId, count: s.count });
  };
  push(st.input);
  push(st.fuel);
  push(st.output);
  st.input = null;
  st.fuel = null;
  st.output = null;
  st.burn = 0;
  st.burnMax = 0;
  st.cook = 0;
  return out;
}

export interface CraftingTableState {
  recipeId: string | null;
  buffered: Record<number, number>;
}

export const newCraftingTable = (): CraftingTableState => ({ recipeId: null, buffered: {} });

const RECIPE_INDEX = new Map<string, Recipe>();
const REQ_CACHE = new Map<string, ReadonlyMap<number, number>>();

export function recipeById(id: string | null, recipes: readonly Recipe[] = RECIPES): Recipe | null {
  if (!id) return null;
  if (recipes === RECIPES) {
    if (RECIPE_INDEX.size === 0) for (const r of RECIPES) RECIPE_INDEX.set(r.id, r);
    return RECIPE_INDEX.get(id) ?? null;
  }
  return recipes.find((r) => r.id === id) ?? null;
}

export function recipeRequirements(recipe: Recipe): ReadonlyMap<number, number> {
  const cached = REQ_CACHE.get(recipe.id);
  if (cached) return cached;
  const req = new Map<number, number>();
  for (const ing of recipeIngredients(recipe)) {
    if (ing.kind === 'block') req.set(ing.blockId, (req.get(ing.blockId) ?? 0) + 1);
  }
  REQ_CACHE.set(recipe.id, req);
  return req;
}

export type CraftInsertResult =
  | { accepted: false }
  | { accepted: true; producedId: number; producedCount: number };

const REJECT: CraftInsertResult = { accepted: false };

export function tryInsertCrafting(
  st: CraftingTableState,
  itemId: number,
  recipes: readonly Recipe[] = RECIPES,
): CraftInsertResult {
  if (!Number.isFinite(itemId) || itemId <= 0) return REJECT;
  const recipe = recipeById(st.recipeId, recipes);
  if (!recipe || recipe.output.kind !== 'block') return REJECT;
  const req = recipeRequirements(recipe);
  const need = req.get(itemId) ?? 0;
  const have = st.buffered[itemId] ?? 0;
  if (need <= 0 || have >= need) return REJECT;

  st.buffered[itemId] = have + 1;
  for (const [id, count] of req) {
    if ((st.buffered[id] ?? 0) < count) {
      return { accepted: true, producedId: 0, producedCount: 0 };
    }
  }

  for (const [id, count] of req) {
    const left = (st.buffered[id] ?? 0) - count;
    if (left > 0) st.buffered[id] = left;
    else delete st.buffered[id];
  }
  return {
    accepted: true,
    producedId: recipe.output.blockId,
    producedCount: Math.max(1, recipe.output.count),
  };
}

export function setCraftingBlueprint(
  st: CraftingTableState,
  recipeId: string | null,
  recipes: readonly Recipe[] = RECIPES,
): StackOut[] {
  if (st.recipeId === recipeId) return [];
  st.recipeId = recipeId;
  const recipe = recipeById(recipeId, recipes);
  const req = recipe?.output.kind === 'block'
    ? recipeRequirements(recipe)
    : new Map<number, number>();
  const spill: StackOut[] = [];
  for (const key of Object.keys(st.buffered)) {
    const id = Number(key);
    const have = st.buffered[id] ?? 0;
    const keep = Math.min(have, req.get(id) ?? 0);
    if (have > keep) spill.push({ id, count: have - keep });
    if (keep > 0) st.buffered[id] = keep;
    else delete st.buffered[id];
  }
  return spill;
}

export function spillCrafting(st: CraftingTableState): StackOut[] {
  const out: StackOut[] = [];
  for (const key of Object.keys(st.buffered)) {
    const id = Number(key), count = st.buffered[id] ?? 0;
    if (count > 0) out.push({ id, count });
  }
  st.buffered = {};
  st.recipeId = null;
  return out;
}

export function craftingTableIdle(st: CraftingTableState): boolean {
  if (st.recipeId) return false;
  return !Object.keys(st.buffered).some((k) => (st.buffered[Number(k)] ?? 0) > 0);
}

export function craftingProgress(
  st: CraftingTableState,
  recipes: readonly Recipe[] = RECIPES,
): number {
  const recipe = recipeById(st.recipeId, recipes);
  if (!recipe) return 0;
  let need = 0, have = 0;
  for (const [id, count] of recipeRequirements(recipe)) {
    need += count;
    have += Math.min(count, st.buffered[id] ?? 0);
  }
  return need > 0 ? have / need : 0;
}

export function sanitizeCraftingState(
  raw: Partial<CraftingTableState> | null | undefined,
  recipes: readonly Recipe[] = RECIPES,
): CraftingTableState {
  const st = newCraftingTable();
  const recipe = recipeById(typeof raw?.recipeId === 'string' ? raw.recipeId : null, recipes);
  if (!recipe || recipe.output.kind !== 'block') return st;
  st.recipeId = recipe.id;
  const req = recipeRequirements(recipe);
  for (const key of Object.keys(raw?.buffered ?? {})) {
    const id = Number(key);
    const count = Math.floor(Number(raw?.buffered?.[id]));
    const cap = req.get(id) ?? 0;
    if (Number.isFinite(id) && id > 0 && Number.isFinite(count) && count > 0 && cap > 0) {
      st.buffered[id] = Math.min(count, cap);
    }
  }
  return st;
}

export const enum MachineKind {
  None = 0,
  Furnace = 1,
  CraftingTable = 2,
}

export function feedMachine(
  kind: MachineKind,
  st: FurnaceState | CraftingTableState,
  x: number,
  y: number,
  z: number,
  itemId: number,
  sink: MachineItemSink,
  recipes: readonly Recipe[] = RECIPES,
): boolean {
  if (kind === MachineKind.Furnace) {
    return tryInsertFurnace(st as FurnaceState, itemId) !== 'rejected';
  }
  if (kind === MachineKind.CraftingTable) {
    const result = tryInsertCrafting(st as CraftingTableState, itemId, recipes);
    if (!result.accepted) return false;
    if (result.producedCount > 0) sink.emitAbove(x, y, z, result.producedId, result.producedCount);
    return true;
  }
  return false;
}