// Inventory state manager for Minecraft-style voxel items & hotbar.
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
  Object.values(FOODS).map((f) => [f.id, f.name])
);

export interface SlotRef {
  isHotbar: boolean;
  index: number;
  /** third slot bank: the crafting grid (2×2 pocket or 3×3 table) */
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
};

export class Inventory {
  hotbar: (SlotItem | null)[] = [
    { kind: 'weapon', weaponId: 'handgun' },
    { kind: 'weapon', weaponId: 'smg' },
    { kind: 'weapon', weaponId: 'rifle' },
    { kind: 'weapon', weaponId: 'sniper' },
    { kind: 'weapon', weaponId: 'bazooka' },
    { kind: 'weapon', weaponId: 'laser' },
  ];

  mainInv: (SlotItem | null)[] = (() => {
    const arr: (SlotItem | null)[] = Array(27).fill(null);
    arr[0] = { kind: 'block', blockId: B.COBBLE, count: 64 };
    arr[9] = { kind: 'food', foodId: 'chicken-drum', count: 64 };
    return arr;
  })();

  /** Add any stackable item (stacks then spills into empty slots). */
  addItem(item: SlotItem): boolean {
    if (item.kind === 'block') return this.addBlock(item.blockId, item.count);
    if (item.kind === 'food') return this.addFood(item.foodId, item.count);
    return false;
  }

  private addFood(foodId: string, count: number): boolean {
    const merge = (arr: (SlotItem | null)[]) => {
      for (let i = 0; i < arr.length && count > 0; i++) {
        const it = arr[i];
        if (it && it.kind === 'food' && it.foodId === foodId && it.count < 64) {
          const add = Math.min(64 - it.count, count);
          it.count += add;
          count -= add;
        }
      }
    };
    const place = (arr: (SlotItem | null)[]) => {
      for (let i = 0; i < arr.length && count > 0; i++) {
        if (!arr[i]) {
          const add = Math.min(64, count);
          arr[i] = { kind: 'food', foodId, count: add };
          count -= add;
        }
      }
    };
    merge(this.hotbar);
    merge(this.mainInv);
    if (count > 0) { place(this.mainInv); place(this.hotbar); }
    return count === 0;
  }

  /** Consume `n` of any item from a slot. */
  consumeAt(ref: SlotRef, n = 1): boolean {
    const arr = ref.isHotbar ? this.hotbar : this.mainInv;
    const item = arr[ref.index];
    if (!item || (item.kind !== 'block' && item.kind !== 'food')) return false;
    item.count -= n;
    if (item.count <= 0) arr[ref.index] = null;
    return true;
  }

  /** Add mined block item. Returns true if added. */
  addBlock(blockId: number, count = 1): boolean {
    if (blockId === B.AIR || blockId === B.BEDROCK) return false;

    // 1. Try to stack into existing hotbar block slots
    for (let i = 0; i < this.hotbar.length; i++) {
      const item = this.hotbar[i];
      if (item && item.kind === 'block' && item.blockId === blockId && item.count < 64) {
        const space = 64 - item.count;
        const add = Math.min(space, count);
        item.count += add;
        count -= add;
        if (count <= 0) return true;
      }
    }

    // 2. Try to stack into main inventory block slots
    for (let i = 0; i < this.mainInv.length; i++) {
      const item = this.mainInv[i];
      if (item && item.kind === 'block' && item.blockId === blockId && item.count < 64) {
        const space = 64 - item.count;
        const add = Math.min(space, count);
        item.count += add;
        count -= add;
        if (count <= 0) return true;
      }
    }

    // 3. Place into empty main inventory slot
    for (let i = 0; i < this.mainInv.length; i++) {
      if (!this.mainInv[i]) {
        const add = Math.min(64, count);
        this.mainInv[i] = { kind: 'block', blockId, count: add };
        count -= add;
        if (count <= 0) return true;
      }
    }

    // 4. Place into empty hotbar slot
    for (let i = 0; i < this.hotbar.length; i++) {
      if (!this.hotbar[i]) {
        const add = Math.min(64, count);
        this.hotbar[i] = { kind: 'block', blockId, count: add };
        count -= add;
        if (count <= 0) return true;
      }
    }

    return count === 0;
  }

  /** Consume 1 block from a specific slot. */
  consumeBlock(slotRef: SlotRef): boolean {
    const arr = slotRef.isHotbar ? this.hotbar : this.mainInv;
    const item = arr[slotRef.index];
    if (!item || item.kind !== 'block' || item.count <= 0) return false;
    item.count--;
    if (item.count <= 0) {
      arr[slotRef.index] = null;
    }
    return true;
  }

  /** the crafting grid — 9 cells, only the first craftSize² are active */
  craft: (SlotItem | null)[] = Array(9).fill(null);
  craftSize: 2 | 3 = 2;

  /** active crafting cells for the current grid size */
  get craftCells(): (SlotItem | null)[] {
    const s = this.craftSize;
    return this.craft.slice(0, s * s);
  }

  private bank(ref: SlotRef): (SlotItem | null)[] {
    if (ref.isCraft) return this.craft;
    return ref.isHotbar ? this.hotbar : this.mainInv;
  }

  /**
   * Switch the crafting grid between the 2×2 pocket and the 3×3 table.
   * When shrinking, cells that fall outside the smaller grid are pushed back
   * into storage; if storage is full the switch is refused and returns false.
   */
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

  /** Swap or move items between slots. */
  swapSlots(from: SlotRef, to: SlotRef) {
    const arrFrom = this.bank(from);
    const arrTo = this.bank(to);

    const itemFrom = arrFrom[from.index];
    const itemTo = arrTo[to.index];

    // Stacking same block type
    if (
      itemFrom && itemTo &&
      itemFrom.kind === 'block' && itemTo.kind === 'block' &&
      itemFrom.blockId === itemTo.blockId
    ) {
      const space = 64 - itemTo.count;
      if (space > 0) {
        const add = Math.min(space, itemFrom.count);
        itemTo.count += add;
        itemFrom.count -= add;
        if (itemFrom.count <= 0) {
          arrFrom[from.index] = null;
        }
        return;
      }
    }

    // Stacking same food type
    if (
      itemFrom && itemTo &&
      itemFrom.kind === 'food' && itemTo.kind === 'food' &&
      itemFrom.foodId === itemTo.foodId
    ) {
      const space = 64 - itemTo.count;
      if (space > 0) {
        const add = Math.min(space, itemFrom.count);
        itemTo.count += add;
        itemFrom.count -= add;
        if (itemFrom.count <= 0) {
          arrFrom[from.index] = null;
        }
        return;
      }
    }

    // Direct swap
    arrFrom[from.index] = itemTo;
    arrTo[to.index] = itemFrom;
  }

  getItem(ref: SlotRef): SlotItem | null {
    const arr = this.bank(ref);
    if (ref.isCraft && ref.index >= this.craftSize * this.craftSize) return null;
    return arr[ref.index] ?? null;
  }

  /** would `item` fit without mutating anything? (used to gate crafting) */
  canAdd(item: SlotItem): boolean {
    const need = (key: (s: SlotItem) => string | null) => {
      let count = item.kind === 'weapon' ? 1 : item.count;
      let empties = 0;
      for (const arr of [this.hotbar, this.mainInv]) {
        for (const s of arr) {
          if (!s) { empties++; continue; }
          const k = key(s);
          if (k && k === key(item) && s.kind !== 'weapon' && s.count < 64) {
            count -= Math.min(64 - s.count, count);
          }
        }
      }
      if (item.kind === 'weapon') return empties > 0;
      return count <= empties * 64;
    };
    if (item.kind === 'block') return need((s) => (s.kind === 'block' ? `b${s.blockId}` : null));
    if (item.kind === 'food') return need((s) => (s.kind === 'food' ? `f${s.foodId}` : null));
    return need(() => null);
  }
}
