# Task 2 — Voxel Camp Structures

**Goal:** Build the actual camp (tents, campfire, crates, fence, torches/posts) out of **blocks** in the voxel world at each `CampSite`, so camps are part of the terrain (and therefore automatically visible on the terrain minimap).

**Depends on:** Task 1 (`CampSite`).

---

## Context to pass

**File: `src/game/world/world.ts`** — block I/O:
```ts
setBlock(wx, wy, wz, id): void   // writes a block; wraps toroidally; remeshes chunks
getBlockRaw(wx, wy, wz): number  // reads a block; -1 if chunk unloaded
isSolid(wx, wy, wz): boolean
gen: TerrainGenerator            // heightAt(x,z)
```

**File: `src/game/world/blocks.ts`** — block ids:
```ts
B = { AIR:0, GRASS:1, DIRT:2, STONE:3, SAND:4, LOG:5, LEAVES:6, WATER:7, SNOW:8,
      PLANKS:9, GLASS:10, FLOWER_RED:11, FLOWER_YELLOW:12, TALLGRASS:13,
      BEDROCK:14, GRAVEL:15, CACTUS:16 }
```
Placement pattern to copy: `TerrainGenerator.buildRuin()` / `buildPyramid()` in `src/game/world/generator.ts` (they write directly with `data[idx]` — here you use `world.setBlock` instead).

**Important:** the world is toroidal — always wrap x/z with `wrapBlock` before `setBlock`.

---

## Deliverable

Add to **`src/game/fps/camps.ts`** (same file as Task 1):

```ts
export interface CampBuild {
  site: CampSite;
  /** patrol waypoints (ground points inside the camp) for Task 3 */
  patrolPoints: { x: number; z: number }[];
  /** block positions of campfires / light sources */
  fires: { x: number; y: number; z: number }[];
  /** where defenders stand (posts around the perimeter) */
  posts: { x: number; z: number }[];
}

export function buildCamp(world: World, site: CampSite, seed: number): CampBuild;
```

**Structure recipe (block-based, ~1 block per voxel):**
- **Fence perimeter**: a ring of `LOG` posts (every ~3 blocks) + `PLANKS` rails between them, at `site.radius`
- **2–3 tents**: A-frame from `LOG` frame + `PLANKS`/`LEAVES` walls — simple 3×3×2 shapes, oriented randomly
- **Campfire center**: `GRAVEL` base 3×3, center `LOG` (or a `STONE` ring) — record position in `fires`
- **Crates**: 1×1×1 `PLANKS` cubes with `LOG` edges, scattered inside
- **Guard posts**: 2–3 elevated `LOG`+`PLANKS` platforms near the perimeter — record in `posts`
- Keep everything within `site.radius` of center; skip blocks already solid; never replace `BEDROCK`/`WATER`
- Deterministic per `seed` (seeded RNG for scatter)

**Acceptance:** camps render as distinct brown/wood clusters on the terrain; nothing spawns in water; patrol points & posts are on walkable ground (`heightAt + 1`).

---

## Output contract (for Tasks 3/4/5)
`CampBuild { site, patrolPoints, fires, posts }` is the stable output.
