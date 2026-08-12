const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/hullParts.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const HULL_PARTS: typeof _mod.HULL_PARTS = _mod.HULL_PARTS;
export const GLOW_PARTS: typeof _mod.GLOW_PARTS = _mod.GLOW_PARTS;
