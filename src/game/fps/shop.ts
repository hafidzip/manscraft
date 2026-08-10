
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

export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'stone', name: 'Stone', price: 15,
    desc: '16× Stone blocks — the backbone of every build.',
    goods: { kind: 'block', blockId: B.STONE, count: 16 },
  },
  {
    id: 'cobble', name: 'Cobblestone', price: 20,
    desc: '32× Cobblestone for walls, bridges and foundations.',
    goods: { kind: 'block', blockId: B.COBBLE, count: 32 },
  },
  {
    id: 'log', name: 'Wood Log', price: 15,
    desc: '16× Wood Logs — craft them into planks.',
    goods: { kind: 'block', blockId: B.LOG, count: 16 },
  },
  {
    id: 'plank', name: 'Wood Planks', price: 12,
    desc: '16× Planks, ready for building.',
    goods: { kind: 'block', blockId: B.PLANK, count: 16 },
  },
  {
    id: 'sand', name: 'Sand', price: 10,
    desc: '16× Sand — smelt it into Glass.',
    goods: { kind: 'block', blockId: B.SAND, count: 16 },
  },
  {
    id: 'glass', name: 'Glass', price: 20,
    desc: '8× Glass panes for windows and skylights.',
    goods: { kind: 'block', blockId: B.GLASS, count: 8 },
  },
  {
    id: 'sandstone', name: 'Sandstone', price: 15,
    desc: '16× Sandstone for desert-themed builds.',
    goods: { kind: 'block', blockId: B.SANDSTONE, count: 16 },
  },
  {
    id: 'dirt', name: 'Dirt', price: 8,
    desc: '32× Dirt — cheap and cheerful terrain.',
    goods: { kind: 'block', blockId: B.DIRT, count: 32 },
  },
  {
    id: 'crafting_table', name: 'Crafting Table', price: 25,
    desc: '1× Crafting Table — unlocks 3×3 recipes.',
    goods: { kind: 'block', blockId: B.CRAFTING_TABLE, count: 1 },
  },
  {
    id: 'furnace', name: 'Furnace', price: 30,
    desc: '1× Furnace — smelt ores and cook materials.',
    goods: { kind: 'block', blockId: B.FURNACE, count: 1 },
  },
  {
    id: 'wool', name: 'Target Wool', price: 12,
    desc: '16× Wool blocks for decoration.',
    goods: { kind: 'block', blockId: B.WOOL, count: 16 },
  },
  {
    id: 'rations', name: 'Chicken Drum', price: 25,
    desc: '8× Chicken Drum — eat to restore health.',
    goods: { kind: 'food', foodId: 'chicken-drum', count: 8 },
  },
];

export const COIN_REWARDS: Record<string, number> = {
  grunt: 12,
  runner: 16,
  heavy: 30,
  merchant: 50,
};

export const STARTING_COINS = 40;

export const TRADE_DISTANCE = 4.2;

export const MERCHANT_PRESET_ID = 'merchant';

export const BLOCK_SELL_PRICES: Record<number, number> = {
  [B.GRASS]: 1,
  [B.DIRT]: 1,
  [B.STONE]: 1,
  [B.SAND]: 1,
  [B.SANDSTONE]: 2,
  [B.LOG]: 1,
  [B.LEAVES]: 0,
  [B.CACTUS]: 1,
  [B.PLANK]: 1,
  [B.ORE]: 3,
  [B.COBBLE]: 1,
  [B.WOOL]: 1,
  [B.CRAFTING_TABLE]: 15,
  [B.GLASS]: 2,
  [B.FURNACE]: 18,
  50: 4,
  51: 3,
  52: 3,
  53: 5,
  54: 3,
  55: 2,
  56: 3,
  57: 4,
};

export const FOOD_SELL_PRICES: Record<string, number> = {
  'chicken-drum': 2,
};

export function getShopSellPrice(item: ShopItem): number {
  if (item.goods.kind === 'block') return BLOCK_SELL_PRICES[item.goods.blockId] ?? 1;
  return FOOD_SELL_PRICES[item.goods.foodId] ?? 1;
}

export function getBlockSellPrice(blockId: number): number {
  return BLOCK_SELL_PRICES[blockId] ?? 1;
}

export function getFoodSellPrice(foodId: string): number {
  return FOOD_SELL_PRICES[foodId] ?? 1;
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
