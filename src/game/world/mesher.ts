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

const FACES: Face[] = [
  { dir: [1, 0, 0], shade: 0.6, corners: [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]] },
  { dir: [-1, 0, 0], shade: 0.6, corners: [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.5, corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
  { dir: [0, 0, 1], shade: 0.8, corners: [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]] },
  { dir: [0, 0, -1], shade: 0.8, corners: [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]] },
];

const AO_SHADE = [0.55, 0.72, 0.86, 1.0];

interface Bucket {
  pos: number[];
  nrm: number[];
  uv: number[];
  col: number[];
  flow: number[]; // per-vertex uv-space flow velocity (water only)
  idx: number[];
  base: number;
}

const newBucket = (): Bucket => ({ pos: [], nrm: [], uv: [], col: [], flow: [], idx: [], base: 0 });

/** shared shader-time uniform for the animated water flow */
export const WATER_TIME = { value: 0 };

export interface ChunkGeoms {
  opaque?: THREE.BufferGeometry;
  cutout?: THREE.BufferGeometry;
  water?: THREE.BufferGeometry;
}

function buildGeom(b: Bucket, withFlow = false): THREE.BufferGeometry | undefined {
  if (b.base === 0) return undefined;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(b.col, 3));
  if (withFlow) g.setAttribute('aFlow', new THREE.Float32BufferAttribute(b.flow, 2));
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
        const id = data[chunkIndex(x, y, z)];
        if (id === B.AIR) continue;
        const d = DEFS[id];

        if (d.cross) {
          emitCross(cutoutB, x, y, z, d.side);
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

          // corner positions: (0,0)=E-corner(x+0,z+0) SE, (1,0)=SW, (1,1)=NW, (0,1)=NE — see corner index mapping below
          let ci = 0;
          for (let dz = 0; dz < 2; dz++) {
            for (let dx = 0; dx < 2; dx++, ci++) {
              // the 4 cells touching this corner: (x,z), (x+sx,z), (x,z+sz), (x+sx,z+sz)
              const sx = dx ? 1 : -1;
              const sz = dz ? 1 : -1;
              // any water above the 4 cells -> full height
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
                  // unloaded: blend toward own level to avoid border seams
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
                // air directly over water transfers drainage downward (pour-over dip)
                if (nid === B.AIR) {
                  const bi = waterInfo(localGet(x + nx, y - 1, z + nz));
                  if (bi) {
                    sum += waterHeight(bi.level, bi.falling) - 1;
                    cnt++;
                  }
                }
                // solid / air over solid: excluded -> crisp flat shorelines
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
          const nid = localGet(nx, ny, nz);
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

  return { opaque: buildGeom(opaqueB), cutout: buildGeom(cutoutB), water: buildGeom(waterB, true) };
}

/** two diagonal quads (plants) — full-bright, double-sided rendering */
function emitCross(bucket: Bucket, x: number, y: number, z: number, tile: number): void {
  const m = 0.15;
  const [u0, v0, u1, v1] = tileUV(tile);
  const quads: { x0: number; z0: number; x1: number; z1: number; n: [number, number, number] }[] = [
    { x0: x + m, z0: z + m, x1: x + 1 - m, z1: z + 1 - m, n: [-0.707, 0, 0.707] },
    { x0: x + 1 - m, z0: z + m, x1: x + m, z1: z + 1 - m, n: [0.707, 0, 0.707] },
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
    for (let i = 0; i < 4; i++) bucket.col.push(0.95, 0.95, 0.95);
    bucket.idx.push(vbase, vbase + 1, vbase + 2, vbase, vbase + 2, vbase + 3);
    bucket.base += 4;
  }
}
