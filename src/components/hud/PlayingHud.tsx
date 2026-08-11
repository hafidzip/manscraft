import type { GameEngine, HudStats } from '../../game/engine';
import { PixelHeart, RenderSlotItem, LABELS } from './icons';
import { PilotChip, BoardPrompt } from './PilotChip';
import { TradePrompt } from './ShopPanel';

export function PlayingHud({ stats, game }: { stats: HudStats; game: () => GameEngine | null }) {
  const lowAmmo = (stats.ammo ?? 0) >= 0 && (stats.ammo ?? 0) <= Math.ceil((stats.mag ?? 1) * 0.25);
  const isFoodHud = stats.toolMode === 'food';
  const toolLabel = LABELS[stats.weaponId] ?? (isFoodHud ? 'FOOD' : stats.heldBlockId !== null ? 'BLOCK' : 'MK-7');

  return (
    <>
      {stats.piloting ? (
        <PilotChip stats={stats} />
      ) : (
        <>
          {stats.switchAt > 0 && (
            <div key={stats.switchAt} className="absolute right-[26px] bottom-[150px] z-20 pointer-events-none fade-up px-font px-shadow text-[11px] text-[#ffd23e]">
              {stats.weaponName}
            </div>
          )}

          <div className="absolute right-4 bottom-4 z-20 pointer-events-none flex flex-col items-end gap-1">
            <div className="px-font text-[8px] px-shadow-sm text-white/60 tracking-widest">{toolLabel}</div>
            {stats.weaponId === 'laser' || stats.toolMode === 'barehand' ? (
              <>
                <div className="px-font px-shadow text-[26px] leading-none text-[#ff8b4e]">
                  ∞<span className="text-[11px] text-white/50"> {stats.toolMode === 'barehand' ? 'HAND' : 'CELL'}</span>
                </div>
                <div className="reload-bar-track w-28 h-[10px] relative overflow-hidden mt-0.5">
                  <div className="absolute inset-y-[3px] left-[3px] bg-[#ff5a1e]"
                    style={{ width: `${(stats.mineCharge ?? 0) * 96}%`, boxShadow: '0 0 8px #ff5a1e' }} />
                </div>
                <div className="px-font text-[7px] px-shadow-sm text-white/45 tracking-widest">{stats.toolMode === 'barehand' ? 'HOLD LMB TO MINE' : 'HOLD LMB TO CUT'}</div>
              </>
            ) : isFoodHud || stats.heldBlockId !== null ? (
              <>
                <div className="px-font px-shadow text-[26px] leading-none text-white">
                  {stats.ammo}<span className="text-[13px] text-white/50"> x</span>
                </div>
                <div className={`px-font text-[7px] px-shadow-sm tracking-widest ${isFoodHud ? 'text-[#6dc24a]' : 'text-[#ffd23e]'}`}>
                  {isFoodHud ? 'RMB — EAT' : 'RMB — PLACE'}
                </div>
              </>
            ) : (
              <div className={`px-font px-shadow text-[26px] leading-none ${lowAmmo ? 'text-[#ff5347]' : 'text-white'}`}>
                {stats.ammo}<span className="text-[13px] text-white/50"> / {stats.mag}</span>
              </div>
            )}
          </div>

          <div className="absolute left-1/2 -translate-x-1/2 bottom-3 z-20 flex flex-col items-center gap-1.5 pointer-events-none">
            <div className="flex gap-[3px]">
              {Array.from({ length: 10 }).map((_, i) => {
                const v = Math.max(0, Math.min(10, stats.hp - i * 10));
                const mode: 'full' | 'half' | 'empty' = v >= 10 ? 'full' : v >= 5 ? 'half' : 'empty';
                return <PixelHeart key={i} mode={mode} />;
              })}
            </div>

            {stats.reloading && (
              <div className="flex flex-col items-center gap-1 mb-0.5">
                <div className="px-font px-shadow-sm text-[7px] text-[#ffd23e] px-blink">RELOADING</div>
                <div className="reload-bar-track w-40 h-[10px] relative overflow-hidden">
                  <div className="absolute inset-y-[3px] left-[3px] bg-[#ffd23e]" style={{ width: `${Math.min(100, (stats.reloadT ?? 0) * 100) * 0.96}%` }} />
                </div>
              </div>
            )}

            <div className="flex gap-[3px]">
              {(game()?.inventory.hotbar ?? Array(6).fill(null)).map((item, i) => (
                <div key={i} className={`mc-slot relative w-[50px] h-[44px] flex items-center justify-center ${stats.slot === i ? 'mc-slot-active border-[#ffd23e]' : ''}`}>
                  <RenderSlotItem item={item} />
                  <span className="absolute top-[1px] left-[3px] px-font text-[7px] text-white/50 px-shadow-sm">{i + 1}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="absolute left-4 bottom-4 z-20 px-font px-shadow-sm text-[8px] leading-4 text-white/55 pointer-events-none">
            <div>TAB — INVENTORY</div>
            <div>R — RELOAD</div>
            <div>F — INSPECT</div>
            <div>CTRL — CROUCH</div>
            <div>1-6 / WHEEL — SWAP</div>
            <div>E — SPACESHIP / TRADE</div>
            <div className="text-[#ff8b4e]">RMB — ADS / PLACE / EAT</div>
          </div>
        </>
      )}
      {stats.shipNear && !stats.piloting && !stats.nearMerchant && <BoardPrompt />}
      {stats.nearMerchant && !stats.shopOpen && !stats.piloting && !stats.dead && <TradePrompt />}
    </>
  );
}
