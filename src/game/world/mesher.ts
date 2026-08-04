/**
 * Chunk mesher. Converts a chunk's voxel data into (up to) three merged
 * BufferGeometries: opaque, alpha-cutout, and translucent water.
 *
 * Features:
 *  - hidden-face culling against neighboring chunk data
 *  - per-face directional shading (Minecraft-style: top brightest)
 *  - per-vertex ambient occlusion with flipped-quad anisotropy fix
 *  - lowered water surface + cross-quad plants
 */

import * as THREE from 'three';
import { CHUNK_SIZE as S, WORLD_HEIGHT as H, chunkIndex } from '../core/constants';
import { tileUV } from '../core/textures';
import { B, DEFS, isWaterId, waterHeight, waterInfo } from './blocks';

/** world-space block lookup; -1 = chunk not loaded (treated as occluder) */
export type BlockGetter = (wx: number, wy: number, wz: number) => number;

interface Face {
  dir: [number, number, number];
  corners: [number, number, number][]; // ordered TL, BL, BR, TR seen from outside
  shade: number;
}

// ---- Directional face shading ----
// These vertex-colour multipliers simulate the sky-dome light distribution
// on each face normal. They multiply on top of Lambert, so the effective
// range must be kept tight or shadows become unrealistically dark.
//
// Physical reference (overcast sky, all faces lit by the hemisphere):
//   Top    = 1.00 (full sky dome overhead)
//   Sides  = 0.76 (roughly half the sky visible from a vertical face)
//   Bottom = 0.62 (ground-bounce only; sky fully occluded)
//
// We keep a gentle variation (1.00→0.62, ratio 1.61:1) so blocks read as
// three-dimensional without crushing the dark faces to black.  With ACES
// even a 2:1 face-shade ratio was enough to destroy bottom-face detail;
// Reinhard handles 2.5:1 comfortably but we err on the side of subtlety.
const FACES: Face[] = [
  { dir: [1, 0, 0], shade: 0.76, corners: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] },
  { dir: [-1, 0, 0], shade: 0.76, corners: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
  { dir: [0, 1, 0], shade: 1.00, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.62, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], shade: 0.82, corners: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
  { dir: [0, 0, -1], shade: 0.70, corners: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
];

// ---- Ambient occlusion shade levels ----
// AO darkens corners/crevices where light is occluded from multiple sides.
// The range 0.68→1.0 (ratio 1.47:1) gives clear contact shadow at tight
// block joins while avoiding the "ink-black crevice" look that ACES caused.
// Full occlusion (3 neighbours blocking) gives 0.68, not 0.55.
const AO_SHADE = [0.68, 0.80, 0.91, 1.0];

/**
 * Flat-array index deltas for the six FACES directions, in the same order.
 * chunkIndex(x, y, z) = (y * S + z) * S + x, so x steps by 1, z by S and
 * y by S².
 */
const NEIGHBOR_STRIDE = [1, -1, S * S, -(S * S), S, -S];

interface Bucket {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  flow: number[]; // per-vertex uv-space flow velocity (water only)
  sway: number[]; // vec4: phase, strength, top-weight, flutter
  idx: number[];
  base: number;
}

const newBucket = (): Bucket => ({ pos: [], nrm: [], uv: [], col: [], flow: [], sway: [], idx: [], base: 0 });

/** shared shader-time uniform for the animated water flow */
export const WATER_TIME = { value: 0 };
/** shared shader-time uniform for procedural grass/plant sway */
export const GRASS_TIME = { value: 0 };
/** camera position, so the vertex shader can distance-cull grass blades */
export const GRASS_CAM = { value: new THREE.Vector3() };
/** x = fade start distance, y = fully-collapsed distance (blocks) */
export const GRASS_FADE = { value: new THREE.Vector2(26, 46) };

export interface ChunkGeoms {
  opaque?: THREE.BufferGeometry;
  cutout?: THREE.BufferGeometry;
  water?: THREE.BufferGeometry;
}

function buildGeom(b: Bucket, withFlow = false, withSway = false): THREE.BufferGeometry | undefined {
  if (b.base === 0) return undefined;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  if (withFlow) g.setAttribute('aFlow', new THREE.Float32BufferAttribute(b.flow, 2));
  if (withSway) g.setAttribute('aSway', new THREE.Float32BufferAttribute(b.sway, 4));
  g.setIndex(b.idx);
  g.computeBoundingSphere();
  return g;
}

export function buildChunkGeometry(get: BlockGetter, cx: number, cz: number, data: Uint8Array): ChunkGeoms {
  const opaqueB = newBucket();
  const cutoutB = newBucket();
  const waterB = newBucket();
  const baseX = cx * S;
  const baseZ = cz * S;

  const localGet = (lx: number, ly: number, lz: number): number => {
    if (ly < 0) return B.BEDROCK;
    if (ly >= H) return B.AIR;
    if (lx >= 0 && lx < S && lz >= 0 && lz < S) return data[chunkIndex(lx, ly, lz)];
    return get(baseX + lx, ly, baseZ + lz);
  };

  const occludes = (lx: number, ly: number, lz: number): boolean => {
    const id = localGet(lx, ly, lz);
    if (id === -1) return true;
    return DEFS[id].opaque || id === B.LEAVES;
  };

  for (let y = 0; y < H; y++) {
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const idx = chunkIndex(x, y, z);
        const id = data[idx];
        if (id === B.AIR) continue;
        const d = DEFS[id];
        // Interior voxels (the overwhelming majority — only the 1-block shell
        // of a chunk can reach into a neighbour) can read their six face
        // neighbours straight out of `data` with constant strides, skipping
        // the bounds-checked cross-chunk getter for every face test.
        const interior = x > 0 && x < S - 1 && z > 0 && z < S - 1 && y > 0 && y < H - 1;

        if (d.cross) {
          if (id === B.TALLGRASS) emitTallGrass(cutoutB, x, y, z, d.side, baseX + x, baseZ + z);
          else emitCross(cutoutB, x, y, z, d.side, id === B.FLOWER_RED || id === B.FLOWER_YELLOW ? 0.018 : 0.028, baseX + x, baseZ + z);
          continue;
        }

        const isWater = !!d.water;
        const bucket = isWater ? waterB : d.cutout ? cutoutB : opaqueB;

        // ---- water surface + flow ----
        // Vanilla-style corner heights, symmetric per corner so adjacent
        // cells agree (seamless), with "air-over-water" transfer so surfaces
        // dip where water pours over a lip instead of drooping like rubber.
        let cornerH: [number, number, number, number] = [1, 1, 1, 1];
        let flowX = 0;
        let flowZ = 0;
        let falling = false;
        if (isWater) {
          const info = waterInfo(id)!;
          const hSelf = waterHeight(info.level, info.falling);
          falling = info.falling;

          let ci = 0;
          for (let dz = 0; dz < 2; dz++) {
            for (let dx = 0; dx < 2; dx++, ci++) {
              const sx = dx ? 1 : -1;
              const sz = dz ? 1 : -1;
              let above = false;
              for (const [nx, nz] of [[0, 0], [sx, 0], [0, sz], [sx, sz]] as const) {
                if (isWaterId(localGet(x + nx, y + 1, z + nz))) above = true;
              }
              if (above) {
                cornerH[ci] = 1;
                continue;
              }
              let sum = 0;
              let cnt = 0;
              for (const [nx, nz] of [[0, 0], [sx, 0], [0, sz], [sx, sz]] as const) {
                const nid = localGet(x + nx, y, z + nz);
                if (nid === -1) {
                  sum += hSelf;
                  cnt++;
                  continue;
                }
                const ni = waterInfo(nid);
                if (ni) {
                  sum += waterHeight(ni.level, ni.falling);
                  cnt++;
                  continue;
                }
                if (nid === B.AIR) {
                  const bi = waterInfo(localGet(x + nx, y - 1, z + nz));
                  if (bi) {
                    sum += waterHeight(bi.level, bi.falling) - 1;
                    cnt++;
                  }
                }
              }
              cornerH[ci] = cnt ? Math.max(0, Math.min(1, sum / cnt)) : hSelf;
            }
          }

          // flow direction: toward the pour-over edge, or toward the lowest
          // neighboring level; pools stay still
          const belowId = localGet(x, y - 1, z);
          const belowReplaceable = belowId === B.AIR || (belowId !== -1 && DEFS[belowId].cross === true);
          let bestDir: [number, number] | null = null;
          let bestScore = -1;
          for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
            const nid = localGet(x + ox, y, z + oz);
            const ni = waterInfo(nid);
            let score = -1;
            if (belowReplaceable && (nid === B.AIR || (nid !== -1 && DEFS[nid].cross === true))) {
              score = 3; // pours over this edge: strongest pull
            } else if (ni && !ni.falling && ni.level > info.level) {
              score = 2 - (ni.level - info.level) * 0.1; // downhill
            }
            if (score > bestScore) {
              bestScore = score;
              bestDir = [ox, oz];
            }
          }
          if (bestDir) {
            const speed = falling ? 0.25 : 0.10 + 0.05 * Math.min(info.level, 3);
            flowX = bestDir[0] * speed;
            flowZ = bestDir[1] * speed;
          }
        }

        for (let fi = 0; fi < 6; fi++) {
          const f = FACES[fi];
          const nx = x + f.dir[0];
          const ny = y + f.dir[1];
          const nz = z + f.dir[2];
          const nid = interior ? data[idx + NEIGHBOR_STRIDE[fi]] : localGet(nx, ny, nz);
          if (nid === -1) continue;
          const nd = DEFS[nid];

          let visible: boolean;
          if (isWater) visible = !isWaterId(nid) && !nd.opaque;
          else if (d.cutout) visible = nid !== id && !nd.opaque;
          else visible = !nd.opaque;
          if (!visible) continue;

          const tile = f.dir[1] === 1 ? d.top : f.dir[1] === -1 ? d.bottom : d.side;
          const [u0, v0, u1, v1] = tileUV(tile);
          // water uses its own full-face standalone texture (not atlas space)
          const us = isWater ? [0, 0, 1, 1] : [u0, u0, u1, u1];
          const vs = isWater ? [1, 0, 0, 1] : [v1, v0, v0, v1];

          const doAO = !isWater && !d.cutout;
          // map world flow (fx,fz) to this face's uv axes; falling water rushes down
          let fu = 0;
          let fv = 0;
          if (isWater) {
            fv = falling ? -0.55 : 0;
            switch (fi) {
              case 2: case 3: fu = flowX; fv += flowZ; break; // top/bottom: u∝x, v∝z
              case 0: fu = -flowZ; break; // +x face: u∝-z
              case 1: fu = flowZ; break; // -x face: u∝+z
              case 4: fu = flowX; break; // +z face: u∝+x
              case 5: fu = -flowX; break; // -z face: u∝-x
            }
          }
          const t1 = f.dir[0] !== 0 ? 1 : 0;
          const t2 = f.dir[0] !== 0 ? 2 : f.dir[1] !== 0 ? 2 : 1;
          const ex = x + f.dir[0];
          const ey = y + f.dir[1];
          const ez = z + f.dir[2];

          const vbase = bucket.base;
          const aos = [0, 0, 0, 0];

          for (let ci = 0; ci < 4; ci++) {
            const c = f.corners[ci];
            const vTop = isWater ? cornerH[c[0] + c[2] * 2] : 1;
            bucket.pos.push(x + c[0], y + (c[1] ? vTop : 0), z + c[2]);
            bucket.nrm.push(f.dir[0], f.dir[1], f.dir[2]);
            bucket.uv.push(us[ci], vs[ci]);
            if (isWater) bucket.flow.push(fu, fv);
            if (bucket === cutoutB) bucket.sway.push(0, 0, 0, 0);

            let shade = f.shade;
            if (doAO) {
              const d1: [number, number, number] = [ex, ey, ez];
              const d2: [number, number, number] = [ex, ey, ez];
              d1[t1] += c[t1] ? 1 : -1;
              d2[t2] += c[t2] ? 1 : -1;
              const o1 = occludes(d1[0], d1[1], d1[2]);
              const o2 = occludes(d2[0], d2[1], d2[2]);
              const oc = occludes(
                ex + (d1[0] - ex) + (d2[0] - ex),
                ey + (d1[1] - ey) + (d2[1] - ey),
                ez + (d2[2] - ez) + (d1[2] - ez)
              );
              const ao = o1 && o2 ? 0 : 3 - ((o1 ? 1 : 0) + (o2 ? 1 : 0) + (oc ? 1 : 0));
              aos[ci] = ao;
              shade *= AO_SHADE[ao];
            }
            bucket.col.push(shade, shade, shade);
          }

          if (doAO && aos[0] + aos[2] < aos[1] + aos[3]) {
            bucket.idx.push(vbase, vbase + 1, vbase + 3, vbase + 1, vbase + 2, vbase + 3);
          } else {
            bucket.idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
          }
          bucket.base += 4;
        }
      }
    }
  }

  return { opaque: buildGeom(opaqueB), cutout: buildGeom(cutoutB, false, true), water: buildGeom(waterB, true) };
}

/** two diagonal quads (plants) — full-bright, double-sided rendering */
function emitCross(bucket: Bucket, x: number, y: number, z: number, tile: number, swayStrength = 0, wx = x, wz = z): void {
  const m = 0.15;
  const [u0, v0, u1, v1] = tileUV(tile);
  const phase = hashPlant(wx, y, wz, 11) * Math.PI * 2;
  // Same upward normal bias as tallgrass so flower quads respond to sun and
  // shadow the same way the ground block they grow from does. Without this
  // bloom clusters look like glowing patches when the terrain is shadowed.
  const upBias = 0.78;
  const horiz = 1 - upBias;
  const n1x = -0.707 * horiz, n1z = 0.707 * horiz;
  const n2x =  0.707 * horiz, n2z = 0.707 * horiz;
  const n1l = Math.hypot(n1x, upBias, n1z) || 1;
  const n2l = Math.hypot(n2x, upBias, n2z) || 1;
  const quads: { x0: number; z0: number; x1: number; z1: number; n: [number, number, number] }[] = [
    { x0: x + m, z0: z + m, x1: x + 1 - m, z1: z + 1 - m,
      n: [n1x / n1l, upBias / n1l, n1z / n1l] },
    { x0: x + 1 - m, z0: z + m, x1: x + m, z1: z + 1 - m,
      n: [n2x / n2l, upBias / n2l, n2z / n2l] },
  ];
  for (const q of quads) {
    const vbase = bucket.base;
    bucket.pos.push(
      q.x0, y, q.z0,
      q.x0, y + 1, q.z0,
      q.x1, y + 1, q.z1,
      q.x1, y, q.z1
    );
    for (let i = 0; i < 4; i++) bucket.nrm.push(q.n[0], q.n[1], q.n[2]);
    bucket.uv.push(u0, v0, u0, v1, u1, v1, u1, v0);
    // Root (verts 0, 3) darker so stems blend into the ground they emerge
    // from; petals up top stay at full brightness.
    const root = 0.62, tip = 0.98;
    bucket.col.push(
      root, root, root,
      tip,  tip,  tip,
      tip,  tip,  tip,
      root, root, root,
    );
    bucket.sway.push(
      phase, swayStrength, 0, 0,
      phase, swayStrength, 1, 0.5,
      phase, swayStrength, 1, 0.5,
      phase, swayStrength, 0, 0,
    );
    bucket.idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    bucket.base += 4;
  }
}

function hashPlant(x: number, y: number, z: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(y | 0, 0x9e3779b1) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Procedural tall grass clump: each block grows 4-7 independent blades with
 * unique height/width/angle/lean. The atlas alpha still provides blade cutouts,
 * but the geometry silhouette now differs block-to-block, and each top vertex
 * carries its own sway phase so nearby clumps never move in lockstep.
 */
function emitTallGrass(bucket: Bucket, x: number, y: number, z: number, tile: number, wx: number, wz: number): void {
  const [u0, v0, u1, v1] = tileUV(tile);
  const seed = hashPlant(wx, y, wz, 101);
  // 5-7 blades: packed tight enough to form a solid clump once blades are wider,
  // but avoiding the 8-12 extra quads per block that a larger count would spend.
  const blades = 5 + Math.floor(seed * 3);
  for (let i = 0; i < blades; i++) {
    const r0 = hashPlant(wx, y, wz, 200 + i * 7);
    const r1 = hashPlant(wx, y, wz, 201 + i * 7);
    const r2 = hashPlant(wx, y, wz, 202 + i * 7);
    const r3 = hashPlant(wx, y, wz, 203 + i * 7);
    const r4 = hashPlant(wx, y, wz, 204 + i * 7);
    const cx = x + 0.18 + r0 * 0.64;
    const cz = z + 0.18 + r1 * 0.64;
    const ang = r2 * Math.PI * 2;
    const h = 0.5 + r3 * 0.78;
    const w = 0.13 + r4 * 0.13;
    const lean = (hashPlant(wx, y, wz, 205 + i * 7) - 0.5) * 0.2;
    const dx = Math.cos(ang) * w;
    const dz = Math.sin(ang) * w;
    const lx = Math.cos(ang + Math.PI / 2) * lean;
    const lz = Math.sin(ang + Math.PI / 2) * lean;
    const phase = hashPlant(wx, y, wz, 206 + i * 7) * Math.PI * 2;
    const strength = 0.07 + hashPlant(wx, y, wz, 207 + i * 7) * 0.06;
    // Tip stays close to the grass-top surface colour; the root is darker
    // so the base of every blade visually blends into the ground it grows
    // from instead of sticking out as a bright line. The gradient also
    // gives each blade a natural sense of depth.
    const tipShade  = 0.96 + hashPlant(wx, y, wz, 208 + i * 7) * 0.16;
    const rootShade = tipShade * 0.62;
    const vbase = bucket.base;

    bucket.pos.push(
      cx - dx, y, cz - dz,
      cx - dx + lx, y + h, cz - dz + lz,
      cx + dx + lx, y + h * (0.9 + r1 * 0.14), cz + dz + lz,
      cx + dx, y, cz + dz,
    );
    // Bias the blade normal STRONGLY upward. A horizontal normal reflects
    // overhead sunlight poorly and — worse — makes Lambert's shadow-map
    // response almost invisible on grass, so shadowed ground reads as dark
    // while the blades on top stay bright. A mostly-up normal lets each
    // blade respond to sun + shadows exactly like the grass_top surface.
    const upBias = 0.82;
    const horiz = 1 - upBias;
    const nnx = Math.sin(ang) * horiz;
    const nnz = -Math.cos(ang) * horiz;
    const nlen = Math.hypot(nnx, upBias, nnz) || 1;
    const nx = nnx / nlen, ny = upBias / nlen, nz = nnz / nlen;
    for (let k = 0; k < 4; k++) bucket.nrm.push(nx, ny, nz);
    bucket.uv.push(u0, v0, u0, v1, u1, v1, u1, v0);
    // Root (vertices 0, 3) darker; tip (1, 2) at full tipShade.
    bucket.col.push(
      rootShade, rootShade, rootShade,
      tipShade,  tipShade,  tipShade,
      tipShade,  tipShade,  tipShade,
      rootShade, rootShade, rootShade,
    );
    // w carries the blade height so the vertex shader can collapse distant
    // blades back into the ground (cheap LOD without re-meshing chunks).
    bucket.sway.push(
      phase, strength, 0, h,
      phase, strength, 1, h,
      phase, strength, 1, h,
      phase, strength, 0, h,
    );
    bucket.idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    bucket.base += 4;
  }
}
