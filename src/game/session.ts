
const COIN_KEY = 'manscraft.coins';

function loadCoins(): number {
  try {
    const raw = localStorage.getItem(COIN_KEY);
    const n = raw === null ? NaN : parseInt(raw, 10);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  } catch {
    return NaN;
  }
}

const stored = loadCoins();

export const session = {
  booted: false,
  coins: stored,
};

export function saveCoins(n: number): void {
  session.coins = n;
  try {
    localStorage.setItem(COIN_KEY, String(Math.max(0, Math.floor(n))));
  } catch {
  }
}
