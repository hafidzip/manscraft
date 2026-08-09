// Procedural pixel-art textures (Minecraft-style block atlas + weapon/sfx textures).
import * as THREE from 'three';
import { mulberry32 } from '../core/noise';

const TILE = 32;          // pixels per tile
const ATLAS_COLS = 4;
const ATLAS_ROWS = 8;     // grew to fit coal/stick/torch tiles

function mkCanvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return { c, g: c.getContext('2d')! };
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  r = Math.max(0, Math.min(255, Math.round(r + amt)));
  g = Math.max(0, Math.min(255, Math.round(g + amt)));
  b = Math.max(0, Math.min(255, Math.round(b + amt)));
  return `rgb(${r},${g},${b})`;
}

function noisyTile(g: CanvasRenderingContext2D, ox: number, oy: number, base: string, variance: number, seed: number, specks: string[] = []) {
  const rand = mulberry32(seed);
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      g.fillStyle = shade(base, Math.floor((rand() - 0.5) * 2 * variance));
      g.fillRect(ox + x, oy + y, 1, 1);
    }
  }
  for (const s of specks) {
    for (let i = 0; i < 26; i++) {
      g.fillStyle = s;
      g.fillRect(ox + Math.floor(rand() * TILE), oy + Math.floor(rand() * TILE), 2, 2);
    }
  }
}

// Tile ids (index into 4x4 atlas)
export const T = {
  GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3,
  SAND: 4, SANDSTONE: 5, SANDSTONE_TOP: 6, LOG_SIDE: 7,
  LOG_TOP: 8, LEAVES: 9, CACTUS_SIDE: 10, CACTUS_TOP: 11,
  PLANK: 12, ORE: 13, COBBLE: 14, TARGET_WOOL: 15, CRAFT_TOP: 16, GLASS: 17,
  FURNACE: 18,
  // gemstone ores (match the world-atlas gem set)
  ORE_RUBY: 19, ORE_AMBER: 20, ORE_LUMI: 21, ORE_DIAMOND: 22,
  ORE_GOLD: 23, ORE_SILVER: 24, ORE_JADE: 25, ORE_EMERALD: 26,
  COAL_ORE: 27, COAL: 28, STICK: 29, TORCH: 30,
} as const;

let atlasTex: THREE.CanvasTexture | null = null;

/** Returns the shared block atlas (lazy build). */
export function getAtlas(): THREE.CanvasTexture {
  if (!atlasTex) atlasTex = buildAtlas();
  return atlasTex;
}

// ── cached data-URL helpers ─────────────────────────────────────────────
// `HTMLCanvasElement.toDataURL()` on the 128×224 atlas takes a few ms, and
// BlockIcon/DrumstickIcon each call it per mount. The inventory renders 80+
// icons at once, so the original code rebuilt + re-encoded the atlas on every
// menu open — a noticeable 2–3 s freeze. Build once, share everywhere.
let atlasDataUrlCache: string | null = null;
export function atlasDataUrl(): string {
  if (atlasDataUrlCache) return atlasDataUrlCache;
  const tex = getAtlas();
  const c = (tex.image as HTMLCanvasElement);
  atlasDataUrlCache = c.toDataURL();
  return atlasDataUrlCache;
}

let drumstickDataUrlCache: string | null = null;
export function drumstickDataUrl(): string {
  if (drumstickDataUrlCache) return drumstickDataUrlCache;
  const { c } = mkCanvas(16, 16);
  paintDrumstick(c.getContext('2d')!);
  drumstickDataUrlCache = c.toDataURL();
  return drumstickDataUrlCache;
}

export function buildAtlas(): THREE.CanvasTexture {
  const { c, g } = mkCanvas(ATLAS_COLS * TILE, ATLAS_ROWS * TILE);
  const tile = (idx: number, fn: (ox: number, oy: number) => void) => {
    const ox = (idx % ATLAS_COLS) * TILE;
    const oy = Math.floor(idx / ATLAS_COLS) * TILE;
    fn(ox, oy);
  };
  const px = (ox: number, oy: number, x: number, y: number, w: number, h: number, col: string) => {
    g.fillStyle = col; g.fillRect(ox + x, oy + y, w, h);
  };

  tile(T.GRASS_TOP, (ox, oy) => {
    noisyTile(g, ox, oy, '#5faa3c', 18, 101, ['#6dc24a', '#4c8f2f']);
  });
  tile(T.GRASS_SIDE, (ox, oy) => {
    noisyTile(g, ox, oy, '#7a5a38', 16, 102);
    const rand = mulberry32(55);
    for (let x = 0; x < TILE; x++) {
      const d = 7 + Math.floor(rand() * 4);
      for (let y = 0; y < d; y++) {
        g.fillStyle = shade('#5faa3c', Math.floor((rand() - 0.5) * 30));
        g.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  });
  tile(T.DIRT, (ox, oy) => noisyTile(g, ox, oy, '#7a5a38', 18, 103, ['#684a2c', '#8a6a45']));
  tile(T.STONE, (ox, oy) => noisyTile(g, ox, oy, '#82858a', 12, 104, ['#75787d', '#8f9297']));
  tile(T.SAND, (ox, oy) => noisyTile(g, ox, oy, '#ddd3a0', 10, 105, ['#cfc48d', '#eae2b6']));
  tile(T.SANDSTONE, (ox, oy) => {
    noisyTile(g, ox, oy, '#d8cd9c', 8, 106);
    px(ox, oy, 0, 0, TILE, 3, '#c9bd8b');
    px(ox, oy, 0, TILE - 4, TILE, 4, '#c9bd8b');
    px(ox, oy, 4, 12, TILE - 8, 2, '#c4b586');
    px(ox, oy, 6, 20, TILE - 12, 2, '#e3d9ac');
  });
  tile(T.SANDSTONE_TOP, (ox, oy) => noisyTile(g, ox, oy, '#d8cd9c', 6, 107, ['#c9bd8b']));
  tile(T.LOG_SIDE, (ox, oy) => {
    noisyTile(g, ox, oy, '#6b5136', 12, 108);
    const rand = mulberry32(77);
    for (let x = 0; x < TILE; x += 3) {
      g.fillStyle = rand() > 0.5 ? '#5a4230' : '#7b5f40';
      g.fillRect(ox + x, oy, 1, TILE);
    }
  });
  tile(T.LOG_TOP, (ox, oy) => {
    noisyTile(g, ox, oy, '#b0925a', 10, 109);
    g.strokeStyle = '#7b5f40';
    for (let r = 4; r < 15; r += 4) {
      g.strokeRect(ox + 16 - r, oy + 16 - r, r * 2, r * 2);
    }
  });
  tile(T.LEAVES, (ox, oy) => noisyTile(g, ox, oy, '#3f7a2b', 22, 110, ['#2f5c20', '#549339']));
  tile(T.CACTUS_SIDE, (ox, oy) => {
    noisyTile(g, ox, oy, '#3f8f3f', 8, 111);
    px(ox, oy, 4, 0, 2, TILE, '#2f7030');
    px(ox, oy, 16, 0, 2, TILE, '#2f7030');
    px(ox, oy, 26, 0, 2, TILE, '#2f7030');
    px(ox, oy, 10, 0, 1, TILE, '#63b058');
  });
  tile(T.CACTUS_TOP, (ox, oy) => {
    noisyTile(g, ox, oy, '#3f8f3f', 8, 112);
    g.strokeStyle = '#2f7030';
    g.lineWidth = 3; g.strokeRect(ox + 2, oy + 2, TILE - 4, TILE - 4);
  });
  tile(T.PLANK, (ox, oy) => {
    noisyTile(g, ox, oy, '#a1814f', 10, 113);
    for (let y = 7; y < TILE; y += 8) px(ox, oy, 0, y, TILE, 2, '#7d6238');
    px(ox, oy, 10, 0, 2, 7, '#7d6238'); px(ox, oy, 22, 9, 2, 6, '#7d6238'); px(ox, oy, 6, 17, 2, 6, '#7d6238'); px(ox, oy, 20, 25, 2, 7, '#7d6238');
  });
  tile(T.ORE, (ox, oy) => {
    noisyTile(g, ox, oy, '#82858a', 12, 114);
    const rand = mulberry32(31);
    for (let i = 0; i < 7; i++) {
      const x = 3 + Math.floor(rand() * 24), y = 3 + Math.floor(rand() * 24);
      px(ox, oy, x, y, 4, 4, '#e8b93c');
      px(ox, oy, x + 1, y + 1, 2, 2, '#f7dc7d');
    }
  });
  tile(T.COBBLE, (ox, oy) => {
    noisyTile(g, ox, oy, '#7d7f82', 14, 115);
    g.strokeStyle = '#54565a'; g.lineWidth = 2;
    g.strokeRect(ox + 1, oy + 1, 13, 13); g.strokeRect(ox + 17, oy + 1, 13, 13);
    g.strokeRect(ox + 1, oy + 17, 13, 13); g.strokeRect(ox + 17, oy + 17, 13, 13);
  });
  tile(T.TARGET_WOOL, (ox, oy) => noisyTile(g, ox, oy, '#e8e6df', 8, 116, ['#d8d5cc']));

  // crafting table top: planks with a worked-in cross seam + rim
  tile(T.CRAFT_TOP, (ox, oy) => {
    noisyTile(g, ox, oy, '#a48150', 10, 131, ['#b8935e', '#8f6d3f']);
    px(ox, oy, 0, 0, TILE, 2, '#64482a');
    px(ox, oy, 0, TILE - 2, TILE, 2, '#64482a');
    px(ox, oy, 0, 0, 2, TILE, '#64482a');
    px(ox, oy, TILE - 2, 0, 2, TILE, '#64482a');
    px(ox, oy, 15, 3, 2, TILE - 6, '#70512e');
    px(ox, oy, 3, 15, TILE - 6, 2, '#70512e');
    px(ox, oy, 12, 12, 8, 8, '#c9a066');
    px(ox, oy, 14, 14, 4, 4, '#70512e');
  });

  // furnace face: cobble shell with a dark arch and glowing coals
  tile(T.FURNACE, (ox, oy) => {
    noisyTile(g, ox, oy, '#7c7c80', 12, 151, ['#8e8e92', '#68686c']);
    px(ox, oy, 0, 0, TILE, 3, '#5a5a5e');
    px(ox, oy, 0, TILE - 3, TILE, 3, '#5a5a5e');
    px(ox, oy, 0, 0, 3, TILE, '#5a5a5e');
    px(ox, oy, TILE - 3, 0, 3, TILE, '#5a5a5e');
    // hearth arch
    px(ox, oy, 6, 8, 20, 6, '#3a3a3e');
    px(ox, oy, 6, 14, 20, 10, '#181819');
    // coals + flame licks
    px(ox, oy, 8, 20, 16, 4, '#e45818');
    px(ox, oy, 10, 17, 3, 4, '#ffa028');
    px(ox, oy, 15, 15, 3, 6, '#ffd65c');
    px(ox, oy, 20, 18, 3, 3, '#ffa028');
    px(ox, oy, 6, 24, 20, 2, '#55555a');
  });

  // glass: pale frame + diagonal glint, transparent body
  tile(T.GLASS, (ox, oy) => {
    px(ox, oy, 0, 0, TILE, 2, '#cee8f5');
    px(ox, oy, 0, TILE - 2, TILE, 2, '#cee8f5');
    px(ox, oy, 0, 0, 2, TILE, '#cee8f5');
    px(ox, oy, TILE - 2, 0, 2, TILE, '#cee8f5');
    px(ox, oy, 6, 8, 3, 3, '#e0f4fc');
    px(ox, oy, 9, 11, 3, 3, '#e0f4fc');
    px(ox, oy, 18, 20, 4, 4, '#e0f4fc');
  });

  // ---- gemstone ores: MC-style diamond clusters on a stone base ----
  // dark = crystal body, lite = facet highlight, spark = 1px glint
  const oreTile = (idx: number, seed: number, dark: string, lite: string, spark: string) => {
    tile(idx, (ox, oy) => {
      noisyTile(g, ox, oy, '#82858a', 12, seed, ['#75787d', '#8f9297']);
      const rand = mulberry32(seed);
      for (let i = 0; i < 6; i++) {
        const x = 3 + Math.floor(rand() * 22), y = 3 + Math.floor(rand() * 22);
        // diamond-shaped cluster (like MC ore blobs)
        px(ox, oy, x + 1, y, 3, 1, dark);
        px(ox, oy, x, y + 1, 5, 3, dark);
        px(ox, oy, x + 1, y + 4, 3, 1, dark);
        px(ox, oy, x + 1, y + 1, 2, 2, lite);
        px(ox, oy, x + 2, y + 1, 1, 1, spark);
      }
    });
  };
  oreTile(T.ORE_RUBY,    401, '#b41e28', '#ff505a', '#ffb0b6');
  oreTile(T.ORE_AMBER,   402, '#c88c1e', '#ffc83c', '#ffe9a8');
  oreTile(T.ORE_LUMI,    403, '#2ea183', '#8cffe0', '#e2fff6');
  oreTile(T.ORE_DIAMOND, 404, '#3c9cc8', '#b4f0ff', '#ffffff');
  oreTile(T.ORE_GOLD,    405, '#c8a028', '#ffdc50', '#fff3b0');
  oreTile(T.ORE_SILVER,  406, '#9aa0a6', '#e6ebf0', '#ffffff');
  oreTile(T.ORE_JADE,    407, '#3f8a52', '#8cdc9f', '#d8ffe2');
  oreTile(T.ORE_EMERALD, 408, '#178c46', '#50ff78', '#c8ffd8');

  // coal ore: stone base with black coal chunks
  tile(T.COAL_ORE, (ox, oy) => {
    noisyTile(g, ox, oy, '#82858a', 12, 431, ['#75787d', '#8f9297']);
    const rand = mulberry32(431);
    for (let i = 0; i < 6; i++) {
      const x = 3 + Math.floor(rand() * 22), y = 3 + Math.floor(rand() * 22);
      px(ox, oy, x, y, 6, 5, '#1c1c20');
      px(ox, oy, x + 1, y + 1, 2, 2, '#44444a');
    }
  });
  // coal lump item
  tile(T.COAL, (ox, oy) => {
    const rand = mulberry32(432);
    g.clearRect(ox, oy, TILE, TILE);
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) {
      const dx = x - 16, dy = y - 16;
      if (dx * dx + dy * dy > 144) continue;
      g.fillStyle = shade('#26262c', Math.floor((rand() - 0.5) * 26));
      g.fillRect(ox + x, oy + y, 1, 1);
    }
    px(ox, oy, 11, 11, 4, 4, '#55555c');
  });
  // stick item: diagonal twig
  tile(T.STICK, (ox, oy) => {
    g.clearRect(ox, oy, TILE, TILE);
    for (let i = 0; i < TILE; i++) {
      px(ox, oy, i, TILE - 1 - i, 3, 3, '#8a643a');
      px(ox, oy, i, TILE - 1 - i, 2, 2, '#a67c4a');
    }
  });
  // torch item: shaft + glowing flame
  tile(T.TORCH, (ox, oy) => {
    g.clearRect(ox, oy, TILE, TILE);
    // shaft
    px(ox, oy, 13, 12, 6, 18, '#8a643a');
    px(ox, oy, 13, 12, 2, 18, '#a67c4a');
    px(ox, oy, 17, 12, 2, 18, '#6b4c2c');
    // ember base
    px(ox, oy, 12, 8, 8, 5, '#2a2020');
    // flame
    px(ox, oy, 13, 2, 6, 8, '#f0821e');
    px(ox, oy, 14, 1, 4, 8, '#ffc846');
    px(ox, oy, 15, 3, 2, 5, '#fff6c8');
  });

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = true;
  return tex;
}

export const ATLAS_SIZE = ATLAS_COLS;

/** UV rect (with inset) for a given tile index. */
export function tileUV(idx: number): [number, number, number, number] {
  const col = idx % ATLAS_COLS, row = Math.floor(idx / ATLAS_COLS);
  const inset = 0.6 / (ATLAS_COLS * TILE);
  const u0 = col / ATLAS_COLS + inset;
  const v0 = 1 - (row + 1) / ATLAS_ROWS + inset;
  const u1 = (col + 1) / ATLAS_COLS - inset;
  const v1 = 1 - row / ATLAS_ROWS - inset;
  return [u0, v0, u1, v1];
}

/** Noisy pixel texture for weapon parts / skin. */
export function pixelTexture(base: string, variance = 22, size = 24, seed = 7): THREE.CanvasTexture {
  const key = `${base}|${variance}|${size}|${seed}`;
  const cached = pixelTextureCache.get(key);
  if (cached) return cached;
  const { c, g } = mkCanvas(size, size);
  const rand = mulberry32(seed);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    g.fillStyle = shade(base, Math.floor((rand() - 0.5) * variance));
    g.fillRect(x, y, 1, 1);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  pixelTextureCache.set(key, tex);
  return tex;
}

/** Enemy waves and effects reuse a small fixed palette; painting a fresh
 * canvas and uploading an identical texture for every spawn caused GC and GPU
 * upload spikes. Textures are immutable, so sharing is safe. */
const pixelTextureCache = new Map<string, THREE.CanvasTexture>();

/** Star-burst muzzle flash sprite. */
export function muzzleTexture(): THREE.CanvasTexture {
  const { c, g } = mkCanvas(64, 64);
  g.translate(32, 32);
  const spike = (len: number, w: number, col: string) => {
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(-w, 0); g.lineTo(0, len); g.lineTo(w, 0); g.lineTo(0, len * 0.25);
    g.closePath(); g.fill();
  };
  g.fillStyle = '#fff2b8';
  g.beginPath(); g.arc(0, 0, 12, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 6; i++) {
    g.save(); g.rotate((i / 6) * Math.PI * 2 + 0.3);
    spike(26 + (i % 2) * 6, 6, i % 2 ? '#ffd23e' : '#fff6c9');
    g.restore();
  }
  g.fillStyle = '#ffffff';
  g.beginPath(); g.arc(0, 0, 6, 0, Math.PI * 2); g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Bullet-hole decal. `seed` picks one of several procedural variants so a wall
 * peppered with shots does not look like the same stamp repeated.
 *
 * The sprite is built as: a near-black punched core, a crunchy crater ring of
 * pulverised material, a few radial cracks, and a faint bright dust rim so the
 * hole still reads against dark *and* light blocks. Everything is drawn on a
 * 32px grid and sampled with NearestFilter to stay in the voxel art style.
 */
export function holeTexture(seed = 9): THREE.CanvasTexture {
  const S = 32, R = S / 2;
  const { c, g } = mkCanvas(S, S);
  const rand = mulberry32(seed * 2654435761 % 2147483647 || 9);

  // Per-variant shape: slightly elliptical + wobbly so no two holes match.
  const squash = 0.82 + rand() * 0.36;
  const tilt = rand() * Math.PI;
  const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
  const coreR = 3.1 + rand() * 1.1;
  const craterR = coreR + 2.2 + rand() * 1.4;
  const dustR = craterR + 2.6 + rand() * 1.8;

  // wobble the outline with a couple of low-frequency harmonics
  const h1 = rand() * Math.PI * 2, h2 = rand() * Math.PI * 2;
  const wob = (a: number) => 1 + Math.sin(a * 3 + h1) * 0.12 + Math.sin(a * 5 + h2) * 0.07;

  const px = (x: number, y: number, style: string) => { g.fillStyle = style; g.fillRect(x, y, 1, 1); };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const dx = x - R + 0.5, dy = y - R + 0.5;
      // rotate + squash into the ellipse frame
      const rx = dx * cosT + dy * sinT;
      const ry = (-dx * sinT + dy * cosT) / squash;
      const d = Math.sqrt(rx * rx + ry * ry);
      const a = Math.atan2(ry, rx);
      const w = wob(a);

      if (d < coreR * w) {
        // punched-through core, darkest dead centre
        const k = d / (coreR * w);
        const v = Math.round(4 + k * 14);
        px(x, y, `rgba(${v},${v - 1},${v - 2},${(0.99 - k * 0.12).toFixed(3)})`);
      } else if (d < craterR * w) {
        // fractured crater lip — dithered so it keeps the pixel look
        const k = (d - coreR * w) / (craterR * w - coreR * w);
        if (rand() > 0.12 + k * 0.55) {
          const v = Math.round(26 + k * 34);
          px(x, y, `rgba(${v},${v - 3},${v - 6},${(0.85 - k * 0.35).toFixed(3)})`);
        }
      } else if (d < dustR * w) {
        // pale dust halo (multiplied by the block tint at runtime)
        const k = (d - craterR * w) / (dustR * w - craterR * w);
        if (rand() > 0.55 + k * 0.4) {
          const v = Math.round(150 - k * 60);
          px(x, y, `rgba(${v},${v - 6},${v - 14},${(0.3 - k * 0.24).toFixed(3)})`);
        }
      }
    }
  }

  // radial cracks spidering out of the crater
  const cracks = 2 + Math.floor(rand() * 3);
  for (let i = 0; i < cracks; i++) {
    let a = rand() * Math.PI * 2;
    let r = coreR * 0.9;
    const len = craterR + rand() * 5;
    while (r < len) {
      a += (rand() - 0.5) * 0.7;
      r += 0.75;
      const x = Math.round(R + Math.cos(a) * r), y = Math.round(R + Math.sin(a) * r * squash);
      if (x < 0 || y < 0 || x >= S || y >= S) break;
      px(x, y, `rgba(20,18,16,${(0.72 * (1 - r / (len + 2))).toFixed(3)})`);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/** Archery-style target rings for the practice range. */
export function targetTexture(): THREE.CanvasTexture {
  const { c, g } = mkCanvas(64, 64);
  g.fillStyle = '#e8e6df'; g.fillRect(0, 0, 64, 64);
  const rings: [number, string][] = [[28, '#e8e6df'], [22, '#d43a2f'], [16, '#e8e6df'], [10, '#d43a2f'], [4, '#f2c14e']];
  for (const [r, col] of rings) {
    g.fillStyle = col;
    g.beginPath(); g.arc(32, 32, r, 0, Math.PI * 2); g.fill();
  }
  g.fillStyle = 'rgba(0,0,0,0.08)';
  for (let i = 0; i < 40; i++) g.fillRect(Math.random() * 64, Math.random() * 64, 2, 2);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Minecraft-style character face (eyes + mouth) on a noisy skin base. */
export function faceTexture(skin = '#c98f5f', seed = 77): THREE.CanvasTexture {
  const { c, g } = mkCanvas(16, 16);
  const rand = mulberry32(seed);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    g.fillStyle = shade(skin, Math.floor((rand() - 0.5) * 16));
    g.fillRect(x, y, 1, 1);
  }
  // hair fringe
  g.fillStyle = shade('#2a1d12', 0);
  g.fillRect(0, 0, 16, 3);
  for (let x = 0; x < 16; x++) if (rand() > 0.6) g.fillRect(x, 3, 1, 1);
  // eyes (white + pupil)
  g.fillStyle = '#ffffff';
  g.fillRect(3, 7, 3, 2); g.fillRect(10, 7, 3, 2);
  g.fillStyle = '#3a4a8a';
  g.fillRect(5, 7, 1, 2); g.fillRect(10, 7, 1, 2);
  g.fillStyle = '#101014';
  g.fillRect(5, 8, 1, 1); g.fillRect(10, 8, 1, 1);
  // nose + mouth
  g.fillStyle = shade(skin, -28);
  g.fillRect(7, 10, 2, 1);
  g.fillStyle = '#5a3a2a';
  g.fillRect(6, 12, 4, 1);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tile index for a block face given its vertical direction (+1 top, -1 bottom, 0 side). */
export function blockFaceTile(blockId: number, dy: number): number {
  switch (blockId) {
    case 1: return dy === 1 ? T.GRASS_TOP : dy === -1 ? T.DIRT : T.GRASS_SIDE; // GRASS
    case 2: return T.DIRT;
    case 3: return T.STONE;
    case 4: return T.SAND;
    case 5: return dy === 1 ? T.SANDSTONE_TOP : T.SANDSTONE;
    case 6: return dy !== 0 ? T.LOG_TOP : T.LOG_SIDE;
    case 7: return T.LEAVES;
    case 8: return dy !== 0 ? T.CACTUS_TOP : T.CACTUS_SIDE;
    case 9: return T.PLANK;
    case 10: return T.ORE;
    case 11: return T.COBBLE;
    case 12: return T.TARGET_WOOL;
    case 13: return T.COBBLE; // BEDROCK
    case 14: return T.CRAFT_TOP;
    case 15: return T.GLASS;
    case 16: return T.FURNACE;
    // gemstone ores (world blocks mapped into fps inventory ids 50-57)
    case 50: return T.ORE_RUBY;
    case 51: return T.ORE_AMBER;
    case 52: return T.ORE_LUMI;
    case 53: return T.ORE_DIAMOND;
    case 54: return T.ORE_GOLD;
    case 55: return T.ORE_SILVER;
    case 56: return T.ORE_JADE;
    case 57: return T.ORE_EMERALD;
    case 58: return T.COAL;
    case 59: return T.STICK;
    case 60: return T.TORCH;
    default: return T.STONE;
  }
}

/**
 * Build a cube geometry whose UVs point at the correct atlas tiles for the
 * given block, so held/dropped items look exactly like world voxels.
 */
export function blockCubeGeometry(blockId: number, size = 0.22): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(size, size, size);
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  // BoxGeometry face order: +x, -x, +y, -y, +z, -z
  const faceDy = [0, 0, 1, -1, 0, 0];
  // Per-face vertex order is: top-left, top-right, bottom-left, bottom-right
  const corners: [number, number][] = [[0, 1], [1, 1], [0, 0], [1, 0]];
  for (let f = 0; f < 6; f++) {
    const [u0, v0, u1, v1] = tileUV(blockFaceTile(blockId, faceDy[f]));
    for (let i = 0; i < 4; i++) {
      const [cu, cv] = corners[i];
      uv.setXY(f * 4 + i, u0 + (u1 - u0) * cu, v0 + (v1 - v0) * cv);
    }
  }
  uv.needsUpdate = true;
  return geo;
}

/**
 * Minecraft cooked-chicken item texture (16×16).
 * Returns both a CanvasTexture (for HUD icons) and the raw pixel data used
 * to build the extruded first-person 3D item model.
 */
export function drumstickTexture(): THREE.CanvasTexture {
  const { c } = mkCanvas(16, 16);
  paintDrumstick(c.getContext('2d')!);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Paint the classic Minecraft cooked-chicken silhouette onto a 16×16 canvas. */
export function paintDrumstick(g: CanvasRenderingContext2D): void {
  // transparent background
  g.clearRect(0, 0, 16, 16);
  const px = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };

  // Palette matching Minecraft's cooked_chicken.png closely
  const M  = '#a05a28'; // main meat
  const Md = '#7a4018'; // dark meat / shade
  const Mc = '#c87838'; // crisp highlight
  const Mh = '#d89850'; // bright highlight
  const B  = '#e8e0c8'; // bone
  const Bd = '#c8c0a8'; // bone shade
  const Bo = '#f5f0dc'; // bone highlight

  // Meat body (top-left blob) — classic MC chicken silhouette
  // Row by row for exact pixel control
  const meat: [number, number, string][] = [
    // y=1
    [5,1,Mc],[6,1,Mc],[7,1,M],
    // y=2
    [4,2,Mc],[5,2,Mh],[6,2,Mc],[7,2,M],[8,2,M],
    // y=3
    [3,3,Mc],[4,3,Mh],[5,3,M],[6,3,M],[7,3,M],[8,3,Md],
    // y=4
    [3,4,M],[4,4,M],[5,4,M],[6,4,M],[7,4,Md],[8,4,Md],[9,4,Md],
    // y=5
    [3,5,M],[4,5,M],[5,5,M],[6,5,Md],[7,5,Md],[8,5,Md],[9,5,Md],
    // y=6
    [4,6,M],[5,6,Md],[6,6,Md],[7,6,Md],[8,6,Md],
    // y=7
    [4,7,Md],[5,7,Md],[6,7,Md],[7,7,Md],
    // y=8 (transition to bone)
    [5,8,Md],[6,8,Md],[7,8,B],
  ];
  for (const [x, y, c] of meat) px(x, y, c);

  // Bone shaft (diagonal down-right) + knobby tip
  const bone: [number, number, string][] = [
    [7,8,B],[8,8,B],
    [8,9,B],[9,9,Bd],
    [9,10,B],[10,10,Bd],
    [10,11,B],[11,11,Bd],
    // knobby tip
    [10,12,Bo],[11,12,B],[12,12,Bd],
    [11,13,B],[12,13,Bd],
    [12,11,Bo],
  ];
  for (const [x, y, c] of bone) px(x, y, c);
}

export function paintTorch(g: CanvasRenderingContext2D): void {
  g.clearRect(0, 0, 16, 16);
  const px = (x: number, y: number, col: string) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };

  // Minecraft torch palette — matches the block's atlas painter colours
  // wood
  const Wh = '#c49a5a'; // highlight
  const Wm = '#8a643a'; // mid
  const Wd = '#5a3a1e'; // dark
  const Wc = '#3a2a18'; // charred ember base
  // flame inner -> outer
  const Fw = '#ffffd0'; // white core
  const Fy = '#ffe86a'; // bright yellow
  const Fo = '#ffb62a'; // orange mid
  const Fr = '#e85a10'; // red-orange outer
  const Fd = '#a03008'; // dark ember

  // ---- Minecraft-style item: 2px wide handle, 6px tall flame ----
  // Flame (centered top)
  // y=1
  px(7, 1, Fw); px(8, 1, Fw);
  // y=2
  px(6, 2, Fo); px(7, 2, Fy); px(8, 2, Fw); px(9, 2, Fo);
  // y=3
  px(6, 3, Fr); px(7, 3, Fo); px(8, 3, Fy); px(9, 3, Fr);
  // y=4
  px(5, 4, Fd); px(6, 4, Fr); px(7, 4, Fo); px(8, 4, Fo); px(9, 4, Fr); px(10, 4, Fd);
  // y=5 - ember base (charred)
  px(6, 5, Fd); px(7, 5, Wc); px(8, 5, Wc); px(9, 5, Fd);

  // Handle — 2px wide, with left highlight / right shade like MC sticks
  // y=6..13
  for (let y = 6; y <= 13; y++) {
    // slight checker for MC shading
    px(7, y, y % 2 === 0 ? Wh : Wm);
    px(8, y, Wd);
  }
  // charred top under flame
  px(7, 6, Wc); px(8, 6, Wc);
  // bottom tip darker
  px(7, 13, Wd); px(8, 13, Wc);
}

/**
 * Build a Minecraft-style extruded item model from a 16×16 pixel canvas.
 * Each opaque pixel becomes a 1×1×depth voxel cube — this is exactly how
 * Minecraft renders flat items (tools, food, etc.) in first person.
 */
export function buildExtrudedItem(
  paint: (g: CanvasRenderingContext2D) => void,
  pixelSize = 0.018,
  depth = 0.036
): THREE.Group {
  const { g } = mkCanvas(16, 16);
  paint(g);
  const data = g.getImageData(0, 0, 16, 16).data;

  const group = new THREE.Group();
  // Shared materials keyed by colour hex
  const matCache = new Map<string, THREE.MeshLambertMaterial>();
  const getMat = (r: number, g: number, b: number) => {
    const key = `${r},${g},${b}`;
    let m = matCache.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: (r << 16) | (g << 8) | b });
      matCache.set(key, m);
    }
    return m;
  };

  // Center the 16×16 grid around origin; Y is flipped (canvas Y-down → 3D Y-up)
  const half = 8 * pixelSize;
  for (let py = 0; py < 16; py++) {
    for (let px = 0; px < 16; px++) {
      const i = (py * 16 + px) * 4;
      const a = data[i + 3];
      if (a < 128) continue; // skip transparent
      const r = data[i], gv = data[i + 1], b = data[i + 2];
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(pixelSize, pixelSize, depth),
        getMat(r, gv, b)
      );
      mesh.position.set(
        px * pixelSize - half + pixelSize * 0.5,
        (15 - py) * pixelSize - half + pixelSize * 0.5,
        0
      );
      mesh.frustumCulled = false;
      group.add(mesh);
    }
  }
  return group;
}

/** Round soft smoke puff. */
export function smokeTexture(): THREE.CanvasTexture {
  const { c, g } = mkCanvas(32, 32);
  const grad = g.createRadialGradient(16, 16, 2, 16, 16, 15);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}
