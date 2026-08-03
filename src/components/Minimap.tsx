/**
 * Minimap — circular radar in the top-right corner.
 * Renders a 96×96-block window around the player from the world's cached
 * column colors (fog-of-war for unexplored chunks). Sampling is fully
 * toroidal, so the map scrolls seamlessly across the world wrap seam.
 * North is up; the white arrow shows the player heading.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { GameEngine } from '../game/engine';
import { SEA_LEVEL, WORLD_SIZE, wrapDelta } from '../game/core/constants';

const SIZE = 176; // css px — deliberately compact
const SAMPLES = 96; // logical blocks per edge shown
const HALF = SAMPLES / 2;
const REFRESH_MS = 180;

const CELL = SIZE / SAMPLES;
const MAP_R = SIZE / 2;
const MARKER_R = 5.5;
/** clamp off-map camps to the rim as small chevrons; false = strict in-view only */
const EDGE_HINTS = true;

function campGlyph(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + r * 0.92, y + r * 0.78);
  ctx.lineTo(x - r * 0.92, y + r * 0.78);
  ctx.closePath();
}

function drawCamps(
  ctx: CanvasRenderingContext2D,
  camps: { x: number; z: number; cleared: boolean }[],
  px: number, pz: number, now: number,
) {
  if (!camps.length) return;
  const lim = MAP_R - 4;
  let nx = 0, ny = 0, nearD = Infinity;

  ctx.save();
  ctx.lineJoin = 'round';
  for (const c of camps) {
    // same wrapped player-centered math as the terrain loop → seam-correct
    const dx = wrapDelta(c.x - px, WORLD_SIZE);
    const dz = wrapDelta(c.z - pz, WORLD_SIZE);
    let mx = (dx + HALF) * CELL + CELL / 2;
    let my = (dz + HALF) * CELL + CELL / 2;

    const ox = mx - MAP_R, oy = my - MAP_R;
    const d = Math.hypot(ox, oy);
    let edge = false;
    if (d > lim) {
      if (!EDGE_HINTS) continue;
      edge = true;
      const k = lim / (d || 1);
      mx = MAP_R + ox * k; my = MAP_R + oy * k;
    }
    const r = edge ? MARKER_R * 0.7 : MARKER_R;

    campGlyph(ctx, mx, my, r);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';   // dark outline for contrast
    ctx.stroke();
    ctx.fillStyle = c.cleared
      ? 'rgba(120,120,120,0.6)'
      : edge ? 'rgba(255,120,60,0.75)' : '#ff6a3c';
    ctx.fill();

    if (c.cleared) {                        // tiny check over the dim tent
      ctx.beginPath();
      ctx.moveTo(mx - r * 0.5, my + r * 0.15);
      ctx.lineTo(mx - r * 0.1, my + r * 0.55);
      ctx.lineTo(mx + r * 0.6, my - r * 0.35);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(220,255,220,0.8)';
      ctx.stroke();
    } else if (!edge && d < nearD) { nearD = d; nx = mx; ny = my; }
  }

  if (nearD < Infinity) {                   // cheap pulse on the closest active camp
    const t = 0.5 + 0.5 * Math.sin(now / 380);
    ctx.beginPath();
    ctx.arc(nx, ny, MARKER_R + 3 + t * 3, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,120,60,${0.45 - t * 0.3})`;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

export function Minimap({ engineRef }: { engineRef: RefObject<GameEngine | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;

    const img = ctx.createImageData(SAMPLES, SAMPLES);
    const t = setInterval(() => {
      const engine = engineRef.current;
      const world = engine?.getWorld();
      const player = engine?.getPlayer();
      if (!engine || !world || !player) return;

      const px = Math.floor(player.pos.x);
      const pz = Math.floor(player.pos.z);
      const d = img.data;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const col = world.mapColumn(px + sx - HALF, pz + sy - HALF);
          const i = (sy * SAMPLES + sx) * 4;
          if (!col || col.height <= 0) {
            // unexplored
            d[i] = 13;
            d[i + 1] = 19;
            d[i + 2] = 28;
            d[i + 3] = 255;
            continue;
          }
          let r = (col.color >> 16) & 255;
          let g = (col.color >> 8) & 255;
          let b = col.color & 255;
          // relief shading by altitude
          const f = 0.6 + 0.5 * Math.min(1, Math.max(0, (col.height - 12) / 46));
          r *= f;
          g *= f;
          b *= f;
          if (col.water) {
            // depth tint: sink toward deep navy below sea level
            const deep = Math.min(1, Math.max(0, (SEA_LEVEL - col.height) / 12));
            r = r * (1 - deep) + 18 * deep;
            g = g * (1 - deep) + 40 * deep;
            b = Math.min(255, b * (1 - deep * 0.5) + 90 * deep);
          }
          d[i] = r;
          d[i + 1] = g;
          d[i + 2] = b;
          d[i + 3] = 255;
        }
      }

      // compose: clipped circle, scaled pixel grid, overlay ring glow
      ctx.clearRect(0, 0, SIZE, SIZE);
      ctx.save();
      ctx.beginPath();
      ctx.arc(SIZE / 2, SIZE / 2, SIZE / 2 - 2, 0, Math.PI * 2);
      ctx.clip();
      // nearest-neighbor scale of the sample grid (drawImage respects the clip)
      ctx.putImageData(img, 0, 0);
      ctx.drawImage(canvas, 0, 0, SAMPLES, SAMPLES, 0, 0, SIZE, SIZE);

      drawCamps(ctx, engine.getCamps?.() ?? [], px, pz, performance.now());

      // heading arrow
      const yaw = player.yaw;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rot = Math.atan2(fx, -fz);
      ctx.translate(SIZE / 2, SIZE / 2);
      ctx.rotate(rot);
      ctx.beginPath();
      ctx.moveTo(0, -7);
      ctx.lineTo(5, 6);
      ctx.lineTo(0, 3);
      ctx.lineTo(-5, 6);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth = 2;
      ctx.fill();
      ctx.stroke();
      ctx.restore();

      // cardinal ticks
      ctx.save();
      ctx.font = '10px VT323, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.shadowColor = 'rgba(0,0,0,0.8)';
      ctx.shadowBlur = 2;
      ctx.fillText('N', SIZE / 2, 13);
      ctx.restore();
    }, REFRESH_MS);

    return () => clearInterval(t);
  }, [engineRef]);

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-20 flex flex-col items-center gap-1.5">
      <canvas
        ref={canvasRef}
        width={SIZE}
        height={SIZE}
        className="rounded-full border-2 border-black/60 shadow-[0_0_0_2px_rgba(255,255,255,0.25),0_4px_16px_rgba(0,0,0,0.5)]"
      />
    </div>
  );
}
