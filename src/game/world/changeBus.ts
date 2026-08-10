export type BlockChangeFn =
  (x: number, y: number, z: number, oldId: number, newId: number) => void;
export type ChunkDataFn =
  (cx: number, cz: number, data: Uint8Array, fromGenerator: boolean) => void;
export type ChunkGoneFn = (cx: number, cz: number) => void;

export interface ChangeSink {
  onBlock?: BlockChangeFn;
  onChunkData?: ChunkDataFn;
  onChunkGone?: ChunkGoneFn;
}

export interface ChangeSource {
  onChanged: BlockChangeFn | null;
  onChunkData?: ChunkDataFn | null;
  onChunkGone?: ChunkGoneFn | null;
}

const ATTACHED = Symbol('manscraft.changeBus');

export class ChangeBus {
  version = 1;
  readonly stats = { blocks: 0, chunkData: 0, chunkGone: 0 };
  private sinks: ChangeSink[] = [];

  add(sink: ChangeSink): () => void {
    this.sinks.push(sink);
    return () => {
      const i = this.sinks.indexOf(sink);
      if (i >= 0) this.sinks.splice(i, 1);
    };
  }

  attach(world: ChangeSource): void {
    const w = world as ChangeSource & { [ATTACHED]?: boolean };
    if (w[ATTACHED]) return;
    w[ATTACHED] = true;

    const prevBlock = world.onChanged;
    world.onChanged = (x, y, z, oldId, newId) => {
      prevBlock?.(x, y, z, oldId, newId);
      this.version++;
      this.stats.blocks++;
      for (let i = 0; i < this.sinks.length; i++)
        this.sinks[i].onBlock?.(x, y, z, oldId, newId);
    };

    const prevData = world.onChunkData ?? null;
    world.onChunkData = (cx, cz, data, fromGenerator) => {
      prevData?.(cx, cz, data, fromGenerator);
      this.stats.chunkData++;
      for (let i = 0; i < this.sinks.length; i++)
        this.sinks[i].onChunkData?.(cx, cz, data, fromGenerator);
    };

    const prevGone = world.onChunkGone ?? null;
    world.onChunkGone = (cx, cz) => {
      prevGone?.(cx, cz);
      this.stats.chunkGone++;
      for (let i = 0; i < this.sinks.length; i++)
        this.sinks[i].onChunkGone?.(cx, cz);
    };
  }
}