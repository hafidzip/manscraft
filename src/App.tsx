import { useCallback, useEffect, useRef, useState } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { SpaceCanvas } from './components/SpaceCanvas';
import type { PlanetHome } from './game/space/theme';
import { Inventory } from './game/fps/Inventory';

type Mode = 'craft' | 'space';

function planetKey(home: PlanetHome | null): string {
  if (!home) return 'home';
  return `${home.star.seed.toString(16)}-${home.planet.seed.toString(16)}`;
}

interface Transition {
  img: string;
  label: string;
  accent: string;
}

export default function App() {
  const [mode, setMode] = useState<Mode>('craft');
  const [home, setHome] = useState<PlanetHome | null>(null);
  const inventoryRef = useRef<Inventory | null>(null);
  if (!inventoryRef.current) {
    inventoryRef.current = new Inventory();
  }

  const [transition, setTransition] = useState<Transition | null>(null);
  const [fading, setFading] = useState(false);
  const transRef = useRef<Transition | null>(null);
  const fadeTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
  }, []);

  const armTransition = (img: string | null | undefined, label: string, accent: string) => {
    if (fadeTimer.current) { window.clearTimeout(fadeTimer.current); fadeTimer.current = null; }
    const t = img ? { img, label, accent } : null;
    transRef.current = t;
    setTransition(t);
    setFading(false);
  };

  const onChildReady = useCallback(() => {
    if (!transRef.current) return;
    setFading(true);
    if (fadeTimer.current) window.clearTimeout(fadeTimer.current);
    fadeTimer.current = window.setTimeout(() => {
      transRef.current = null;
      setTransition(null);
      setFading(false);
    }, 720);
  }, []);

  const key = planetKey(home);

  const switchMode = useCallback((next: Mode, h: PlanetHome, snapshot: string | null | undefined, label: string, accent: string) => {
    armTransition(snapshot, label, accent);
    setHome(h);
    setMode(next);
  }, []);

  const enterSpace = useCallback((h: PlanetHome, snapshot?: string | null) => {
    switchMode('space', h, snapshot, '▲ BREAKING ATMOSPHERE', '#9fd4ff');
  }, [switchMode]);

  const land = useCallback((h: PlanetHome, snapshot?: string | null) => {
    switchMode('craft', h, snapshot, '▼ MATERIALIZING SURFACE', '#ffd23e');
  }, [switchMode]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {mode === 'craft' ? (
        <GameCanvas
          key={key}
          home={home}
          onEnterSpace={enterSpace}
          persistentInventory={inventoryRef.current}
          onReady={onChildReady}
          planetKey={key}
        />
      ) : (
        <SpaceCanvas
          key={key}
          home={home}
          onExit={land}
          onReady={onChildReady}
        />
      )}

      {transition && (
        <div
          className={`absolute inset-0 z-50 overflow-hidden bg-black ${fading ? 'warp-exit' : ''}`}
          aria-hidden
        >
          <img
            src={transition.img}
            alt=""
            className="absolute inset-0 h-full w-full object-cover pixelated"
            draggable={false}
          />
          <div className="warp-grid absolute inset-0" />
          <div className="warp-sweep absolute inset-0" />

          <div className="absolute inset-x-0 bottom-9 flex flex-col items-center gap-3">
            <div
              className="px-font px-shadow text-[11px] tracking-[0.32em]"
              style={{ color: transition.accent }}
            >
              {transition.label}
            </div>
            <div className="reload-bar-track relative h-[10px] w-64 overflow-hidden">
              <div
                className="warp-bar absolute inset-y-[2px] left-[2px]"
                style={{ background: transition.accent }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
