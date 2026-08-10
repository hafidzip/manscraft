import { Shield } from 'lucide-react';
import type { HudStats } from '../../game/engine';

export function ResumePrompt({ onPlay }: { onPlay: () => void }) {
  return (
    <div className="absolute inset-x-0 bottom-[16%] z-40 flex justify-center pointer-events-none overlay-in">
      <button
        onClick={onPlay}
        className="pointer-events-auto mc-panel group flex flex-col items-center gap-2.5 px-8 py-5 cursor-pointer transition-transform duration-100 hover:scale-[1.03] active:translate-y-[2px]"
      >
        <span className="px-font px-shadow text-[11px] tracking-[0.22em] text-white group-hover:text-[#ffd23e]">
          CLICK TO RESUME CONTROL
        </span>
        <span className="px-font px-shadow-sm text-[8px] tracking-[0.18em] text-[#6dc24a] px-blink">
          ▼ SIGNAL LOCKED — WORLD LIVE
        </span>
      </button>
    </div>
  );
}

export function MainMenu({ coldStart, hasPlayed, stats, onPlay, onToggleEnemies }: {
  coldStart: boolean;
  hasPlayed: boolean;
  stats: HudStats | null;
  onPlay: () => void;
  onToggleEnemies: () => void;
}) {
  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center overlay-in"
      style={{ background: 'radial-gradient(ellipse at 50% 35%, rgba(24,34,54,0.82), rgba(6,8,12,0.94))' }}>
      <div className="flex flex-col items-center gap-7 max-w-2xl px-6">
        {coldStart ? (
          <div className="flex flex-col items-center gap-3">
            <div className="px-font text-[10px] text-[#6dc24a] tracking-[0.35em] px-shadow-sm">// UNIFIED BLOCK-OPS</div>
            <h1 className="px-font px-shadow title-in text-[clamp(28px,6vw,54px)] text-white tracking-[0.08em]">
              VOXEL<span className="text-[#ffd23e]">CRAFT</span>
            </h1>
            <div className="px-font text-[10px] text-white/60 tracking-[0.2em] px-shadow-sm">SURVIVE · BUILD · FLY</div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div className="px-font text-[9px] text-[#6dc24a] tracking-[0.35em] px-shadow-sm">// SESSION LIVE</div>
            <h2 className="px-font px-shadow text-[22px] text-white tracking-[0.14em]">PAUSED</h2>
          </div>
        )}

        <div className="mc-panel p-5 grid grid-cols-2 sm:grid-cols-4 gap-x-8 gap-y-2.5 px-font text-[8px] leading-relaxed text-white/80">
          <div><span className="text-[#ffd23e]">WASD</span> MOVE</div>
          <div><span className="text-[#ffd23e]">MOUSE</span> LOOK</div>
          <div><span className="text-[#ffd23e]">LMB</span> FIRE / CUT</div>
          <div><span className="text-[#ffd23e]">RMB</span> ADS / USE</div>
          <div><span className="text-[#ffd23e]">R</span> RELOAD</div>
          <div><span className="text-[#ffd23e]">F</span> INSPECT</div>
          <div><span className="text-[#ffd23e]">TAB</span> INVENTORY</div>
          <div><span className="text-[#ffd23e]">E</span> SPACESHIP</div>
          <div><span className="text-[#ffd23e]">SHIFT</span> SPRINT</div>
          <div><span className="text-[#ffd23e]">SPACE</span> JUMP</div>
          <div><span className="text-[#ffd23e]">1-6</span> HOTBAR</div>
          <div><span className="text-[#ff8b4e]">LASER</span> SLOT 6</div>
          <div><span className="text-[#6dc24a]">FOOD</span> EAT TO HEAL</div>
          <div><span className="text-[#8ab4ff]">BLOCKS</span> MINE & BUILD</div>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="mc-btn px-5 py-3.5 text-[10px] tracking-widest cursor-pointer flex items-center gap-2"
            onClick={onToggleEnemies}
          >
            <Shield size={14} className={stats?.enemiesEnabled ? 'text-[#ff5347]' : 'text-[#6dc24a]'} />
            ENEMIES: {stats?.enemiesEnabled ? 'ON' : 'OFF'}
          </button>
          <button className="mc-btn px-9 py-3.5 text-[11px] tracking-widest cursor-pointer" onClick={onPlay}>
            {hasPlayed ? '▶ RESUME' : '▶ DEPLOY'}
          </button>
        </div>
      </div>
    </div>
  );
}
