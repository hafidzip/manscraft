/**
 * Furnace smelting — recipes, fuel table and the per-block state machine.
 *
 * Mirrors Minecraft's model: a furnace burns one fuel item at a time, and
 * while a flame is alive an input item cooks toward its output. Progress is
 * kept in seconds (not ticks) so it integrates directly with the engine's
 * variable delta time.
 *
 * State lives per world position in `FurnaceStore`, keyed by wrapped block
 * coordinates, so every placed furnace keeps its own contents and continues
 * cooking while the player walks away.
 */

import type { SlotItem } from '../fps/Inventory';
import { B } from '../fps/World';

/** seconds one item takes to smelt (MC: 10s) */
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

/** seconds of burn time each fuel block provides (MC planks = 15s) */
export const FUELS: Record<number, number> = {
  [B.PLANK]: 15,
  [B.LOG]: 15,
  [B.CRAFTING_TABLE]: 15,
  [B.LEAVES]: 5,
  [B.CACTUS]: 5,
};

export const fuelTime = (blockId: number): number => FUELS[blockId] ?? 0;
export const isFuel = (blockId: number): boolean => fuelTime(blockId) > 0;

/** One furnace's contents + burn state. */
export interface FurnaceState {
  input: SlotItem | null;
  fuel: SlotItem | null;
  output: SlotItem | null;
  /** seconds of flame remaining */
  burn: number;
  /** seconds the current fuel item started with (drives the flame gauge) */
  burnMax: number;
  /** seconds the current input has been cooking */
  cook: number;
}

export const newFurnace = (): FurnaceState => ({
  input: null, fuel: null, output: null, burn: 0, burnMax: 0, cook: 0,
});

/** can the pending result be merged into the output slot? */
function outputAccepts(st: FurnaceState, recipe: SmeltRecipe): boolean {
  const out = st.output;
  if (!out) return true;
  if (out.kind !== 'block' || out.blockId !== recipe.output) return false;
  return out.count + recipe.count <= 64;
}

/**
 * Advance one furnace by `dt` seconds. Returns true when anything visible
 * changed (so the caller can swap the lit/unlit block or refresh the HUD).
 */
export function tickFurnace(st: FurnaceState, dt: number): boolean {
  const wasLit = st.burn > 0;
  let changed = false;

  const input = st.input && st.input.kind === 'block' ? st.input : null;
  const recipe = input ? smeltResult(input.blockId) : null;
  const canCook = !!recipe && outputAccepts(st, recipe);

  // burn down the current flame
  if (st.burn > 0) {
    st.burn = Math.max(0, st.burn - dt);
    changed = true;
  }

  // light a fresh fuel item when there is work to do
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
    // MC behaviour: progress decays when the flame dies or input is removed
    st.cook = Math.max(0, st.cook - dt * 2);
    changed = true;
  }

  return changed || wasLit !== st.burn > 0;
}

/** true when this furnace has nothing to do and can be dropped from the map */
export function furnaceIdle(st: FurnaceState): boolean {
  return !st.input && !st.fuel && !st.output && st.burn <= 0 && st.cook <= 0;
}

/** stable key for a wrapped block position */
export const furnaceKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
