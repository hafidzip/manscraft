import { Rocket } from 'lucide-react';
import type { HudStats } from '../../game/engine';

export function PilotChip({ stats }: { stats: HudStats }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 z-20 flex flex-col items-center gap-2">
      <div className="flex items-center gap-4 rounded-md border-2 border-cyan-400/40 bg-slate-950/70 px-4 py-2 font-vt text-lg leading-none text-cyan-200 backdrop-blur-sm">
        <Rocket className="h-4 w-4 text-cyan-300" />
        <span className="text-cyan-50">{stats.shipSpeed} b/s</span>
        <span className="text-white/40">|</span>
        <span>ALT {stats.shipAlt}</span>
        <span className="text-white/40">|</span>
        <span className="text-cyan-300/90">ION DRIVE</span>
      </div>
      <p className="font-vt text-base leading-none text-white/75">
        <b className="text-white/90">W/S</b> thrust · <b className="text-white/90">A/D</b> strafe ·{' '}
        <b className="text-white/90">Space</b> rise · <b className="text-white/90">Shift</b> drop ·{' '}
        <b className="text-cyan-300">E</b> disembark
      </p>
    </div>
  );
}

export function BoardPrompt() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-1/3 z-20 flex justify-center">
      <div className="flex animate-pulse items-center gap-2 rounded-md border border-cyan-300/50 bg-slate-950/70 px-4 py-2 font-vt text-lg text-cyan-100 backdrop-blur-sm">
        <Rocket className="h-4 w-4 text-cyan-300" />
        Press <b className="mx-1 rounded border border-white/40 bg-white/10 px-1.5 text-white">E</b> to board the spaceship
      </div>
    </div>
  );
}
