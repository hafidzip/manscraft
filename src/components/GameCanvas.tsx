import { useEffect, useRef, useState } from 'react';
import { GameEngine, type HotbarItem, type HudStats } from '../game/engine';
import { themeFromPlanet, homeFromTheme, type PlanetHome } from '../game/space/theme';
import { homeStar, homePlanet } from '../game/space/galaxy';
import { HUD } from './HUD';
import { Minimap } from './Minimap';
import { Inventory } from '../game/fps/Inventory';

interface GameCanvasProps {
  home?: PlanetHome | null;
  onEnterSpace?: (home: PlanetHome) => void;
  persistentInventory?: Inventory | null;
}

export function GameCanvas({ home, onEnterSpace, persistentInventory }: GameCanvasProps) {
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
        },
        onLock: (l) => {
          setLocked(l);
          if (l) setHasPlayed(true);
        },
        onSelect: setSelected,
        onStats: setStats,
        onEnterSpace: (theme) => {
          // theme carries spec+star; fall back to the prop home, then to the
          // deterministic home planet on a cold launch (no planet selected)
          const h =
            homeFromTheme(theme as never) ??
            home ??
            { star: homeStar(), planet: homePlanet() };
          onEnterSpace?.(h);
        },
      },
      home ? themeFromPlanet(home.planet, home.star) : undefined,
      persistentInventory ?? undefined,
    );
    engineRef.current = engine;
    engine.init().then(() => {
      if (cancelled) engine.dispose();
    });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const play = () => engineRef.current?.requestLock();
  const closeInventory = () => engineRef.current?.toggleInventory(false);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none ${stats?.dead ? 'death-grade' : 'alive-grade'}`}
      />
      {phase === 'ready' && locked && <Minimap engineRef={engineRef} />}
      <HUD
        phase={phase}
        locked={locked}
        hasPlayed={hasPlayed}
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
