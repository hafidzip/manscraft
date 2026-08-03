# Task 3 — Enemy Patrol AI (camp-based behavior)

**Goal:** Give enemies a **patrol** state: they walk a loop of waypoints around their camp when idle, and return to patrolling after losing the player (leash back to camp). Keep all existing chase/attack/strafing behavior intact.

**Depends on:** Task 2 (`CampBuild.patrolPoints`).

---

## Context to pass

**File: `src/game/fps/Enemy.ts`** — current state machine:
```ts
type EnemyState = 'spawn' | 'chase' | 'attack' | 'dead';
```
In `Enemy.update(dt, player)`:
- Perception: `hasLos` (multi-point raycast), `dist` to player, `lastKnown`, `searchT`
- Steering: `inCombatRange = hasLos && dist < preferredRange * 1.15` → strafing orbit; else A* pathfinding toward `lastKnown`
- Firing gate (recently added): `hasLos && dist <= fireRange` where `fireRange = ENEMY_FIRE_MODE === 'distance' ? ENEMY_FIRE_RANGE : cfg.attackRange`
- Existing fields on `Enemy`: `pos`, `yaw`, `vel`, `walkPhase`, `speedN`, `hasTarget`, `searchT`

`EnemyManager` (same file) currently: waves (`wave`, `spawnTimer`, `targetCount()`, `spawnOne()`, `spawnPoints`), `alertNearby`, `notifyWorldChanged`, `damageInRadius`, `raycast`, `clearAll`.

---

## Deliverable

**In `src/game/fps/Enemy.ts`:**

1. Extend state: `'patrol'` (new initial state instead of `'spawn'` — or keep `'spawn'` as a 0.5s drop-in, then `'patrol'`).

2. New `Enemy` fields (set via a new method `assignCamp(build: CampBuild)`):
```ts
patrolPoints: { x: number; z: number }[];  // loop waypoints
patrolIdx = 0;
home: { x: number; z: number };            // camp center
maxLeash = 45;                             // blocks from home; beyond -> return
```

3. Patrol behavior in `update()`:
   - If `!hasLos && !hasTarget` (or `searchT > 6` after losing the player): walk toward `patrolPoints[patrolIdx]`; on arrival (`dist < 1.5`) advance `patrolIdx = (idx+1) % len`
   - Same movement physics as chase (reuse accel/damp/jump); slower walk speed (`speed * 0.55`)
   - While patrolling, keep `yaw` toward the waypoint, arms idle-swing
   - If `hasLos` → immediately switch to existing chase/attack logic
   - **Leash**: if `hasTarget` but the player is beyond `maxLeash` from `home` for > 3s, clear `hasTarget`/`lastKnown` and path back to home, then resume patrol
   - Do NOT fire while in `'patrol'` state (firing requires `hasLos && inFireRange` anyway, but be explicit)

4. `EnemyManager` gets:
```ts
assignCampToEnemy(e: Enemy, build: CampBuild): void
```
(called by Task 4 when spawning)

**Acceptance:** enemy walks the loop forever when player is away; aggroes normally on sight; returns to patrol after losing the player; never fires while patrolling; chase/attack unchanged.

---

## Output contract (for Task 4)
`assignCamp(build)` + `maxLeash` are the stable entry points.
