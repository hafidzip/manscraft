import { useCallback, useState } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { SpaceCanvas } from './components/SpaceCanvas';
import type { PlanetHome } from './game/space/theme';

type Mode = 'craft' | 'space';

export default function App() {
  const [mode, setMode] = useState<Mode>('craft');
  const [home, setHome] = useState<PlanetHome | null>(null);

  const key = home
    ? `${home.star.seed.toString(16)}-${home.planet.seed.toString(16)}`
    : 'home';

  const enterSpace = useCallback((h: PlanetHome) => {
    setHome(h);
    setMode('space');
  }, []);

  const land = useCallback((h: PlanetHome) => {
    setHome(h);
    setMode('craft');
  }, []);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-black">
      {mode === 'craft' ? (
        <GameCanvas key={key} home={home} onEnterSpace={enterSpace} />
      ) : (
        <SpaceCanvas key={key} home={home} onExit={land} />
      )}
    </div>
  );
}
