import { B } from './World';

export type SlotItem =
  | { kind: 'weapon'; weaponId: string }
  | { kind: 'block'; blockId: number; count: number }
  | { kind: 'food'; foodId: string; count: number };

export interface FoodDef {
  id: string;
  name: string;
  heal: number;
}

export const FOODS: Record<string, FoodDef> = {
  'chicken-drum': { id: 'chicken-drum', name: 'Chicken Drum', heal: 24 },
};

export const FOOD_NAMES: Record<string, string> = Object.fromEntries(
  Object.values(FOODS).map((f) => [f.id, f.name]),
);

export interface SlotRef {
  isHotbar: boolean;
  index: number;
  isCraft?: boolean;
}

export const BLOCK_NAMES: Record<number, string> = {
  [B.GRASS]: 'Grass Block',
  [B.DIRT]: 'Dirt',
  [B.STONE]: 'Stone',
  [B.SAND]: 'Sand',
  [B.SANDSTONE]: 'Sandstone',
  [B.LOG]: 'Wood Log',
  [B.LEAVES]: 'Leaves',
  [B.CACTUS]: 'Cactus',
  [B.PLANK]: 'Wood Planks',
  [B.ORE]: 'Gold Ore',
  [B.COBBLE]: 'Cobblestone',
  [B.WOOL]: 'Target Wool',
  [B.CRAFTING_TABLE]: 'Crafting Table',
  [B.GLASS]: 'Glass',
  [B.FURNACE]: 'Furnace',
  [B.COAL]: 'Coal',
  [B.STICK]: 'Stick',
  [B.TORCH]: 'Torch',
  [B.CONVEYOR]: 'Conveyor Belt',
  [B.INSERTER]: 'Inserter',
  [B.LASER_MINER]: 'Laser Miner',
  [B.TURRET]: 'Turret',
  50: 'Ruby Ore',
  51: 'Amber Ore',
  52: 'Luminescence Ore',
  53: 'Diamond Ore',
  54: 'Gold Ore',
  55: 'Silver Ore',
  56: 'Jade Ore',
  57: 'Emerald Ore',
};

const STACK = 64;
const WEAPONS = ['handgun', 'smg', 'rifle', 'sniper', 'bazooka', 'laser'] as const;

type Stackable = Extract<SlotItem, { count: number }>;

const sameStack = (a: SlotItem, b: SlotItem): boolean => {
  if (a.kind === 'block' && b.kind === 'block') return a.blockId === b.blockId;
  if (a.kind === 'food' && b.kind === 'food') return a.foodId === b.foodId;
  return false;
};

const mergeInto = (arr: (SlotItem | null)[], item: Stackable): number => {
  let left = item.count;
  for (let i = 0; i < arr.length && left > 0; i++) {
    const s = arr[i];
    if (!s || !sameStack(s, item) || s.kind === 'weapon' || s.count >= STACK) continue;
    const add = Math.min(STACK - s.count, left);
    s.count += add;
    left -= add;
  }
  return left;
};

const placeInto = (arr: (SlotItem | null)[], item: Stackable, left: number): number => {
  for (let i = 0; i < arr.length && left > 0; i++) {
    if (arr[i]) continue;
    const add = Math.min(STACK, left);
    arr[i] = item.kind === 'block'
      ? { kind: 'block', blockId: item.blockId, count: add }
      : { kind: 'food', foodId: item.foodId, count: add };
    left -= add;
  }
  return left;
};

const stackItem = (hotbar: (SlotItem | null)[], main: (SlotItem | null)[], item: Stackable): boolean => {
  let left = mergeInto(hotbar, item);
  left = mergeInto(main, { ...item, count: left });
  if (left > 0) left = placeInto(main, item, left);
  if (left > 0) left = placeInto(hotbar, item, left);
  return left === 0;
};

export class Inventory {
  hotbar: (SlotItem | null)[] = WEAPONS.map((weaponId) => ({ kind: 'weapon' as const, weaponId }));

  mainInv: (SlotItem | null)[] = (() => {
    const arr: (SlotItem | null)[] = Array(27).fill(null);
    arr[0] = { kind: 'block', blockId: B.INSERTER, count: 64 };
    arr[1] = { kind: 'block', blockId: B.LASER_MINER, count: 64 };
    arr[2] = { kind: 'block', blockId: B.CONVEYOR, count: 64 };
    arr[3] = { kind: 'block', blockId: B.TURRET, count: 64 };
    arr[4] = { kind: 'block', blockId: B.COBBLE, count: 64 };
    arr[9] = { kind: 'food', foodId: 'chicken-drum', count: 64 };
    return arr;
  })();

  craft: (SlotItem | null)[] = Array(9).fill(null);
  craftSize: 2 | 3 = 2;

  get craftCells(): (SlotItem | null)[] {
    return this.craft.slice(0, this.craftSize * this.craftSize);
  }

  private bank(ref: SlotRef): (SlotItem | null)[] {
    if (ref.isCraft) return this.craft;
    return ref.isHotbar ? this.hotbar : this.mainInv;
  }

  addItem(item: SlotItem): boolean {
    if (item.kind === 'block') return this.addBlock(item.blockId, item.count);
    if (item.kind === 'food') return stackItem(this.hotbar, this.mainInv, item);
    return false;
  }

  addBlock(blockId: number, count = 1): boolean {
    if (blockId === B.AIR || blockId === B.BEDROCK) return false;
    return stackItem(this.hotbar, this.mainInv, { kind: 'block', blockId, count });
  }

  consumeAt(ref: SlotRef, n = 1): boolean {
    const arr = this.bank(ref);
    const item = arr[ref.index];
    if (!item || (item.kind !== 'block' && item.kind !== 'food')) return false;
    item.count -= n;
    if (item.count <= 0) arr[ref.index] = null;
    return true;
  }

  consumeBlock(slotRef: SlotRef): boolean {
    const arr = this.bank(slotRef);
    const item = arr[slotRef.index];
    if (!item || item.kind !== 'block' || item.count <= 0) return false;
    item.count--;
    if (item.count <= 0) arr[slotRef.index] = null;
    return true;
  }

  setCraftSize(size: 2 | 3): boolean {
    if (size === this.craftSize) return true;
    if (size === 2) {
      const overflow = this.craft.slice(4, 9).filter((c): c is SlotItem => !!c);
      for (const item of overflow) if (!this.addItem(item)) return false;
      this.craft.splice(4, 5, null, null, null, null, null);
    }
    this.craftSize = size;
    return true;
  }

  swapSlots(from: SlotRef, to: SlotRef) {
    const arrFrom = this.bank(from);
    const arrTo = this.bank(to);
    const a = arrFrom[from.index];
    const b = arrTo[to.index];

    if (a && b && sameStack(a, b) && a.kind !== 'weapon' && b.kind !== 'weapon') {
      const space = STACK - b.count;
      if (space > 0) {
        const add = Math.min(space, a.count);
        b.count += add;
        a.count -= add;
        if (a.count <= 0) arrFrom[from.index] = null;
        return;
      }
    }

    arrFrom[from.index] = b;
    arrTo[to.index] = a;
  }

  getItem(ref: SlotRef): SlotItem | null {
    if (ref.isCraft && ref.index >= this.craftSize * this.craftSize) return null;
    return this.bank(ref)[ref.index] ?? null;
  }

  setItem(ref: SlotRef, item: SlotItem | null): void {
    this.bank(ref)[ref.index] = item;
  }

  countBlock(blockId: number): number {
    let n = 0;
    for (const arr of [this.hotbar, this.mainInv])
      for (const s of arr) if (s?.kind === 'block' && s.blockId === blockId) n += s.count;
    return n;
  }

  canAdd(item: SlotItem): boolean {
    if (item.kind === 'weapon') {
      return this.hotbar.some((s) => !s) || this.mainInv.some((s) => !s);
    }
    let count = item.count;
    let empties = 0;
    for (const arr of [this.hotbar, this.mainInv]) {
      for (const s of arr) {
        if (!s) { empties++; continue; }
        if (sameStack(s, item) && s.kind !== 'weapon' && s.count < STACK)
          count -= Math.min(STACK - s.count, count);
      }
    }
    return count <= empties * STACK;
  }
}
