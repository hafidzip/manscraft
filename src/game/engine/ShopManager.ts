/**
 * ShopManager — encapsulates all merchant economy logic: proximity detection,
 * merchant stock generation, buying, selling, coin purse management.
 */

import * as THREE from 'three';
import * as C from '../core/constants';
import { Enemy, type EnemyManager } from '../fps/Enemy';
import { type Inventory } from '../fps/Inventory';
import {
  SHOP_ITEMS, COIN_REWARDS, TRADE_DISTANCE,
  generateMerchantStock, getBlockSellPrice, getFoodSellPrice,
  type MerchantStock,
} from '../fps/shop';
import { session, saveCoins } from '../session';
import type { AudioSynth } from '../fps/audio';

export class ShopManager {
  coins: number;
  /** bumped on every gain/spend so the HUD coin chip can pulse */
  coinSeq = 0;
  lastCoinGain = 0;

  nearMerchant = false;
  nearMerchantEnemy: Enemy | null = null;

  /** the merchant whose shop UI is currently open (null = closed) */
  shopEnemy: Enemy | null = null;
  /** items this specific merchant currently has on their shelf */
  shopStock: MerchantStock[] = [];
  /** whether the sell tab is currently active in the shop UI */
  shopSellOpen = false;

  constructor(
    private audio: AudioSynth,
    private inventory: Inventory,
    private canvas: HTMLCanvasElement,
    private onStatsChanged: () => void,
    private requestLock: () => void,
  ) {
    if (!Number.isFinite(session.coins)) {
      session.coins = 0;
      saveCoins(0);
    }
    this.coins = session.coins;
  }

  /** Pay out the coin bounty for a kill (HUD pulses via coinSeq). */
  rewardCoins(e: Enemy): void {
    const gain = COIN_REWARDS[e.cfg.id] ?? 12;
    this.coins += gain;
    saveCoins(this.coins);
    this.coinSeq++;
    this.lastCoinGain = gain;
    this.audio.coin();
  }

  /** Nearest idle merchant within haggling distance (torus-aware). */
  updateProximity(playerPos: THREE.Vector3, dead: boolean, piloting: boolean, enemies: EnemyManager): void {
    if (dead || piloting) {
      this.nearMerchant = false;
      this.nearMerchantEnemy = null;
      return;
    }
    let best: Enemy | null = null;
    let bestD = TRADE_DISTANCE;
    for (const e of enemies.enemies) {
      if (!e.alive || e.cfg.id !== 'merchant' || e.state !== 'idle' || e.alerted) continue;
      const dx = C.wrapDelta(e.pos.x - playerPos.x, C.WORLD_SIZE);
      const dz = C.wrapDelta(e.pos.z - playerPos.z, C.WORLD_SIZE);
      if (Math.abs(e.pos.y - playerPos.y) > 3) continue;
      const d = Math.hypot(dx, dz);
      if (d < bestD) { best = e; bestD = d; }
    }
    this.nearMerchantEnemy = best;
    this.nearMerchant = !!best;
    if (best) best.tradeFaceT = 0.4;
  }

  /** Keep an open shop honest: it slams shut if the deal goes sour. */
  updateShop(playerPos: THREE.Vector3, dead: boolean, piloting: boolean): void {
    const m = this.shopEnemy;
    if (!m) return;
    const dx = C.wrapDelta(m.pos.x - playerPos.x, C.WORLD_SIZE);
    const dz = C.wrapDelta(m.pos.z - playerPos.z, C.WORLD_SIZE);
    const stale =
      !m.alive || m.state !== 'idle' || m.alerted ||
      dead || piloting ||
      Math.hypot(dx, dz) > TRADE_DISTANCE * 1.6;
    if (stale) this.closeShop();
  }

  openShop(): void {
    const m = this.nearMerchantEnemy;
    if (!m || this.shopEnemy) return;
    this.shopEnemy = m;
    this.shopStock = generateMerchantStock(() => Math.random());
    this.shopSellOpen = false;
    m.tradeFaceT = 1e5;
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.onStatsChanged();
  }

  closeShop(): void {
    if (!this.shopEnemy) return;
    this.shopEnemy.tradeFaceT = 0;
    this.shopEnemy = null;
    this.requestLock();
    this.onStatsChanged();
  }

  /** HUD → engine: buy from the open merchant. Returns true on success. */
  buyShopItem(id: string): boolean {
    const item = SHOP_ITEMS.find((i) => i.id === id);
    const m = this.shopEnemy;
    if (!item || !m || !m.alive || m.state !== 'idle') return false;

    const stock = this.shopStock.find((s) => s.itemId === id);
    if (stock && stock.quantity <= 0) { this.audio.deny(); return false; }
    if (this.coins < item.price) { this.audio.deny(); return false; }

    const inv = this.inventory;
    const goods = item.goods;
    if (!inv.canAdd(goods)) { this.audio.deny(); return false; }
    inv.addItem(goods);

    if (stock) stock.quantity--;

    this.coins -= item.price;
    saveCoins(this.coins);
    this.coinSeq++;
    this.lastCoinGain = -item.price;
    this.audio.purchase();
    this.onStatsChanged();
    return true;
  }

  /** Toggle the sell tab inside the shop UI. */
  toggleShopSell(open?: boolean): void {
    if (!this.shopEnemy) return;
    this.shopSellOpen = open !== undefined ? open : !this.shopSellOpen;
    this.onStatsChanged();
  }

  /** HUD → engine: sell an item from inventory to the merchant. */
  sellShopItem(ref: { isHotbar: boolean; index: number }, amount: number): boolean {
    const m = this.shopEnemy;
    if (!m || !m.alive || m.state !== 'idle') return false;

    const inv = this.inventory;
    const arr = ref.isHotbar ? inv.hotbar : inv.mainInv;
    const item = arr[ref.index];
    if (!item) return false;

    if (item.kind === 'weapon') return false;

    let pricePerUnit: number;
    let sellCount: number;
    if (item.kind === 'block') {
      pricePerUnit = getBlockSellPrice(item.blockId);
      sellCount = amount === 0 ? item.count : Math.min(amount, item.count);
    } else {
      pricePerUnit = getFoodSellPrice(item.foodId);
      sellCount = amount === 0 ? item.count : Math.min(amount, item.count);
    }
    if (sellCount <= 0 || pricePerUnit <= 0) return false;

    const totalGain = sellCount * pricePerUnit;

    item.count -= sellCount;
    if (item.count <= 0) arr[ref.index] = null;

    this.coins += totalGain;
    saveCoins(this.coins);
    this.coinSeq++;
    this.lastCoinGain = totalGain;
    this.audio.coin();
    this.onStatsChanged();
    return true;
  }
}
