/**
 * FurnaceManager — manages all active furnaces in the world, UI state, smelting ticks,
 * transfers, and quick-moving items between player inventory and furnace slots.
 */

import { B } from '../world/blocks';
import type { World } from '../world/world';
import type { Inventory, SlotItem } from '../fps/Inventory';
import {
  newFurnace, tickFurnace, furnaceIdle, furnaceKey, isFuel, smeltResult, SMELT_TIME,
  type FurnaceState,
} from '../crafting/smelting';

export class FurnaceManager {
  /** every placed furnace's contents + burn state, keyed by block position */
  furnaces = new Map<string, FurnaceState>();
  /** the furnace whose UI is open (null = closed) */
  openFurnaceKey: string | null = null;

  constructor(
    private canvas: HTMLCanvasElement,
    private inventory: Inventory,
    private onStatsChanged: () => void,
    private requestLock: () => void,
  ) {}

  /** live state of the furnace whose UI is open (HUD reads this) */
  get openFurnace(): FurnaceState | null {
    return this.openFurnaceKey ? this.furnaces.get(this.openFurnaceKey) ?? null : null;
  }

  openFurnaceAt(x: number, y: number, z: number): void {
    const k = furnaceKey(x, y, z);
    if (!this.furnaces.has(k)) this.furnaces.set(k, newFurnace());
    this.openFurnaceKey = k;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.onStatsChanged();
  }

  closeFurnace(): void {
    this.openFurnaceKey = null;
    this.requestLock();
    this.onStatsChanged();
  }

  /**
   * Move one (or a whole stack with `all`) between a furnace slot and the
   * player's inventory. Slot semantics mirror Minecraft: input and fuel take
   * items in, output only gives them out.
   */
  furnaceTransfer(slot: 'input' | 'fuel' | 'output', all: boolean, selectedHotbarSlot: number): void {
    const st = this.openFurnace;
    if (!st) return;
    const inv = this.inventory;
    const held = st[slot];

    if (held) {
      // pull out of the furnace
      const take = all ? held : { ...held, count: held.kind === 'weapon' ? 1 : 1 } as SlotItem;
      if (all) {
        if (inv.canAdd(held)) { inv.addItem(held); st[slot] = null; }
      } else if (held.kind !== 'weapon') {
        if (inv.canAdd({ ...held, count: 1 })) {
          inv.addItem({ ...held, count: 1 });
          held.count -= 1;
          if (held.count <= 0) st[slot] = null;
        }
      } else if (inv.canAdd(take)) { inv.addItem(take); st[slot] = null; }
      this.onStatsChanged();
      return;
    }

    if (slot === 'output') return; // nothing to insert into the result slot

    // insert the selected hotbar stack, if it is valid for this slot
    const sel = inv.hotbar[selectedHotbarSlot];
    if (!sel || sel.kind !== 'block') return;
    const ok = slot === 'fuel' ? isFuel(sel.blockId) : !!smeltResult(sel.blockId);
    if (!ok) return;
    const n = all ? sel.count : 1;
    st[slot] = { kind: 'block', blockId: sel.blockId, count: n };
    sel.count -= n;
    if (sel.count <= 0) { inv.hotbar[selectedHotbarSlot] = null; }
    this.onStatsChanged();
  }

  /**
   * Minecraft shift-click semantics: clicking an inventory stack while the
   * furnace is open routes the WHOLE stack to the correct slot automatically —
   * smeltable items go to input, fuel goes to fuel (merging with same-type
   * stacks up to 64). Returns false when the item fits neither slot.
   */
  furnaceQuickMove(ref: { isHotbar: boolean; isCraft?: boolean; index: number }): boolean {
    const st = this.openFurnace;
    if (!st) return false;
    const inv = this.inventory;
    const item = inv.getItem(ref);
    if (!item || item.kind !== 'block') return false;

    // smeltable wins when an item is somehow both (mirrors MC priority)
    const target: 'input' | 'fuel' | null =
      smeltResult(item.blockId) ? 'input' :
      isFuel(item.blockId) ? 'fuel' : null;
    if (!target) return false;

    const cur = st[target];
    if (cur && (cur.kind !== 'block' || cur.blockId !== item.blockId || cur.count >= 64)) return false;

    const space = cur && cur.kind === 'block' ? 64 - cur.count : 64;
    const n = Math.min(space, item.count);
    if (n <= 0) return false;

    if (cur && cur.kind === 'block') cur.count += n;
    else st[target] = { kind: 'block', blockId: item.blockId, count: n };
    item.count -= n;
    if (item.count <= 0) inv.setItem(ref, null);

    this.onStatsChanged();
    return true;
  }

  /** advance every furnace; swap lit/unlit blocks as flames start and die */
  updateFurnaces(dt: number, world: World): void {
    if (this.furnaces.size === 0) return;
    for (const [k, st] of this.furnaces) {
      const wasLit = st.burn > 0;
      tickFurnace(st, dt);
      const lit = st.burn > 0;
      if (lit !== wasLit) {
        const [x, y, z] = k.split(',').map(Number);
        const cur = world.getBlockRaw(x, y, z);
        if (cur === B.FURNACE || cur === B.FURNACE_LIT) {
          world.setBlock(x, y, z, lit ? B.FURNACE_LIT : B.FURNACE);
        }
      }
      // reclaim memory from furnaces that were emptied out
      if (furnaceIdle(st) && k !== this.openFurnaceKey) this.furnaces.delete(k);
    }
  }

  getFurnaceGauges(): { furnaceBurn: number; furnaceCook: number } {
    const f = this.openFurnace;
    return {
      furnaceBurn: f && f.burnMax > 0 ? Math.max(0, Math.min(1, f.burn / f.burnMax)) : 0,
      furnaceCook: f ? Math.max(0, Math.min(1, f.cook / SMELT_TIME)) : 0,
    };
  }
}
