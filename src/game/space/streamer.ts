import * as THREE from 'three';
import { vdist, type Vec3d } from './rng';
import {
  starsInSector,
  starKey,
  SECTOR_SIZE,
  type StarSpec,
} from './galaxy';
import { makeStarSprite } from './billboard';

export interface StreamedStar {
  star: StarSpec;
  sprite: THREE.Sprite;
  key: string;
}

export interface SectorCoord {
  x: number;
  y: number;
  z: number;
}

export function sectorOf(p: Vec3d): SectorCoord {
  return {
    x: Math.floor(p.x / SECTOR_SIZE),
    y: Math.floor(p.y / SECTOR_SIZE),
    z: Math.floor(p.z / SECTOR_SIZE),
  };
}

export class SectorStreamer {
  private loaded = new Map<string, StreamedStar>();
  private lastSector: SectorCoord = { x: NaN, y: NaN, z: NaN };
  radius = 2;

  constructor(private scene: THREE.Scene) {}

  get stars(): IterableIterator<StreamedStar> {
    return this.loaded.values();
  }

  get count(): number {
    return this.loaded.size;
  }

  get sector(): SectorCoord {
    return this.lastSector;
  }

  update(shipPos: Vec3d, force = false): boolean {
    const s = sectorOf(shipPos);
    if (
      !force &&
      s.x === this.lastSector.x &&
      s.y === this.lastSector.y &&
      s.z === this.lastSector.z
    ) {
      return false;
    }
    this.lastSector = s;

    const R = this.radius;
    const wanted = new Set<string>();
    for (let dx = -R; dx <= R; dx++) {
      for (let dy = -R; dy <= R; dy++) {
        for (let dz = -R; dz <= R; dz++) {
          const stars = starsInSector(s.x + dx, s.y + dy, s.z + dz);
          for (const star of stars) {
            const key = starKey(star.address);
            wanted.add(key);
            if (this.loaded.has(key)) continue;
            const sprite = makeStarSprite(star.color, star.radius);
            this.scene.add(sprite);
            this.loaded.set(key, { star, sprite, key });
          }
        }
      }
    }

    for (const [key, e] of this.loaded) {
      if (wanted.has(key)) continue;
      this.scene.remove(e.sprite);
      (e.sprite.material as THREE.Material).dispose();
      this.loaded.delete(key);
    }
    return true;
  }

  nearest(p: Vec3d): { entry: StreamedStar; dist: number } | null {
    let best: StreamedStar | null = null;
    let bestD = Infinity;
    for (const e of this.loaded.values()) {
      const d = vdist(p, e.star.pos);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best ? { entry: best, dist: bestD } : null;
  }

  get(key: string): StreamedStar | undefined {
    return this.loaded.get(key);
  }

  clear() {
    for (const e of this.loaded.values()) {
      this.scene.remove(e.sprite);
      (e.sprite.material as THREE.Material).dispose();
    }
    this.loaded.clear();
    this.lastSector = { x: NaN, y: NaN, z: NaN };
  }
}
