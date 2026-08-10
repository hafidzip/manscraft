import { useState, type RefObject } from 'react';
import { X, Package, ArrowDownUp } from 'lucide-react';
import type { GameEngine, HudStats } from '../../game/engine';
import { SHOP_ITEMS, getBlockSellPrice, getFoodSellPrice } from '../../game/fps/shop';
import type { SlotItem } from '../../game/fps/Inventory';
import { BLOCK_NAMES, FOODS } from '../../game/fps/Inventory';
import { CoinIcon, ShopItemIcon, BlockIcon, DrumstickIcon } from './icons';

export function TradePrompt() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-1/3 z-20 flex justify-center">
      <div className="flex items-center gap-2 rounded-md border-2 border-[#f2c14e]/60 bg-[#1a1408]/80 px-4 py-2 font-vt text-lg text-[#ffe08a] backdrop-blur-sm">
        <CoinIcon size={18} />
        Press <b className="mx-1 rounded border border-[#f2c14e]/50 bg-[#f2c14e]/15 px-1.5 text-[#ffd23e]">E</b>
        to trade with the merchant
      </div>
    </div>
  );
}

export function ShopPanel({ stats, engineRef }: { stats: HudStats; engineRef: RefObject<GameEngine | null> }) {
  const [flash, setFlash] = useState<string | null>(null);
  const [sellFlash, setSellFlash] = useState<string | null>(null);
  const [hoverItem, setHoverItem] = useState<string | null>(null);
  const [hoverSellSlot, setHoverSellSlot] = useState<string | null>(null);

  const isSell = stats.shopSellOpen;

  const stockedItems = stats.shopStock.length > 0
    ? stats.shopStock.map((s) => ({
        stock: s,
        item: SHOP_ITEMS.find((i) => i.id === s.itemId)!,
      })).filter((s) => s.item)
    : SHOP_ITEMS.map((item) => ({
        stock: { itemId: item.id, quantity: 999, maxQuantity: 999 },
        item,
      }));

  const pulse = (setter: typeof setFlash, key: string) => {
    setter(key);
    window.setTimeout(() => setter((f) => (f === key ? null : f)), 280);
  };
  const buy = (id: string) => { if (engineRef.current?.buyShopItem(id)) pulse(setFlash, id); };
  const sellItem = (ref: { isHotbar: boolean; index: number }, amount: number) => {
    if (engineRef.current?.sellShopItem(ref, amount))
      pulse(setSellFlash, `${ref.isHotbar ? 'h' : 'm'}${ref.index}`);
  };

  const hoveredEntry = hoverItem ? SHOP_ITEMS.find((i) => i.id === hoverItem) ?? null : null;

  const sellableInventory = (() => {
    const inv = engineRef.current?.inventory;
    if (!inv) return [];
    type SellEntry = { ref: { isHotbar: boolean; index: number }; item: Exclude<SlotItem, { kind: 'weapon' }>; pricePerUnit: number; totalValue: number };
    const result: SellEntry[] = [];
    const addItem = (it: SlotItem, isHotbar: boolean, index: number) => {
      if (it.kind === 'weapon') return;
      const pricePerUnit = it.kind === 'block' ? getBlockSellPrice(it.blockId) : getFoodSellPrice(it.foodId);
      if (pricePerUnit <= 0) return;
      result.push({ ref: { isHotbar, index }, item: it, pricePerUnit, totalValue: pricePerUnit * it.count });
    };
    inv.mainInv.forEach((it, i) => { if (it) addItem(it, false, i); });
    inv.hotbar.forEach((it, i) => { if (it) addItem(it, true, i); });
    return result;
  })();

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) engineRef.current?.closeShop(); }}>
      <div className="mc-book px-5 pt-4 pb-5 w-[min(780px,94vw)] relative">
        <button onClick={() => engineRef.current?.closeShop()}
          className="absolute top-3 right-3 text-white/50 hover:text-white cursor-pointer z-10">
          <X size={14} />
        </button>

        <div className="flex items-center justify-center gap-2 mb-2">
          <CoinIcon size={16} />
          <span className="px-font px-shadow text-[12px] text-white tracking-widest">
            {stats.shopMerchantName?.toUpperCase() ?? 'MERCHANT'}
          </span>
        </div>

        <div className="flex gap-1 mb-2">
          <button
            onClick={() => engineRef.current?.toggleShopSell(false)}
            className={`px-font text-[9px] tracking-wider px-4 py-1.5 rounded-sm cursor-pointer transition-all flex items-center gap-1.5
              ${!isSell ? 'bg-[#ffd23e]/20 text-[#ffd23e] border border-[#ffd23e]/40' : 'bg-white/5 text-white/40 border border-white/10 hover:text-white/60'}`}>
            <Package size={11} /> BUY
          </button>
          <button
            onClick={() => engineRef.current?.toggleShopSell(true)}
            className={`px-font text-[9px] tracking-wider px-4 py-1.5 rounded-sm cursor-pointer transition-all flex items-center gap-1.5
              ${isSell ? 'bg-[#6dc24a]/20 text-[#6dc24a] border border-[#6dc24a]/40' : 'bg-white/5 text-white/40 border border-white/10 hover:text-white/60'}`}>
            <ArrowDownUp size={11} /> SELL
          </button>
        </div>

        <div className="mc-book-slot flex items-center justify-center gap-3 px-3 py-1.5 mb-2 rounded-sm">
          <div className="flex items-center gap-2">
            <CoinIcon size={16} />
            <span className="px-font px-shadow-sm text-[10px] text-[#ffd23e] tracking-wider">YOUR PURSE</span>
          </div>
          <div className="w-px h-4 bg-white/15" />
          <span className="px-font px-shadow text-[16px] text-[#ffe08a] tabular-nums">{stats.coins}</span>
          <span className="px-font text-[6px] text-white/35">COINS</span>
        </div>

        <div className="h-8 px-2 flex items-center mc-book-slot overflow-hidden mb-2 rounded-sm">
          {!isSell && hoveredEntry ? (
            <div className="flex items-center gap-2 truncate">
              <Package size={11} className="text-[#8ab4ff] flex-shrink-0" />
              <span className="px-font text-[8px] text-white truncate">{hoveredEntry.name}</span>
              <span className="px-font text-[7px] text-white/50">×{hoveredEntry.goods.count}</span>
              <span className="px-font text-[6px] text-white/30 ml-1 truncate">{hoveredEntry.desc}</span>
            </div>
          ) : !isSell ? (
            <span className="px-font text-[7px] text-white/30">HOVER TO INSPECT · CLICK TO BUY</span>
          ) : hoverSellSlot ? (
            <span className="px-font text-[7px] text-white/50">LEFT-CLICK SELL 1 · RIGHT-CLICK SELL ALL</span>
          ) : (
            <span className="px-font text-[7px] text-white/30">CLICK AN ITEM TO SELL IT FOR COINS</span>
          )}
        </div>

        <div className="mc-book-slot p-2 h-[320px] overflow-y-auto scroll-shop space-y-1 rounded-sm">
          {!isSell ? (
            stockedItems.map(({ item, stock }) => {
              const affordable = stats.coins >= item.price;
              const isFlash = flash === item.id;
              const soldOut = stock.quantity <= 0;
              return (
                <button
                  key={item.id}
                  onClick={() => !soldOut && buy(item.id)}
                  onMouseEnter={() => setHoverItem(item.id)}
                  onMouseLeave={() => setHoverItem((h) => (h === item.id ? null : h))}
                  disabled={!affordable || soldOut}
                  className={`w-full text-left flex items-center gap-3 px-2 py-2 rounded-sm border transition-all duration-75
                    ${isFlash ? 'bg-[#3f5a34]/70 border-[#5a8c54]/60' : 'bg-white/[0.03] border-white/10 hover:bg-white/[0.08] hover:border-white/25'}
                    ${soldOut ? 'opacity-30 cursor-not-allowed grayscale' : ''}
                    ${!soldOut && !affordable ? 'opacity-45 cursor-not-allowed' : ''}`}
                >
                  <div className="w-9 h-9 flex items-center justify-center flex-shrink-0 mc-book-slot rounded-sm">
                    <ShopItemIcon item={item} size={24} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="px-font text-[8px] text-white truncate">{item.name}</span>
                      <span className="px-font text-[7px] text-white/40">×{item.goods.count}</span>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="px-font text-[6px] text-white/40 truncate">{item.desc}</span>
                      <span className="px-font text-[6px] text-white/30">· stock: {soldOut ? '0' : stock.quantity}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <div className="flex items-center gap-0.5 bg-[#1a1408]/80 px-1.5 py-0.5 rounded-sm border border-white/10">
                      <CoinIcon size={8} />
                      <span className={`px-font text-[7px] ${affordable ? 'text-[#ffd23e]' : 'text-[#ff5347]'}`}>{item.price}</span>
                    </div>
                    <span className="px-font text-[6px] text-white/30">BUY</span>
                  </div>
                </button>
              );
            })
          ) : (
            sellableInventory.length === 0 ? (
              <div className="flex items-center justify-center py-10">
                <span className="px-font text-[8px] text-white/30">NO SELLABLE ITEMS — MINE BLOCKS OR GATHER FOOD</span>
              </div>
            ) : (
              sellableInventory.map(({ ref, item, pricePerUnit, totalValue }) => {
                const key = `${ref.isHotbar ? 'h' : 'm'}${ref.index}`;
                const isFlashing = sellFlash === key;
                const name = item.kind === 'block'
                  ? (BLOCK_NAMES[item.blockId] ?? `Block #${item.blockId}`)
                  : (FOODS[item.foodId]?.name ?? item.foodId);
                const icon = item.kind === 'block'
                  ? <BlockIcon blockId={item.blockId} size={20} />
                  : <DrumstickIcon size={20} />;
                return (
                  <div key={key} className="flex items-center gap-3 px-2 py-2 rounded-sm border bg-white/[0.03] border-white/10">
                    <div className="w-9 h-9 flex items-center justify-center flex-shrink-0 mc-book-slot rounded-sm">
                      {icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="px-font text-[8px] text-white truncate">{name}</span>
                        <span className="px-font text-[7px] text-white/40">×{item.count}</span>
                      </div>
                      <div className="flex items-center gap-1 mt-0.5">
                        <CoinIcon size={7} />
                        <span className="px-font text-[7px] text-[#ffd23e]">{pricePerUnit}/ea</span>
                        <span className="px-font text-[6px] text-white/30">=</span>
                        <CoinIcon size={7} />
                        <span className="px-font text-[7px] text-[#6dc24a]">{totalValue}</span>
                      </div>
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); sellItem(ref, 1); }}
                        onMouseEnter={() => setHoverSellSlot(key)}
                        onMouseLeave={() => setHoverSellSlot(null)}
                        className={`px-font text-[7px] px-2 py-1 rounded-sm border cursor-pointer transition-all
                          ${isFlashing ? 'bg-[#6dc24a]/30 border-[#6dc24a]/50 text-[#6dc24a]' : 'bg-white/5 border-white/15 text-white/60 hover:bg-[#6dc24a]/15 hover:border-[#6dc24a]/30 hover:text-[#6dc24a]'}`}
                      >+{pricePerUnit}</button>
                      {item.count > 1 && (
                        <button
                          onClick={(e) => { e.stopPropagation(); sellItem(ref, 0); }}
                          onMouseEnter={() => setHoverSellSlot(key)}
                          onMouseLeave={() => setHoverSellSlot(null)}
                          className={`px-font text-[7px] px-2 py-1 rounded-sm border cursor-pointer transition-all
                            ${isFlashing ? 'bg-[#6dc24a]/30 border-[#6dc24a]/50 text-[#6dc24a]' : 'bg-white/5 border-white/15 text-white/60 hover:bg-[#6dc24a]/15 hover:border-[#6dc24a]/30 hover:text-[#6dc24a]'}`}
                        >ALL +{totalValue}</button>
                      )}
                    </div>
                  </div>
                );
              })
            )
          )}
        </div>

        <div className="flex items-center gap-4 mt-2 px-font px-shadow-sm text-[7px] text-white/55">
          <span className="flex items-center gap-1.5"><span className="mc-book-key !text-[#ff5347]">ESC</span> EXIT</span>
          {!isSell && <span className="flex items-center gap-1.5"><span className="mc-book-key">CLICK</span> BUY</span>}
          {isSell && <>
            <span className="flex items-center gap-1.5"><span className="mc-book-key">CLICK</span> SELL 1</span>
            <span className="flex items-center gap-1.5"><span className="mc-book-key">RIGHT-CLICK</span> SELL ALL</span>
          </>}
        </div>
      </div>
    </div>
  );
}
