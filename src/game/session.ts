
const COIN_KEY = 'manscraft.coins';

const loadCoins = (): number => {
  try {
    const n = parseInt(localStorage.getItem(COIN_KEY) ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  } catch { return NaN; }
};

export const session = { booted: false, coins: loadCoins() };

export const saveCoins = (n: number): void => {
  session.coins = n;
  try { localStorage.setItem(COIN_KEY, String(Math.max(0, Math.floor(n)))); } catch { }
};
