import { B } from './World';

export interface ShopItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  goods:
    | { kind: 'block'; blockId: number; count: number }
    | { kind: 'food'; foodId: string; count: number };
}

const blk = (id: string, name: string, price: number, desc: string, blockId: number, count: number): ShopItem =>
  ({ id, name, price, desc, goods: { kind: 'block', blockId, count } });

export const SHOP_ITEMS: ShopItem[] = [
  blk('stone', 'Stone', 15, '16× Stone blocks — the backbone of every build.', B.STONE, 16),
  blk('cobble', 'Cobblestone', 20, '32× Cobblestone for walls, bridges and foundations.', B.COBBLE, 32),
  blk('log', 'Wood Log', 15, '16× Wood Logs — craft them into planks.', B.LOG, 16),
  blk('plank', 'Wood Planks', 12, '16× Planks, ready for building.', B.PLANK, 16),
  blk('sand', 'Sand', 10, '16× Sand — smelt it into Glass.', B.SAND, 16),
  blk('glass', 'Glass', 20, '8× Glass panes for windows and skylights.', B.GLASS, 8),
  blk('sandstone', 'Sandstone', 15, '16× Sandstone for desert-themed builds.', B.SANDSTONE, 16),
  blk('dirt', 'Dirt', 8, '32× Dirt — cheap and cheerful terrain.', B.DIRT, 32),
  blk('crafting_table', 'Crafting Table', 25, '1× Crafting Table — unlocks 3×3 recipes.', B.CRAFTING_TABLE, 1),
  blk('furnace', 'Furnace', 30, '1× Furnace — smelt ores and cook materials.', B.FURNACE, 1),
  blk('wool', 'Target Wool', 12, '16× Wool blocks for decoration.', B.WOOL, 16),
  {
    id: 'rations', name: 'Chicken Drum', price: 25,
    desc: '8× Chicken Drum — eat to restore health.',
    goods: { kind: 'food', foodId: 'chicken-drum', count: 8 },
  },
];

export const COIN_REWARDS: Record<string, number> = {
  grunt: 12, runner: 16, heavy: 30, merchant: 50,
};

export const STARTING_COINS = 40;
export const TRADE_DISTANCE = 4.2;
export const MERCHANT_PRESET_ID = 'merchant';

export const BLOCK_SELL_PRICES: Record<number, number> = {
  [B.GRASS]: 1, [B.DIRT]: 1, [B.STONE]: 1, [B.SAND]: 1, [B.SANDSTONE]: 2,
  [B.LOG]: 1, [B.LEAVES]: 0, [B.CACTUS]: 1, [B.PLANK]: 1, [B.ORE]: 3,
  [B.COBBLE]: 1, [B.WOOL]: 1, [B.CRAFTING_TABLE]: 15, [B.GLASS]: 2, [B.FURNACE]: 18,
  [B.RAW_COAL_ORE]: 1, [B.COAL]: 2,
  50: 4, 51: 3, 52: 3, 53: 5, 54: 3, 55: 2, 56: 3, 57: 4,
};

export const FOOD_SELL_PRICES: Record<string, number> = { 'chicken-drum': 2 };

export const getBlockSellPrice = (blockId: number): number => BLOCK_SELL_PRICES[blockId] ?? 1;
export const getFoodSellPrice = (foodId: string): number => FOOD_SELL_PRICES[foodId] ?? 1;

export function getShopSellPrice(item: ShopItem): number {
  return item.goods.kind === 'block'
    ? getBlockSellPrice(item.goods.blockId)
    : getFoodSellPrice(item.goods.foodId);
}

export interface MerchantStock {
  itemId: string;
  quantity: number;
  maxQuantity: number;
}

export function generateMerchantStock(rng: () => number): MerchantStock[] {
  const count = 1 + Math.floor(rng() * 3);
  const shuffled = [...SHOP_ITEMS].sort(() => rng() - 0.5);
  return shuffled.slice(0, count).map((item) => ({
    itemId: item.id,
    quantity: 3 + Math.floor(rng() * 8),
    maxQuantity: 10,
  }));
}
