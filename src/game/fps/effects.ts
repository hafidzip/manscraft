const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/b5ea2ca7a1e3d0eed775ee75f7d048d8/raw/effects.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const Effects: typeof _mod.Effects = _mod.Effects;
