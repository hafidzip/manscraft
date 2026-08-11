
import * as THREE from 'three';
import type { PlanetTheme } from '../space/theme';
import { colorsFor } from '../world/blocks';
import { NO_ORIGIN, type OriginTag } from '../core/origin';

export interface PlanetLook {
  sky: THREE.Color;
  fog: THREE.Color;
  fogDensity: number;
  ambient: THREE.Color;
  sun: THREE.Color;
  particle: THREE.Color;
  toolTint: THREE.Color;
  water: THREE.Color;
  underwater: THREE.Color;
}

const C = (hex: number) => new THREE.Color(hex);

export function planetLook(theme: PlanetTheme | null): PlanetLook {
  if (!theme) {
    return {
      sky: C(0x87ceeb), fog: C(0xa8c8e8), fogDensity: 0.0075,
      ambient: C(0xffffff), sun: C(0xfff6e6), particle: C(0x795a3a),
      toolTint: C(0xffffff), water: C(0x3a66de), underwater: C(0x1b3a7a),
    };
  }
  const water = C(theme.waterHex ?? 0x3a66de);
  return {
    sky: C(theme.skyHex),
    fog: C(theme.fogHex ?? theme.skyHex),
    fogDensity: theme.fogDensity ?? 0.0075,
    ambient: C(theme.ambientHex ?? 0xffffff),
    sun: C(theme.sunHex ?? 0xfff6e6),
    particle: C(theme.particleHex ?? 0x795a3a),
    toolTint: C(theme.toolTintHex ?? 0xffffff),
    water,
    underwater: water.clone().multiplyScalar(0.55),
  };
}

export interface ApplyLookTarget {
  scene?: THREE.Scene;
  renderer?: THREE.WebGLRenderer;
  ambient?: { color: THREE.Color } | null;
  sun?: { color: THREE.Color } | null;
  waterMat?: (THREE.Material & { color?: THREE.Color }) | null;
}

export function applyPlanetLook(look: PlanetLook, r: ApplyLookTarget): void {
  if (r.scene) {
    r.scene.fog = new THREE.FogExp2(look.fog.getHex(), look.fogDensity);
    r.scene.background = look.sky;
  }
  if (r.renderer) r.renderer.setClearColor(look.sky);
  if (r.ambient) r.ambient.color.copy(look.ambient);
  if (r.sun) r.sun.color.copy(look.sun);
  if (r.waterMat?.color) r.waterMat.color.copy(look.water);
}

export function heldTint(blockId: number | null, origin: OriginTag | undefined, fallback: PlanetLook): THREE.Color {
  if (blockId == null) return fallback.toolTint.clone();
  const cols = colorsFor(blockId, origin ?? NO_ORIGIN);
  return cols.length ? new THREE.Color(cols[0]) : fallback.toolTint.clone();
}

export function particleColorsFor(blockId: number, tag: OriginTag, fallback: PlanetLook): number[] {
  const cols = colorsFor(blockId, tag);
  return cols.length ? cols : [fallback.particle.getHex()];
}
