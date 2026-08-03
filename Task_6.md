# Task 6 — Integration, HUD, and tuning config

**Goal:** Wire the whole camp system into the engine init + HUD, add a single tuning-config block, and verify the full loop (load → find camps → clear → respawn → minimap). This is the final glue task.

**Depends on:** Tasks 1–5.

---

## Context to pass

**File: `src/game/engine.ts`** — init flow (exact order):
```ts
const seed = this.theme ? planetSeedToWorldSeed(this.theme.seed) : (Math.random() * 0x7fffffff) | 0;
this.world = new World(seed, mats);
...
this.player = new Player(this.world);
const [sx, sz] = this.world.gen.findSpawn();
...
this.ship = new Spaceship(...); this.ship.placeNear(this.world.gen, sx, sz);
...
// AFTER world preload completes (so chunks exist before setBlock):
this.fx = new Effects(...);
this.weapons = new WeaponSystem(...);
this.enemies = new EnemyManager(this.player, { world, effects, audio, camera, onPlayerHit, onEnemyKilled });
```
**HUD (`src/components/HUD.tsx`)** reads `HudStats`: `wave`, `kills`, `enemiesAlive`, `damageSeq`, `hp`, etc. (`StatChip` renders `W{stats.wave}` · `KILLS {stats.kills}` · `{stats.enemiesAlive} LEFT`).

**Death/respawn** in engine: `respawn()` calls `this.enemies.clear(this.scene)` and currently `this.enemies.wave = 0`.

---

## Deliverable

**1. Engine init wiring (`src/game/engine.ts`):**
- After world preload: `const camps = generateCamps(this.world.gen, seed);` → `const campBuilds = camps.map(s => ({ site: s, build: buildCamp(this.world, s, seed) }));`
- Pass `campBuilds` into `new EnemyManager(...)`
- Add `getCamps()` accessor (Task 5 needs it): returns `{ x, z, cleared }[]` from the manager
- Guard: only build camps when the world is NOT deep-ocean themed (Task 4's themes) — if `generateCamps` returns 0, skip gracefully

**2. HUD (`src/components/HUD.tsx` + `HudStats`):**
- Replace the `W{wave}` chip with `CAMPS {campsCleared}/{campsTotal}`
- Add `campsTotal`, `campsCleared` to `HudStats` (engine `reportStats()`)
- Keep `KILLS` and `{enemiesAlive} LEFT`

**3. Tuning config — put at the top of `src/game/fps/camps.ts`:**
```ts
export const CAMP_CONFIG = {
  campCount: 5,            // how many camps per world
  minDistFromSpawn: 40,    // blocks from spawn
  squadSize: [3, 5],       // min..max enemies per camp
  respawnDelay: 20,        // seconds before a dead camper respawns
  repopulateDelay: 90,     // seconds before a CLEARED camp repopulates (0 = never)
  patrolSpeedFactor: 0.55, // patrol walk speed multiplier
  maxLeash: 45,            // aggro leash radius from camp center
};
```
Document in a comment: "adjust these to change difficulty/spread".

**4. Respawn integration:**
- `respawn()` clears enemies as today; camps should rebuild their squads on respawn (call the manager's `respawnAllCamps()` or equivalent)
- Death slow-mo/timeScale already applies to `enemies.update(sdt)` — verify camp respawn timers use the same scaled dt (fine either way; document the choice)

**Acceptance checklist (manual test):**
- [ ] World loads with 5 camps (terrain clusters visible)
- [ ] Camps appear on the minimap with markers; cleared camps change icon
- [ ] Patrol squads walk loops; aggro + fire range work; leash returns them
- [ ] Killing a full squad → camp cleared → HUD `CAMPS n/5 CLEARED`
- [ ] After `respawnDelay`/`repopulateDelay`, squads return
- [ ] Death → respawn → camps rebuilt; no wave counter anywhere
- [ ] Build passes; no console errors
