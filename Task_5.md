# Task 5 — Minimap Camp Markers

**Goal:** Draw camp markers on the minimap so the player can find camps at a glance, including cleared state. (Camps are block-built, so they already tint the terrain — this adds distinct icons + status.)

**Depends on:** Task 4 (`campsTotal`, `campsCleared`, `CampSite` positions).

---

## Context to pass

**File: `src/components/Minimap.tsx`** — full current structure:
```tsx
const SIZE = 176; const SAMPLES = 96; const HALF = SAMPLES / 2; const REFRESH_MS = 180;

export function Minimap({ engineRef }: { engineRef: RefObject<GameEngine | null> }) {
  // interval every 180ms:
  //   world = engine.getWorld(); player = engine.getPlayer();
  //   px/pz = floor(player.pos)
  //   for sy/sx over SAMPLES: world.mapColumn(px + sx - HALF, pz + sy - HALF)
  //     -> { color, height, water } → write to ImageData
  //   then: clip circle, putImageData, drawImage (nearest-neighbor scale),
  //   heading arrow (player.yaw), 'N' label
}
```
**File: `src/game/engine.ts`** — engine already exposes:
```ts
getWorld(): World
getPlayer(): Player
```
`Player.pos` is the player's feet position (x, z in world blocks, toroidal).

---

## Deliverable

**In `src/components/Minimap.tsx`:**

1. Each refresh (after the terrain blit), get camp data from the engine. Add a small engine accessor (or read from `EnemyManager` via a getter you add in Task 4):
```ts
getCamps(): { x: number; z: number; cleared: boolean }[]  // on GameEngine
```

2. Draw markers in **screen space** on the minimap (after the circle clip, before the arrow):
   - Convert world → minimap px: `mx = (x - px + HALF) / SAMPLES * SIZE`, `my = (z - pz + HALF) / SAMPLES * SIZE` (player-centered, like the terrain)
   - Skip markers outside the circle (distance check from center > SIZE/2 - 4)
   - **Active camp**: red/amber diamond or tent glyph (e.g. `▲`/drawn triangle), 5–6px, with a dark outline for contrast
   - **Cleared camp**: same shape in dim grey (`rgba(120,120,120,0.6)`) — or a checkmark
   - Draw a faint pulsing ring around the nearest active camp (optional; keep cheap)

3. Keep everything else identical (terrain pass, arrow, 'N').

**Acceptance:** camps are visible on the minimap as you fly/walk near them; cleared camps change appearance; markers wrap correctly across the torus seam (they already will if you use the same wrapped `px + dx` math as the terrain loop).

---

## Output contract (for Task 6)
Marker positions + cleared flag are purely read from Task 4's data — no new contracts.
