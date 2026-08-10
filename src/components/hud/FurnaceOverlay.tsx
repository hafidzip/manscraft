import { X, Flame, Package, ArrowRight } from 'lucide-react';
import type { GameEngine, HudStats } from '../../game/engine';
import type { SlotItem } from '../../game/fps/Inventory';
import { smeltResult, isFuel } from '../../game/crafting/smelting';
import { RenderSlotItem } from './icons';

export function FurnaceOverlay({ game, stats, refreshInv }: {
  game: () => GameEngine | null;
  stats: HudStats;
  refreshInv: () => void;
}) {
  const g = game();
  const inv = g?.inventory;
  const fur = g?.openFurnace;
  if (!g || !inv || !fur) return null;

  const burn = stats.furnaceBurn ?? 0;
  const cook = stats.furnaceCook ?? 0;

  const takeBack = (slot: 'input' | 'fuel' | 'output') => () => {
    g.furnaceTransfer(slot, true);
    refreshInv();
  };
  const quickMove = (isHotbar: boolean, index: number) => () => {
    g.furnaceQuickMove({ isHotbar, index });
    refreshInv();
  };
  const slotClass = (item: SlotItem | null): string => {
    if (!item || item.kind !== 'block') return 'opacity-60';
    if (smeltResult(item.blockId))
      return 'cursor-pointer !outline-[#6dc24a] hover:!bg-[#3f5a34]/70';
    if (isFuel(item.blockId))
      return 'cursor-pointer !outline-[#ff8b4e] hover:!bg-[#5a3a24]/70';
    return 'opacity-60';
  };

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) g.closeFurnace(); }}>
      <div className="mc-book px-6 pt-4 pb-4 w-[520px] relative">
        <button onClick={() => g.closeFurnace()}
          className="absolute top-3 right-3 text-white/50 hover:text-white cursor-pointer">
          <X size={14} />
        </button>

        <div className="flex items-center justify-center gap-2 mb-4">
          <Flame size={13} className={burn > 0 ? 'text-[#ff8b4e]' : 'text-white/40'} />
          <span className="px-font px-shadow text-[12px] text-white tracking-widest">FURNACE</span>
        </div>

        <div className="flex items-center justify-center gap-4 mb-4">
          <div className="flex flex-col items-center gap-2">
            <button onClick={takeBack('input')} title={fur.input ? 'Click: return to inventory' : 'Click a smeltable item below to load'}
              className={`mc-book-slot w-[52px] h-[52px] flex items-center justify-center relative
                ${fur.input ? 'mc-book-slot-hoverable cursor-pointer' : '!outline-dashed !outline-[#6dc24a]/40'}`}>
              {!fur.input && <span className="px-font text-[6px] text-[#6dc24a]/60 absolute inset-0 flex items-center justify-center">SMELT</span>}
              <RenderSlotItem item={fur.input} />
            </button>
            <div className="relative w-[26px] h-[26px]">
              <Flame size={26} className="absolute inset-0 text-white/12" strokeWidth={2} />
              <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(${(1 - burn) * 100}% 0 0 0)` }}>
                <Flame size={26} className="text-[#ff8b4e]" strokeWidth={2}
                  style={{ filter: burn > 0 ? 'drop-shadow(0 0 5px rgba(255,139,78,0.85))' : 'none' }} />
              </div>
            </div>
            <button onClick={takeBack('fuel')} title={fur.fuel ? 'Click: return to inventory' : 'Click a fuel item below to load (planks, logs, leaves, cactus)'}
              className={`mc-book-slot w-[52px] h-[52px] flex items-center justify-center relative
                ${fur.fuel ? 'mc-book-slot-hoverable cursor-pointer' : '!outline-dashed !outline-[#ff8b4e]/40'}`}>
              {!fur.fuel && <span className="px-font text-[6px] text-[#ff8b4e]/60 absolute inset-0 flex items-center justify-center">FUEL</span>}
              <RenderSlotItem item={fur.fuel} />
            </button>
          </div>

          <div className="relative w-[62px] h-[22px] flex items-center">
            <div className="absolute inset-0 flex items-center">
              <ArrowRight size={30} className="text-white/15" strokeWidth={2.5} />
            </div>
            <div className="absolute inset-0 flex items-center overflow-hidden"
              style={{ clipPath: `inset(0 ${(1 - cook) * 100}% 0 0)` }}>
              <ArrowRight size={30} className="text-[#6dc24a]" strokeWidth={2.5} />
            </div>
          </div>

          <button onClick={takeBack('output')} title="Click: collect"
            className={`mc-book-slot w-[62px] h-[62px] flex items-center justify-center relative
              ${fur.output ? 'cursor-pointer !outline-[#6dc24a] hover:!bg-[#3f5a34]/80' : 'opacity-60'}`}>
            <RenderSlotItem item={fur.output} />
          </button>
        </div>

        <div className="mc-book-slot p-3">
          <div className="flex items-center justify-center gap-3 mb-2">
            <Package size={11} className="text-[#8ab4ff]" />
            <span className="px-font px-shadow-sm text-[9px] text-white/80 tracking-wider">INVENTORY</span>
            <span className="px-font text-[6px] text-[#6dc24a]">■ SMELTABLE</span>
            <span className="px-font text-[6px] text-[#ff8b4e]">■ FUEL</span>
          </div>
          <div className="grid grid-cols-9 gap-[3px] mb-2">
            {inv.mainInv.map((item, i) => (
              <button key={i} onClick={quickMove(false, i)}
                title={item && item.kind === 'block' ? (smeltResult(item.blockId) ? 'Click: smelt' : isFuel(item.blockId) ? 'Click: use as fuel' : undefined) : undefined}
                className={`mc-book-slot w-[46px] h-[40px] flex items-center justify-center ${slotClass(item)}`}>
                {item && <RenderSlotItem item={item} />}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-9 gap-[3px] pt-2 border-t border-white/10">
            {inv.hotbar.map((item, i) => (
              <button key={i} onClick={quickMove(true, i)}
                title={item && item.kind === 'block' ? (smeltResult(item.blockId) ? 'Click: smelt' : isFuel(item.blockId) ? 'Click: use as fuel' : undefined) : undefined}
                className={`mc-book-slot w-[46px] h-[40px] flex items-center justify-center ${slotClass(item)} ${stats.slot === i ? 'mc-book-picked' : ''}`}>
                {item && <RenderSlotItem item={item} />}
              </button>
            ))}
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={`f${i}`} className="mc-book-slot w-[46px] h-[40px] opacity-60" />
            ))}
          </div>
        </div>

        <div className="flex items-center gap-4 mt-3 px-font px-shadow-sm text-[7px] text-white/55">
          <span className="flex items-center gap-1.5"><span className="mc-book-key !text-[#ff5347]">ESC</span> EXIT</span>
          <span>CLICK ITEM → AUTO-LOADS · CLICK FURNACE SLOT → RETURNS</span>
        </div>
      </div>
    </div>
  );
}
