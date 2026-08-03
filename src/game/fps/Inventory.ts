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

  /** Swap or move items between slots. */
  swapSlots(from: SlotRef, to: SlotRef) {
    const arrFrom = from.isHotbar ? this.hotbar : this.mainInv;
    const arrTo = to.isHotbar ? this.hotbar : this.mainInv;

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
    return ref.isHotbar ? this.hotbar[ref.index] : this.mainInv[ref.index];
  }
}
