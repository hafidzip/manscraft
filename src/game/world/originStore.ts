
import { CHUNK_SIZE as S } from '../core/constants';
import { packChunk } from '../core/cellKey';
import { NO_ORIGIN, type OriginTag } from '../core/origin';

export const localIdxOf = (lx: number, y: number, lz: number): number => (y * S + lz) * S + lx;

export class OriginStore {
  nativeTag: OriginTag = NO_ORIGIN;

  private overrides = new Map<number, Map<number, OriginTag>>();

  at(ck: number, li: number): OriginTag {
    return this.overrides.get(ck)?.get(li) ?? this.nativeTag;
  }

  atWorld(x: number, y: number, z: number): OriginTag {
    const ck = packChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);
    const li = localIdxOf(Math.floor(x) & 15, y | 0, Math.floor(z) & 15);
    return this.at(ck, li);
  }

  set(ck: number, li: number, tag: OriginTag): void {
    if (!tag || tag === this.nativeTag) {
      this.overrides.get(ck)?.delete(li);
      return;
    }
    let m = this.overrides.get(ck);
    if (!m) this.overrides.set(ck, (m = new Map()));
    m.set(li, tag);
  }

  setWorld(x: number, y: number, z: number, tag: OriginTag): void {
    const ck = packChunk(Math.floor(x) >> 4, Math.floor(z) >> 4);
    const li = localIdxOf(Math.floor(x) & 15, y | 0, Math.floor(z) & 15);
    this.set(ck, li, tag);
  }

  clearChunk(ck: number): void {
    this.overrides.delete(ck);
  }

  entries(ck: number): Iterable<[number, OriginTag]> {
    return this.overrides.get(ck) ?? [];
  }

  get size(): number {
    let n = 0;
    for (const m of this.overrides.values()) n += m.size;
    return n;
  }
}
