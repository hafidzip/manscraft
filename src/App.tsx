import { useCallback, useState, useRef } from 'react';
import { GameCanvas } from './components/GameCanvas';
import { SpaceCanvas } from './components/SpaceCanvas';
import type { PlanetHome } from './game/space/theme';
import { Inventory } from './game/fps/Inventory';

type Mode = 'craft' | 'space';

export default function App() {
  const [mode, setMode] = useState<Mode>('craft');
  const [home, setHome] = useState<PlanetHome | null>(null);
  // Persistent inventory that survives planet hops
  const inventoryRef = useRef<Inventory | null>(null);
  if (!inventoryRef.current) {
    inventoryRef.current = new Inventory();
  }

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
        <GameCanvas
          key={key}
          home={home}
          onEnterSpace={enterSpace}
          persistentInventory={inventoryRef.current}
        />
      ) : (
        <SpaceCanvas
          key={key}
          home={home}
          onExit={land}
        />
      )}
    </div>
  );
}
