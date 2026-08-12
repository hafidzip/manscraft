export interface FlightInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/b5ea2ca7a1e3d0eed775ee75f7d048d8/raw/spaceship.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const Spaceship: typeof _mod.Spaceship = _mod.Spaceship;
