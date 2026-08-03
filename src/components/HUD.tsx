/**
 * VOXELCRAFT — unified HUD. The inventory overlay, hotbar, hearts and pixel
 * icons match the original voxel-fps shell; the Minecraft stat chips, pilot
 * readout and ship prompt are layered on top for the unified game.
 */

import { useEffect, useMemo, useState, type RefObject } from 'react';
import {
  Bomb, Crosshair as CrosshairIcon, Moon, Mountain, Rocket, Shield, Skull,
  Sun, Swords, Volume2, VolumeX, X, Package, Apple,
} from 'lucide-react';
import type { GameEngine, HotbarItem, HudStats } from '../game/engine';
import { B } from '../game/fps/World';
import { buildAtlas, tileUV, T, drumstickTexture } from '../game/fps/textures';
import type { SlotRef, SlotItem, FoodDef } from '../game/fps/Inventory';
import { BLOCK_NAMES, FOODS } from '../game/fps/Inventory';

export interface HudProps {
  phase: 'loading' | 'ready';
  locked: boolean;
  hasPlayed: boolean;
  progress: number;
  label: string;
  selected: number;
  items: HotbarItem[];
  stats: HudStats | null;
  seed: number;
  onPlay: () => void;
  onCloseInventory: () => void;
  engineRef: RefObject<GameEngine | null>;
}

const TIPS = [
  'Did you know? Every texture is painted by code.',
  'Tip: hold Shift to sprint across the plains.',
  'Tip: 1-6 swap weapons and tools.',
  'The world is generated from a single random seed.',
  'Mined blocks stack into your inventory — drag them onto the hotbar.',
  'Rockets turn mountains into inventory.',
];

// ---------------------------------------------------------- pixel weapon icons
type Rect = [number, number, number, number, string];
const ICONS: Record<string, Rect[]> = {
  handgun: [
    [5, 4, 13, 2, '#3a3f47'], [17, 3, 1, 1, '#dfe8d8'],
    [5, 6, 9, 2, '#22252b'], [9, 8, 5, 1, '#22252b'],
    [6, 8, 3, 4, '#8a7350'], [5, 12, 4, 1, '#22252b'],
  ],
  smg: [
    [4, 5, 15, 3, '#2c2e33'], [19, 6, 3, 1, '#22252b'],
    [1, 5, 3, 2, '#22252b'], [10, 8, 3, 5, '#3a3f47'],
    [6, 8, 2, 3, '#3a3f47'], [12, 4, 1, 1, '#ff3b30'], [17, 4, 1, 1, '#22252b'],
  ],
  rifle: [
    [4, 5, 16, 2, '#22252b'], [14, 5, 6, 3, '#2c2e33'],
    [20, 6, 2, 1, '#22252b'], [22, 5, 1, 3, '#3a3f47'],
    [5, 3, 3, 2, '#22252b'], [18, 3, 1, 2, '#22252b'],
    [11, 7, 3, 4, '#3a3f47'], [1, 4, 3, 3, '#2c2e33'], [7, 7, 2, 3, '#3a3f47'],
  ],
  sniper: [
    [3, 6, 19, 1, '#22252b'], [22, 5, 2, 3, '#3a3f47'],
    [5, 5, 9, 3, '#565b3c'], [8, 3, 8, 2, '#22252b'],
    [7, 2, 2, 2, '#22252b'], [1, 5, 4, 3, '#565b3c'],
    [8, 8, 4, 2, '#3a3f47'], [12, 4, 2, 1, '#3a3f47'],
  ],
  bazooka: [
    [2, 6, 18, 4, '#5d6142'], [20, 5, 3, 6, '#5d6142'],
    [23, 6, 1, 4, '#33352a'], [0, 5, 2, 7, '#33352a'],
    [8, 10, 2, 3, '#6e4f30'], [6, 4, 6, 2, '#6e4f30'],
  ],
  laser: [
    [3, 5, 12, 4, '#3a4148'], [4, 3, 9, 2, '#2c3238'],
    [15, 5, 5, 4, '#4d565f'], [20, 4, 2, 6, '#23282e'],
    [8, 6, 4, 2, '#ffb060'], [5, 9, 3, 5, '#4a3b28'],
    [22, 6, 2, 2, '#ff5a1e'],
  ],
};

function WeaponIcon({ id, size = 46 }: { id: string; size?: number }) {
  const rects = ICONS[id] ?? ICONS.rifle;
  return (
    <svg width={size} height={size * 0.58} viewBox="0 0 24 14" className="icon-pixel" style={{ imageRendering: 'pixelated' }} shapeRendering="crispEdges">
      {rects.map((r, i) => (
        <rect key={i} x={r[0]} y={r[1]} width={r[2]} height={r[3]} fill={r[4]} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------- block + food icons
/** Face tile for each block (matches the world's side texture). */
function blockTile(blockId: number): number {
  switch (blockId) {
    case B.GRASS: return T.GRASS_SIDE;
    case B.DIRT: return T.DIRT;
    case B.STONE: return T.STONE;
    case B.SAND: return T.SAND;
    case B.SANDSTONE: return T.SANDSTONE;
    case B.LOG: return T.LOG_SIDE;
    case B.LEAVES: return T.LEAVES;
    case B.CACTUS: return T.CACTUS_SIDE;
    case B.PLANK: return T.PLANK;
    case B.ORE: return T.ORE;
    case B.COBBLE: return T.COBBLE;
    case B.WOOL: return T.TARGET_WOOL;
    default: return T.STONE;
  }
}

function BlockIcon({ blockId, size = 22 }: { blockId: number; size?: number }) {
  const url = useMemo(() => buildAtlas().image.toDataURL(), []);
  const [u0, v0, u1, v1] = tileUV(blockTile(blockId));
  const tu0 = Math.min(u0, u1), tu1 = Math.max(u0, u1);
  const tv0 = Math.min(v0, v1), tv1 = Math.max(v0, v1);
  const w = tu1 - tu0, h = tv1 - tv0;
  return (
    <div
      className="rounded-sm icon-pixel"
      style={{
        width: size, height: size,
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${100 / w}% ${100 / h}%`,
        backgroundPosition: `${(tu0 / (1 - w)) * 100}% ${((1 - tv1) / (1 - h)) * 100}%`,
        imageRendering: 'pixelated',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.55), inset 2px 2px 0 rgba(255,255,255,0.18), inset -2px -2px 0 rgba(0,0,0,0.28)',
      }}
    />
  );
}

function DrumstickIcon({ size = 26 }: { size?: number }) {
  const url = useMemo(() => drumstickTexture().image.toDataURL(), []);
  return (
    <img src={url} width={size} height={size} alt="Chicken Drum"
      style={{ imageRendering: 'pixelated', filter: 'drop-shadow(1px 1px 0 rgba(0,0,0,0.6))' }}
      draggable={false} />
  );
}

const WEAPON_TITLES: Record<string, string> = {
  handgun: "P9 'SIDEKICK'", smg: "KV-9 'HORNET'", rifle: "AR-77 'SENTINEL'",
  sniper: "LW-50 'LONGSTAR'", bazooka: "RPG-9 'HAMMER'", laser: "MK-7 'PROSPECTOR'",
};

function itemName(item: SlotItem | null): string {
  if (!item) return '';
  if (item.kind === 'weapon') return WEAPON_TITLES[item.weaponId] ?? item.weaponId;
  if (item.kind === 'block') return BLOCK_NAMES[item.blockId] ?? `Block #${item.blockId}`;
  return FOODS[item.foodId]?.name ?? item.foodId;
}

// ---------------------------------------------------------- slot renderer
interface RenderSlotItemProps {
  item: SlotItem | null;
  hovered?: boolean;
}

function RenderSlotItem({ item, hovered }: RenderSlotItemProps) {
  if (!item) return null;
  const hot = hovered ? 'brightness(1.35)' : 'none';
  if (item.kind === 'weapon') {
    return <div style={{ filter: hot }}><WeaponIcon id={item.weaponId} size={38} /></div>;
  }
  if (item.kind === 'block') {
    return (
      <div className="flex flex-col items-center justify-center relative w-full h-full" style={{ filter: hot }}>
        <BlockIcon blockId={item.blockId} size={22} />
        <span className="absolute bottom-0 right-0.5 px-font text-[8px] text-white px-shadow">{item.count}</span>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center relative w-full h-full" style={{ filter: hot }}>
      <DrumstickIcon size={24} />
      <span className="absolute bottom-0 right-0.5 px-font text-[8px] text-white px-shadow">{item.count}</span>
    </div>
  );
}

// ---------------------------------------------------------- pixel hearts
const HEART_GRID = [
  '.XX.XX.',
  'XXXXXXX',
  'XXXXXXX',
  'XXXXXXX',
  '.XXXXX.',
  '..XXX..',
  '...X...',
];

function PixelHeart({ mode = 'full' }: { mode?: 'full' | 'half' | 'empty' }) {
  return (
    <svg width="16" height="16" viewBox="0 0 7 7" shapeRendering="crispEdges">
      {HEART_GRID.flatMap((row, y) =>
        row.split('').map((c, x) => {
          if (c !== 'X') return null;
          const half = mode === 'half' && x < 3.5;
          const fill = mode === 'full' || half ? '#e52521' : mode === 'half' ? '#4a1210' : '#3a1512';
          return <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={fill} stroke="#000" strokeWidth={0.08} />;
        })
      )}
    </svg>
  );
}

// ---------------------------------------------------------- pieces kept from the minecraft HUD
const LABELS: Record<string, string> = { handgun: 'P9', smg: 'KV-9', rifle: 'AR-77', sniper: 'LW-50', bazooka: 'RPG-9', laser: 'MK-7' };

function StatChip({ stats, seed }: { stats: HudStats; seed: number }) {
  return (
    <div className="pointer-events-none absolute left-4 top-4 z-20 flex flex-col gap-1.5 font-vt text-sm leading-none text-white/90">
      <span className="flex items-center gap-2">
        <span className="text-emerald-300">{stats.fps} FPS</span>
        <span className="text-white/50">|</span>
        <span>XYZ {stats.x} / {stats.y} / {stats.z}</span>
      </span>
      <span className="flex items-center gap-2 rounded bg-black/40 px-2.5 py-1.5 backdrop-blur-sm">
        <Mountain className="h-3.5 w-3.5 text-amber-300" />
        <span>{stats.biome}</span>
        <span className="text-white/50">|</span>
        {stats.isDay ? <Sun className="h-3.5 w-3.5 text-yellow-300" /> : <Moon className="h-3.5 w-3.5 text-indigo-300" />}
        <span>{stats.isDay ? 'Day' : 'Night'}</span>
        <span className="text-white/50">|</span>
        {stats.muted ? <VolumeX className="h-3.5 w-3.5 text-red-300" /> : <Volume2 className="h-3.5 w-3.5 text-sky-300" />}
        <span className="text-white/40">seed {seed}</span>
      </span>
      <span className="flex items-center gap-2 rounded bg-black/40 px-2.5 py-1.5 font-pixel text-[9px] text-white/90 backdrop-blur-sm">
        <Swords size={11} className="text-[#ff5347]" />
        <span className="text-[#ff8bb0]">CAMPS {stats.campsCleared}/{stats.campsTotal} CLEARED</span>
        <span className="text-white/40">·</span>
        <Skull size={11} className="text-white/70" />
        <span className="text-[#ffd23e]">{stats.kills}</span>
        <span className="text-white/40">·</span>
        <span className={stats.enemiesAlive > 0 ? 'text-[#ff5347]' : 'text-[#6dc24a]'}>{stats.enemiesAlive} LEFT</span>
        {stats.targetsHit > 0 && (<><span className="text-white/40">·</span><CrosshairIcon size={11} className="text-white/70" /><span className="text-[#ffd23e]">{stats.targetsHit}</span></>)}
        {stats.demolition > 0 && (<><span className="text-white/40">·</span><Bomb size={11} className="text-white/70" /><span className="text-[#ff8b4e]">{stats.demolition}</span></>)}
      </span>
    </div>
  );
}

/** training-protocol session bar (voxel-fps boss bar) */
function SessionBar({ stats }: { stats: HudStats }) {
  return (
    <div className="absolute top-3 left-1/2 z-20 -translate-x-1/2 pointer-events-none flex flex-col items-center gap-1.5">
      <div className="px-font px-shadow text-[8px] text-[#ffb7ec] tracking-widest">TRAINING PROTOCOL</div>
      <div className="bossbar w-[min(420px,60vw)] h-[10px]">
        <div
          className="bossbar-fill h-full transition-[width] duration-500 ease-linear"
          style={{ width: `${(stats.session ?? 1) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** cockpit readout while flying */
function PilotChip({ stats }: { stats: HudStats }) {
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

/** "press E to board" proximity prompt */
function BoardPrompt() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-1/3 z-20 flex justify-center">
      <div className="flex animate-pulse items-center gap-2 rounded-md border border-cyan-300/50 bg-slate-950/70 px-4 py-2 font-vt text-lg text-cyan-100 backdrop-blur-sm">
        <Rocket className="h-4 w-4 text-cyan-300" />
        Press <b className="mx-1 rounded border border-white/40 bg-white/10 px-1.5 text-white">E</b> to board the spaceship
      </div>
    </div>
  );
}

function LoadingScreen({ progress, label }: { progress: number; label: string }) {
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

// ---------------------------------------------------------- app
export function HUD({ phase, locked, hasPlayed, progress, label, stats, seed, onPlay, onCloseInventory, engineRef }: HudProps) {
  const playing = phase === 'ready' && locked;
  const showMenu = phase === 'ready' && !locked && !stats?.inventoryOpen;
  const game = () => engineRef.current;

  // inventory UI state
  const [selectedSlot, setSelectedSlot] = useState<SlotRef | null>(null);
  const [hoverSlot, setHoverSlot] = useState<SlotRef | null>(null);
  const [dragItem, setDragItem] = useState<{ item: SlotItem; from: SlotRef } | null>(null);
  const [, setInvSeq] = useState(0);
  const refreshInv = () => setInvSeq((s) => s + 1);

  const commitSwap = (from: SlotRef, to: SlotRef) => {
    const g = game();
    if (!g) return;
    g.inventory.swapSlots(from, to);
    g.syncHotbarMode();
    refreshInv();
  };

  const handleSlotClick = (ref: SlotRef) => {
    const g = game();
    if (!g) return;
    if (selectedSlot && selectedSlot.isHotbar === ref.isHotbar && selectedSlot.index === ref.index) {
      setSelectedSlot(null);
      return;
    }
    if (!selectedSlot) {
      if (g.inventory.getItem(ref)) setSelectedSlot(ref);
      return;
    }
    commitSwap(selectedSlot, ref);
    setSelectedSlot(null);
  };

  const onSlotDrop = (to: SlotRef) => {
    if (dragItem) {
      commitSwap(dragItem.from, to);
      setDragItem(null);
    } else if (selectedSlot) {
      commitSwap(selectedSlot, to);
      setSelectedSlot(null);
    }
  };

  const hoverItem = hoverSlot ? game()?.inventory.getItem(hoverSlot) ?? null : null;
  const selItem = selectedSlot ? game()?.inventory.getItem(selectedSlot) ?? null : null;

  const slotProps = (ref: SlotRef) => {
    const item = game()?.inventory.getItem(ref) ?? null;
    const isSel = !!selectedSlot && selectedSlot.isHotbar === ref.isHotbar && selectedSlot.index === ref.index;
    const isHov = !!hoverSlot && hoverSlot.isHotbar === ref.isHotbar && hoverSlot.index === ref.index;
    return {
      draggable: !!item,
      onClick: () => handleSlotClick(ref),
      onDragStart: (e: React.DragEvent) => {
        if (!item) { e.preventDefault(); return; }
        setDragItem({ item, from: ref });
        e.dataTransfer.effectAllowed = 'move';
        const ghost = document.createElement('div');
        ghost.style.width = '1px'; ghost.style.height = '1px';
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => ghost.remove(), 0);
      },
      onDragEnd: () => setDragItem(null),
      onDragOver: (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; },
      onDrop: (e: React.DragEvent) => { e.preventDefault(); onSlotDrop(ref); },
      onMouseEnter: () => setHoverSlot(ref),
      onMouseLeave: () => setHoverSlot((h) => (h && h.isHotbar === ref.isHotbar && h.index === ref.index) ? null : h),
      className: `mc-slot relative flex items-center justify-center cursor-pointer transition-all duration-75
        ${isSel ? 'mc-slot-active !outline-[#ffd23e] scale-110 z-10' : ''}
        ${isHov && item ? '!bg-[#5a6070]/90' : ''}
        ${dragItem && item ? 'opacity-40' : ''}`,
    };
  };

  // hitmarker flash
  const [hitFlash, setHitFlash] = useState(0);
  useEffect(() => {
    if (!stats || stats.hitSeq === 0) return;
    setHitFlash(stats.hitSeq);
    const t = setTimeout(() => setHitFlash(0), 130);
    return () => clearTimeout(t);
  }, [stats?.hitSeq]);

  const spread = Math.round(stats?.spread ?? 8);
  const lowAmmo = (stats?.ammo ?? 0) >= 0 && (stats?.ammo ?? 0) <= Math.ceil((stats?.mag ?? 1) * 0.25);
  const isFoodHud = stats?.toolMode === 'food';
  const toolLabel = stats ? LABELS[stats.weaponId] ?? (isFoodHud ? 'FOOD' : stats.heldBlockId !== null ? 'BLOCK' : 'MK-7') : '';

  return (
    <div className="absolute inset-0 overflow-hidden">
      {/* vignette + underwater tint */}
      <div className="vignette z-10" />
      {stats?.underwater && playing && (
        <div className="pointer-events-none absolute inset-0 z-10 bg-blue-600/25" />
      )}
      {playing && stats && stats.hp > 0 && stats.hp <= 30 && !stats.dead && <div className="lowhp-vignette z-30" />}

      {/* damage feedback */}
      {(stats?.damageSeq ?? 0) > 0 && <div key={stats!.damageSeq} className="dmg-vignette z-30" />}

      {/* death scene */}
      {stats?.dead && (
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
      )}

      {/* sniper scope overlay */}
      {stats?.scoped && locked && (
        <div className="absolute inset-0 pointer-events-none z-30 overlay-in">
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, transparent 0, transparent min(34vh, 34vw), rgba(3,3,4,0.985) calc(min(34vh, 34vw) + 2px))' }} />
          <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at center, rgba(120,170,255,0.10) 0, rgba(20,40,80,0.18) min(26vh,26vw), rgba(0,0,0,0.4) min(34vh,34vw))' }} />
          <div className="crosshair-line" style={{ left: 0, right: 0, top: '50%', height: 1 }} />
          <div className="crosshair-line" style={{ top: 0, bottom: 0, left: '50%', width: 1 }} />
          <div className="absolute left-1/2 top-[8%] -translate-x-1/2 px-font px-shadow text-[10px] text-white/70">4.5x</div>
        </div>
      )}

      {/* session boss bar */}
      {playing && stats && !stats.dead && <SessionBar stats={stats} />}

      {/* crosshair */}
      {playing && stats && !stats.dead && !stats.scoped && stats.toolMode !== 'laser' && stats.ads < 0.5 && !stats.piloting && (
        <div className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ transform: 'translate(-50%,-50%)' }}>
          <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: -(spread + 9) }} />
          <div className="crosshair-line" style={{ width: 2, height: 9, left: -1, top: spread }} />
          <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: -(spread + 9) }} />
          <div className="crosshair-line" style={{ width: 9, height: 2, top: -1, left: spread }} />
          <div className="crosshair-line" style={{ width: 2, height: 2, left: -1, top: -1 }} />
        </div>
      )}

      {/* hitmarker */}
      {hitFlash > 0 && (
        <div key={hitFlash} className="absolute left-1/2 top-1/2 z-20 pointer-events-none" style={{ animation: 'hit-pop 0.14s steps(3) forwards' }}>
          <svg width="36" height="36" viewBox="0 0 36 36" style={{ transform: 'translate(-50%,-50%)' }}>
            <path d="M8 8 L14 14 M28 8 L22 14 M8 28 L14 22 M28 28 L22 22" stroke="#fff" strokeWidth="3" />
          </svg>
        </div>
      )}

      {playing && stats && (
        <>
          {stats.piloting ? (
            <PilotChip stats={stats} />
          ) : (
            <>
              {/* weapon name toast */}
              {stats.switchAt > 0 && (
                <div key={stats.switchAt} className="absolute right-[26px] bottom-[150px] z-20 pointer-events-none fade-up px-font px-shadow text-[11px] text-[#ffd23e]">
                  {stats.weaponName}
                </div>
              )}

              {/* ammo / laser / block / food readout */}
              <div className="absolute right-4 bottom-4 z-20 pointer-events-none flex flex-col items-end gap-1">
                <div className="px-font text-[8px] px-shadow-sm text-white/60 tracking-widest">{toolLabel}</div>
                {stats.weaponId === 'laser' ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-[#ff8b4e]">
                      ∞<span className="text-[11px] text-white/50"> CELL</span>
                    </div>
                    <div className="reload-bar-track w-28 h-[10px] relative overflow-hidden mt-0.5">
                      <div className="absolute inset-y-[3px] left-[3px] bg-[#ff5a1e]"
                        style={{ width: `${(stats.mineCharge ?? 0) * 96}%`, boxShadow: '0 0 8px #ff5a1e' }} />
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-white/45 tracking-widest">HOLD LMB TO CUT</div>
                  </>
                ) : isFoodHud ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-white">
                      {stats.ammo}<span className="text-[13px] text-white/50"> x</span>
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-[#6dc24a] tracking-widest">RMB — EAT</div>
                  </>
                ) : stats.heldBlockId !== null ? (
                  <>
                    <div className="px-font px-shadow text-[26px] leading-none text-white">
                      {stats.ammo}<span className="text-[13px] text-white/50"> x</span>
                    </div>
                    <div className="px-font text-[7px] px-shadow-sm text-[#ffd23e] tracking-widest">RMB — PLACE</div>
                  </>
                ) : (
                  <div className={`px-font px-shadow text-[26px] leading-none ${lowAmmo ? 'text-[#ff5347]' : 'text-white'}`}>
                    {stats.ammo}
                    <span className="text-[13px] text-white/50"> / {stats.mag}</span>
                  </div>
                )}
              </div>

              {/* hearts + hotbar stack */}
              <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 flex flex-col items-center gap-1.5 pointer-events-none">
                <div className="flex gap-[3px]">
                  {Array.from({ length: 10 }).map((_, i) => {
                    const v = Math.max(0, Math.min(10, stats.hp - i * 10));
                    const mode: 'full' | 'half' | 'empty' = v >= 10 ? 'full' : v >= 5 ? 'half' : 'empty';
                    return <PixelHeart key={i} mode={mode} />;
                  })}
                </div>

                {/* reload progress */}
                {stats.reloading && (
                  <div className="flex flex-col items-center gap-1 mb-0.5">
                    <div className="px-font px-shadow-sm text-[7px] text-[#ffd23e] px-blink">RELOADING</div>
                    <div className="reload-bar-track w-40 h-[10px] relative overflow-hidden">
                      <div className="absolute inset-y-[3px] left-[3px] bg-[#ffd23e]" style={{ width: `${Math.min(100, (stats.reloadT ?? 0) * 100) * 0.96}%` }} />
                    </div>
                  </div>
                )}

                {/* hotbar */}
                <div className="flex gap-[3px]">
                  {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => (
                    <div key={i} className={`mc-slot relative w-[50px] h-[44px] flex items-center justify-center ${stats.slot === i ? 'mc-slot-active border-[#ffd23e]' : ''}`}>
                      <RenderSlotItem item={item} />
                      <span className="absolute top-[1px] left-[3px] px-font text-[7px] text-white/50 px-shadow-sm">{i + 1}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* hints */}
              <div className="absolute left-4 bottom-4 z-20 px-font px-shadow-sm text-[8px] leading-4 text-white/55 pointer-events-none">
                <div>TAB — INVENTORY</div>
                <div>R — RELOAD</div>
                <div>F — INSPECT</div>
                <div>CTRL — CROUCH</div>
                <div>1-6 / WHEEL — SWAP</div>
                <div>E — SPACESHIP</div>
                <div className="text-[#ff8b4e]">RMB — ADS / PLACE / EAT</div>
              </div>
            </>
          )}
          {stats.shipNear && !stats.piloting && <BoardPrompt />}
          <StatChip stats={stats} seed={seed} />
        </>
      )}

      {/* ============================== INVENTORY OVERLAY (TAB) ============================== */}
      {phase === 'ready' && stats && stats.inventoryOpen && (
        <div className="absolute inset-0 z-50 flex items-center justify-center overlay-in bg-black/80 backdrop-blur-sm">
          <div className="mc-panel p-6 flex flex-col items-center gap-5 max-w-xl w-full mx-4 relative">
            <button
              onClick={onCloseInventory}
              className="absolute top-4 right-4 text-white/60 hover:text-white cursor-pointer px-font text-[10px]"
            >
              <X size={16} />
            </button>

            <div className="flex items-center gap-3">
              <Package size={18} className="text-[#ffd23e]" />
              <h2 className="px-font text-[14px] text-white tracking-widest px-shadow">PLAYER INVENTORY</h2>
            </div>

            {/* Tooltip strip */}
            <div className="w-full h-9 px-3 flex items-center mc-slot overflow-hidden">
              {(() => {
                const shown = hoverItem ?? (selItem ? selItem : dragItem?.item ?? null);
                if (!shown) return <span className="px-font text-[8px] text-white/35">HOVER AN ITEM • DRAG TO MOVE • CLICK TO PICK UP & SWAP</span>;
                return (
                  <div className="flex items-center gap-2.5">
                    {shown.kind === 'weapon' && <Swords size={12} className="text-[#ffd23e]" />}
                    {shown.kind === 'block' && <Package size={12} className="text-[#8ab4ff]" />}
                    {shown.kind === 'food' && <Apple size={12} className="text-[#ff8b4e]" />}
                    <span className="px-font text-[9px] text-white">{itemName(shown)}</span>
                    {(shown.kind === 'block' || shown.kind === 'food') && (
                      <span className="px-font text-[8px] text-white/50">x{shown.count}</span>
                    )}
                    {shown.kind === 'food' && <span className="px-font text-[7px] text-[#6dc24a]">+{(FOODS[shown.foodId] as FoodDef | undefined)?.heal ?? 10} HP</span>}
                  </div>
                );
              })()}
            </div>

            {/* Toggle Enemies Switch */}
            <div className="mc-slot p-3 w-full flex items-center justify-between border-white/20">
              <div className="flex items-center gap-2 px-font text-[9px] text-white">
                <Shield size={14} className={stats.enemiesEnabled ? 'text-[#ff5347]' : 'text-[#6dc24a]'} />
                HOSTILE AI:
              </div>
              <button
                onClick={() => game()?.toggleEnemies(!stats.enemiesEnabled)}
                className={`mc-btn px-4 py-1.5 text-[9px] cursor-pointer ${stats.enemiesEnabled ? '!bg-red-900' : '!bg-green-900'}`}
              >
                {stats.enemiesEnabled ? '▶ ENABLED' : '▷ DISABLED'}
              </button>
            </div>

            {/* Main Inventory Grid (3x9 = 27 slots) */}
            <div className="flex flex-col gap-1 w-full">
              <div className="px-font text-[8px] text-white/50 tracking-wider">STORAGE (3x9)</div>
              <div className="grid grid-cols-9 gap-1.5 w-full justify-items-center">
                {(game()?.inventory.mainInv ?? Array(27).fill(null)).map((item, i) => {
                  const ref: SlotRef = { isHotbar: false, index: i };
                  const p = slotProps(ref);
                  return (
                    <div key={i} draggable={p.draggable}
                      className={`${p.className} w-[46px] h-[46px]`}
                      onClick={p.onClick} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
                      onDragOver={p.onDragOver} onDrop={p.onDrop}
                      onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
                      <RenderSlotItem item={item} hovered={!!hoverSlot && !hoverSlot.isHotbar && hoverSlot.index === i} />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Hotbar Slots (1x6) */}
            <div className="flex flex-col gap-1 w-full">
              <div className="px-font text-[8px] text-[#ffd23e] tracking-wider">HOTBAR (SLOTS 1-6)</div>
              <div className="grid grid-cols-6 gap-2 w-full justify-items-center">
                {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => {
                  const ref: SlotRef = { isHotbar: true, index: i };
                  const p = slotProps(ref);
                  return (
                    <div key={i} draggable={p.draggable}
                      className={`${p.className} w-[58px] h-[52px] ${stats.slot === i ? '!outline-[#ffd23e]' : ''}`}
                      onClick={p.onClick} onDragStart={p.onDragStart} onDragEnd={p.onDragEnd}
                      onDragOver={p.onDragOver} onDrop={p.onDrop}
                      onMouseEnter={p.onMouseEnter} onMouseLeave={p.onMouseLeave}>
                      <span className="absolute top-1 left-1 px-font text-[7px] text-white/40">{i + 1}</span>
                      <RenderSlotItem item={item} hovered={!!hoverSlot && hoverSlot.isHotbar && hoverSlot.index === i} />
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-between w-full px-font text-[8px] text-white/50 border-t border-white/10 pt-3">
              <div>DRAG & DROP TO REARRANGE</div>
              <div>PRESS TAB TO RESUME</div>
            </div>
          </div>
        </div>
      )}

      {phase === 'loading' && <LoadingScreen progress={progress} label={label} />}

      {/* ============================== START / PAUSE ============================== */}
      {showMenu && (
        <div className="absolute inset-0 z-40 flex items-center justify-center overlay-in"
          style={{ background: 'radial-gradient(ellipse at 50% 35%, rgba(24,34,54,0.82), rgba(6,8,12,0.94))' }}>
          <div className="flex flex-col items-center gap-7 max-w-2xl px-6">
            <div className="flex flex-col items-center gap-3">
              <div className="px-font text-[10px] text-[#6dc24a] tracking-[0.35em] px-shadow-sm">// UNIFIED BLOCK-OPS</div>
              <h1 className="px-font px-shadow title-in text-[clamp(28px,6vw,54px)] text-white tracking-[0.08em]">
                VOXEL<span className="text-[#ffd23e]">CRAFT</span>
              </h1>
              <div className="px-font text-[10px] text-white/60 tracking-[0.2em] px-shadow-sm">SURVIVE · BUILD · FLY</div>
            </div>

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
                onClick={() => game()?.toggleEnemies(!(stats?.enemiesEnabled ?? true))}
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
      )}
    </div>
  );
}
