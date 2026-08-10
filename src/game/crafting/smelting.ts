
import type { SlotItem } from '../fps/Inventory';
import { B } from '../fps/World';

export const SMELT_TIME = 10;

export interface SmeltRecipe {
  input: number;
  output: number;
  count: number;
}

export const SMELT_RECIPES: SmeltRecipe[] = [
  { input: B.SAND, output: B.GLASS, count: 1 },
  { input: B.COBBLE, output: B.STONE, count: 1 },
  { input: B.GRASS, output: B.DIRT, count: 1 },
];

export function smeltResult(blockId: number): SmeltRecipe | null {
  return SMELT_RECIPES.find((r) => r.input === blockId) ?? null;
}

export const FUELS: Record<number, number> = {
  [B.PLANK]: 15,
  [B.LOG]: 15,
  [B.CRAFTING_TABLE]: 15,
  [B.LEAVES]: 5,
  [B.CACTUS]: 5,
};

export const fuelTime = (blockId: number): number => FUELS[blockId] ?? 0;
export const isFuel = (blockId: number): boolean => fuelTime(blockId) > 0;

export interface FurnaceState {
  input: SlotItem | null;
  fuel: SlotItem | null;
  output: SlotItem | null;
  burn: number;
  burnMax: number;
  cook: number;
}

export const newFurnace = (): FurnaceState => ({
  input: null, fuel: null, output: null, burn: 0, burnMax: 0, cook: 0,
});

function outputAccepts(st: FurnaceState, recipe: SmeltRecipe): boolean {
  const out = st.output;
  if (!out) return true;
  if (out.kind !== 'block' || out.blockId !== recipe.output) return false;
  return out.count + recipe.count <= 64;
}

export function tickFurnace(st: FurnaceState, dt: number): boolean {
  const wasLit = st.burn > 0;
  let changed = false;

  const input = st.input && st.input.kind === 'block' ? st.input : null;
  const recipe = input ? smeltResult(input.blockId) : null;
  const canCook = !!recipe && outputAccepts(st, recipe);

  if (st.burn > 0) {
    st.burn = Math.max(0, st.burn - dt);
    changed = true;
  }

  if (st.burn <= 0 && canCook && st.fuel && st.fuel.kind === 'block') {
    const t = fuelTime(st.fuel.blockId);
    if (t > 0) {
      st.burn = t;
      st.burnMax = t;
      st.fuel.count -= 1;
      if (st.fuel.count <= 0) st.fuel = null;
      changed = true;
    }
  }

  if (st.burn > 0 && canCook && recipe && input) {
    st.cook += dt;
    changed = true;
    if (st.cook >= SMELT_TIME) {
      st.cook = 0;
      input.count -= 1;
      if (input.count <= 0) st.input = null;
      if (st.output && st.output.kind === 'block') st.output.count += recipe.count;
      else st.output = { kind: 'block', blockId: recipe.output, count: recipe.count };
    }
  } else if (st.cook > 0) {
    st.cook = Math.max(0, st.cook - dt * 2);
    changed = true;
  }

  return changed || wasLit !== st.burn > 0;
}

export function furnaceIdle(st: FurnaceState): boolean {
  return !st.input && !st.fuel && !st.output && st.burn <= 0 && st.cook <= 0;
}

export const furnaceKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
