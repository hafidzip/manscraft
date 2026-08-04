/**
 * Shared state for the screen-space exponential height fog (see depthFog.ts).
 *
 * The fog itself is applied as a single post-process pass that reads the
 * depth buffer, so every material in the scene — terrain, water, enemies,
 * props — receives *identical* fog and the horizon always converges to the
 * sky colour. No per-material shader injection is needed (that approach was
 * fragile: the water flow shader fought it and produced the blue/grey seam).
 *
 * The engine drives these uniforms from the sky each frame.
 */

import * as THREE from 'three';

export const FOG_UNIFORMS = {
  /** far-field fog colour — must equal the sky background for a clean horizon */
  uFogColor: { value: new THREE.Color(0x8fb4d8) },
  /** sun colour used for forward in-scattering (warm glow when looking sunward) */
  uFogSunColor: { value: new THREE.Color(0xffd9a0) },
  /** normalized direction FROM the camera TOWARD the sun */
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  /** base density at the reference height */
  uFogDensity: { value: 0.011 },
  /** world Y where density equals uFogDensity */
  uFogHeight: { value: 32 },
  /** e-folding height in blocks — larger = fog reaches higher */
  uFogFalloff: { value: 24 },
  /** strength of the sun in-scatter tint (0 = pure ambient fog) */
  uFogInscatter: { value: 0.4 },
  /** fog fades in beyond this distance so near blocks stay crisp */
  uFogStart: { value: 8 },
  /**
   * Hard world-edge guard. The torus only meshes chunks within view distance
   * (~80 blocks at VIEW_DISTANCE=5), so a literal geometry edge exists there.
   * Height fog alone thins out at altitude — exactly when flying exposes that
   * edge. These two values drive a pure horizontal-distance term that forces
   * full fog saturation well inside the render radius, hiding the cutoff at
   * any altitude and blending distant ridges into the sky colour.
   */
  uFarFogStart: { value: 36 },
  uFarFogEnd: { value: 68 },
  /**
   * How strongly the *sky* itself is swallowed by the fog (0 = clear sky,
   * 1 = the sky is solid mist). Sky pixels have no depth, so the height-fog
   * integral can never touch them; without this the horizon dissolves into
   * mist while the sky above stays perfectly clear, which instantly breaks
   * the "socked-in" look on a foggy night.
   */
  uSkyFog: { value: 0 },
  /** colour the sky is pushed toward as uSkyFog rises — keep equal to sky */
  uSkyFogColor: { value: new THREE.Color(0x8fb4d8) },
};
