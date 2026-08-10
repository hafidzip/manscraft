import { B } from '../../game/fps/World';
import { tileUV, T, atlasDataUrl, drumstickDataUrl } from '../../game/fps/textures';
import type { SlotItem } from '../../game/fps/Inventory';
import { BLOCK_NAMES, FOODS } from '../../game/fps/Inventory';
import type { SHOP_ITEMS } from '../../game/fps/shop';

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

export function WeaponIcon({ id, size = 46 }: { id: string; size?: number }) {
  const rects = ICONS[id] ?? ICONS.rifle;
  return (
    <svg width={size} height={size * 0.58} viewBox="0 0 24 14" className="icon-pixel" style={{ imageRendering: 'pixelated' }} shapeRendering="crispEdges">
      {rects.map((r, i) => (
        <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={r[4]} />
      ))}
    </svg>
  );
}

const BLOCK_TILE: Record<number, number> = {
  [B.GRASS]: T.GRASS_SIDE, [B.DIRT]: T.DIRT, [B.STONE]: T.STONE, [B.SAND]: T.SAND,
  [B.SANDSTONE]: T.SANDSTONE, [B.LOG]: T.LOG_SIDE, [B.LEAVES]: T.LEAVES,
  [B.CACTUS]: T.CACTUS_SIDE, [B.PLANK]: T.PLANK, [B.ORE]: T.ORE, [B.COBBLE]: T.COBBLE,
  [B.WOOL]: T.TARGET_WOOL, [B.CRAFTING_TABLE]: T.CRAFT_TOP, [B.GLASS]: T.GLASS,
  [B.FURNACE]: T.FURNACE, [B.COAL]: T.COAL, [B.STICK]: T.STICK, [B.TORCH]: T.TORCH,
  [B.CONVEYOR]: T.CONVEYOR, [B.INSERTER]: T.INSERTER,
  50: T.ORE_RUBY, 51: T.ORE_AMBER, 52: T.ORE_LUMI, 53: T.ORE_DIAMOND,
  54: T.ORE_GOLD, 55: T.ORE_SILVER, 56: T.ORE_JADE, 57: T.ORE_EMERALD,
};
const blockTile = (blockId: number): number => BLOCK_TILE[blockId] ?? T.STONE;

export function BlockIcon({ blockId, size = 22 }: { blockId: number; size?: number }) {
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

export function DrumstickIcon({ size = 26 }: { size?: number }) {
  const url = drumstickDataUrl();
  return (
    <img src={url} width={size} height={size} alt="Chicken Drum"
      style={{ imageRendering: 'pixelated', filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.6))' }}
      draggable={false} />
  );
}

export const WEAPON_TITLES: Record<string, string> = {
  handgun: "P9 'SIDEKICK'", smg: "KV-9 'HORNET'", rifle: "AR-77 'SENTINEL'",
  sniper: "LW-50 'LONGSTAR'", bazooka: "RPG-9 'HAMMER'", laser: "MK-7 'PROSPECTOR'",
};

export const LABELS: Record<string, string> = { handgun: 'P9', smg: 'KV-9', rifle: 'AR-77', sniper: 'LW-50', bazooka: 'RPG-9', laser: 'MK-7' };

export function itemName(item: SlotItem | null): string {
  if (!item) return '';
  if (item.kind === 'weapon') return WEAPON_TITLES[item.weaponId] ?? item.weaponId;
  if (item.kind === 'block') return BLOCK_NAMES[item.blockId] ?? `Block #${item.blockId}`;
  return FOODS[item.foodId]?.name ?? item.foodId;
}

interface RenderSlotItemProps {
  item: SlotItem | null;
  hovered?: boolean;
}

export function RenderSlotItem({ item, hovered }: RenderSlotItemProps) {
  if (!item) return null;
  const hot = hovered ? 'brightness(1.35)' : 'none';
  if (item.kind === 'weapon') {
    return <div style={{ filter: hot }}><WeaponIcon id={item.weaponId} size={38} /></div>;
  }
  return (
    <div className="flex flex-col items-center justify-center relative w-full h-full" style={{ filter: hot }}>
      {item.kind === 'block' ? <BlockIcon blockId={item.blockId} size={22} /> : <DrumstickIcon size={24} />}
      <span className="absolute bottom-0 right-0.5 px-font text-[8px] text-white px-shadow">{item.count}</span>
    </div>
  );
}

const HEART_GRID = [
  '.XX.XX.',
  'XXXXXXX',
  'XXXXXXX',
  'XXXXXXX',
  '.XXXXX.',
  '..XXX..',
  '...X...',
];

export function PixelHeart({ mode = 'full' }: { mode?: 'full' | 'half' | 'empty' }) {
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

export function CoinIcon({ size = 16 }: { size?: number }) {
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

export function ShopItemIcon({ item, size = 32 }: { item: typeof SHOP_ITEMS[0]; size?: number }) {
  if (item.goods.kind === 'food') return <DrumstickIcon size={size} />;
  return <BlockIcon blockId={item.goods.blockId} size={size} />;
}
