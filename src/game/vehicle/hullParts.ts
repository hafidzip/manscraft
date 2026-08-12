const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/b5ea2ca7a1e3d0eed775ee75f7d048d8/raw/hullParts.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const HULL_PARTS: typeof _mod.HULL_PARTS = _mod.HULL_PARTS;
export const GLOW_PARTS: typeof _mod.GLOW_PARTS = _mod.GLOW_PARTS;
