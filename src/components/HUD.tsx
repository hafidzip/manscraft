/**
 * VOXELCRAFT — unified HUD. The inventory overlay, hotbar, hearts and pixel
 * icons match the original voxel-fps shell; the Minecraft stat chips, pilot
 * readout and ship prompt are layered on top for the unified game.
 */

import { useEffect, useState, type RefObject } from 'react';
import {
  ChevronUp, Hammer,
  Rocket, Shield, Swords, X, Package, Apple, ArrowRight, Flame,
  ArrowDownUp,
} from 'lucide-react';
import type { GameEngine, HotbarItem, HudStats } from '../game/engine';
import { SHOP_ITEMS, getBlockSellPrice, getFoodSellPrice } from '../game/fps/shop';
import { RECIPES, RECIPE_GROUPS, matchCraft, recipeIngredients, type Recipe, type RecipeGroupId } from '../game/crafting/recipes';
import { smeltResult, isFuel } from '../game/crafting/smelting';
import { B } from '../game/fps/World';
import { tileUV, T, atlasDataUrl, drumstickDataUrl } from '../game/fps/textures';
import type { SlotRef, SlotItem } from '../game/fps/Inventory';
import { BLOCK_NAMES, FOODS } from '../game/fps/Inventory';

export interface HudProps {
  phase: 'loading' | 'ready';
  locked: boolean;
  hasPlayed: boolean;
  /**
   * True only for the app's very first boot. The full VOXELCRAFT title screen
   * belongs to that moment alone — warm planet/space re-entries drop straight
   * into the world with (at most) a tiny "resume control" chip.
   */
  coldStart: boolean;
  progress: number;
  label: string;
  selected: number;
  items: HotbarItem[];
  stats: HudStats | null;
  seed: number;
  onPlay: () => void;
  onCloseInventory: () => void;
  engineRef: RefObject<GameEngine | null>;
}

const TIPS = [
  'Did you know? Every texture is painted by code.',
  'Tip: hold Shift to sprint across the plains.',
  'Tip: 1-6 swap weapons and tools.',
  'The world is generated from a single random seed.',
  'Mined blocks stack into your inventory — drag them onto the hotbar.',
  'Rockets turn mountains into inventory.',
];

// ---------------------------------------------------------- pixel weapon icons
type Rect = [number, number, number, number, string];
const ICONS: Record<string, Rect[]> = {
  handgun: [
    [5, 4, 13, 2, '#3a3f47'], [17, 3, 1, 1, '#dfe8d8'],
    [5, 6, 9, 2, '#22252b'], [9, 8, 5, 1, '#22252b'],
    [6, 8, 3, 4, '#8a7350'], [5, 12, 4, 1, '#22252b'],
  ],
  smg: [
    [4, 5, 15, 3, '#2c2e33'], [19, 6, 3, 1, '#22252b'],
    [1, 5, 3, 2, '#22252b'], [10, 8, 3, 5, '#3a3f47'],
    [6, 8, 2, 3, '#3a3f47'], [12, 4, 1, 1, '#ff3b30'], [17, 4, 1, 1, '#22252b'],
  ],
  rifle: [
    [4, 5, 16, 2, '#22252b'], [14, 5, 6, 3, '#2c2e33'],
    [20, 6, 2, 1, '#22252b'], [22, 5, 1, 3, '#3a3f47'],
    [5, 3, 3, 2, '#22252b'], [18, 3, 1, 2, '#22252b'],
    [11, 7, 3, 4, '#3a3f47'], [1, 4, 3, 3, '#2c2e33'], [7, 7, 2, 3, '#3a3f47'],
  ],
  sniper: [
    [3, 6, 19, 1, '#22252b'], [22, 5, 2, 3, '#3a3f47'],
    [5, 5, 9, 3, '#565b3c'], [8, 3, 8, 2, '#22252b'],
    [7, 2, 2, 2, '#22252b'], [1, 5, 4, 3, '#565b3c'],
    [8, 8, 4, 2, '#3a3f47'], [12, 4, 2, 1, '#3a3f47'],
  ],
  bazooka: [
    [2, 6, 18, 4, '#5d6142'], [20, 5, 3, 6, '#5d6142'],
    [23, 6, 1, 4, '#33352a'], [0, 5, 2, 7, '#33352a'],
    [8, 10, 2, 3, '#6e4f30'], [6, 4, 6, 2, '#6e4f30'],
  ],
  laser: [
    [3, 5, 12, 4, '#3a4148'], [4, 3, 9, 2, '#2c3238'],
    [15, 5, 5, 4, '#4d565f'], [20, 4, 2, 6, '#23282e'],
    [8, 6, 4, 2, '#ffb060'], [5, 9, 3, 5, '#4a3b28'],
    [22, 6, 2, 2, '#ff5a1e'],
  ],
};

function WeaponIcon({ id, size = 46 }: { id: string; size?: number }) {
  const rects = ICONS[id] ?? ICONS.rifle;
  return (
    <svg width={size} height={size * 0.58} viewBox="0 0 24 14" className="icon-pixel" style={{ imageRendering: 'pixelated' }} shapeRendering="crispEdges">
      {rects.map((r, i) => (
        <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={r[4]} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------- block + food icons
/** Face tile for each block (matches the world's side texture). */
function blockTile(blockId: number): number {
  switch (blockId) {
    case B.GRASS: return T.GRASS_SIDE;
    case B.DIRT: return T.DIRT;
    case B.STONE: return T.STONE;
    case B.SAND: return T.SAND;
    case B.SANDSTONE: return T.SANDSTONE;
    case B.LOG: return T.LOG_SIDE;
    case B.LEAVES: return T.LEAVES;
    case B.CACTUS: return T.CACTUS_SIDE;
    case B.PLANK: return T.PLANK;
    case B.ORE: return T.ORE;
    case B.COBBLE: return T.COBBLE;
    case B.WOOL: return T.TARGET_WOOL;
    case B.CRAFTING_TABLE: return T.CRAFT_TOP;
    case B.GLASS: return T.GLASS;
    case B.FURNACE: return T.FURNACE;
    // gemstone ores (fps ids 50-57)
    case 50: return T.ORE_RUBY;
    case 51: return T.ORE_AMBER;
    case 52: return T.ORE_LUMI;
    case 53: return T.ORE_DIAMOND;
    case 54: return T.ORE_GOLD;
    case 55: return T.ORE_SILVER;
    case 56: return T.ORE_JADE;
    case 57: return T.ORE_EMERALD;
    case B.COAL: return T.COAL;
    case B.STICK: return T.STICK;
    case B.TORCH: return T.TORCH;
    default: return T.STONE;
  }
}

function BlockIcon({ blockId, size = 22 }: { blockId: number; size?: number }) {
  // Atlas is built + encoded once at module scope (see atlasDataUrl in textures.ts).
  // The previous `useMemo(() => buildAtlas().image.toDataURL(), [])` rebuilt the
  // entire 128×224 procedural atlas per icon mount — freezing the menu open.
  const url = atlasDataUrl();
  const [u0, v0, u1, v1] = tileUV(blockTile(blockId));
  const tu0 = Math.min(u0, u1), tu1 = Math.max(u0, u1);
  const tv0 = Math.min(v0, v1), tv1 = Math.max(v0, v1);
  const w = tu1 - tu0, h = tv1 - tv0;
  return (
    <div
      className="rounded-sm icon-pixel"
      style={{
        width: size, height: size,
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${100 / w}% ${100 / h}%`,
        backgroundPosition: `${(tu0 / (1 - w)) * 100}% ${((1 - tv1) / (1 - h)) * 100}%`,
        imageRendering: 'pixelated',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.55), inset 2px 2px 0 rgba(255,255,255,0.18), inset -2px -2px 0 rgba(0,0,0,0.28)',
      }}
    />
  );
}

function DrumstickIcon({ size = 26 }: { size?: number }) {
  // Cached at module scope — see drumstickDataUrl in textures.ts.
  const url = drumstickDataUrl();
  return (
    <img src={url} width={size} height={size} alt="Chicken Drum"
      style={{ imageRendering: 'pixelated', filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.6))' }}
      draggable={false} />
  );
}

const WEAPON_TITLES: Record<string, string> = {
  handgun: "P9 'SIDEKICK'", smg: "KV-9 'HORNET'", rifle: "AR-77 'SENTINEL'",
  sniper: "LW-50 'LONGSTAR'", bazooka: "RPG-9 'HAMMER'", laser: "MK-7 'PROSPECTOR'",
};

function itemName(item: SlotItem | null): string {
  if (!item) return '';
  if (item.kind === 'weapon') return WEAPON_TITLES[item.weaponId] ?? item.weaponId;
  if (item.kind === 'block') return BLOCK_NAMES[item.blockId] ?? `Block #${item.blockId}`;
  return FOODS[item.foodId]?.name ?? item.foodId;
}

// ---------------------------------------------------------- slot renderer
interface RenderSlotItemProps {
  item: SlotItem | null;
  hovered?: boolean;
}

function RenderSlotItem({ item, hovered }: RenderSlotItemProps) {
  if (!item) return null;
  const hot = hovered ? 'brightness(1.35)' : 'none';
  if (item.kind === 'weapon') {
    return <div style={{ filter: hot }}><WeaponIcon id={item.weaponId} size={38} /></div>;
  }
  if (item.kind === 'block') {
    return (
      <div className="flex flex-col items-center justify-center relative w-full h-full" style={{ filter: hot }}>
        <BlockIcon blockId={item.blockId} size={22} />
        <span className="absolute bottom-0 right-0.5 px-font text-[8px] text-white px-shadow">{item.count}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center relative w-full h-full" style={{ filter: hot }}>
      <DrumstickIcon size={24} />
      <span className="absolute bottom-0 right-0.5 px-font text-[8px] text-white px-shadow">{item.count}</span>
    </div>
  );
}

// ---------------------------------------------------------- pixel hearts
const HEART_GRID = [
  '.XX.XX.',
  'XXXXXXX',
  'XXXXXXX',
  'XXXXXXX',
  '.XXXXX.',
  '..XXX..',
  '...X...',
];

function PixelHeart({ mode = 'full' }: { mode?: 'full' | 'half' | 'empty' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 7 7" shapeRendering="crispEdges">
      {HEART_GRID.flatMap((row, y) =>
        row.split('').map((c, x) => {
          if (c !== 'X') return null;
          const half = mode === 'half' && x < 3.5;
          const fill = mode === 'full' || half ? '#e52521' : mode === 'half' ? '#4a1210' : '#3a1512';
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} stroke="#000" strokeWidth={0.08} />;
        })
      )}
    </svg>
  );
}

// ---------------------------------------------------------- pieces kept from the minecraft HUD
const LABELS: Record<string, string> = { handgun: 'P9', smg: 'KV-9', rifle: 'AR-77', sniper: 'LW-50', bazooka: 'RPG-9', laser: 'MK-7' };

/** cockpit readout while flying */
function PilotChip({ stats }: { stats: HudStats }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-20 flex flex-col items-center gap-2">
      <div className="flex items-center gap-4 rounded-md border-2 border-cyan-400/40 bg-slate-950/70 px-4 py-2 font-vt text-lg leading-none text-cyan-200 backdrop-blur-sm">
        <Rocket className="h-4 w-4 text-cyan-300" />
        <span className="text-cyan-50">{stats.shipSpeed} b/s</span>
        <span className="text-white/40">|</span>
        <span>ALT {stats.shipAlt}</span>
        <span className="text-white/40">|</span>
        <span className="text-cyan-300/90">ION DRIVE</span>
      </div>
      <p className="font-vt text-base leading-none text-white/75">
        <b className="text-white/90">W/S</b> thrust · <b className="text-white/90">A/D</b> strafe ·{' '}
        <b className="text-white/90">Space</b> rise · <b className="text-white/90">Shift</b> drop ·{' '}
        <b className="text-cyan-300">E</b> disembark
      </p>
    </div>
  );
}

/** "press E to board" proximity prompt */
function BoardPrompt() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-1/3 z-20 flex justify-center">
      <div className="flex animate-pulse items-center gap-2 rounded-md border border-cyan-300/50 bg-slate-950/70 px-4 py-2 font-vt text-lg text-cyan-100 backdrop-blur-sm">
        <Rocket className="h-4 w-4 text-cyan-300" />
        Press <b className="mx-1 rounded border border-white/40 bg-white/10 px-1.5 text-white">E</b> to board the spaceship
      </div>
    </div>
  );
}

// ---------------------------------------------------------- merchant economy
/** Pixel-art gold coin used across the purse, the shop and item prices. */
function CoinIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" style={{ imageRendering: 'pixelated' }} shapeRendering="crispEdges">
      <rect x="2" y="0" width="6" height="10" fill="#f2c14e" />
      <rect x="0" y="2" width="10" height="6" fill="#f2c14e" />
      <rect x="1" y="1" width="8" height="8" fill="#f2c14e" />
      <rect x="3" y="2" width="4" height="6" fill="#ffe08a" />
      <rect x="2" y="3" width="6" height="4" fill="#ffe08a" />
      <rect x="4" y="3" width="2" height="4" fill="#b8860b" />
      <rect x="3" y="4" width="4" height="2" fill="#b8860b" />
    </svg>
  );
}

/** Render a shop item's icon — block texture tile or drumstick for food */
function ShopItemIcon({ item, size = 32 }: { item: typeof SHOP_ITEMS[0]; size?: number }) {
  if (item.goods.kind === 'food') return <DrumstickIcon size={size} />;
  return <BlockIcon blockId={item.goods.blockId} size={size} />;
}

/** "press E to trade" prompt above an idle merchant */
function TradePrompt() {
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

/** full merchant shop overlay — styled to match the crafting/furnace mc-book panels */
function ShopPanel({ stats, engineRef }: { stats: HudStats; engineRef: RefObject<GameEngine | null> }) {
  const [flash, setFlash] = useState<string | null>(null);
  const [sellFlash, setSellFlash] = useState<string | null>(null);
  const [hoverItem, setHoverItem] = useState<string | null>(null);
  const [hoverSellSlot, setHoverSellSlot] = useState<string | null>(null);

  const isSell = stats.shopSellOpen;

  // ----- BUY tab: only show stocked items
  const stockedItems = stats.shopStock.length > 0
    ? stats.shopStock.map((s) => ({
        stock: s,
        item: SHOP_ITEMS.find((i) => i.id === s.itemId)!,
      })).filter((s) => s.item)
    : SHOP_ITEMS.map((item) => ({
        stock: { itemId: item.id, quantity: 999, maxQuantity: 999 },
        item,
      }));

  const buy = (id: string) => {
    const ok = engineRef.current?.buyShopItem(id);
    if (ok) {
      setFlash(id);
      window.setTimeout(() => setFlash((f) => (f === id ? null : f)), 280);
    }
  };

  // ----- SELL tab: sell from inventory
  const sellItem = (ref: { isHotbar: boolean; index: number }, amount: number) => {
    const ok = engineRef.current?.sellShopItem(ref, amount);
    if (ok) {
      const key = `${ref.isHotbar ? 'h' : 'm'}${ref.index}`;
      setSellFlash(key);
      window.setTimeout(() => setSellFlash((f) => (f === key ? null : f)), 280);
    }
  };

  const hoveredEntry = hoverItem ? SHOP_ITEMS.find((i) => i.id === hoverItem) ?? null : null;

  // Build sellable items from inventory
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

        {/* title */}
        <div className="flex items-center justify-center gap-2 mb-2">
          <CoinIcon size={16} />
          <span className="px-font px-shadow text-[12px] text-white tracking-widest">
            {stats.shopMerchantName?.toUpperCase() ?? 'MERCHANT'}
          </span>
        </div>

        {/* Buy / Sell tabs */}
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

        {/* Coin info — right after tabs */}
        <div className="mc-book-slot flex items-center justify-center gap-3 px-3 py-1.5 mb-2 rounded-sm">
          <div className="flex items-center gap-2">
            <CoinIcon size={16} />
            <span className="px-font px-shadow-sm text-[10px] text-[#ffd23e] tracking-wider">YOUR PURSE</span>
          </div>
          <div className="w-px h-4 bg-white/15" />
          <span className="px-font px-shadow text-[16px] text-[#ffe08a] tabular-nums">{stats.coins}</span>
          <span className="px-font text-[6px] text-white/35">COINS</span>
        </div>

        {/* tooltip strip */}
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

        {/* List content with custom scrollbar */}
        <div className="mc-book-slot p-2 h-[320px] overflow-y-auto scroll-shop space-y-1 rounded-sm">
          {!isSell ? (
            /* BUY list — list layout like sell tab */
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
                  {/* icon */}
                  <div className="w-9 h-9 flex items-center justify-center flex-shrink-0 mc-book-slot rounded-sm">
                    <ShopItemIcon item={item} size={24} />
                  </div>
                  {/* info */}
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
                  {/* price + buy */}
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
            /* SELL list */
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

        {/* bottom key hints */}
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

function LoadingScreen({ progress, label }: { progress: number; label: string }) {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#0b0e14]">
      <h2 className="px-font px-shadow text-center text-3xl leading-relaxed text-white md:text-5xl">
        VOXEL<span className="text-[#ffd23e]">CRAFT</span>
      </h2>
      <div className="mt-10 w-72 md:w-96">
        <p className="px-font px-shadow-sm text-[10px] text-white/80">{label}…</p>
        <div className="mt-2 h-5 rounded-sm border-2 border-black bg-neutral-800 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
          <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-2 text-right px-font text-[10px] text-emerald-300">{Math.round(progress * 100)}%</p>
      </div>
      <p className="mt-10 max-w-md px-6 text-center font-vt text-lg leading-tight text-white/50">{tip}</p>
    </div>
  );
}

// ---------------------------------------------------------- app
export function HUD({ phase, locked, hasPlayed, coldStart, progress, label, stats, onPlay, onCloseInventory, engineRef }: HudProps) {
  const playing = phase === 'ready' && locked;

  // The pause/title menu only appears after the "unlocked, no modal" state
  // has settled for a beat. Pointer-lock release and modal flags land on
  // React at slightly different times; without this delay, closing the
  // inventory (or opening it before first deploy) flashes the title screen.
  const unlockedIdle = phase === 'ready' && !locked
    && !stats?.inventoryOpen && !stats?.craftingOpen && !stats?.furnaceOpen && !stats?.shopOpen;
  const [menuReady, setMenuReady] = useState(false);
  useEffect(() => {
    if (!unlockedIdle) { setMenuReady(false); return; }
    const t = setTimeout(() => setMenuReady(true), 130);
    return () => clearTimeout(t);
  }, [unlockedIdle]);
  // The big branded title screen is a once-per-session moment (cold boot) or
  // the ESC pause after you've already deployed. Warm planet re-entries
  // (hasPlayed still false, coldStart false) get only the slim resume chip.
  const showMenu = unlockedIdle && menuReady && (coldStart || hasPlayed);

  // Warm re-entry chip: delayed a beat so the silent auto pointer-lock
  // (fired ~120 ms after ready) wins the race and the chip never flashes.
  const wantPrompt = unlockedIdle && !coldStart && !hasPlayed;
  const [promptReady, setPromptReady] = useState(false);
  useEffect(() => {
    if (!wantPrompt) { setPromptReady(false); return; }
    const t = setTimeout(() => setPromptReady(true), 450);
    return () => clearTimeout(t);
  }, [wantPrompt]);
  const game = () => engineRef.current;

  // inventory UI state
  const [selectedSlot, setSelectedSlot] = useState<SlotRef | null>(null);
  const [hoverSlot, setHoverSlot] = useState<SlotRef | null>(null);
  const [dragItem, setDragItem] = useState<{ item: SlotItem; from: SlotRef } | null>(null);
  const [, setInvSeq] = useState(0);
  const refreshInv = () => setInvSeq((s) => s + 1);

  // console recipe-book selection (persists across open/close)
  const [bookGroup, setBookGroup] = useState<RecipeGroupId>('building');
  const [bookSel, setBookSel] = useState<string | null>(null);
  const [bookFlash, setBookFlash] = useState(0);

  /** slot identity across the three banks (hotbar / storage / craft grid) */
  const sameRef = (a: SlotRef, b: SlotRef) =>
    a.isHotbar === b.isHotbar && !!a.isCraft === !!b.isCraft && a.index === b.index;

  const commitSwap = (from: SlotRef, to: SlotRef) => {
    const g = game();
    if (!g) return;
    g.inventory.swapSlots(from, to);
    g.syncHotbarMode();
    refreshInv();
  };

  const handleSlotClick = (ref: SlotRef) => {
    const g = game();
    if (!g) return;
    if (selectedSlot && sameRef(selectedSlot, ref)) {
      setSelectedSlot(null);
      return;
    }
    if (!selectedSlot) {
      if (g.inventory.getItem(ref)) setSelectedSlot(ref);
      return;
    }
    commitSwap(selectedSlot, ref);
    setSelectedSlot(null);
  };

  const onSlotDrop = (to: SlotRef) => {
    if (dragItem) {
      commitSwap(dragItem.from, to);
      setDragItem(null);
    } else if (selectedSlot) {
      commitSwap(selectedSlot, to);
      setSelectedSlot(null);
    }
  };

  const hoverItem = hoverSlot ? game()?.inventory.getItem(hoverSlot) ?? null : null;
  const selItem = selectedSlot ? game()?.inventory.getItem(selectedSlot) ?? null : null;

  const slotProps = (ref: SlotRef) => {
    const item = game()?.inventory.getItem(ref) ?? null;
    const isSel = !!selectedSlot && sameRef(selectedSlot, ref);
    const isHov = !!hoverSlot && sameRef(hoverSlot, ref);
    return {
      draggable: !!item,
      onClick: () => handleSlotClick(ref),
      onDragStart: (e: React.DragEvent) => {
        if (!item) { e.preventDefault(); return; }
        setDragItem({ item, from: ref });
        e.dataTransfer.effectAllowed = 'move';
        const ghost = document.createElement('div');
        ghost.style.width = '1px'; ghost.style.height = '1px';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      },
      onDragEnd: () => setDragItem(null),
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      onDrop: (e: React.DragEvent) => { e.preventDefault(); onSlotDrop(ref); },
      onMouseEnter: () => setHoverSlot(ref),
      onMouseLeave: () => setHoverSlot((h) => (h && sameRef(h, ref)) ? null : h),
      className: `mc-slot relative flex items-center justify-center cursor-pointer transition-all duration-75
        ${isSel ? 'mc-slot-active !outline-[#ffd23e] scale-110 z-10' : ''}
        ${isHov && item ? '!bg-[#5a6070]/90' : ''}
        ${dragItem && item ? 'opacity-40' : ''}`,
    };
  };

  /** click a recipe chip: pull ingredients from inventory into the grid */
  const fillRecipe = (r: Recipe) => {
    const g = game();
    if (!g) return;
    const inv = g.inventory;
    if (r.grid === 3 && !inv.setCraftSize(3)) return;
    const size = inv.craftSize;

    // required block id per active cell (centered shaped patterns)
    const need: (number | null)[] = Array(size * size).fill(null);
    if (r.shaped) {
      const off = Math.floor((size - r.shaped.length) / 2);
      r.shaped.forEach((row, y) => row.forEach((ing, x) => {
        if (ing) need[(y + off) * size + (x + off)] = ing.blockId;
      }));
    } else {
      r.shapeless!.forEach((ing, i) => { need[i] = ing.blockId; });
    }

    // feasibility: enough of every ingredient across hotbar + storage?
    const req = new Map<number, number>();
    for (const id of need) if (id != null) req.set(id, (req.get(id) ?? 0) + 1);
    const avail = new Map<number, number>();
    for (const arr of [inv.hotbar, inv.mainInv]) for (const s of arr)
      if (s && s.kind === 'block') avail.set(s.blockId, (avail.get(s.blockId) ?? 0) + s.count);
    for (const [id, n] of req) if ((avail.get(id) ?? 0) < n) return;

    // return whatever is in the grid first
    for (let i = 0; i < size * size; i++) {
      const it = inv.craft[i];
      if (it) {
        if (!inv.addItem(it)) { inv.craft[i] = it; return; } // no room — abort
        inv.craft[i] = null;
      }
    }
    // pull one of each required block into its cell
    for (let i = 0; i < size * size; i++) {
      const id = need[i];
      if (id == null) continue;
      for (const arr of [inv.hotbar, inv.mainInv]) {
        for (let k = 0; k < arr.length; k++) {
          const s = arr[k];
          if (s && s.kind === 'block' && s.blockId === id && s.count > 0) {
            s.count -= 1;
            if (s.count <= 0) arr[k] = null;
            inv.craft[i] = { kind: 'block', blockId: id, count: 1 };
            break;
          }
        }
        if (inv.craft[i]) break;
      }
    }
    refreshInv();
  };

  // hitmarker flash
  const [hitFlash, setHitFlash] = useState(0);
  useEffect(() => {
    if (!stats || stats.hitSeq === 0) return;
    setHitFlash(stats.hitSeq);
    const t = setTimeout(() => setHitFlash(0), 130);
    return () => clearTimeout(t);
  }, [stats?.hitSeq]);

  const spread = Math.round(stats?.spread ?? 8);
  const lowAmmo = (stats?.ammo ?? 0) >= 0 && (stats?.ammo ?? 0) <= Math.ceil((stats?.mag ?? 1) * 0.25);
  const isFoodHud = stats?.toolMode === 'food';
  const toolLabel = stats ? LABELS[stats.weaponId] ?? (isFoodHud ? 'FOOD' : stats.heldBlockId !== null ? 'BLOCK' : 'MK-7') : '';

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* vignette + underwater tint */}
      <div className="vignette z-10" />
      {stats?.underwater && playing && (
        <div className="pointer-events-none absolute inset-0 z-10 bg-blue-600/25" />
      )}
      {playing && stats && stats.hp > 0 && stats.hp <= 30 && !stats.dead && <div className="lowhp-vignette z-30" />}

      {/* damage feedback */}
      {(stats?.damageSeq ?? 0) > 0 && <div key={stats!.damageSeq} className="dmg-vignette z-30" />}

      {/* directional hit marker: chevron rotates around the reticle to point
          back at whoever just landed a shot, remounted on every new hit */}
      {stats && stats.damageSeq > 0 && !stats.dead && (
        <div
          key={`dmg-dir-${stats.damageSeq}`}
          className="dmg-dir"
          style={{ transform: `rotate(${((stats.dmgAngle ?? 0) * 180) / Math.PI}deg)` }}
        >
          <ChevronUp className="dmg-dir-arrow" size={56} strokeWidth={3.5} />
        </div>
      )}

      {/* death scene */}
      {stats?.dead && (
        <>
          <div key={`flash-${stats.damageSeq}`} className="death-flash z-40" />
          <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-7 death-overlay pointer-events-none"
            style={{ background: 'radial-gradient(ellipse at center, rgba(70,5,5,0.5) 0%, rgba(12,2,2,0.92) 100%)' }}>
            <h2 className="px-font death-title text-[clamp(30px,7vw,64px)] text-[#c4231c]"
              style={{ textShadow: '0 0 22px rgba(200,20,16,0.55), 3px 3px 0 #000' }}>
              YOU DIED
            </h2>
            <div className="death-sub flex flex-col items-center gap-5">
              <div className="px-font px-shadow-sm text-[10px] text-white/75 flex flex-wrap justify-center gap-6">
                <span>KILLS <span className="text-[#ffd23e]">{stats.kills}</span></span>
                <span>CAMPS <span className="text-white">{stats.campsCleared}/{stats.campsTotal} CLEARED</span></span>
                <span>MINED <span className="text-[#ffd23e]">{stats.blocksMined}</span></span>
              </div>
              <div className="px-font px-shadow-sm text-[11px] text-white/55">
                RESPAWNING IN <span className="text-[#ff5347]">{Math.max(1, stats.respawnIn)}</span>
              </div>
            </div>
          </div>
        </>
      )}

      {/* sniper scope overlay */}
      {stats?.scoped && locked && (
        <div className="absolute inset-0 pointer-events-none z-30 overlay-in">
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 0, transparent min(34vh, 34vw), rgba(3,3,4,0.985) calc(min(34vh, 34vw) + 2px))' }} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, rgba(120,170,255,0.10) 0, rgba(20,40,80,0.18) min(26vh,26vw), rgba(0,0,0,0.4) min(34vh,34vw))' }} />
          <div className="crosshair-line" style={{ left: 0, right: 0, top: '50%', height: 1 }} />
          <div className="crosshair-line" style={{ top: 0, bottom: 0, left: '50%', width: 1 }} />
          <div className="absolute left-1/2 top-[8%] -translate-x-1/2 px-font px-shadow text-[10px] text-white/70">4.5x</div>
        </div>
      )}

      {/* crosshair */}
      {playing && stats && !stats.dead && !stats.scoped && stats.toolMode !== 'laser' && stats.ads < 0.5 && !stats.piloting && (
        <div className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ transform: 'translate(-50%,-50%)' }}>
          <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: -(spread + 9) }} />
          <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: spread }} />
          <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: -(spread + 9) }} />
          <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: spread }} />
          <div className="crosshair-line" style={{ width: 2, height: 2, left: -1, top: -1 }} />
        </div>
      )}

      {/* hitmarker */}
      {hitFlash > 0 && (
        <div key={hitFlash} className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ animation: 'hit-pop 0.14s steps(3) forwards' }}>
          <svg width="36" height="36" viewBox="0 0 36 36" style={{ transform: 'translate(-50%,-50%)' }}>
            <path d="M8 8 L14 14 M28 8 L22 14 M8 28 L14 22 M28 28 L22 22" stroke="#fff" strokeWidth="3" />
          </svg>
        </div>
      )}

      {playing && stats && (
        <>
          {stats.piloting ? (
            <PilotChip stats={stats} />
          ) : (
            <>
              {/* weapon name toast */}
              {stats.switchAt > 0 && (
                <div key={stats.switchAt} className="absolute right-[26px] bottom-[150px] z-20 pointer-events-none fade-up px-font px-shadow text-[11px] text-[#ffd23e]">
                  {stats.weaponName}
                </div>
              )}

              {/* ammo / laser / block / food readout */}
              <div className="absolute right-4 bottom-4 z-20 pointer-events-none flex flex-col items-end gap-1">
                <div className="px-font text-[8px] px-shadow-sm text-white/60 tracking-widest">{toolLabel}</div>
                {stats.weaponId === 'laser' ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-[#ff8b4e]">
                      ∞<span className="text-[11px] text-white/50"> CELL</span>
                    </div>
                    <div className="reload-bar-track w-28 h-[10px] relative overflow-hidden mt-0.5">
                      <div className="absolute inset-y-[3px] left-[3px] bg-[#ff5a1e]"
                        style={{ width: `${(stats.mineCharge ?? 0) * 96}%`, boxShadow: '0 0 8px #ff5a1e' }} />
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-white/45 tracking-widest">HOLD LMB TO CUT</div>
                  </>
                ) : isFoodHud ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-white">
                      {stats.ammo}<span className="text-[13px] text-white/50"> x</span>
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-[#6dc24a] tracking-widest">RMB — EAT</div>
                  </>
                ) : stats.heldBlockId !== null ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-white">
                      {stats.ammo}<span className="text-[13px] text-white/50"> x</span>
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-[#ffd23e] tracking-widest">RMB — PLACE</div>
                  </>
                ) : (
                  <div className={`px-font px-shadow text-[26px] leading-none ${lowAmmo ? 'text-[#ff5347]' : 'text-white'}`}>
                    {stats.ammo}
                    <span className="text-[13px] text-white/50"> / {stats.mag}</span>
                  </div>
                )}
              </div>

              {/* hearts + hotbar stack */}
              <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 flex flex-col items-center gap-1.5 pointer-events-none">
                <div className="flex gap-[3px]">
                  {Array.from({ length: 10 }).map((_, i) => {
                    const v = Math.max(0, Math.min(10, stats.hp - i * 10));
                    const mode: 'full' | 'half' | 'empty' = v >= 10 ? 'full' : v >= 5 ? 'half' : 'empty';
                    return <PixelHeart key={i} mode={mode} />;
                  })}
                </div>

                {/* reload progress */}
                {stats.reloading && (
                  <div className="flex flex-col items-center gap-1 mb-0.5">
                    <div className="px-font px-shadow-sm text-[7px] text-[#ffd23e] px-blink">RELOADING</div>
                    <div className="reload-bar-track w-40 h-[10px] relative overflow-hidden">
                      <div className="absolute inset-y-[3px] left-[3px] bg-[#ffd23e]" style={{ width: `${Math.min(100, (stats.reloadT ?? 0) * 100) * 0.96}%` }} />
                    </div>
                  </div>
                )}

                {/* hotbar */}
                <div className="flex gap-[3px]">
                  {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => (
                    <div key={i} className={`mc-slot relative w-[50px] h-[44px] flex items-center justify-center ${stats.slot === i ? 'mc-slot-active border-[#ffd23e]' : ''}`}>
                      <RenderSlotItem item={item} />
                      <span className="absolute top-[1px] left-[3px] px-font text-[7px] text-white/50 px-shadow-sm">{i + 1}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* hints */}
              <div className="absolute left-4 bottom-4 z-20 px-font px-shadow-sm text-[8px] leading-4 text-white/55 pointer-events-none">
                <div>TAB — INVENTORY</div>
                <div>R — RELOAD</div>
                <div>F — INSPECT</div>
                <div>CTRL — CROUCH</div>
                <div>1-6 / WHEEL — SWAP</div>
                <div>E — SPACESHIP / TRADE</div>
                <div className="text-[#ff8b4e]">RMB — ADS / PLACE / EAT</div>
              </div>
            </>
          )}
          {stats.shipNear && !stats.piloting && !stats.nearMerchant && <BoardPrompt />}
          {stats.nearMerchant && !stats.shopOpen && !stats.piloting && !stats.dead && <TradePrompt />}
        </>
      )}

      {/* ============================== MERCHANT SHOP ============================== */}
      {phase === 'ready' && stats && stats.shopOpen && (
        <>
          {/* transparent overlay prevents the canvas from stealing hover/click */}
          <div className="absolute inset-0 z-30 cursor-default" />
          <ShopPanel stats={stats} engineRef={engineRef} />
        </>
      )}

      {/* ============================== INVENTORY OVERLAY (TAB) ============================== */}
      {phase === 'ready' && stats && stats.inventoryOpen && (() => {
        const inv = game()?.inventory;
        if (!inv) return null;
        // Pocket 2×2 crafting grid, always kept at size 2 in inventory
        const pocketSize = 2;
        const pocketCells = inv.craft.slice(0, 4);
        const pocketResult = matchCraft(pocketCells, pocketSize);
        const pocketOutput = pocketResult?.output ?? null;
        const takePocket = (n: number) => {
          if (!inv) return;
          // temporarily shrink to 2 so takeCraftResult sees 2×2
          const prev = inv.craftSize;
          inv.craftSize = 2;
          if (game()?.takeCraftResult(n)) refreshInv();
          inv.craftSize = prev;
        };
        const itemTip = hoverItem ?? (selItem ? selItem : dragItem?.item ?? null);
        return (
          <div className="absolute inset-0 z-50 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm">
            {/* Two-column layout: crafting on left, storage on right */}
            <div className="flex gap-3 items-start max-h-[92vh] overflow-y-auto px-4 pb-4 pt-2">

              {/* LEFT: Pocket crafting 2×2 */}
              <div className="mc-panel p-4 flex flex-col gap-3 w-[220px] flex-shrink-0">
                <div className="flex items-center gap-2 px-font text-[9px] text-[#ffd23e]">
                  <Hammer size={12} /> CRAFTING
                </div>
                {/* 2×2 grid + arrow + output */}
                <div className="flex items-center gap-3 justify-center">
                  <div className="grid grid-cols-2 gap-1.5">
                    {[0,1,2,3].map((i) => {
                      const ref: SlotRef = { isHotbar: false, index: i, isCraft: true };
                      const p = slotProps(ref);
                      return (
                        <div key={i} draggable={p.draggable}
                          className={`${p.className} w-[44px] h-[44px]`}
                          onClick={p.onClick} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
                          onDragOver={p.onDragOver} onDrop={p.onDrop}
                          onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
                          <RenderSlotItem item={pocketCells[i] ?? null} hovered={!!hoverSlot && !!hoverSlot.isCraft && hoverSlot.index === i} />
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
                {/* pocket recipe hint */}
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

              {/* RIGHT: Inventory */}
              <div className="mc-panel p-4 flex flex-col gap-3 relative">
                <button onClick={onCloseInventory}
                  className="absolute top-3 right-3 text-white/50 hover:text-white cursor-pointer">
                  <X size={14} />
                </button>
                <div className="flex items-center gap-2 px-font text-[9px] text-[#ffd23e]">
                  <Package size={12} /> INVENTORY
                </div>
                {/* tooltip strip */}
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
                {/* 3×9 storage */}
                <div className="flex flex-col gap-1">
                  <div className="px-font text-[7px] text-white/40">STORAGE</div>
                  <div className="grid grid-cols-9 gap-1.5">
                    {(game()?.inventory.mainInv ?? Array(27).fill(null)).map((item, i) => {
                      const ref: SlotRef = { isHotbar: false, index: i };
                      const p = slotProps(ref);
                      return (
                        <div key={i} draggable={p.draggable}
                          className={`${p.className} w-[44px] h-[44px]`}
                          onClick={p.onClick} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
                          onDragOver={p.onDragOver} onDrop={p.onDrop}
                          onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
                          <RenderSlotItem item={item} hovered={!!hoverSlot && !hoverSlot.isHotbar && !hoverSlot.isCraft && hoverSlot.index === i} />
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* hotbar */}
                <div className="flex flex-col gap-1 border-t border-white/10 pt-2">
                  <div className="px-font text-[7px] text-[#ffd23e]">HOTBAR</div>
                  <div className="grid grid-cols-6 gap-1.5">
                    {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => {
                      const ref: SlotRef = { isHotbar: true, index: i };
                      const p = slotProps(ref);
                      return (
                        <div key={i} draggable={p.draggable}
                          className={`${p.className} w-[44px] h-[44px] ${stats.slot === i ? '!outline-[#ffd23e]' : ''}`}
                          onClick={p.onClick} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
                          onDragOver={p.onDragOver} onDrop={p.onDrop}
                          onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
                          <span className="absolute top-0.5 left-1 px-font text-[6px] text-white/35">{i+1}</span>
                          <RenderSlotItem item={item} hovered={!!hoverSlot && hoverSlot.isHotbar && !hoverSlot.isCraft && hoverSlot.index === i} />
                        </div>
                      );
                    })}
                  </div>
                </div>
                {/* bottom row */}
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
      })()}

      {/* ================= CRAFTING TABLE — legacy console recipe book ================= */}
      {phase === 'ready' && stats && stats.craftingOpen && (() => {
        const inv = game()?.inventory;
        if (!inv) return null;
        const activeGroup = RECIPE_GROUPS.find((g) => g.id === bookGroup) ?? RECIPE_GROUPS[0];
        const list = RECIPES.filter((r) => r.group === activeGroup.id);
        const sel: Recipe | null = list.find((r) => r.id === bookSel) ?? list[0] ?? null;

        // how many of a block the player currently owns
        const countOf = (id: number) => {
          let n = 0;
          for (const arr of [inv.hotbar, inv.mainInv])
            for (const s of arr) if (s && s.kind === 'block' && s.blockId === id) n += s.count;
          return n;
        };
        // ingredient requirement of the selected recipe
        const needMap = new Map<number, number>();
        if (sel) for (const ing of recipeIngredients(sel))
          needMap.set(ing.blockId, (needMap.get(ing.blockId) ?? 0) + 1);
        let maxCraft = sel ? 64 : 0;
        for (const [id, n] of needMap) maxCraft = Math.min(maxCraft, Math.floor(countOf(id) / n));
        const craftable = maxCraft > 0;

        // 3×3 display grid for the selected recipe (patterns centered)
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

              {/* ---- top category tabs ---- */}
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

              {/* ---- panel + left rail ---- */}
              <div className="flex relative">
                {/* left vertical recipe rail */}
                <div className="flex flex-col items-center gap-1 pr-1 -mr-[2px] z-10 self-center -translate-x-1">
                  <div className="mc-book-rail w-[44px] h-[20px] flex items-center justify-center">
                    <ChevronUp size={12} className="text-white/35" />
                  </div>
                  {list.map((r) => (
                    <button
                      key={r.id}
                      title={r.name}
                      onClick={() => setBookSel(r.id)}
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

                {/* main panel */}
                <div className="mc-book px-5 pt-4 pb-4 w-[860px]">
                  {/* group title */}
                  <div className="flex items-center justify-center gap-2 mb-3">
                    <Hammer size={13} className="text-[#ffd23e]" />
                    <span className="px-font px-shadow text-[12px] text-white tracking-widest">
                      {activeGroup.label.toUpperCase()}
                    </span>
                  </div>

                  {/* horizontal recipe strip */}
                  <div className="flex gap-1 justify-center mb-4">
                    {list.map((r) => {
                      const rNeeds = recipeIngredients(r);
                      const reqMap = new Map<number, number>();
                      for (const ing of rNeeds) reqMap.set(ing.blockId, (reqMap.get(ing.blockId) ?? 0) + 1);
                      let can = 64;
                      for (const [id, n] of reqMap) can = Math.min(can, Math.floor(countOf(id) / n));
                      return (
                        <button
                          key={r.id}
                          title={r.name}
                          onClick={() => setBookSel(r.id)}
                          className={`mc-book-slot mc-book-slot-hoverable w-[46px] h-[46px] flex items-center justify-center cursor-pointer
                            ${sel?.id === r.id ? 'mc-book-picked' : ''} ${can <= 0 ? 'opacity-45' : ''}`}
                        >
                          <BlockIcon blockId={(r.output as { blockId?: number }).blockId ?? 1} size={28} />
                        </button>
                      );
                    })}
                    {Array.from({ length: Math.max(0, 11 - list.length) }).map((_, i) => (
                      <div key={`e${i}`} className="mc-book-slot w-[46px] h-[46px] opacity-60" />
                    ))}
                  </div>

                  {/* bottom: recipe detail + inventory */}
                  <div className="flex gap-4">
                    {/* recipe detail */}
                    <div className="mc-book-slot flex-1 p-3">
                      <div className="px-font px-shadow-sm text-center text-[9px] text-[#ffd23e] tracking-wider mb-3">
                        {sel ? sel.name.toUpperCase() : '—'}
                      </div>
                      <div className="flex items-center justify-center gap-5">
                        {/* 3×3 pattern */}
                        <div className="grid grid-cols-3 gap-[3px]">
                          {gridCells.map((id, i) => (
                            <div key={i}
                              className={`mc-book-slot w-[46px] h-[46px] flex items-center justify-center
                                ${id != null && !craftable ? 'mc-book-slot-missing' : ''}`}>
                              {id != null && <BlockIcon blockId={id} size={28} />}
                            </div>
                          ))}
                        </div>
                        {/* arrow */}
                        <ArrowRight size={26} className="text-white/45 flex-shrink-0" />
                        {/* output */}
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
                      {/* ingredient tally */}
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
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* inventory */}
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
                          <div key={i} className={`mc-book-slot w-[40px] h-[40px] flex items-center justify-center ${stats.slot === i ? 'mc-book-picked' : ''}`}>
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

              {/* ---- bottom key hints ---- */}
              <div className="flex items-center gap-4 mt-3 pl-2 px-font px-shadow-sm text-[7px] text-white/55">
                <span className="flex items-center gap-1.5"><span className="mc-book-key !text-[#ff5347]">ESC</span> EXIT</span>
                <span className="flex items-center gap-1.5"><span className="mc-book-key">CLICK</span> CRAFT</span>
                <span className="flex items-center gap-1.5"><span className="mc-book-key">SHIFT</span> CRAFT ALL</span>
                <span className="flex items-center gap-1.5"><span className="mc-book-key">TAB</span> INVENTORY</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ================= FURNACE (RMB a placed furnace) ================= */}
      {phase === 'ready' && stats && stats.furnaceOpen && (() => {
        const g = game();
        const inv = g?.inventory;
        const fur = g?.openFurnace;
        if (!g || !inv || !fur) return null;

        const burn = stats.furnaceBurn ?? 0;
        const cook = stats.furnaceCook ?? 0;

        // Furnace slots: one click returns the whole stack to the inventory
        // (like MC shift-click); output collects everything.
        const takeBack = (slot: 'input' | 'fuel' | 'output') => () => {
          g.furnaceTransfer(slot, true);
          refreshInv();
        };
        // Inventory stacks: one click auto-routes the whole stack —
        // smeltable → input, fuel → fuel. Exactly MC's shift-click behaviour.
        const quickMove = (isHotbar: boolean, index: number) => () => {
          g.furnaceQuickMove({ isHotbar, index });
          refreshInv();
        };
        /** eligibility → outline colour class for an inventory stack */
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

              {/* title */}
              <div className="flex items-center justify-center gap-2 mb-4">
                <Flame size={13} className={burn > 0 ? 'text-[#ff8b4e]' : 'text-white/40'} />
                <span className="px-font px-shadow text-[12px] text-white tracking-widest">FURNACE</span>
              </div>

              {/* smelting row: input over fuel, flame gauge, arrow, output */}
              <div className="flex items-center justify-center gap-4 mb-4">
                <div className="flex flex-col items-center gap-2">
                  {/* input */}
                  <button onClick={takeBack('input')} title={fur.input ? 'Click: return to inventory' : 'Click a smeltable item below to load'}
                    className={`mc-book-slot w-[52px] h-[52px] flex items-center justify-center relative
                      ${fur.input ? 'mc-book-slot-hoverable cursor-pointer' : '!outline-dashed !outline-[#6dc24a]/40'}`}>
                    {!fur.input && <span className="px-font text-[6px] text-[#6dc24a]/60 absolute inset-0 flex items-center justify-center">SMELT</span>}
                    <RenderSlotItem item={fur.input} />
                  </button>
                  {/* flame gauge */}
                  <div className="relative w-[26px] h-[26px]">
                    <Flame size={26} className="absolute inset-0 text-white/12" strokeWidth={2} />
                    <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(${(1 - burn) * 100}% 0 0 0)` }}>
                      <Flame size={26} className="text-[#ff8b4e]" strokeWidth={2}
                        style={{ filter: burn > 0 ? 'drop-shadow(0 0 5px rgba(255,139,78,0.85))' : 'none' }} />
                    </div>
                  </div>
                  {/* fuel */}
                  <button onClick={takeBack('fuel')} title={fur.fuel ? 'Click: return to inventory' : 'Click a fuel item below to load (planks, logs, leaves, cactus)'}
                    className={`mc-book-slot w-[52px] h-[52px] flex items-center justify-center relative
                      ${fur.fuel ? 'mc-book-slot-hoverable cursor-pointer' : '!outline-dashed !outline-[#ff8b4e]/40'}`}>
                    {!fur.fuel && <span className="px-font text-[6px] text-[#ff8b4e]/60 absolute inset-0 flex items-center justify-center">FUEL</span>}
                    <RenderSlotItem item={fur.fuel} />
                  </button>
                </div>

                {/* progress arrow */}
                <div className="relative w-[62px] h-[22px] flex items-center">
                  <div className="absolute inset-0 flex items-center">
                    <ArrowRight size={30} className="text-white/15" strokeWidth={2.5} />
                  </div>
                  <div className="absolute inset-0 flex items-center overflow-hidden"
                    style={{ clipPath: `inset(0 ${(1 - cook) * 100}% 0 0)` }}>
                    <ArrowRight size={30} className="text-[#6dc24a]" strokeWidth={2.5} />
                  </div>
                </div>

                {/* output */}
                <button onClick={takeBack('output')} title="Click: collect"
                  className={`mc-book-slot w-[62px] h-[62px] flex items-center justify-center relative
                    ${fur.output ? 'cursor-pointer !outline-[#6dc24a] hover:!bg-[#3f5a34]/80' : 'opacity-60'}`}>
                  <RenderSlotItem item={fur.output} />
                </button>
              </div>

              {/* interactive inventory: click a highlighted stack to load it */}
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

              {/* key hints */}
              <div className="flex items-center gap-4 mt-3 px-font px-shadow-sm text-[7px] text-white/55">
                <span className="flex items-center gap-1.5"><span className="mc-book-key !text-[#ff5347]">ESC</span> EXIT</span>
                <span>CLICK ITEM → AUTO-LOADS · CLICK FURNACE SLOT → RETURNS</span>
              </div>
            </div>
          </div>
        );
      })()}

      {phase === 'loading' && <LoadingScreen progress={progress} label={label} />}

      {/* ============ WARM RE-ENTRY: slim resume chip (no title screen) ============ */}
      {wantPrompt && promptReady && (
        <div className="absolute inset-x-0 bottom-[16%] z-40 flex justify-center pointer-events-none overlay-in">
          <button
            onClick={onPlay}
            className="pointer-events-auto mc-panel group flex flex-col items-center gap-2.5 px-8 py-5 cursor-pointer transition-transform duration-100 hover:scale-[1.03] active:translate-y-[2px]"
          >
            <span className="px-font px-shadow text-[11px] tracking-[0.22em] text-white group-hover:text-[#ffd23e]">
              CLICK TO RESUME CONTROL
            </span>
            <span className="px-font px-shadow-sm text-[8px] tracking-[0.18em] text-[#6dc24a] px-blink">
              ▼ SIGNAL LOCKED — WORLD LIVE
            </span>
          </button>
        </div>
      )}

      {/* ============================== START / PAUSE ============================== */}
      {showMenu && (
        <div className="absolute inset-0 z-40 flex items-center justify-center overlay-in"
          style={{ background: 'radial-gradient(ellipse at 50% 35%, rgba(24,34,54,0.82), rgba(6,8,12,0.94))' }}>
          <div className="flex flex-col items-center gap-7 max-w-2xl px-6">
            {coldStart ? (
              <div className="flex flex-col items-center gap-3">
                <div className="px-font text-[10px] text-[#6dc24a] tracking-[0.35em] px-shadow-sm">// UNIFIED BLOCK-OPS</div>
                <h1 className="px-font px-shadow title-in text-[clamp(28px,6vw,54px)] text-white tracking-[0.08em]">
                  VOXEL<span className="text-[#ffd23e]">CRAFT</span>
                </h1>
                <div className="px-font text-[10px] text-white/60 tracking-[0.2em] px-shadow-sm">SURVIVE · BUILD · FLY</div>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <div className="px-font text-[9px] text-[#6dc24a] tracking-[0.35em] px-shadow-sm">// SESSION LIVE</div>
                <h2 className="px-font px-shadow text-[22px] text-white tracking-[0.14em]">PAUSED</h2>
              </div>
            )}

            <div className="mc-panel p-5 grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2.5 px-font text-[8px] leading-relaxed text-white/80">
              <div><span className="text-[#ffd23e]">WASD</span> MOVE</div>
              <div><span className="text-[#ffd23e]">MOUSE</span> LOOK</div>
              <div><span className="text-[#ffd23e]">LMB</span> FIRE / CUT</div>
              <div><span className="text-[#ffd23e]">RMB</span> ADS / USE</div>
              <div><span className="text-[#ffd23e]">R</span> RELOAD</div>
              <div><span className="text-[#ffd23e]">F</span> INSPECT</div>
              <div><span className="text-[#ffd23e]">TAB</span> INVENTORY</div>
              <div><span className="text-[#ffd23e]">E</span> SPACESHIP</div>
              <div><span className="text-[#ffd23e]">SHIFT</span> SPRINT</div>
              <div><span className="text-[#ffd23e]">SPACE</span> JUMP</div>
              <div><span className="text-[#ffd23e]">1-6</span> HOTBAR</div>
              <div><span className="text-[#ff8b4e]">LASER</span> SLOT 6</div>
              <div><span className="text-[#6dc24a]">FOOD</span> EAT TO HEAL</div>
              <div><span className="text-[#8ab4ff]">BLOCKS</span> MINE & BUILD</div>
            </div>

            <div className="flex items-center gap-3">
              <button
                className="mc-btn px-5 py-3.5 text-[10px] tracking-widest cursor-pointer flex items-center gap-2"
                onClick={() => game()?.toggleEnemies(!(stats?.enemiesEnabled ?? true))}
              >
                <Shield size={14} className={stats?.enemiesEnabled ? 'text-[#ff5347]' : 'text-[#6dc24a]'} />
                ENEMIES: {stats?.enemiesEnabled ? 'ON' : 'OFF'}
              </button>
              <button className="mc-btn px-9 py-3.5 text-[11px] tracking-widest cursor-pointer" onClick={onPlay}>
                {hasPlayed ? '▶ RESUME' : '▶ DEPLOY'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
