import { useEffect, useState } from 'react';
import { ChevronUp, Hammer, Package, ArrowRight } from 'lucide-react';
import type { GameEngine } from '../../game/engine';
import { RECIPES, RECIPE_GROUPS, recipeIngredients, type Recipe, type RecipeGroupId } from '../../game/crafting/recipes';
import { BlockIcon, RenderSlotItem } from './icons';

export function CraftingOverlay({ game, refreshInv, selectedSlot }: {
  game: () => GameEngine | null;
  refreshInv: () => void;
  selectedSlot: number;
}) {
  const table = game()?.openCraftingState ?? null;
  const tableKey = game()?.openCraftingCoords?.join(',') ?? '';
  const [bookGroup, setBookGroup] = useState<RecipeGroupId>('building');
  const [bookSel, setBookSel] = useState<string | null>(table?.recipeId ?? null);
  const [bookFlash, setBookFlash] = useState(0);

  useEffect(() => {
    setBookSel(game()?.openCraftingState?.recipeId ?? null);
  }, [tableKey]);

  const inv = game()?.inventory;
  if (!inv) return null;

  const activeGroup = RECIPE_GROUPS.find((g) => g.id === bookGroup) ?? RECIPE_GROUPS[0];
  const list = RECIPES.filter((r) => r.group === activeGroup.id);
  const sel: Recipe | null = list.find((r) => r.id === bookSel) ?? null;

  const pickBlueprint = (id: string) => {
    setBookSel(id);
    game()?.selectCraftingBlueprint(id);
    refreshInv();
  };

  const countOf = (id: number) => inv.countBlock(id);
  const needMap = new Map<number, number>();
  if (sel) for (const ing of recipeIngredients(sel))
    needMap.set(ing.blockId, (needMap.get(ing.blockId) ?? 0) + 1);
  let maxCraft = sel ? 64 : 0;
  for (const [id, n] of needMap) maxCraft = Math.min(maxCraft, Math.floor(countOf(id) / n));
  const craftable = maxCraft > 0;

  const gridCells: (number | null)[] = Array(9).fill(null);
  if (sel?.shaped) {
    const off = Math.floor((3 - sel.shaped.length) / 2);
    sel.shaped.forEach((row, y) => row.forEach((ing, x) => {
      if (ing) gridCells[(y + off) * 3 + (x + off)] = ing.blockId;
    }));
  } else if (sel?.shapeless) {
    sel.shapeless.forEach((ing, i) => { gridCells[i] = ing.blockId; });
  }

  const doCraft = (e: React.MouseEvent) => {
    if (!sel || !craftable) return;
    const made = game()?.craftRecipe(sel.id, e.shiftKey ? maxCraft : 1) ?? 0;
    if (made > 0) { setBookFlash(Date.now()); refreshInv(); }
  };
  const outBlock = sel ? ((sel.output as { blockId?: number }).blockId ?? 1) : 1;
  const outCount = sel && sel.output.kind !== 'weapon' ? (sel.output.count ?? 1) : 1;

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) game()?.closeCraftingTable(); }}>
      <div className="relative">

        <div className="flex gap-1 pl-16 relative z-0">
          {RECIPE_GROUPS.map((g) => (
            <button
              key={g.id}
              title={g.label}
              onClick={() => { setBookGroup(g.id); setBookSel(null); }}
              className={`mc-book-tab w-[72px] h-[50px] flex items-center justify-center
                ${g.id === activeGroup.id ? 'mc-book-tab-active' : ''}`}
            >
              <BlockIcon blockId={g.icon} size={28} />
            </button>
          ))}
        </div>

        <div className="flex relative">
          <div className="flex flex-col items-center gap-1 pr-1 -mr-[2px] z-10 self-center -translate-x-1">
            <div className="mc-book-rail w-[44px] h-[20px] flex items-center justify-center">
              <ChevronUp size={12} className="text-white/35" />
            </div>
            {list.map((r) => (
              <button
                key={r.id}
                title={r.name}
                onClick={() => pickBlueprint(r.id)}
                className={`mc-book-rail w-[50px] h-[50px] flex items-center justify-center
                  ${sel?.id === r.id ? 'mc-book-rail-active mc-book-picked' : ''}`}
              >
                <BlockIcon blockId={(r.output as { blockId?: number }).blockId ?? 1} size={28} />
              </button>
            ))}
            <div className="mc-book-rail w-[44px] h-[20px] flex items-center justify-center">
              <ChevronUp size={12} className="text-white/35 rotate-180" />
            </div>
          </div>

          <div className="mc-book px-5 pt-4 pb-4 w-[860px]">
            <div className="flex items-center justify-center gap-2 mb-3">
              <Hammer size={13} className="text-[#ffd23e]" />
              <span className="px-font px-shadow text-[12px] text-white tracking-widest">
                {activeGroup.label.toUpperCase()}
              </span>
            </div>

            <div className="flex gap-1 justify-center mb-4">
              {list.map((r) => {
                const rNeeds = recipeIngredients(r);
                const reqMap = new Map<number, number>();
                for (const ing of rNeeds) reqMap.set(ing.blockId, (reqMap.get(ing.blockId) ?? 0) + 1);
                let can = 64;
                for (const [id, n] of reqMap) can = Math.min(can, Math.floor(countOf(id) / n));
                const outId = (r.output as { blockId?: number }).blockId ?? 1;
                return (
                  <button key={r.id} title={r.name} onClick={() => pickBlueprint(r.id)}
                    className={`mc-book-slot mc-book-slot-hoverable w-[46px] h-[46px] flex items-center justify-center cursor-pointer
                      ${sel?.id === r.id ? 'mc-book-picked' : ''} ${can <= 0 ? 'opacity-45' : ''}`}>
                    <BlockIcon blockId={outId} size={28} />
                  </button>
                );
              })}
              {Array.from({ length: Math.max(0, 11 - list.length) }).map((_, i) => (
                <div key={`e${i}`} className="mc-book-slot w-[46px] h-[46px] opacity-60" />
              ))}
            </div>

            <div className="flex gap-4">
              <div className="mc-book-slot flex-1 p-3">
                <div className="px-font px-shadow-sm text-center text-[9px] text-[#ffd23e] tracking-wider mb-3">
                  {sel ? sel.name.toUpperCase() : '—'}
                </div>
                <div className="flex items-center justify-center gap-5">
                  <div className="grid grid-cols-3 gap-[3px]">
                    {gridCells.map((id, i) => (
                      <div key={i}
                        className={`mc-book-slot w-[46px] h-[46px] flex items-center justify-center
                          ${id != null && !craftable ? 'mc-book-slot-missing' : ''}`}>
                        {id != null && <BlockIcon blockId={id} size={28} />}
                      </div>
                    ))}
                  </div>
                  <ArrowRight size={26} className="text-white/45 flex-shrink-0" />
                  <button
                    key={bookFlash}
                    onClick={doCraft}
                    title={craftable ? 'Click: craft 1 · Shift+Click: craft all' : 'Missing ingredients'}
                    className={`mc-book-slot w-[60px] h-[60px] flex items-center justify-center relative
                      ${craftable
                        ? 'cursor-pointer craft-pop !outline-[#6dc24a] hover:!bg-[#3f5a34]/80'
                        : 'mc-book-slot-missing cursor-not-allowed'}`}
                  >
                    <BlockIcon blockId={outBlock} size={34} />
                    {outCount > 1 && (
                      <span className="px-font px-shadow absolute bottom-0.5 right-1 text-[8px] text-white">
                        {outCount}
                      </span>
                    )}
                    {craftable && maxCraft < 64 && (
                      <span className="px-font px-shadow-sm absolute top-0.5 left-1 text-[7px] text-[#ffd23e]">
                        ×{maxCraft}
                      </span>
                    )}
                  </button>
                </div>
                <div className="flex items-center justify-center gap-3 mt-3 pt-2 border-t border-white/10">
                  {[...needMap.entries()].map(([id, n]) => {
                    const have = countOf(id);
                    const ok = have >= n;
                    return (
                      <div key={id} className="flex items-center gap-1.5">
                        <BlockIcon blockId={id} size={16} />
                        <span className={`px-font text-[7px] ${ok ? 'text-[#6dc24a]' : 'text-[#ff5347]'}`}>
                          {have}/{n}
                        </span>
                        {table && (
                          <span className="px-font text-[7px] text-[#8ab4ff]">
                            A:{table.buffered[id] ?? 0}/{n}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="mc-book-slot w-[430px] p-3">
                <div className="flex items-center justify-center gap-2 mb-3">
                  <Package size={11} className="text-[#8ab4ff]" />
                  <span className="px-font px-shadow-sm text-[9px] text-white/80 tracking-wider">INVENTORY</span>
                </div>
                <div className="grid grid-cols-9 gap-[3px] mb-2">
                  {(inv.mainInv).map((item, i) => (
                    <div key={i} className="mc-book-slot w-[40px] h-[40px] flex items-center justify-center">
                      {item && <RenderSlotItem item={item} />}
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-9 gap-[3px] pt-2 border-t border-white/10">
                  {inv.hotbar.map((item, i) => (
                    <div key={i} className={`mc-book-slot w-[40px] h-[40px] flex items-center justify-center ${selectedSlot === i ? 'mc-book-picked' : ''}`}>
                      {item && <RenderSlotItem item={item} />}
                    </div>
                  ))}
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={`h${i}`} className="mc-book-slot w-[40px] h-[40px] opacity-60" />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4 mt-3 pl-2 px-font px-shadow-sm text-[7px] text-white/55">
          <span className="flex items-center gap-1.5"><span className="mc-book-key !text-[#ff5347]">ESC</span> EXIT</span>
          <span className="flex items-center gap-1.5"><span className="mc-book-key">CLICK</span> CRAFT</span>
          <span className="flex items-center gap-1.5"><span className="mc-book-key">SHIFT</span> CRAFT ALL</span>
          <span className="flex items-center gap-1.5"><span className="mc-book-key">TAB</span> INVENTORY</span>
        </div>
      </div>
    </div>
  );
}
