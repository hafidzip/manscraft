import { useEffect, useRef, useState } from 'react';
import { GameEngine, type HotbarItem, type HudStats } from '../game/engine';
import { themeFromPlanet, homeFromTheme, type PlanetHome } from '../game/space/theme';
import { homeStar, homePlanet } from '../game/space/galaxy';
import { session } from '../game/session';
import { HUD } from './HUD';
import { Minimap } from './Minimap';
import { Inventory } from '../game/fps/Inventory';
import { planetKeyOf } from '../game/persist/planetStore';

interface GameCanvasProps {
  home?: PlanetHome | null;
  onEnterSpace?: (home: PlanetHome, snapshot?: string | null) => void;
  persistentInventory?: Inventory | null;
  initialClearedCamps?: number[];
  onSaveClearedCamps?: (campIds: number[]) => void;
  onReady?: () => void;
  planetKey?: string;
}

export function GameCanvas({
  home, onEnterSpace, persistentInventory, initialClearedCamps, onSaveClearedCamps, onReady,
  planetKey,
}: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GameEngine | null>(null);

  const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
  const [progress, setProgress] = useState(0);
  const [label, setLabel] = useState('Igniting renderer');
  const [locked, setLocked] = useState(false);
  const [hasPlayed, setHasPlayed] = useState(false);
  const [selected, setSelected] = useState(0);
  const [items, setItems] = useState<HotbarItem[]>([]);
  const [stats, setStats] = useState<HudStats | null>(null);
  const [seed, setSeed] = useState(0);

  const [coldStart] = useState(() => !session.booted);

  const saveRef = useRef(onSaveClearedCamps);
  saveRef.current = onSaveClearedCamps;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;

    const engine = new GameEngine(
      canvas,
      {
        onProgress: (p, l) => {
          setProgress(p);
          setLabel(l);
        },
        onReady: (it, sd) => {
          setItems(it);
          setSeed(sd);
          setPhase('ready');
          readyRef.current?.();
        },
        onLock: (l) => {
          setLocked(l);
          if (l) {
            setHasPlayed(true);
            session.booted = true;
          }
        },
        onSelect: setSelected,
        onStats: setStats,
        onEnterSpace: (theme) => {
          const h =
            homeFromTheme(theme as never) ??
            home ??
            { star: homeStar(), planet: homePlanet() };
          const snap = engineRef.current?.getSnapshot() ?? null;
          onEnterSpace?.(h, snap ? snap.toDataURL('image/jpeg', 0.82) : null);
        },
      },
      home ? themeFromPlanet(home.planet, home.star) : undefined,
      persistentInventory ?? undefined,
      initialClearedCamps,
      planetKey ?? planetKeyOf(home ?? null),
    );
    engineRef.current = engine;
    engine.init().then(() => {
      if (cancelled) engine.dispose();
    }).catch((error) => {
      console.error('Game initialization failed', error);
    });

    return () => {
      cancelled = true;
      const cleared = engine.getClearedCampIds();
      saveRef.current?.(cleared);
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const autoLockTried = useRef(false);
  useEffect(() => {
    if (phase !== 'ready' || coldStart || locked || autoLockTried.current) return;
    autoLockTried.current = true;
    const t = window.setTimeout(() => {
      engineRef.current?.requestLock();
    }, 120);
    return () => window.clearTimeout(t);
  }, [phase, coldStart, locked]);

  const play = () => engineRef.current?.requestLock();
  const closeInventory = () => engineRef.current?.toggleInventory(false);

  const modalOpen = stats?.inventoryOpen || stats?.craftingOpen || stats?.furnaceOpen || stats?.shopOpen;

  return (
    <div className={`relative h-screen w-screen overflow-hidden bg-black ${modalOpen ? 'cursor-default' : ''}`}>
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none ${stats?.dead ? 'death-grade' : 'alive-grade'}`}
      />
      {phase === 'ready' && locked && <Minimap engineRef={engineRef} />}
      <HUD
        phase={phase}
        locked={locked}
        hasPlayed={hasPlayed}
        coldStart={coldStart}
        progress={progress}
        label={label}
        selected={selected}
        items={items}
        stats={stats}
        seed={seed}
        onPlay={play}
        onCloseInventory={closeInventory}
        engineRef={engineRef}
      />
    </div>
  );
}
