// Voxel world: minecraft-style terrain, chunked meshes with hidden-face culling,
// per-face shading, DDA raycasting and real-time block destruction.
import * as THREE from 'three';
import { buildAtlas, tileUV, T } from './textures';
import { makeNoise2D, fbm } from './noise';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, SANDSTONE: 5,
  LOG: 6, LEAVES: 7, CACTUS: 8, PLANK: 9, ORE: 10, COBBLE: 11, WOOL: 12, BEDROCK: 13,
  CRAFTING_TABLE: 14, GLASS: 15, FURNACE: 16,
  COAL: 58, STICK: 59, TORCH: 60,
} as const;

const SIZE = 96;         // x/z extent
export const WORLD_SIZE = SIZE;
const HEIGHT = 44;       // y extent
export const WORLD_HEIGHT = HEIGHT;
const CHUNK = 16;

interface FaceDef { dir: [number, number, number]; shade: number; corners: [number, number, number][] }

const FACES: FaceDef[] = [
  { dir: [1, 0, 0], shade: 0.62, corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
  { dir: [-1, 0, 0], shade: 0.62, corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
  { dir: [0, 1, 0], shade: 1.0, corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]] },
  { dir: [0, -1, 0], shade: 0.45, corners: [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]] },
  { dir: [0, 0, 1], shade: 0.8, corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
  { dir: [0, 0, -1], shade: 0.8, corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
];

function tileFor(block: number, dy: number): number {
  switch (block) {
    case B.GRASS: return dy === 1 ? T.GRASS_TOP : dy === -1 ? T.DIRT : T.GRASS_SIDE;
    case B.DIRT: return T.DIRT;
    case B.STONE: return T.STONE;
    case B.SAND: return T.SAND;
    case B.SANDSTONE: return dy === 1 ? T.SANDSTONE_TOP : T.SANDSTONE;
    case B.LOG: return dy !== 0 ? T.LOG_TOP : T.LOG_SIDE;
    case B.LEAVES: return T.LEAVES;
    case B.CACTUS: return dy !== 0 ? T.CACTUS_TOP : T.CACTUS_SIDE;
    case B.PLANK: return T.PLANK;
    case B.ORE: return T.ORE;
    case B.COBBLE: return T.COBBLE;
    case B.WOOL: return T.TARGET_WOOL;
    case B.BEDROCK: return T.COBBLE;
    case B.CRAFTING_TABLE: return T.CRAFT_TOP;
    case B.GLASS: return T.GLASS;
    case B.FURNACE: return T.FURNACE;
    default: return T.STONE;
  }
}

export const BLOCK_COLORS: Record<number, number> = {
  [B.GRASS]: 0x5faa3c, [B.DIRT]: 0x7a5a38, [B.STONE]: 0x82858a,
  [B.SAND]: 0xddd3a0, [B.SANDSTONE]: 0xd8cd9c, [B.LOG]: 0x6b5136,
  [B.LEAVES]: 0x3f7a2b, [B.CACTUS]: 0x3f8f3f, [B.PLANK]: 0xa1814f,
  [B.ORE]: 0xe8b93c, [B.COBBLE]: 0x7d7f82, [B.WOOL]: 0xe8e6df, [B.BEDROCK]: 0x333336,
  [B.CRAFTING_TABLE]: 0xa48150, [B.GLASS]: 0xcee8f5, [B.FURNACE]: 0x7c7c80,
};

export interface RayHit {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  block: number;
  x: number; y: number; z: number;
  dist: number;
}

interface Chunk { mesh: THREE.Mesh | null; dirty: boolean }

export class World {
  group = new THREE.Group();
  private data = new Uint8Array(SIZE * HEIGHT * SIZE);
  private chunks = new Map<string, Chunk>();
  private material: THREE.MeshLambertMaterial;
  spawn = new THREE.Vector3(SIZE / 2 + 0.5, 12, SIZE / 2 + 0.5);

  constructor() {
    const atlas = buildAtlas();
    this.material = new THREE.MeshLambertMaterial({ map: atlas, vertexColors: true });
    this.generate();
    for (let cx = 0; cx < SIZE / CHUNK; cx++) {
      for (let cz = 0; cz < SIZE / CHUNK; cz++) {
        const key = `${cx},${cz}`;
        const chunk: Chunk = { mesh: null, dirty: true };
        this.chunks.set(key, chunk);
        this.rebuildChunk(cx, cz);
      }
    }
  }

  private idx(x: number, y: number, z: number) { return (y * SIZE + z) * SIZE + x; }

  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= SIZE || y >= HEIGHT || z >= SIZE) return B.AIR;
    return this.data[this.idx(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number, markDirty = true) {
    if (x < 0 || y < 0 || z < 0 || x >= SIZE || y >= HEIGHT || z >= SIZE) return;
    this.data[this.idx(x, y, z)] = id;
    if (markDirty) {
      const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
      this.markDirty(cx, cz);
      if (x % CHUNK === 0) this.markDirty(cx - 1, cz);
      if (x % CHUNK === CHUNK - 1) this.markDirty(cx + 1, cz);
      if (z % CHUNK === 0) this.markDirty(cx, cz - 1);
      if (z % CHUNK === CHUNK - 1) this.markDirty(cx, cz + 1);
    }
  }

  private markDirty(cx: number, cz: number) {
    const c = this.chunks.get(`${cx},${cz}`);
    if (c) c.dirty = true;
  }

  solid(x: number, y: number, z: number): boolean {
    if (y < 0) return true;
    if (x < 0 || z < 0 || x >= SIZE || z >= SIZE) return true; // invisible walls at border
    if (y >= HEIGHT) return false;
    return this.data[this.idx(x, y, z)] !== B.AIR;
  }

  highestY(x: number, z: number): number {
    for (let y = HEIGHT - 1; y >= 0; y--) {
      if (this.get(x, y, z) !== B.AIR) return y;
    }
    return 0;
  }

  // ---------------------------------------------------------------- terrain
  private generate() {
    const n1 = makeNoise2D(1337);
    const n2 = makeNoise2D(9001);
    const n3 = makeNoise2D(4242);
    const cx = SIZE / 2, cz = SIZE / 2;

    for (let x = 0; x < SIZE; x++) {
      for (let z = 0; z < SIZE; z++) {
        const dx = (x - cx) / SIZE, dz = (z - cz) / SIZE;
        const edge = Math.max(Math.abs(dx), Math.abs(dz)) * 2; // 0 center -> 1 edge

        let h = 6 + fbm(n1, x * 0.03, z * 0.03, 4) * 7;
        // mesas / buttes
        const m = n2(x * 0.018 + 40, z * 0.018 - 17);
        if (m > 0.28) h += Math.min(1, (m - 0.28) * 6) * 9;
        // border hills
        h += Math.max(0, edge - 0.62) * 26;

        const hi = Math.max(2, Math.min(HEIGHT - 6, Math.floor(h)));
        const biome = fbm(n3, x * 0.02 + 90, z * 0.02 + 33, 2);
        const desert = biome > -0.05;

        for (let y = 0; y <= hi; y++) {
          let id: number = B.STONE;
          if (y === 0) id = B.BEDROCK;
          else if (y < hi - 4) id = B.STONE;
          else if (y < hi) id = desert ? B.SANDSTONE : B.DIRT;
          else id = desert ? B.SAND : B.GRASS;
          if (desert && y === hi - 1) id = B.SAND;
          this.data[this.idx(x, y, z)] = id;
        }

        // scattered gold ore on exposed surfaces (fun demolition targets)
        const ore = n2(x * 0.4, z * 0.4);
        if (ore > 0.86 && hi > 7) this.data[this.idx(x, hi, z)] = B.ORE;

        // vegetation
        const r = n3(x * 0.7 + 11, z * 0.7 - 5);
        if (r > 0.885 && edge < 0.8 && hi < HEIGHT - 10) {
          if (desert) {
            const hh = 2 + Math.floor(r * 10 % 2);
            for (let i = 1; i <= hh; i++) this.data[this.idx(x, hi + i, z)] = B.CACTUS;
          } else if (r > 0.94) {
            this.plantTree(x, hi + 1, z);
          }
        }
      }
    }

    // ---- shooting-range pad near spawn (flat stone pad at center)
    const px = cx, pz = cz;
    for (let x = px - 8; x < px + 8; x++) {
      for (let z = pz - 6; z < pz + 14; z++) {
        const gy = 6;
        for (let y = gy + 1; y < gy + 12; y++) this.data[this.idx(x, y, z)] = B.AIR;
        for (let y = 0; y < gy; y++) if (this.data[this.idx(x, y, z)] === B.AIR) this.data[this.idx(x, y, z)] = B.SANDSTONE;
        this.data[this.idx(x, gy, z)] = (Math.abs(x - px) === 7 || z === pz - 5) ? B.COBBLE : B.SANDSTONE;
      }
    }
    this.spawn.set(px + 0.5, 8, pz + 11.5);

    // ---- sandstone pyramids (homage to classic voxel deserts)
    this.buildPyramid(px - 26, pz - 30, 8);
    this.buildPyramid(px + 20, pz - 40, 11);

    // ---- ruined arch for rocket target practice
    this.buildRuin(px + 14, pz - 16);
  }

  private plantTree(x: number, y: number, z: number) {
    const h = 4;
    for (let i = 0; i < h; i++) this.data[this.idx(x, y + i, z)] = B.LOG;
    for (let ox = -2; ox <= 2; ox++) for (let oy = 2; oy <= 4; oy++) for (let oz = -2; oz <= 2; oz++) {
      if (Math.abs(ox) + Math.abs(oz) + Math.max(0, oy - 3) <= 3 && !(ox === 0 && oz === 0 && oy < 4)) {
        const xx = x + ox, yy = y + oy, zz = z + oz;
        if (xx > 0 && zz > 0 && xx < SIZE && zz < SIZE && yy < HEIGHT && this.data[this.idx(xx, yy, zz)] === B.AIR) {
          this.data[this.idx(xx, yy, zz)] = B.LEAVES;
        }
      }
    }
  }

  private buildPyramid(px: number, pz: number, half: number) {
    const baseY = this.highestY(px, pz) + 1;
    for (let lvl = 0; lvl < half; lvl++) {
      const s = half - lvl;
      for (let x = px - s; x <= px + s; x++) {
        for (let z = pz - s; z <= pz + s; z++) {
          if (x < 1 || z < 1 || x >= SIZE - 1 || z >= SIZE - 1) continue;
          const edgeBlock = x === px - s || x === px + s || z === pz - s || z === pz + s;
          this.data[this.idx(x, baseY + lvl, z)] = edgeBlock ? B.SANDSTONE : (lvl === half - 1 ? B.SANDSTONE : B.SANDSTONE);
        }
      }
    }
    this.data[this.idx(px, baseY + half, pz)] = B.ORE; // gold cap
  }

  private buildRuin(px: number, pz: number) {
    const baseY = this.highestY(px, pz) + 1;
    const put = (x: number, y: number, z: number, id: number) => {
      if (x >= 0 && z >= 0 && x < SIZE && z < SIZE && y < HEIGHT) this.data[this.idx(x, y, z)] = id;
    };
    // two pillars + lintel arch
    for (let y = 0; y < 6; y++) {
      put(px - 3, baseY + y, pz, y % 3 === 2 ? B.COBBLE : B.SANDSTONE);
      put(px + 3, baseY + y, pz, y % 3 === 1 ? B.COBBLE : B.SANDSTONE);
    }
    for (let x = -3; x <= 3; x++) put(px + x, baseY + 6, pz, B.SANDSTONE);
    put(px - 2, baseY + 7, pz, B.COBBLE); put(px + 2, baseY + 7, pz, B.SANDSTONE);
    // side wall segment
    for (let x = 4; x <= 8; x++) for (let y = 0; y < 3 + (x % 3); y++) put(px + x, baseY + y, pz, x % 2 ? B.SANDSTONE : B.COBBLE);
  }

  // ---------------------------------------------------------------- meshing
  private rebuildChunk(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    const chunk = this.chunks.get(key);
    if (!chunk) return;
    chunk.dirty = false;

    const pos: number[] = [], nrm: number[] = [], uv: number[] = [], col: number[] = [], idxArr: number[] = [];
    let v = 0;

    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    for (let x = x0; x < x0 + CHUNK; x++) {
      for (let z = z0; z < z0 + CHUNK; z++) {
        for (let y = 0; y < HEIGHT; y++) {
          const block = this.get(x, y, z);
          if (block === B.AIR) continue;
          for (const f of FACES) {
            const nx = x + f.dir[0], ny = y + f.dir[1], nz = z + f.dir[2];
            const nb = this.get(nx, ny, nz);
            if (nb !== B.AIR && !(block === B.LEAVES && nb !== B.LEAVES)) continue;
            if (block !== B.LEAVES && nb === B.LEAVES) { /* draw face under leaves */ }
            else if (block === B.LEAVES && nb === B.LEAVES) continue;
            else if (nb !== B.AIR) continue;

            const [u0, v0, u1, v1] = tileUV(tileFor(block, f.dir[1]));
            const uvs: [number, number][] = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
            for (let i = 0; i < 4; i++) {
              const corner = f.corners[i];
              pos.push(x + corner[0], y + corner[1], z + corner[2]);
              nrm.push(f.dir[0], f.dir[1], f.dir[2]);
              uv.push(uvs[i][0], uvs[i][1]);
              col.push(f.shade, f.shade, f.shade);
            }
            idxArr.push(v, v + 1, v + 2, v, v + 2, v + 3);
            v += 4;
          }
        }
      }
    }

    if (chunk.mesh) {
      chunk.mesh.geometry.dispose();
      if (v === 0) { this.group.remove(chunk.mesh); chunk.mesh = null; return; }
    } else if (v === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    geo.setIndex(idxArr);

    if (chunk.mesh) {
      chunk.mesh.geometry = geo;
    } else {
      chunk.mesh = new THREE.Mesh(geo, this.material);
      chunk.mesh.frustumCulled = true;
      chunk.mesh.castShadow = true;
      chunk.mesh.receiveShadow = true;
      this.group.add(chunk.mesh);
    }
  }

  /** Rebuild any chunks marked dirty (call once per frame). */
  update() {
    for (const [key, chunk] of this.chunks) {
      if (chunk.dirty) {
        const [cx, cz] = key.split(',').map(Number);
        this.rebuildChunk(cx, cz);
      }
    }
  }

  // ---------------------------------------------------------------- queries
  /** Amanatides & Woo voxel traversal. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist = 120): RayHit | null {
    let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
    const stepX = dir.x > 0 ? 1 : -1, stepY = dir.y > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (dir.x || 1e-9));
    const tDeltaY = Math.abs(1 / (dir.y || 1e-9));
    const tDeltaZ = Math.abs(1 / (dir.z || 1e-9));
    const fx = origin.x - x, fy = origin.y - y, fz = origin.z - z;
    let tMaxX = (stepX > 0 ? 1 - fx : fx) * tDeltaX;
    let tMaxY = (stepY > 0 ? 1 - fy : fy) * tDeltaY;
    let tMaxZ = (stepZ > 0 ? 1 - fz : fz) * tDeltaZ;
    let t = 0, axis = -1;

    for (let i = 0; i < 256; i++) {
      if (tMaxX < tMaxY && tMaxX < tMaxZ) { t = tMaxX; tMaxX += tDeltaX; x += stepX; axis = 0; }
      else if (tMaxY < tMaxZ) { t = tMaxY; tMaxY += tDeltaY; y += stepY; axis = 1; }
      else { t = tMaxZ; tMaxZ += tDeltaZ; z += stepZ; axis = 2; }
      if (t > maxDist) return null;
      const block = this.get(x, y, z);
      if (block !== B.AIR || y < 0) {
        const normal = new THREE.Vector3(
          axis === 0 ? -stepX : 0, axis === 1 ? -stepY : 0, axis === 2 ? -stepZ : 0
        );
        const point = origin.clone().addScaledVector(dir, t);
        return { point, normal, block: y < 0 ? B.BEDROCK : block, x, y, z, dist: t };
      }
    }
    return null;
  }

  /** Destroy blocks within a sphere. Returns destroyed count. */
  destroySphere(center: THREE.Vector3, radius: number, onBlockDestroyed?: (x: number, y: number, z: number, blockId: number) => void): number {
    let count = 0;
    const r2 = radius * radius;
    const x0 = Math.floor(center.x - radius), x1 = Math.ceil(center.x + radius);
    const y0 = Math.floor(center.y - radius), y1 = Math.ceil(center.y + radius);
    const z0 = Math.floor(center.z - radius), z1 = Math.ceil(center.z + radius);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) {
      const dx = x + 0.5 - center.x, dy = y + 0.5 - center.y, dz = z + 0.5 - center.z;
      if (dx * dx + dy * dy + dz * dz > r2 + Math.random() * 1.2) continue;
      const b = this.get(x, y, z);
      if (b === B.AIR || b === B.BEDROCK || y <= 0) continue;
      this.set(x, y, z, B.AIR);
      onBlockDestroyed?.(x, y, z, b);
      count++;
    }
    return count;
  }
}

/**
 * Structural surface the fps combat systems need from ANY voxel world —
 * the unified engine's toroidal World satisfies it, so enemies / effects /
 * drops / pathfinding run against the main Minecraft world.
 */
export interface WorldLike {
  group: THREE.Group;
  spawn: THREE.Vector3;
  solid(x: number, y: number, z: number): boolean;
  get(x: number, y: number, z: number): number;
  set(x: number, y: number, z: number, id: number, markDirty?: boolean): void;
  highestY(x: number, z: number): number;
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist?: number): RayHit | null;
}
