
import * as THREE from 'three';

export const FOG_UNIFORMS = {
  uFogColor: { value: new THREE.Color(0x8fb4d8) },
  uFogSunColor: { value: new THREE.Color(0xffd9a0) },
  uFogSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uFogDensity: { value: 0.011 },
  uFogHeight: { value: 32 },
  uFogFalloff: { value: 24 },
  uFogInscatter: { value: 0.4 },
  uFogStart: { value: 8 },
  uFarFogStart: { value: 36 },
  uFarFogEnd: { value: 68 },
  uSkyFog: { value: 0 },
  uSkyFogColor: { value: new THREE.Color(0x8fb4d8) },
};
