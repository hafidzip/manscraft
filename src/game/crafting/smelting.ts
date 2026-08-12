
import type { SlotItem } from '../fps/Inventory';
import { B } from '../fps/World';
import { wrapBlock } from '../core/constants';

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
  { input: B.RAW_COAL_ORE, output: B.COAL, count: 1 },
  { input: B.LOG, output: B.COAL, count: 1 },
];

const SMELT_INDEX = new Map<number, SmeltRecipe>(SMELT_RECIPES.map((r) => [r.input, r]));
export function smeltResult(blockId: number): SmeltRecipe | null {
  return SMELT_INDEX.get(blockId) ?? null;
}

export const FUELS: Record<number, number> = {
  [B.PLANK]: 15,
  [B.LOG]: 15,
  [B.CRAFTING_TABLE]: 15,
  [B.LEAVES]: 5,
  [B.CACTUS]: 5,
  [B.COAL]: 80,
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

export interface FurnaceTickResult {
  changed: boolean;
  producedId: number;
  producedCount: number;
}

export const newFurnaceTickResult = (): FurnaceTickResult => ({
  changed: false, producedId: 0, producedCount: 0,
});

export function drainFurnaceOutput(st: FurnaceState): { id: number; count: number } | null {
  const o = st.output;
  if (!o || o.kind !== 'block' || o.count <= 0) {
    st.output = null;
    return null;
  }
  st.output = null;
  return { id: o.blockId, count: o.count };
}

export function tickFurnace(st: FurnaceState, dt: number, out?: FurnaceTickResult): boolean {
  if (out) {
    out.changed = false;
    out.producedId = 0;
    out.producedCount = 0;
  }
  const wasLit = st.burn > 0;
  let changed = false;
  let remaining = Math.max(0, dt);
  let guard = 0;

  while (remaining > 1e-9 && guard++ < 512) {
    const input = st.input && st.input.kind === 'block' ? st.input : null;
    const recipe = input ? smeltResult(input.blockId) : null;
    const canCook = !!recipe && (!!out || outputAccepts(st, recipe));

    if (st.burn <= 0 && canCook && st.fuel && st.fuel.kind === 'block') {
      const fuel = fuelTime(st.fuel.blockId);
      if (fuel > 0) {
        st.burn = fuel;
        st.burnMax = fuel;
        st.fuel.count--;
        if (st.fuel.count <= 0) st.fuel = null;
        changed = true;
      }
    }

    if (st.burn <= 0) {
      if (st.cook > 0) {
        st.cook = Math.max(0, st.cook - remaining * 2);
        changed = true;
      }
      break;
    }

    if (!canCook || !recipe || !input) {
      const step = Math.min(remaining, st.burn);
      st.burn -= step;
      remaining -= step;
      if (st.cook > 0) st.cook = Math.max(0, st.cook - step * 2);
      changed = true;
      continue;
    }

    const step = Math.min(remaining, st.burn, Math.max(0, SMELT_TIME - st.cook));
    st.burn = Math.max(0, st.burn - step);
    st.cook += step;
    remaining -= step;
    changed = true;

    if (st.cook >= SMELT_TIME - 1e-9) {
      if (out && out.producedId !== 0 && out.producedId !== recipe.output) break;
      st.cook = 0;
      input.count--;
      if (input.count <= 0) st.input = null;
      if (out) {
        out.producedId = recipe.output;
        out.producedCount += recipe.count;
      } else if (st.output && st.output.kind === 'block' && st.output.blockId === recipe.output) {
        st.output.count += recipe.count;
      } else {
        st.output = { kind: 'block', blockId: recipe.output, count: recipe.count };
      }
    }
  }

  const result = changed || wasLit !== (st.burn > 0);
  if (out) out.changed = result;
  return result;
}

export function furnaceIdle(st: FurnaceState): boolean {
  return !st.input && !st.fuel && !st.output && st.burn <= 0 && st.cook <= 0;
}

export const furnaceKey = (x: number, y: number, z: number): string =>
  `${wrapBlock(x | 0)},${y | 0},${wrapBlock(z | 0)}`;
