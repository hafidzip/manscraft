import { Hammer, Package, X, ArrowRight, Swords, Apple, Shield } from 'lucide-react';
import type { GameEngine, HudStats } from '../../game/engine';
import type { SlotRef, SlotItem } from '../../game/fps/Inventory';
import { RECIPES, matchCraft, type Recipe } from '../../game/crafting/recipes';
import { BlockIcon, RenderSlotItem, itemName } from './icons';

export interface SlotPropsFn {
  (ref: SlotRef): {
    draggable: boolean;
    onClick: () => void;
    onDragStart: (e: React.DragEvent) => void;
    onDragEnd: () => void;
    onDragOver: (e: React.DragEvent) => void;
    onDrop: (e: React.DragEvent) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    className: string;
  };
}

export function InventoryOverlay({ stats, game, hoverSlot, selectedSlot, dragItem, slotProps, onCloseInventory, refreshInv }: {
  stats: HudStats;
  game: () => GameEngine | null;
  hoverSlot: SlotRef | null;
  selectedSlot: SlotRef | null;
  dragItem: { item: SlotItem; from: SlotRef } | null;
  slotProps: SlotPropsFn;
  onCloseInventory: () => void;
  refreshInv: () => void;
}) {
  const inv = game()?.inventory;
  if (!inv) return null;

  const pocketSize = 2;
  const pocketCells = inv.craft.slice(0, 4);
  const pocketResult = matchCraft(pocketCells, pocketSize);
  const pocketOutput = pocketResult?.output ?? null;

  const takePocket = (n: number) => {
    const prev = inv.craftSize;
    inv.craftSize = 2;
    if (game()?.takeCraftResult(n)) refreshInv();
    inv.craftSize = prev;
  };

  const fillRecipe = (r: Recipe) => {
    if (!game()) return;
    if (r.grid === 3 && !inv.setCraftSize(3)) return;
    const size = inv.craftSize;
    const need: (number | null)[] = Array(size * size).fill(null);
    if (r.shaped) {
      const off = Math.floor((size - r.shaped.length) / 2);
      r.shaped.forEach((row, y) => row.forEach((ing, x) => {
        if (ing) need[(y + off) * size + (x + off)] = ing.blockId;
      }));
    } else {
      r.shapeless!.forEach((ing, i) => { need[i] = ing.blockId; });
    }

    const req = new Map<number, number>();
    for (const id of need) if (id != null) req.set(id, (req.get(id) ?? 0) + 1);
    for (const [id, n] of req) if (inv.countBlock(id) < n) return;

    for (let i = 0; i < size * size; i++) {
      const it = inv.craft[i];
      if (!it) continue;
      if (!inv.addItem(it)) { inv.craft[i] = it; return; }
      inv.craft[i] = null;
    }
    for (let i = 0; i < size * size; i++) {
      const id = need[i];
      if (id == null) continue;
      outer: for (const arr of [inv.hotbar, inv.mainInv]) {
        for (let k = 0; k < arr.length; k++) {
          const s = arr[k];
          if (s?.kind === 'block' && s.blockId === id && s.count > 0) {
            if (--s.count <= 0) arr[k] = null;
            inv.craft[i] = { kind: 'block', blockId: id, count: 1 };
            break outer;
          }
        }
      }
    }
    refreshInv();
  };

  const hoverItem = hoverSlot ? game()?.inventory.getItem(hoverSlot) ?? null : null;
  const selItem = selectedSlot ? game()?.inventory.getItem(selectedSlot) ?? null : null;
  const itemTip = hoverItem ?? (selItem ? selItem : dragItem?.item ?? null);

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm">
      <div className="flex gap-3 items-start max-h-[92vh] overflow-y-auto px-4 pb-4 pt-2">

        <div className="mc-panel p-4 flex flex-col gap-3 w-[220px] flex-shrink-0">
          <div className="flex items-center gap-2 px-font text-[9px] text-[#ffd23e]">
            <Hammer size={12} /> CRAFTING
          </div>
          <div className="flex items-center gap-3 justify-center">
            <div className="grid grid-cols-2 gap-1.5">
              {[0, 1, 2, 3].map((i) => {
                const ref: SlotRef = { isHotbar: false, index: i, isCraft: true };
                const p = slotProps(ref);
                return (
                  <div key={i} {...p} className={`${p.className} w-[44px] h-[44px]`}>
                    <RenderSlotItem item={pocketCells[i] ?? null} hovered={!!hoverSlot?.isCraft && hoverSlot.index === i} />
                  </div>
                );
              })}
            </div>
            <ArrowRight size={18} className="text-white/40 flex-shrink-0" />
            <div className="flex flex-col items-center gap-1">
              <div
                onClick={() => takePocket(1)}
                title="Click to take 1"
                className={`mc-slot w-[48px] h-[48px] relative flex items-center justify-center cursor-pointer
                  ${pocketOutput ? '!outline-[#6dc24a] hover:!bg-[#3f5a34]/80' : 'opacity-50'}`}
              >
                {pocketOutput && <RenderSlotItem item={pocketOutput.kind === 'weapon' ? pocketOutput : { ...pocketOutput, count: pocketOutput.count ?? 1 }} />}
              </div>
            </div>
          </div>
          <div className="border-t border-white/10 pt-2 flex flex-col gap-1.5">
            <div className="px-font text-[7px] text-white/35">RECIPES (2×2)</div>
            <div className="flex flex-wrap gap-1">
              {RECIPES.filter(r => r.grid === 2).map((r) => {
                const pattern: (number | null)[] = [];
                const dim = r.shaped ? r.shaped.length : 1;
                const wid = r.shaped ? r.shaped[0].length : r.shapeless!.length;
                for (let y = 0; y < dim; y++) for (let x = 0; x < wid; x++)
                  pattern.push(r.shaped ? (r.shaped[y][x]?.blockId ?? null) : r.shapeless![y * wid + x].blockId);
                return (
                  <button key={r.id} onClick={() => fillRecipe(r)} title={r.name}
                    className="mc-slot flex items-center gap-1 px-1 py-0.5 cursor-pointer hover:!bg-[#5a6070]/90">
                    <div className="grid gap-[1px]" style={{ gridTemplateColumns: `repeat(${wid}, 8px)` }}>
                      {pattern.map((id, i) => (
                        <div key={i} className="w-[8px] h-[8px]">
                          {id != null && <BlockIcon blockId={id} size={8} />}
                        </div>
                      ))}
                    </div>
                    <ArrowRight size={8} className="text-white/30" />
                    <BlockIcon blockId={(r.output as { blockId?: number }).blockId ?? 1} size={14} />
                  </button>
                );
              })}
            </div>
            <div className="px-font text-[6px] text-white/25 mt-1">RMB CRAFTING TABLE FOR 3×3</div>
          </div>
        </div>

        <div className="mc-panel p-4 flex flex-col gap-3 relative">
          <button onClick={onCloseInventory}
            className="absolute top-3 right-3 text-white/50 hover:text-white cursor-pointer">
            <X size={14} />
          </button>
          <div className="flex items-center gap-2 px-font text-[9px] text-[#ffd23e]">
            <Package size={12} /> INVENTORY
          </div>
          <div className="h-8 px-2 flex items-center mc-slot overflow-hidden">
            {itemTip ? (
              <div className="flex items-center gap-2">
                {itemTip.kind === 'weapon' && <Swords size={11} className="text-[#ffd23e]" />}
                {itemTip.kind === 'block' && <Package size={11} className="text-[#8ab4ff]" />}
                {itemTip.kind === 'food' && <Apple size={11} className="text-[#ff8b4e]" />}
                <span className="px-font text-[8px] text-white">{itemName(itemTip)}</span>
                {itemTip.kind !== 'weapon' && <span className="px-font text-[7px] text-white/50">×{itemTip.count}</span>}
              </div>
            ) : <span className="px-font text-[7px] text-white/30">HOVER TO INSPECT · CLICK/DRAG TO MOVE</span>}
          </div>
          <div className="flex flex-col gap-1">
            <div className="px-font text-[7px] text-white/40">STORAGE</div>
            <div className="grid grid-cols-9 gap-1.5">
              {(game()?.inventory.mainInv ?? Array(27).fill(null)).map((item, i) => {
                const p = slotProps({ isHotbar: false, index: i });
                return (
                  <div key={i} {...p} className={`${p.className} w-[44px] h-[44px]`}>
                    <RenderSlotItem item={item} hovered={!!hoverSlot && !hoverSlot.isHotbar && !hoverSlot.isCraft && hoverSlot.index === i} />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
            <div className="px-font text-[7px] text-[#ffd23e]">HOTBAR</div>
            <div className="grid grid-cols-6 gap-1.5">
              {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => {
                const p = slotProps({ isHotbar: true, index: i });
                return (
                  <div key={i} {...p} className={`${p.className} w-[44px] h-[44px] ${stats.slot === i ? '!outline-[#ffd23e]' : ''}`}>
                    <span className="absolute top-0.5 left-1 px-font text-[6px] text-white/35">{i + 1}</span>
                    <RenderSlotItem item={item} hovered={!!hoverSlot?.isHotbar && !hoverSlot.isCraft && hoverSlot.index === i} />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex items-center justify-between px-font text-[7px] text-white/35 border-t border-white/10 pt-2">
            <div className="flex items-center gap-3">
              <Shield size={11} className={stats.enemiesEnabled ? 'text-[#ff5347]' : 'text-[#6dc24a]'} />
              <button onClick={() => game()?.toggleEnemies(!stats.enemiesEnabled)}
                className="mc-btn px-2.5 py-1 text-[7px] cursor-pointer">
                AI: {stats.enemiesEnabled ? 'ON' : 'OFF'}
              </button>
            </div>
            <div>TAB TO RESUME</div>
          </div>
        </div>
      </div>
    </div>
  );
}
