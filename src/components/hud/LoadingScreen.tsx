import { useState } from 'react';

const TIPS = [
  'Did you know? Every texture is painted by code.',
  'Tip: hold Shift to sprint across the plains.',
  'Tip: 1-6 swap weapons and tools.',
  'The world is generated from a single random seed.',
  'Mined blocks stack into your inventory — drag them onto the hotbar.',
  'Rockets turn mountains into inventory.',
  'Drops no longer fly to you — walk over them to pick them up.',
  'Conveyor belts carry dropped items. Press E on one to rotate it.',
  'Conveyor belts need a crafting table: stone, sticks and cobblestone.',
  'Inserters scoop up dropped items and place them forward. Press E to rotate.',
];

export function LoadingScreen({ progress, label }: { progress: number; label: string }) {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  return (
    <div className="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[#0b0e14]">
      <h2 className="px-font px-shadow text-center text-3xl leading-relaxed text-white md:text-5xl">
        VOXEL<span className="text-[#ffd23e]">CRAFT</span>
      </h2>
      <div className="mt-10 w-72 md:w-96">
        <p className="px-font px-shadow-sm text-[10px] text-white/80">{label}…</p>
        <div className="mt-2 h-5 rounded-sm border-2 border-black bg-neutral-800 shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)]">
          <div className="h-full bg-emerald-500 transition-[width] duration-200" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
        <p className="mt-2 text-right px-font text-[10px] text-emerald-300">{Math.round(progress * 100)}%</p>
      </div>
      <p className="mt-10 max-w-md px-6 text-center font-vt text-lg leading-tight text-white/50">{tip}</p>
    </div>
  );
}
