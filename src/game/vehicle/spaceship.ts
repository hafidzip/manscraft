export interface FlightInput {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
}

const CDN_URL = 'https://cdn.statically.io/gist/hafidzip/358f8990bb4b494ab1ab3156b4718e10/raw/spaceship.js';

// @ts-ignore
const _mod = await import(/* @vite-ignore */ CDN_URL);

export const Spaceship: typeof _mod.Spaceship = _mod.Spaceship;
