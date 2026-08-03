# Task 4 — CampManager: replace wave spawning with camp populations

**Goal:** Delete the wave system. Each camp owns a fixed squad of enemies that spawn on world load, patrol (Task 3), respawn after a delay when killed, and can be "cleared". The engine reports camp state to the HUD instead of `wave`.

**Depends on:** Tasks 1–3 (`CampSite`, `CampBuild`, patrol AI).

---

## Context to pass

**File: `src/game/fps/Enemy.ts`** — current manager API used by the engine:
```ts
new EnemyManager(player, deps)          // deps: { world, effects, audio, camera, onPlayerHit, onEnemyKilled }
manager.update(dt)
manager.aliveCount
manager.wave                            // HUD reads this
manager.clear(scene) / setEnabled(b) / raycast(...) / alertNearby(...) / damageInRadius(...) / notifyWorldChanged(...)
```
**File: `src/game/engine.ts`** — integration points:
```ts
this.enemies = new EnemyManager(this.player, { world, effects, audio, camera,
  onPlayerHit: (dmg, from) => this.damagePlayer(dmg, from),
  onEnemyKilled: () => { this.kills++; } });
...
this.enemies.update(dt);                // every frame (tickPlay)
this.enemies.clear(this.scene); this.enemies.wave = 0;   // in respawn()
```
**HUD stats** (`HudStats` in engine.ts): `wave`, `enemiesAlive`, `kills` — HUD renders `W{wave}`, `KILLS`, `{enemiesAlive} LEFT`.

---

## Deliverable

**In `src/game/fps/Enemy.ts` (or a new `CampManager` class):**

1. `EnemyManager` constructor optionally takes `camps: { site: CampSite; build: CampBuild }[]` (from Tasks 1+2).
2. Replace `spawnTimer`/`targetCount()`/`spawnOne()` wave logic with:
```ts
interface CampState {
  site: CampSite;
  build: CampBuild;
  squad: Enemy[];            // living enemies of this camp
  squadSize: number;         // e.g. 3–5 by biome/type
  respawnTimer: number;      // when a member dies
  cleared: boolean;          // all dead & respawn disabled after full wipe? (see below)
}

spawnCamp(camp): void         // spawn squadSize enemies at posts, assignCamp(build)
respawnTick(dt): void         // per-camp: respawn dead members after ~20s (only if camp not cleared)
```
3. **Cleared rule (pick one and document):** (a) camp stays cleared forever once its full squad is dead — respawns disabled; or (b) camps repopulate after a long timer (e.g. 90s) for grindability. Recommend (b) with the timer exposed as a constant.
4. Keep existing API working for the engine: `update(dt)`, `aliveCount`, `raycast`, `alertNearby`, `notifyWorldChanged`, `damageInRadius`, `clear(scene)`, `setEnabled`.
5. Replace `wave` with:
```ts
campsTotal: number;
campsCleared: number;
```
(update them in `update()`)

**Engine changes (`src/game/engine.ts`):**
- In `init()`: `generateCamps(gen, seed)` → `buildCamp(world, site, seed)` for each → pass to `EnemyManager`
- Replace `this.enemies.wave` HUD stat with `campsCleared`/`campsTotal`
- Update `respawn()` accordingly (`this.enemies.clear(scene)` stays)

**Acceptance:** on world load, N camps each have a patrol squad; killing them all marks the camp cleared; respawn timer repopulates after the configured delay; HUD shows `CAMPS 2/5 CLEARED` style readout; no wave counter anywhere.

---

## Output contract (for Tasks 5/6)
`campsTotal`, `campsCleared`, per-camp `cleared` state + positions (`CampSite.cx/cz`) are the stable read-outs.
