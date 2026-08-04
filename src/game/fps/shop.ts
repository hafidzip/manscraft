/**
 * Merchant shop catalogue — the single source of truth shared by the engine
 * (purchase validation / application) and the HUD (what to render).
 *
 * Trading is only offered by MERCHANT-class enemies while they are idle.
 */

export type ShopIcon = 'ammo' | 'medkit' | 'heart' | 'food' | 'blocks' | 'rocket';

export interface ShopItem {
  id: string;
  name: string;
  desc: string;
  price: number;
  icon: ShopIcon;
}

export const SHOP_ITEMS: ShopItem[] = [
  {
    id: 'ammo', name: 'AMMO CRATE', price: 30, icon: 'ammo',
    desc: 'Every weapon reserve refilled to full, no questions asked.',
  },
  {
    id: 'medkit', name: 'FIELD MEDKIT', price: 25, icon: 'medkit',
    desc: 'Stitch, wrap, done — health restored to maximum.',
  },
  {
    id: 'rations', name: 'TRAVEL RATIONS', price: 40, icon: 'food',
    desc: '4× Chicken Drum. Tastes better than it has any right to.',
  },
  {
    id: 'cobble', name: 'COBBLE BUNDLE', price: 35, icon: 'blocks',
    desc: '32× Cobblestone for walls, bridges and regret-free blasting.',
  },
  {
    id: 'rockets', name: 'WARHEAD PAIR', price: 60, icon: 'rocket',
    desc: '+2 rockets for the bazooka. Handle with enthusiasm.',
  },
  {
    id: 'vitality', name: 'VITALITY CHARM', price: 120, icon: 'heart',
    desc: '+20 maximum health, permanently. The good stuff.',
  },
];

/** coins paid per kill, by enemy class */
export const COIN_REWARDS: Record<string, number> = {
  grunt: 12,
  runner: 16,
  heavy: 30,
  merchant: 50, // ...they were carrying, after all
};

/** purse a brand-new player starts with (once) */
export const STARTING_COINS = 40;

/** how close you can stand to a merchant and still haggle */
export const TRADE_DISTANCE = 4.2;

export const MERCHANT_PRESET_ID = 'merchant';
