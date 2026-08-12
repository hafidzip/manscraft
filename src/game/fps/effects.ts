const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/effects.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const Effects: typeof _mod.Effects = _mod.Effects;
