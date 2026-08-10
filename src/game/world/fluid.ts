
import { B, DEFS, waterId, waterInfo, WATER_MAX_LEVEL } from './blocks';
import type { World } from './world';

const FLOW_DELAY = 0.12;
const MAX_PER_FRAME = 160;
const MAX_QUEUE = 6000;

interface Task {
  x: number;
  y: number;
  z: number;
  time: number;
}

const H_OFF = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

export class FluidSim {
  private queue: Task[] = [];
  private head = 0;
  private pending = new Set<string>();
  private now = 0;

  constructor(private world: World) {}

  private key(x: number, y: number, z: number): string {
    return `${x},${y},${z}`;
  }

  poke(x: number, y: number, z: number, delay = FLOW_DELAY): void {
    const k = this.key(x, y, z);
    if (this.pending.has(k) || this.queue.length > MAX_QUEUE) return;
    this.pending.add(k);
    this.queue.push({ x, y, z, time: this.now + delay });
  }

  pokeAround(x: number, y: number, z: number, delay = FLOW_DELAY): void {
    this.poke(x, y, z, delay);
    for (const [ox, oz] of H_OFF) this.poke(x + ox, y, z + oz, delay);
    this.poke(x, y + 1, z, delay);
    this.poke(x, y - 1, z, delay);
  }

  update(dt: number): void {
    this.now += dt;
    if (this.head >= this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
      return;
    }

    this.world.beginBatch();
    let processed = 0;
    while (this.head < this.queue.length && processed < MAX_PER_FRAME) {
      const t = this.queue[this.head];
      if (t.time > this.now) break;
      this.head++;
      this.pending.delete(this.key(t.x, t.y, t.z));
      this.recompute(t.x, t.y, t.z);
      processed++;
    }
    this.world.endBatch();

    if (this.head >= this.queue.length) {
      this.queue.length = 0;
      this.head = 0;
    }
  }


  private g(x: number, y: number, z: number): number {
    return this.world.getBlockRaw(x, y, z);
  }

  private replaceable(id: number): boolean {
    if (id === -1) return false;
    return id === B.AIR || DEFS[id].cross === true;
  }

  private hasSupport(x: number, y: number, z: number): boolean {
    const below = this.g(x, y - 1, z);
    if (below === -1) return true;
    if (DEFS[below].solid) return true;
    const bi = waterInfo(below);
    return bi !== null && !bi.falling;
  }

  private recompute(x: number, y: number, z: number): void {
    const id = this.g(x, y, z);
    const info = waterInfo(id);
    if (!info) return;

    if (info.level === 0 && !info.falling) {
      this.fallBelow(x, y, z, 0);
      if (this.hasSupport(x, y, z)) this.spreadHorizontal(x, y, z, 1);
      return;
    }

    if (info.falling) {
      const ai = waterInfo(this.g(x, y + 1, z));
      if (!ai) {
        this.drain(x, y, z);
        return;
      }
      if (ai.level !== info.level) {
        this.world.setBlock(x, y, z, waterId(ai.level, true));
        this.poke(x, y, z);
      }
      this.fallBelow(x, y, z, ai.level);
      if (this.hasSupport(x, y, z) && ai.level < WATER_MAX_LEVEL) {
        this.spreadHorizontal(x, y, z, ai.level + 1);
      }
      return;
    }

    let best = Infinity;
    for (const [ox, oz] of H_OFF) {
      const ni = waterInfo(this.g(x + ox, y, z + oz));
      if (!ni) continue;
      const feeds = !ni.falling || this.hasSupport(x + ox, y, z + oz);
      if (feeds) best = Math.min(best, ni.level + 1);
    }
    if (best > WATER_MAX_LEVEL) {
      this.drain(x, y, z);
      return;
    }
    if (best !== info.level) {
      this.world.setBlock(x, y, z, waterId(best, false));
      this.poke(x, y, z);
    }
    this.fallBelow(x, y, z, best);
    if (this.hasSupport(x, y, z) && best < WATER_MAX_LEVEL) {
      this.spreadHorizontal(x, y, z, best + 1);
    }
  }

  private fallBelow(x: number, y: number, z: number, level: number): void {
    const below = this.g(x, y - 1, z);
    if (this.replaceable(below)) {
      this.world.setBlock(x, y - 1, z, waterId(level, true));
      this.poke(x, y - 1, z);
      return;
    }
    const bi = waterInfo(below);
    if (bi && bi.falling && bi.level !== level) {
      this.world.setBlock(x, y - 1, z, waterId(level, true));
      this.poke(x, y - 1, z);
    }
  }

  private spreadHorizontal(x: number, y: number, z: number, childLevel: number): void {
    for (const [ox, oz] of H_OFF) {
      const nx = x + ox;
      const nz = z + oz;
      const nid = this.g(nx, y, nz);
      if (this.replaceable(nid)) {
        this.world.setBlock(nx, y, nz, waterId(childLevel, false));
        this.poke(nx, y, nz);
        continue;
      }
      const ni = waterInfo(nid);
      if (ni && !ni.falling && ni.level > childLevel) {
        this.world.setBlock(nx, y, nz, waterId(childLevel, false));
        this.poke(nx, y, nz);
      }
    }
  }

  private drain(x: number, y: number, z: number): void {
    this.world.setBlock(x, y, z, B.AIR);
    this.pokeAround(x, y, z);
  }
}
