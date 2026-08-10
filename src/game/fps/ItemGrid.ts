import { packCell } from '../core/cellKey';
import { WORLD_HEIGHT } from '../core/constants';
import type { DroppedItem } from './ItemDrop';

const clampY = (y: number): number => {
  const iy = Math.floor(y);
  return iy < 0 ? 0 : iy > WORLD_HEIGHT - 1 ? WORLD_HEIGHT - 1 : iy;
};

export const itemCellOf = (x: number, y: number, z: number): number =>
  packCell(Math.floor(x), clampY(y), Math.floor(z));

export class ItemGrid {
  readonly stats = { cells: 0, inserts: 0, moves: 0, removes: 0, queries: 0, candidates: 0 };
  private cells = new Map<number, DroppedItem[]>();
  private bucketPool: DroppedItem[][] = [];

  private link(it: DroppedItem, cell: number): void {
    let b = this.cells.get(cell);
    if (b === undefined) {
      b = this.bucketPool.pop() ?? [];
      this.cells.set(cell, b);
    }
    it.cell = cell;
    it.slot = b.length;
    b.push(it);
    this.stats.cells = this.cells.size;
  }

  insert(it: DroppedItem): void {
    this.link(it, itemCellOf(it.pos.x, it.pos.y, it.pos.z));
    this.stats.inserts++;
  }

  remove(it: DroppedItem): void {
    if (it.cell === -1) return;
    const b = this.cells.get(it.cell);
    if (b !== undefined) {
      const last = b.pop()!;
      if (last !== it) { b[it.slot] = last; last.slot = it.slot; }
      if (b.length === 0) {
        this.cells.delete(it.cell);
        if (this.bucketPool.length < 256) this.bucketPool.push(b);
        this.stats.cells = this.cells.size;
      }
    }
    it.cell = -1;
    it.slot = -1;
    this.stats.removes++;
  }

  move(it: DroppedItem): void {
    const cell = itemCellOf(it.pos.x, it.pos.y, it.pos.z);
    if (cell === it.cell) return;
    this.remove(it);
    this.link(it, cell);
    this.stats.moves++;
  }

  forEachBox(
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    cb: (it: DroppedItem) => void,
  ): void {
    this.stats.queries++;
    if (this.cells.size === 0) return;
    const cx0 = Math.floor(x0), cx1 = Math.min(Math.floor(x1), cx0 + 31);
    const cy0 = clampY(y0), cy1 = Math.max(cy0, clampY(y1));
    const cz0 = Math.floor(z0), cz1 = Math.min(Math.floor(z1), cz0 + 31);
    for (let y = cy0; y <= cy1; y++) {
      for (let z = cz0; z <= cz1; z++) {
        for (let x = cx0; x <= cx1; x++) {
          const b = this.cells.get(packCell(x, y, z));
          if (b === undefined) continue;
          for (let i = b.length - 1; i >= 0; i--) {
            this.stats.candidates++;
            cb(b[i]);
          }
        }
      }
    }
  }

  clear(): void {
    this.cells.clear();
    this.bucketPool.length = 0;
    this.stats.cells = 0;
  }
}
