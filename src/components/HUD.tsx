import { useEffect, useState, type RefObject } from 'react';
import type { GameEngine, HotbarItem, HudStats } from '../game/engine';
import type { SlotRef, SlotItem } from '../game/fps/Inventory';
import { LoadingScreen } from './hud/LoadingScreen';
import { ShopPanel } from './hud/ShopPanel';
import { InventoryOverlay } from './hud/InventoryOverlay';
import { CraftingOverlay } from './hud/CraftingOverlay';
import { FurnaceOverlay } from './hud/FurnaceOverlay';
import { PlayingHud } from './hud/PlayingHud';
import { MainMenu, ResumePrompt } from './hud/MainMenu';
import { ScreenVignette, DamageEffects, DeathScreen, ScopeOverlay, Crosshair, HitMarker } from './hud/ScreenEffects';

export interface HudProps {
  phase: 'loading' | 'ready';
  locked: boolean;
  hasPlayed: boolean;
  coldStart: boolean;
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

export function HUD({ phase, locked, hasPlayed, coldStart, progress, label, stats, onPlay, onCloseInventory, engineRef }: HudProps) {
  const playing = phase === 'ready' && locked;

  const unlockedIdle = phase === 'ready' && !locked
    && !stats?.inventoryOpen && !stats?.craftingOpen && !stats?.furnaceOpen && !stats?.shopOpen;
  const [menuReady, setMenuReady] = useState(false);
  useEffect(() => {
    if (!unlockedIdle) { setMenuReady(false); return; }
    const t = setTimeout(() => setMenuReady(true), 130);
    return () => clearTimeout(t);
  }, [unlockedIdle]);
  const showMenu = unlockedIdle && menuReady && (coldStart || hasPlayed);

  const wantPrompt = unlockedIdle && !coldStart && !hasPlayed;
  const [promptReady, setPromptReady] = useState(false);
  useEffect(() => {
    if (!wantPrompt) { setPromptReady(false); return; }
    const t = setTimeout(() => setPromptReady(true), 450);
    return () => clearTimeout(t);
  }, [wantPrompt]);
  const game = () => engineRef.current;

  const [selectedSlot, setSelectedSlot] = useState<SlotRef | null>(null);
  const [hoverSlot, setHoverSlot] = useState<SlotRef | null>(null);
  const [dragItem, setDragItem] = useState<{ item: SlotItem; from: SlotRef } | null>(null);
  const [, setInvSeq] = useState(0);
  const refreshInv = () => setInvSeq((s) => s + 1);

  const sameRef = (a: SlotRef, b: SlotRef) =>
    a.isHotbar === b.isHotbar && !!a.isCraft === !!b.isCraft && a.index === b.index;

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
    if (selectedSlot && sameRef(selectedSlot, ref)) {
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

  const slotProps = (ref: SlotRef) => {
    const item = game()?.inventory.getItem(ref) ?? null;
    const isSel = !!selectedSlot && sameRef(selectedSlot, ref);
    const isHov = !!hoverSlot && sameRef(hoverSlot, ref);
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
      onMouseLeave: () => setHoverSlot((h) => (h && sameRef(h, ref)) ? null : h),
      className: `mc-slot relative flex items-center justify-center cursor-pointer transition-all duration-75
        ${isSel ? 'mc-slot-active !outline-[#ffd23e] scale-110 z-10' : ''}
        ${isHov && item ? '!bg-[#5a6070]/90' : ''}
        ${dragItem && item ? 'opacity-40' : ''}`,
    };
  };

  const [hitFlash, setHitFlash] = useState(0);
  useEffect(() => {
    if (!stats || stats.hitSeq === 0) return;
    setHitFlash(stats.hitSeq);
    const t = setTimeout(() => setHitFlash(0), 130);
    return () => clearTimeout(t);
  }, [stats?.hitSeq]);

  const spread = Math.round(stats?.spread ?? 8);

  return (
    <div className="absolute inset-0 overflow-hidden">
      <ScreenVignette stats={stats} playing={playing} />
      <DamageEffects stats={stats} />

      {stats?.dead && <DeathScreen stats={stats} />}

      {stats?.scoped && locked && <ScopeOverlay />}

      {playing && stats && !stats.dead && !stats.scoped && stats.toolMode !== 'laser' && stats.ads < 0.5 && !stats.piloting && (
        <Crosshair spread={spread} />
      )}

      {hitFlash > 0 && <HitMarker hitFlash={hitFlash} />}

      {playing && stats && <PlayingHud stats={stats} game={game} />}

      {phase === 'ready' && stats && stats.shopOpen && (
        <>
          <div className="absolute inset-0 z-30 cursor-default" />
          <ShopPanel stats={stats} engineRef={engineRef} />
        </>
      )}

      {phase === 'ready' && stats && stats.inventoryOpen && (
        <InventoryOverlay
          stats={stats}
          game={game}
          hoverSlot={hoverSlot}
          selectedSlot={selectedSlot}
          dragItem={dragItem}
          slotProps={slotProps}
          onCloseInventory={onCloseInventory}
          refreshInv={refreshInv}
        />
      )}

      {phase === 'ready' && stats && stats.craftingOpen && (
        <CraftingOverlay game={game} refreshInv={refreshInv} selectedSlot={stats.slot} />
      )}

      {phase === 'ready' && stats && stats.furnaceOpen && (
        <FurnaceOverlay game={game} stats={stats} refreshInv={refreshInv} />
      )}

      {phase === 'loading' && <LoadingScreen progress={progress} label={label} />}

      {wantPrompt && promptReady && <ResumePrompt onPlay={onPlay} />}

      {showMenu && (
        <MainMenu
          coldStart={coldStart}
          hasPlayed={hasPlayed}
          stats={stats}
          onPlay={onPlay}
          onToggleEnemies={() => game()?.toggleEnemies(!(stats?.enemiesEnabled ?? true))}
        />
      )}
    </div>
  );
}
