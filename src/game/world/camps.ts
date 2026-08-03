import { WORLD_SIZE, WORLD_HEIGHT, wrapBlock, wrapDelta } from '../core/constants';
import { mulberry32 } from '../core/noise';
import { Biome } from './biomes';
import type { TerrainGenerator } from './generator';
import { B } from './blocks';
import type { World } from './world';

export interface CampSite {
  id: number;
  cx: number; cz: number;   // center block coords (wrapped)
  radius: number;           // footprint radius in blocks (12–18)
  y: number;                // ground height at center
  biome: Biome;
  flatness: number;         // max height delta across footprint
}

const CAMP_SALT     = 0x9e3779b9;
const CANDIDATES    = 3072;
const MIN_RADIUS    = 12;
const MAX_RADIUS    = 18;
const BASE_FLATNESS = 2;   // strict pass
const MAX_FLATNESS  = 5;   // last relaxed pass, then clamp to whatever was found
const DRY_MARGIN    = 4;   // every sample must be > the planet's sea + 4
const MOUNTAIN_ODDS = 0.15; // strict pass policy; final fallback admits unusual biomes

interface Cand {
  cx: number; cz: number; radius: number; mtnRoll: number;
  ev?: { y: number; min: number; flatness: number; biome: Biome };
}

function torusDist(ax: number, az: number, bx: number, bz: number): number {
  const dx = wrapDelta(ax - bx, WORLD_SIZE);
  const dz = wrapDelta(az - bz, WORLD_SIZE);
  return Math.hypot(dx, dz);
}

/** center + 4 cardinal + 4 diagonal on the rim, + 4 mid-ring for safety */
function evaluate(gen: TerrainGenerator, c: Cand) {
  if (c.ev) return c.ev;
  const r = c.radius;
  const d = Math.max(1, Math.round(r * 0.70710678)); // diagonals stay inside the disc
  const m = Math.max(1, Math.round(r * 0.5));
  const offs: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [r, 0], [-r, 0], [0, r], [0, -r],
    [d, d], [d, -d], [-d, d], [-d, -d],
    [m, 0], [-m, 0], [0, m], [0, -m],
  ];
  let min = Infinity, max = -Infinity, y = 0;
  for (let i = 0; i < offs.length; i++) {
    const h = gen.heightAt(wrapBlock(c.cx + offs[i][0]), wrapBlock(c.cz + offs[i][1]));
    if (i === 0) y = h;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  c.ev = { y, min, flatness: max - min, biome: gen.biomeAt(c.cx, c.cz) };
  return c.ev;
}

export function generateCamps(
  gen: TerrainGenerator,
  seed: number,
  count = 5,
  minDistFromSpawn = 40,
): CampSite[] {
  const rng = mulberry32((seed ^ CAMP_SALT) >>> 0);
  const [sx, sz] = gen.findSpawn();

  // Deterministic candidate cloud, built once so relaxation passes never shift the RNG stream.
  // Sunflower spiral outward from spawn (area-uniform via sqrt), jittered.
  const maxR = WORLD_SIZE * 0.5 - 8;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const cands: Cand[] = [];
  for (let i = 0; i < CANDIDATES; i++) {
    const t = (i + 0.5) / CANDIDATES;
    const ring = minDistFromSpawn + (maxR - minDistFromSpawn) * Math.sqrt(t);
    const ang = i * golden + rng() * 0.35;
    const jr = ring + (rng() - 0.5) * 12;
    cands.push({
      cx: wrapBlock(Math.round(sx + Math.cos(ang) * jr)),
      cz: wrapBlock(Math.round(sz + Math.sin(ang) * jr)),
      radius: MIN_RADIUS + Math.floor(rng() * (MAX_RADIUS - MIN_RADIUS + 1)),
      mtnRoll: rng(),
    });
  }

  const picked: CampSite[] = [];
  for (let limit = BASE_FLATNESS; limit <= MAX_FLATNESS && picked.length < count; limit++) {
    for (const c of cands) {
      if (picked.length >= count) break;
      if (torusDist(c.cx, c.cz, sx, sz) < minDistFromSpawn) continue;

      const ev = evaluate(gen, c);
      if (ev.biome === Biome.SNOW) continue;
      if (ev.biome === Biome.MOUNTAINS && c.mtnRoll >= MOUNTAIN_ODDS) continue;
      if (ev.min <= gen.sea + DRY_MARGIN) continue; // whole footprint is dry land
      if (ev.flatness > limit) continue;

      let clash = false;
      for (const p of picked) {
        if (torusDist(c.cx, c.cz, p.cx, p.cz) < (p.radius + c.radius) * 1.5) { clash = true; break; }
      }
      if (clash) continue;

      picked.push({
        id: 0, cx: c.cx, cz: c.cz, radius: c.radius,
        y: ev.y, biome: ev.biome, flatness: ev.flatness,
      });
    }
  }

  // The strict pass intentionally prefers broad, flat plains, but unusual
  // planet seeds can have no five-way set that satisfies every biome rule.
  // Do not return an empty or half-empty world: relax only the cosmetic
  // constraints while keeping a genuinely dry footprint and spacing camps.
  if (picked.length < count) {
    for (const c of cands) {
      if (picked.length >= count) break;
      const ev = evaluate(gen, c);
      // At this last-resort tier, dry land is the only hard requirement. A
      // steep or snowy planet can still host a camp; rejecting it here was
      // the reason some deterministic worlds returned zero sites.
      if (ev.min <= gen.sea + 1) continue;
      let clash = false;
      for (const p of picked) {
        if (torusDist(c.cx, c.cz, p.cx, p.cz) < (p.radius + c.radius) * 1.15) { clash = true; break; }
      }
      if (clash) continue;
      picked.push({
        id: 0, cx: c.cx, cz: c.cz, radius: c.radius,
        y: ev.y, biome: ev.biome, flatness: ev.flatness,
      });
    }
  }

  picked.sort((a, b) =>
    torusDist(a.cx, a.cz, sx, sz) - torusDist(b.cx, b.cz, sx, sz) ||
    a.cx - b.cx || a.cz - b.cz);
  picked.forEach((s, i) => { s.id = i; });
  return picked;
}

/* ── Task 2: voxel camp construction ───────────────────────────── */

export interface CampBuild {
  site: CampSite;
  patrolPoints: { x: number; z: number }[];
  fires: { x: number; y: number; z: number }[];
  posts: { x: number; z: number }[];
}

const BUILD_SALT = 0x5bf03635;

function groundY(world: World, x: number, z: number): number {
  return world.gen.heightAt(wrapBlock(x), wrapBlock(z));
}

/** never build on/над water */
function dry(world: World, x: number, z: number): boolean {
  const h = groundY(world, x, z);
  if (h <= world.gen.sea) return false;
  return world.getBlockRaw(wrapBlock(x), h, wrapBlock(z)) !== B.WATER;
}

/** wrapped, guarded write. skips existing solids unless `force`; BEDROCK/WATER are untouchable */
function place(world: World, x: number, y: number, z: number, id: number, force = false): boolean {
  if (y < 1 || y >= WORLD_HEIGHT) return false;
  const wx = wrapBlock(x), wz = wrapBlock(z);
  const cur = world.getBlockRaw(wx, y, wz);
  if (cur === B.BEDROCK || cur === B.WATER) return false;
  if (!force && cur !== B.AIR && cur !== -1 && world.isSolid(wx, y, wz)) return false;
  world.setBlock(wx, y, wz, id);
  return true;
}

/** 3×3×2 A-frame; axis 0 = runs along X, 1 = along Z. Front (l = +1) left open as a door. */
function buildTent(world: World, ox: number, oz: number, axis: 0 | 1, wallId: number): void {
  if (!dry(world, ox, oz)) return;
  const h = groundY(world, ox, oz);
  for (let l = -1; l <= 1; l++) {
    const lx = axis === 0 ? l : 0, lz = axis === 0 ? 0 : l;
    place(world, ox + lx, h + 2, oz + lz, B.LOG, true);            // ridge beam
    for (const s of [-1, 1]) {
      const sx = axis === 0 ? 0 : s, sz = axis === 0 ? s : 0;
      place(world, ox + lx + sx, h + 1, oz + lz + sz, wallId, true); // sloped walls
    }
    place(world, ox + lx, h + 1, oz + lz, B.AIR, true);             // hollow interior
  }
  const bx = axis === 0 ? -1 : 0, bz = axis === 0 ? 0 : -1;
  place(world, ox + bx, h + 1, oz + bz, wallId, true);              // back flap
  for (const s of [-1, 1]) {                                        // corner pegs
    const sx = axis === 0 ? 0 : s, sz = axis === 0 ? s : 0;
    place(world, ox + bx + sx, h + 1, oz + bz + sz, B.LOG, true);
  }
}

function buildWatchpost(world: World, ox: number, oz: number): void {
  const h = groundY(world, ox, oz);
  const corners: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (const [dx, dz] of corners)
    for (let y = h + 1; y <= h + 3; y++) place(world, ox + dx, y, oz + dz, B.LOG, true);
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) place(world, ox + dx, h + 4, oz + dz, B.PLANKS, true);
  for (const [dx, dz] of corners) place(world, ox + dx, h + 5, oz + dz, B.LOG, true);
}

/** returns the flame position (one block above the top of the pile) */
function buildFire(world: World, ox: number, oz: number): { x: number; y: number; z: number } {
  const h = groundY(world, ox, oz);
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) place(world, ox + dx, h, oz + dz, B.GRAVEL, true);
  for (const [dx, dz] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const)
    place(world, ox + dx, h + 1, oz + dz, B.STONE, true);           // stone ring
  place(world, ox, h + 1, oz, B.LOG, true);                          // fuel
  return { x: wrapBlock(ox), y: h + 2, z: wrapBlock(oz) };
}

export function buildCamp(world: World, site: CampSite, seed: number): CampBuild {
  const rng = mulberry32(((seed ^ BUILD_SALT) + site.id * 0x9e3779b1 + site.cx * 73856093 + site.cz * 19349663) >>> 0);
  const { cx, cz, radius: r } = site;
  const fires: CampBuild['fires'] = [];
  const posts: CampBuild['posts'] = [];
  const patrolPoints: CampBuild['patrolPoints'] = [];

  // ── fence: LOG posts every ~3 blocks + PLANKS rails, with one 2-post gate gap
  const nPosts = Math.max(8, Math.round((2 * Math.PI * r) / 3));
  const gate = Math.floor(rng() * nPosts);
  const ringPt = (a: number, rad: number) => ({
    x: cx + Math.round(Math.cos(a) * rad),
    z: cz + Math.round(Math.sin(a) * rad),
  });
  for (let i = 0; i < nPosts; i++) {
    if (i === gate || i === (gate + 1) % nPosts) continue;
    const a = (i / nPosts) * Math.PI * 2;
    const p = ringPt(a, r);
    if (!dry(world, p.x, p.z)) continue;
    const h = groundY(world, p.x, p.z);
    place(world, p.x, h + 1, p.z, B.LOG);
    place(world, p.x, h + 2, p.z, B.LOG);
    if (i + 1 === gate || (i + 1) % nPosts === gate) continue;      // no rail into the gate
    for (let t = 1; t <= 2; t++) {                                   // rails toward next post
      const q = ringPt(a + (t / 3) * ((Math.PI * 2) / nPosts), r);
      if (!dry(world, q.x, q.z)) continue;
      place(world, q.x, groundY(world, q.x, q.z) + 2, q.z, B.PLANKS);
    }
  }

  // ── central campfire (+ a second one in bigger camps)
  if (dry(world, cx, cz)) fires.push(buildFire(world, cx, cz));
  if (r >= 15) {
    const a = rng() * Math.PI * 2, p = ringPt(a, Math.round(r * 0.5));
    if (dry(world, p.x, p.z)) fires.push(buildFire(world, p.x, p.z));
  }

  // ── braziers flanking the gate (light + landmark)
  for (const off of [-1, 2]) {
    const a = ((gate + off) / nPosts) * Math.PI * 2;
    const p = ringPt(a, r - 2);
    if (!dry(world, p.x, p.z)) continue;
    const h = groundY(world, p.x, p.z);
    place(world, p.x, h + 1, p.z, B.LOG, true);
    place(world, p.x, h + 2, p.z, B.LOG, true);
    place(world, p.x, h + 3, p.z, B.GRAVEL, true);
    fires.push({ x: wrapBlock(p.x), y: h + 4, z: wrapBlock(p.z) });
  }

  // ── 2–3 tents on an inner ring
  const nTents = 2 + (rng() < 0.6 ? 1 : 0);
  const tentBase = rng() * Math.PI * 2;
  for (let i = 0; i < nTents; i++) {
    const a = tentBase + (i / nTents) * Math.PI * 2 + (rng() - 0.5) * 0.4;
    const p = ringPt(a, Math.round(r * 0.55));
    buildTent(world, p.x, p.z, rng() < 0.5 ? 0 : 1, rng() < 0.3 ? B.LEAVES : B.PLANKS);
  }

  // ── 3–6 scattered crates (PLANKS box, LOG-capped stacks)
  const nCrates = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < nCrates; i++) {
    const a = rng() * Math.PI * 2, rad = Math.round((0.25 + rng() * 0.5) * r);
    const p = ringPt(a, rad);
    if (!dry(world, p.x, p.z)) continue;
    const h = groundY(world, p.x, p.z);
    if (!place(world, p.x, h + 1, p.z, B.PLANKS)) continue;
    if (rng() < 0.35) place(world, p.x, h + 2, p.z, B.LOG);
  }

  // ── 2–3 watchposts near the perimeter; defenders stand on clear ground just inside
  const nGuard = 2 + (rng() < 0.5 ? 1 : 0);
  const guardBase = rng() * Math.PI * 2;
  for (let i = 0; i < nGuard; i++) {
    const a = guardBase + (i / nGuard) * Math.PI * 2;
    const p = ringPt(a, Math.round(r * 0.85));
    if (!dry(world, p.x, p.z)) continue;
    buildWatchpost(world, p.x, p.z);
    const s = ringPt(a, Math.round(r * 0.85) - 3);
    if (dry(world, s.x, s.z)) posts.push({ x: wrapBlock(s.x), z: wrapBlock(s.z) });
  }

  // ── patrol ring, sampled AFTER building so it never lands inside a structure
  const N_PATROL = 8;
  const rot = rng() * Math.PI * 2;
  for (let i = 0; i < N_PATROL; i++) {
    const a = rot + (i / N_PATROL) * Math.PI * 2;
    for (let pull = 0; pull < 4; pull++) {
      const rad = Math.max(3, Math.round(r * 0.7) - pull * 2);
      const p = ringPt(a, rad);
      if (!dry(world, p.x, p.z)) continue;
      const wx = wrapBlock(p.x), wz = wrapBlock(p.z), h = groundY(world, wx, wz);
      if (world.isSolid(wx, h + 1, wz) || world.isSolid(wx, h + 2, wz)) continue;
      patrolPoints.push({ x: wx, z: wz });
      break;
    }
  }

  return { site, patrolPoints, fires, posts };
}

export function buildCamps(world: World, sites: CampSite[], seed: number): CampBuild[] {
  return sites.map((s) => buildCamp(world, s, seed));
}
