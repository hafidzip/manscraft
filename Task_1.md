# Task 1 — Procedural Camp Site Generator

**Goal:** Find N deterministic, flat, dry locations on the toroidal voxel world where camps can be built. Pure data — no enemies, no structures yet.

**Depends on:** nothing (runs first).

---

## Context to pass

**File: `src/game/world/generator.ts`** — `TerrainGenerator` exposes:
```ts
heightAt(x: number, z: number): number          // terrain height at block coords
biomeAt(x: number, z: number): Biome           // PLAINS | FOREST | DESERT | MOUNTAINS | SNOW
findSpawn(): [number, number]                  // existing spawn finder (spiral scan pattern to copy)
```
Biomes: `Plains / Forest / Desert / Mountains / Snowy Taiga` (enum `Biome` in `src/game/world/biomes.ts`).

**File: `src/game/core/constants.ts`**:
```ts
export const WORLD_SIZE = 512;      // toroidal world edge (blocks)
export const SEA_LEVEL = 30;
export const WORLD_HEIGHT = 80;
```
**Toroidal wrap helpers:** `wrapBlock(x)` keeps coords in `[0, WORLD_SIZE)`; `wrapDelta(d, m)` gives shortest signed delta — use these so camps wrap seamlessly like everything else.

---

## Deliverable

New file **`src/game/fps/camps.ts`** (or `src/game/world/camps.ts` — pick the side that owns terrain):

```ts
export interface CampSite {
  id: number;
  cx: number; cz: number;        // center block coords (wrapped)
  radius: number;                // camp footprint radius in blocks (~12–18)
  y: number;                     // ground height at center
  biome: Biome;
  // flatness: max height delta across the footprint (should be <= 2)
  flatness: number;
}

export function generateCamps(
  gen: TerrainGenerator,
  seed: number,
  count?: number,          // default 5
  minDistFromSpawn?: number // default 40
): CampSite[];
```

**Rules:**
- Deterministic: use a seeded RNG (`mulberry32(seed ^ salt)` from `src/game/core/noise.ts`) — never `Math.random()`
- Scan rings/random candidates; accept a site when:
  - `h > SEA_LEVEL + 4` (dry land, not beach)
  - biome is NOT `SNOW` or `MOUNTAINS` (or allow mountains with a lower probability — pick one and document it)
  - flatness ≤ 2 across a `radius` footprint (sample `heightAt` at center + 4 cardinal/4 diagonal points)
  - distance from `gen.findSpawn()` ≥ `minDistFromSpawn`
  - pairwise distance between camps ≥ `radius * 3`
- Return `CampSite[]` sorted by distance to spawn (nearest first)

**Acceptance:** calling twice with the same seed returns identical sites; no site overlaps water; all sites are ≥40 blocks from spawn; 5 sites found on most seeds (fall back to relaxing the flatness rule if fewer than `count` found, then clamp).

---

## Output contract (for Task 2)
`CampSite` is the only export Task 2 consumes — keep it stable.
