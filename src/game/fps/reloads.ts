export interface ReloadCtx {
  hideMag(): void; showMag(): void; showMagHand(): void; hideMagHand(): void; dropMag(): void;
  showWarhead(): void; hideWarheadHand(): void; showWarheadHand(): void; ejectShell(): void;
  sfx(name: 'out' | 'in' | 'rack' | 'snap' | 'slap' | 'grab' | 'twist'): void;
}

const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/reloads.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const buildTimeline: typeof _mod.buildTimeline = _mod.buildTimeline;
