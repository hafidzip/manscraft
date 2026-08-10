import { ChevronUp } from 'lucide-react';
import type { HudStats } from '../../game/engine';

export function ScreenVignette({ stats, playing }: { stats: HudStats | null; playing: boolean }) {
  return (
    <>
      <div className="vignette z-10" />
      {stats?.underwater && playing && (
        <div className="pointer-events-none absolute inset-0 z-10 bg-blue-600/25" />
      )}
      {playing && stats && stats.hp > 0 && stats.hp <= 30 && !stats.dead && <div className="lowhp-vignette z-30" />}
    </>
  );
}

export function DamageEffects({ stats }: { stats: HudStats | null }) {
  if (!stats) return null;
  return (
    <>
      {stats.damageSeq > 0 && <div key={stats.damageSeq} className="dmg-vignette z-30" />}
      {stats.damageSeq > 0 && !stats.dead && (
        <div
          key={`dmg-dir-${stats.damageSeq}`}
          className="dmg-dir"
          style={{ transform: `rotate(${((stats.dmgAngle ?? 0) * 180) / Math.PI}deg)` }}
        >
          <ChevronUp className="dmg-dir-arrow" size={56} strokeWidth={3.5} />
        </div>
      )}
    </>
  );
}

export function DeathScreen({ stats }: { stats: HudStats }) {
  return (
    <>
      <div key={`flash-${stats.damageSeq}`} className="death-flash z-40" />
      <div className="absolute inset-0 z-40 flex flex-col items-center justify-center gap-7 death-overlay pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, rgba(70,5,5,0.5) 0%, rgba(12,2,2,0.92) 100%)' }}>
        <h2 className="px-font death-title text-[clamp(30px,7vw,64px)] text-[#c4231c]"
          style={{ textShadow: '0 0 22px rgba(200,20,16,0.55), 3px 3px 0 #000' }}>
          YOU DIED
        </h2>
        <div className="death-sub flex flex-col items-center gap-5">
          <div className="px-font px-shadow-sm text-[10px] text-white/75 flex flex-wrap justify-center gap-6">
            <span>KILLS <span className="text-[#ffd23e]">{stats.kills}</span></span>
            <span>CAMPS <span className="text-white">{stats.campsCleared}/{stats.campsTotal} CLEARED</span></span>
            <span>MINED <span className="text-[#ffd23e]">{stats.blocksMined}</span></span>
          </div>
          <div className="px-font px-shadow-sm text-[11px] text-white/55">
            RESPAWNING IN <span className="text-[#ff5347]">{Math.max(1, stats.respawnIn)}</span>
          </div>
        </div>
      </div>
    </>
  );
}

export function ScopeOverlay() {
  return (
    <div className="absolute inset-0 pointer-events-none z-30 overlay-in">
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 0, transparent min(34vh, 34vw), rgba(3,3,4,0.985) calc(min(34vh, 34vw) + 2px))' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, rgba(120,170,255,0.10) 0, rgba(20,40,80,0.18) min(26vh,26vw), rgba(0,0,0,0.4) min(34vh,34vw))' }} />
      <div className="crosshair-line" style={{ left: 0, right: 0, top: '50%', height: 1 }} />
      <div className="crosshair-line" style={{ top: 0, bottom: 0, left: '50%', width: 1 }} />
      <div className="absolute left-1/2 top-[8%] -translate-x-1/2 px-font px-shadow text-[10px] text-white/70">4.5x</div>
    </div>
  );
}

export function Crosshair({ spread }: { spread: number }) {
  return (
    <div className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ transform: 'translate(-50%,-50%)' }}>
      <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: -(spread + 9) }} />
      <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: spread }} />
      <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: -(spread + 9) }} />
      <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: spread }} />
      <div className="crosshair-line" style={{ width: 2, height: 2, left: -1, top: -1 }} />
    </div>
  );
}

export function HitMarker({ hitFlash }: { hitFlash: number }) {
  return (
    <div key={hitFlash} className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ animation: 'hit-pop 0.14s steps(3) forwards' }}>
      <svg width="36" height="36" viewBox="0 0 36 36" style={{ transform: 'translate(-50%,-50%)' }}>
        <path d="M8 8 L14 14 M28 8 L22 14 M8 28 L14 22 M28 28 L22 22" stroke="#fff" strokeWidth="3" />
      </svg>
    </div>
  );
}
