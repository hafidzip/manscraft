/**
 * App-wide session flags that survive React remounts (planet ↔ space swaps
 * remount both canvases, but the *session* continues).
 *
 * `booted` flips the first time the player takes control. The unified title
 * screen only shows before that moment — every later planet/space entry drops
 * straight into the action with no title screen and no loading cut.
 *
 * `coins` is the merchant currency. It lives here (not in the engine) so a
 * descent to space and back never empties your pockets, and it is mirrored to
 * localStorage so the purse survives full page reloads too.
 */

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
  /** NaN = fresh player who has not earned anything yet (engine grants the starter purse) */
  coins: stored,
};

export function saveCoins(n: number): void {
  session.coins = n;
  try {
    localStorage.setItem(COIN_KEY, String(Math.max(0, Math.floor(n))));
  } catch {
    // storage unavailable (private mode etc.) — session-only persistence still works
  }
}
