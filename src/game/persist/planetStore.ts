/* eslint-disable no-bitwise */
import {
  WorldDeltaStore, serializeFurnaces, deserializeFurnaces, type FurnaceTuple,
} from './worldDelta';
import { ItemLedger } from '../factory/itemLedger';
import type { PlanetFactorySim, SimSnapshot } from '../factory/factorySim';
import type { FurnaceState } from '../crafting/smelting';

const DB_NAME = 'manscraft.worlds.v1';
const STORE = 'planets';
const LS_PREFIX = 'manscraft.world.';

export const SAVE_VERSION = 1;

export interface PlanetSave {
  v: number;
  key: string;
  seed: number;
  themeSea: number;
  themeJson: string | null;
  savedAtMs: number;
  deltas: Uint8Array;
  furnaces: FurnaceTuple[];
  ledger: Uint8Array;
  sim: SimSnapshot | null;
  player: { x: number; y: number; z: number; yaw: number } | null;
}

export const planetKeyOf = (
  home: { star: { seed: bigint }; planet: { seed: bigint } } | null,
): string => (home ? `${home.star.seed.toString(16)}-${home.planet.seed.toString(16)}` : 'home');

export const themeToJson = (t: unknown): string =>
  JSON.stringify(t, (_k, v) => (typeof v === 'bigint' ? { __big: v.toString(16) } : v));

export const themeFromJson = (s: string | null): unknown =>
  s
    ? JSON.parse(s, (_k, v) =>
        v && typeof v === 'object' && typeof v.__big === 'string' ? BigInt('0x' + v.__big) : v)
    : null;

export interface EngineLike {
  planetKey: string;
  worldSeed: number;
  themeSea: number;
  themeJson: string | null;
  deltas: WorldDeltaStore;
  ledger: ItemLedger;
  sim: PlanetFactorySim | null;
  furnaces: Map<string, FurnaceState>;
  playerState(): { x: number; y: number; z: number; yaw: number };
}

class PlanetPersistenceHub {
  private mem = new Map<string, PlanetSave>();
  private db: IDBDatabase | null = null;
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  loaded = false;
  readonly ready: Promise<void>;
  readonly stats = { loads: 0, captures: 0, installs: 0, flushes: 0, rejects: 0, errors: 0 };

  constructor() {
    this.ready = this.boot();
  }

  private async boot(): Promise<void> {
    try {
      this.db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const all = await new Promise<PlanetSave[]>((res, rej) => {
        const r = this.db!.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        r.onsuccess = () => res(r.result as PlanetSave[]);
        r.onerror = () => rej(r.error);
      });
      for (const s of all) {
        this.mem.set(s.key, s);
        this.stats.loads++;
      }
    } catch {
      this.stats.errors++;
      this.loadFromLocalStorage();
    }
    this.loaded = true;
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        void this.flushNow();
      });
      window.addEventListener('visibilitychange', () => {
        if (document.hidden) void this.flushNow();
      });
    }
  }

  get(key: string): PlanetSave | null {
    return this.mem.get(key) ?? null;
  }

  has(key: string): boolean {
    return this.mem.has(key);
  }

  keys(): string[] {
    return Array.from(this.mem.keys());
  }

  stableSeed(key: string): number | null {
    return this.mem.get(key)?.seed ?? null;
  }

  install(
    key: string,
    seed: number,
    themeSea: number,
  ): { deltas: WorldDeltaStore; ledger: ItemLedger; save: PlanetSave | null } {
    this.stats.installs++;
    const save = this.mem.get(key) ?? null;
    if (!save) return { deltas: new WorldDeltaStore(), ledger: new ItemLedger(), save: null };
    if (save.seed !== seed || Math.abs(save.themeSea - themeSea) > 1e-6 || save.v !== SAVE_VERSION) {
      this.stats.rejects++;
      console.warn('[manscraft] planet save rejected (seed/theme mismatch)', key, save.seed, seed);
      return { deltas: new WorldDeltaStore(), ledger: new ItemLedger(), save: null };
    }
    return {
      deltas: WorldDeltaStore.deserialize(save.deltas),
      ledger: ItemLedger.deserialize(save.ledger),
      save,
    };
  }

  capture(engine: EngineLike): void {
    this.stats.captures++;
    const save: PlanetSave = {
      v: SAVE_VERSION,
      key: engine.planetKey,
      seed: engine.worldSeed,
      themeSea: engine.themeSea,
      themeJson: engine.themeJson,
      savedAtMs: Date.now(),
      deltas: engine.deltas.serialize(),
      furnaces: serializeFurnaces(engine.furnaces),
      ledger: engine.ledger.serialize(),
      sim: engine.sim ? engine.sim.snapshot() : null,
      player: engine.playerState(),
    };
    this.mem.set(save.key, save);
    this.markDirty(save.key);
  }

  captureSim(key: string, sim: PlanetFactorySim): void {
    const prev = this.mem.get(key);
    if (!prev) return;
    prev.sim = sim.snapshot();
    prev.ledger = sim.ledger.serialize();
    prev.deltas = sim.deltas.serialize();
    prev.furnaces = serializeFurnaces(sim.furnaces);
    prev.savedAtMs = Date.now();
    this.markDirty(key);
  }

  furnacesOf(key: string): Map<string, FurnaceState> {
    return deserializeFurnaces(this.mem.get(key)?.furnaces ?? null);
  }

  private markDirty(key: string): void {
    this.dirty.add(key);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushNow();
    }, 1500);
  }

  async flushNow(): Promise<void> {
    if (this.dirty.size === 0) return;
    const keys = Array.from(this.dirty);
    this.dirty.clear();
    this.stats.flushes++;
    if (this.db) {
      try {
        const tx = this.db.transaction(STORE, 'readwrite');
        const st = tx.objectStore(STORE);
        for (const k of keys) {
          const s = this.mem.get(k);
          if (s) st.put(s);
        }
        await new Promise<void>((res) => {
          tx.oncomplete = () => res();
          tx.onerror = () => res();
        });
        return;
      } catch {
        this.stats.errors++;
      }
    }
    this.saveToLocalStorage(keys);
  }

  private saveToLocalStorage(keys: string[]): void {
    for (const k of keys) {
      const s = this.mem.get(k);
      if (!s) continue;
      try {
        const json = JSON.stringify({ ...s, deltas: b64(s.deltas), ledger: b64(s.ledger) });
        if (json.length > 2_000_000) continue;
        localStorage.setItem(LS_PREFIX + k, json);
      } catch {
        this.stats.errors++;
      }
    }
  }

  private loadFromLocalStorage(): void {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith(LS_PREFIX)) continue;
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        const s = JSON.parse(raw);
        s.deltas = unb64(s.deltas);
        s.ledger = unb64(s.ledger);
        this.mem.set(s.key, s);
        this.stats.loads++;
      }
    } catch {
      this.stats.errors++;
    }
  }

  clearAll(): void {
    this.mem.clear();
    this.dirty.clear();
    try {
      this.db?.transaction(STORE, 'readwrite').objectStore(STORE).clear();
    } catch {
    }
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k?.startsWith(LS_PREFIX)) localStorage.removeItem(k);
      }
    } catch {
    }
  }
}

const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.byteLength; i++) s += String.fromCharCode(u[i]);
  return btoa(s);
};

const unb64 = (s: string): Uint8Array => {
  const b = atob(s);
  const u = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
  return u;
};

export const hub = new PlanetPersistenceHub();
