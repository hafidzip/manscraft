/**
 * SPACE — mounts the open-universe SpaceScene (src/game/space) onto a canvas
 * and renders its HUD: galaxy/sector telemetry, ship speed, target lock,
 * hyperjump overlay and the "break atmosphere" entry flow.
 *
 * Entered from the unified game when the spaceship climbs past the
 * atmosphere; ESC (cursor free) or the LAND button returns to the planet.
 */
import { useEffect, useRef, useState } from 'react';
import { SpaceScene, type HudState } from '../game/space/scene';
import type { PlanetHome } from '../game/space/theme';

interface SpaceCanvasProps {
  home?: PlanetHome | null;
  onExit: (home: PlanetHome) => void;
}

export function SpaceCanvas({ home, onExit }: SpaceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SpaceScene | null>(null);
  const [hud, setHud] = useState<HudState | null>(null);
  const [locked, setLocked] = useState(false);

  // keep latest callback/home without re-creating the scene
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const homeRef = useRef(home);
  homeRef.current = home;

  // resolves the home to hand back on LAND: dispose() computes the exit
  // planet (locked -> nearest -> last-locked) and fires onExit; deep space
  // falls back to the entry home.
  const exit = () => {
    const s = sceneRef.current;
    if (s) s.dispose();
    else if (homeRef.current) exitRef.current(homeRef.current);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const scene = new SpaceScene(
      canvas,
      homeRef.current ? { star: homeRef.current.star, planet: homeRef.current.planet } : undefined,
    );
    scene.onHud = (h) => setHud(h);
    scene.onExit = (sx) => {
      exitRef.current({ star: sx.star, planet: sx.planet ?? homeRef.current!.planet });
    };
    // landed on a planet (F-descend or auto-land): exit into its voxel world
    scene.onDescend = (planet) => {
      exitRef.current({ star: scene.getHomeStar(), planet });
    };
    sceneRef.current = scene;
    scene.start();

    const onLock = () => setLocked(document.pointerLockElement === canvas);
    document.addEventListener('pointerlockchange', onLock);
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && document.pointerLockElement !== canvas) exit();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerlockchange', onLock);
      window.removeEventListener('keydown', onKey);
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  const target = hud?.target ?? null;
  const distStr = (d: number) =>
    d >= 1000 ? `${(d / 1000).toFixed(1)}k u` : `${Math.round(d)} u`;

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-[#03040c]">
      <canvas ref={canvasRef} className="block h-full w-full" />

      {/* vignette */}
      <div className="vignette z-10" />

      {/* ============================== TOP-LEFT: galaxy telemetry ============================== */}
      {hud && (
        <div className="absolute left-4 top-4 z-20 flex flex-col gap-1.5 px-font px-shadow-sm text-[9px] text-white/85 pointer-events-none">
          <div className="text-[#ffd23e] tracking-widest">GALAXY — {hud.galaxy}</div>
          <div className="text-white/60">{hud.galaxyType} · RICHNESS {Math.round(hud.density * 100)}%</div>
          <div className="text-white/60">SECTOR {hud.sector}</div>
          <div className="flex items-center gap-1.5">
            <div className="reload-bar-track h-[8px] w-24 relative overflow-hidden">
              <div className="absolute inset-y-[2px] left-[2px] bg-[#ffd23e]" style={{ width: `${hud.density * 92}%` }} />
            </div>
            <span className="text-white/40">{hud.streamed} SYSTEMS</span>
          </div>
        </div>
      )}

      {/* ============================== TOP-RIGHT: ship + exit ============================== */}
      {hud && (
        <div className="absolute right-4 top-4 z-20 flex flex-col items-end gap-2">
          <button
            onClick={exit}
            className="mc-btn px-3 py-2 text-[8px] tracking-widest cursor-pointer z-30"
          >
            ⬅ LAND
          </button>
          <div className="flex flex-col items-end gap-1 px-font px-shadow-sm text-[9px] text-white/85 pointer-events-none">
            <div className={`text-[22px] leading-none ${hud.boost ? 'text-[#ff8a5a]' : 'text-white'}`}>
              {Math.round(hud.speed)}
              <span className="text-[10px] text-white/50"> m/s{hud.boost ? ' ⚡BOOST' : ''}</span>
            </div>
            <div className="text-white/60">STAR — {hud.star} <span className="text-[#9ab8ff]">{hud.spectral}</span></div>
            <div className="text-white/60">{hud.bodies > 0 ? `${hud.bodies} PLANETS` : 'NO PLANETS'}</div>
            <div className={hud.inSystem ? 'text-[#6dc24a]' : 'text-white/40'}>
              {hud.inSystem ? '◉ IN SYSTEM' : '○ DEEP SPACE'}
            </div>
          </div>
        </div>
      )}

      {/* ============================== BOTTOM-LEFT: nearest body ============================== */}
      {hud && (
        <div className="absolute left-4 bottom-4 z-20 px-font px-shadow-sm text-[9px] text-white/70 pointer-events-none leading-4">
          <div>NEAREST — <span className="text-white">{hud.nearest}</span></div>
          <div>DIST — <span className="text-[#ffd23e]">{distStr(hud.distance)}</span></div>
        </div>
      )}

      {/* ============================== TARGET LOCK ============================== */}
      {hud && target && target.onScreen && (
        <div
          className="absolute z-30 -translate-x-1/2 -translate-y-1/2 pointer-events-none"
          style={{ left: `${target.sx * 100}%`, top: `${target.sy * 100}%` }}
        >
          <div
            className={`h-3.5 w-3.5 border-2 ${target.locked ? 'border-[#ffd23e] shadow-[0_0_8px_rgba(255,210,62,0.8)]' : 'border-white/80'}`}
            style={{ transform: 'rotate(45deg)' }}
          />
          <div className="mt-2 px-font px-shadow text-[8px] text-white text-center whitespace-nowrap">
            {target.name} · <span className="text-[#9ab8ff]">{target.spectral}</span>
            <div className="text-white/60">
              {distStr(target.distance)}
              {target.kind === 'star' ? ` · ${target.bodies} BODIES` : ' · PLANET'}
            </div>
          </div>
          {target.locked && (
            <div className="mt-1 text-center px-font text-[7px] text-[#ffd23e] px-blink">
              {target.kind === 'star' ? 'F — HYPERJUMP' : 'F — DESCEND'}
            </div>
          )}
        </div>
      )}

      {/* center reticle */}
      {locked && (
        <div className="absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <div className="crosshair-line" style={{ width: 2, height: 6, left: -1, top: -8 }} />
          <div className="crosshair-line" style={{ width: 2, height: 6, left: -1, top: 2 }} />
          <div className="crosshair-line" style={{ width: 6, height: 2, top: -1, left: -8 }} />
          <div className="crosshair-line" style={{ width: 6, height: 2, top: -1, left: 2 }} />
        </div>
      )}

      {/* ============================== HYPERJUMP OVERLAY ============================== */}
      {hud?.warp && (
        <div className="absolute inset-0 z-40 pointer-events-none">
          {hud.warpPhase === 'flash' && (
            <div className="absolute inset-0 bg-white" style={{ opacity: Math.max(0, 1 - hud.warpProgress * 0.9) }} />
          )}
          {(hud.warpPhase === 'charge' || hud.warpPhase === 'arrive') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/30">
              <div className="px-font px-shadow text-[14px] tracking-widest text-white">
                {hud.warpPhase === 'charge' ? '⚡ CHARGING HYPERJUMP' : '✦ ARRIVING'}
              </div>
              <div className="mt-3 px-font px-shadow-sm text-[9px] text-[#9fd4ff]">
                → {hud.warpTargetName}
              </div>
              <div className="mt-5 reload-bar-track h-3 w-64 relative overflow-hidden">
                <div
                  className={`absolute inset-y-[2px] left-[2px] ${hud.warpPhase === 'arrive' ? 'bg-[#6dc24a]' : 'bg-[#9fd4ff]'}`}
                  style={{ width: `${hud.warpProgress * 96}%`, boxShadow: '0 0 10px currentColor' }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ============================== ENTRY / PAUSE ============================== */}
      {!locked && (
        <div className="absolute inset-0 z-40 flex flex-col items-center justify-center overlay-in pointer-events-none"
          style={{ background: 'radial-gradient(ellipse at 50% 35%, rgba(10,16,32,0.75), rgba(3,4,12,0.92))' }}>
          <div className="px-font text-[10px] text-[#9fd4ff] tracking-[0.35em] px-shadow-sm">// OPEN SPACE</div>
          <h1 className="px-font px-shadow title-in text-[clamp(26px,5vw,48px)] text-white tracking-[0.12em] mt-3">
            VOXEL<span className="text-[#9fd4ff]">SKY</span>
          </h1>
          <div className="mt-8 mc-panel p-5 grid grid-cols-2 gap-x-10 gap-y-2.5 px-font text-[8px] leading-relaxed text-white/80 pointer-events-auto">
            <div><span className="text-[#ffd23e]">W/S</span> THRUST</div>
            <div><span className="text-[#ffd23e]">A/D</span> STRAFE</div>
            <div><span className="text-[#ffd23e]">SPACE/C</span> UP / DOWN</div>
            <div><span className="text-[#ff8a5a]">SHIFT</span> BOOST</div>
            <div><span className="text-[#9fd4ff]">F</span> HYPERJUMP</div>
            <div><span className="text-[#ffd23e]">TARGET</span> LOCK ON</div>
          </div>
          <button
            className="mc-btn pointer-events-auto mt-8 px-9 py-3.5 text-[11px] tracking-widest cursor-pointer"
            onClick={() => canvasRef.current?.requestPointerLock()}
          >
            ▶ TAKE CONTROL
          </button>
          <button
            className="pointer-events-auto mt-4 px-font px-shadow-sm text-[8px] text-white/50 hover:text-white cursor-pointer tracking-widest"
            onClick={exit}
          >
            ⬅ RETURN TO PLANET
          </button>
        </div>
      )}

      {/* bottom hints while flying */}
      {locked && (
        <div className="absolute right-4 bottom-4 z-20 px-font px-shadow-sm text-[7px] leading-4 text-white/45 pointer-events-none text-right">
          <div>SHIFT — BOOST</div>
          <div>F — HYPERJUMP (TARGETED)</div>
          <div>ESC — RELEASE</div>
        </div>
      )}
    </div>
  );
}
