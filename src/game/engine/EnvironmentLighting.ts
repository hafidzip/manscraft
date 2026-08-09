/**
 * EnvironmentLighting — sun/moon shadow orchestration, flashlight, night mist,
 * god-ray handoff and bloom modulation.
 *
 * Pulled out of GameEngine so the main tick can delegate all atmospheric /
 * lighting bookkeeping with a single `update()` call.
 */

import * as THREE from 'three';
import * as C from '../core/constants';
import { FOG_UNIFORMS } from '../vfx/heightFog';
import type { Sky } from '../vfx/sky';
import type { VolumetricLightPass } from '../vfx/volumetric';
import type { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { World } from '../world/world';

const UNDERWATER_FOG = new THREE.Color(0x0a2a5e);

/**
 * Colour the whole world converges to on a foggy night.
 * Lifted to a moonlit blue-grey so the murk is readable for the ENTIRE night.
 */
const NIGHT_MIST = new THREE.Color(0x39465e);

/** Configuration for the celestial (sun/moon) shadow map. */
const CELESTIAL_SHADOW_SIZE = 2048;
const CELESTIAL_SHADOW_HALF_EXTENT = 44;

/**
 * Radius (blocks) inside which GRASS chunks cast shadows.
 * Set to 0 to disable grass shadow casting entirely.
 */
const GRASS_SHADOW_RADIUS = 0;

export class EnvironmentLighting {
  /** true while the moon is the scene's key (shadow-casting) light */
  moonIsKey = false;

  /** shadow-map refresh guards */
  private lastShadowX = 1e9;
  private lastShadowZ = 1e9;
  private lastSunElev = 1e9;
  /** minimum seconds between two shadow-map re-renders */
  private shadowCooldown = 0;
  /** countdown to the next grass shadow-caster re-evaluation */
  private grassShadowT = 0;

  /** camera-mounted night torch */
  flashlight: THREE.SpotLight;
  flashlightTarget: THREE.Object3D;

  /** scratch colour for the per-frame night-mist blend */
  private fogScratch = new THREE.Color();

  constructor(camera: THREE.PerspectiveCamera) {
    // ---- camera-mounted flashlight for night exploration ----
    this.flashlight = new THREE.SpotLight(
      0xfff0d8, 0, 58, THREE.MathUtils.degToRad(42), 0.62, 1.5,
    );
    this.flashlight.position.set(0.12, -0.16, 0.55);
    this.flashlightTarget = new THREE.Object3D();
    this.flashlightTarget.position.set(0, -1.2, -30);
    camera.add(this.flashlight);
    camera.add(this.flashlightTarget);
    this.flashlight.target = this.flashlightTarget;
  }

  /** Configure celestial shadow properties on sun and moon directional lights. */
  static configureShadows(sun: THREE.DirectionalLight, moon: THREE.DirectionalLight): void {
    for (const light of [sun, moon]) {
      light.castShadow = true;
      light.shadow.mapSize.set(CELESTIAL_SHADOW_SIZE, CELESTIAL_SHADOW_SIZE);
      light.shadow.camera.left = -CELESTIAL_SHADOW_HALF_EXTENT;
      light.shadow.camera.right = CELESTIAL_SHADOW_HALF_EXTENT;
      light.shadow.camera.top = CELESTIAL_SHADOW_HALF_EXTENT;
      light.shadow.camera.bottom = -CELESTIAL_SHADOW_HALF_EXTENT;
      light.shadow.camera.near = 0.5;
      light.shadow.camera.far = 180;
      light.shadow.bias = -0.0004;
      light.shadow.normalBias = 0.16;
      light.shadow.radius = 1.0;
      light.shadow.camera.updateProjectionMatrix();
    }
  }

  /**
   * Update atmosphere, fog, flashlight, god rays, bloom, and shadow refresh.
   * Called once per locked frame from the main tick.
   */
  update(
    dt: number,
    camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
    sky: Sky,
    world: World,
    scene: THREE.Scene,
    player: { pos: THREE.Vector3; headInWater: boolean; yaw: number },
    piloting: boolean,
    dead: boolean,
    volumetricLight: VolumetricLightPass | null,
    bloom: UnrealBloomPass | null,
    shipAltitude: number,
  ): void {
    // ---- atmosphere: drive the shared fog uniforms from the sky ----
    const nightFog = 1 - THREE.MathUtils.smoothstep(sky.sunElev, -0.05, 0.11);
    const directT = THREE.MathUtils.smoothstep(sky.dayFactor, 0.18, 0.45);
    const directPos = directT > 0.5 ? sky.sunWorldPos : sky.moonWorldPos;

    const mistK = nightFog * 0.85;
    const mist = this.fogScratch.copy(NIGHT_MIST).lerp(sky.skyColor, 0.25);
    FOG_UNIFORMS.uSkyFogColor.value.copy(mist);
    FOG_UNIFORMS.uSkyFog.value = mistK;
    FOG_UNIFORMS.uFogColor.value.copy(sky.skyColor).lerp(mist, mistK);

    FOG_UNIFORMS.uFogSunColor.value.copy(sky.moonColor).lerp(sky.sunColor, directT);
    FOG_UNIFORMS.uFogSunDir.value.copy(directPos)
      .sub(camera.position).normalize();

    FOG_UNIFORMS.uFogDensity.value = 0.012 + nightFog * 0.072;
    FOG_UNIFORMS.uFogHeight.value = world.gen.sea + 2;
    FOG_UNIFORMS.uFogFalloff.value = 46 - nightFog * 18;
    FOG_UNIFORMS.uFogInscatter.value = 0.04 + (1 - nightFog) * 0.55;
    FOG_UNIFORMS.uFogStart.value = THREE.MathUtils.lerp(8, 1.5, nightFog);

    const maxRange = (C.VIEW_DISTANCE + 0.75) * C.CHUNK_SIZE;
    const flyAmt = piloting
      ? THREE.MathUtils.smoothstep(shipAltitude, 10, 40)
      : THREE.MathUtils.smoothstep(camera.position.y - world.gen.sea, 16, 46);
    const blend = Math.max(nightFog, flyAmt);
    FOG_UNIFORMS.uFarFogStart.value = THREE.MathUtils.lerp(maxRange * 0.48, maxRange * 0.32, blend);
    FOG_UNIFORMS.uFarFogEnd.value = THREE.MathUtils.lerp(maxRange * 0.92, maxRange * 0.78, blend);

    // Underwater wins last
    this.applyUnderwaterFx(scene, sky, player.headInWater);

    // ---- god rays: sun shafts by day, moonbeams after dark ----
    const moonAsKey = sky.dayFactor < 0.32;
    if (volumetricLight) {
      if (moonAsKey) {
        volumetricLight.lightWorldPosition.copy(sky.moonWorldPos);
        const moonUp = THREE.MathUtils.clamp(-sky.sunElev, 0, 1);
        volumetricLight.intensity = 0.05 + moonUp * 0.09;
        volumetricLight.discScale = 18;
        volumetricLight.tint.copy(sky.moonColor);
      } else {
        volumetricLight.lightWorldPosition.copy(sky.sunWorldPos);
        const elev = sky.sunElev;
        const angleFactor = THREE.MathUtils.clamp(0.75 - Math.abs(elev - 0.15) * 0.9, 0, 0.75);
        volumetricLight.intensity = angleFactor * 0.85;
        volumetricLight.discScale = 85;
        volumetricLight.tint.copy(sky.sunColor);
      }
    }

    // ---- bloom fades out at night ----
    if (bloom) {
      bloom.strength = 0.30 * THREE.MathUtils.smoothstep(sky.dayFactor, 0.0, 0.35);
    }

    // ---- flashlight: camera torch after dark, off while flying/dead ----
    const canUse = !dead && !piloting;
    const nightAmt = 1 - THREE.MathUtils.smoothstep(sky.dayFactor, 0.05, 0.3);
    this.flashlight.intensity = canUse ? nightAmt * 2.4 : 0;

    // ---- moon/sun shadow handover ----
    if (moonAsKey !== this.moonIsKey) {
      this.moonIsKey = moonAsKey;
      this.shadowCooldown = 0;
      if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
    }

    // ---- grass shadow casters: budgeted by distance ----
    this.grassShadowT -= dt;
    if (this.grassShadowT <= 0) {
      this.grassShadowT = 0.25;
      const radius = piloting ? 0 : GRASS_SHADOW_RADIUS;
      if (world.updateGrassShadowCasters(camera.position.x, camera.position.z, radius)) {
        this.shadowCooldown = 0;
        if (renderer.shadowMap) renderer.shadowMap.needsUpdate = true;
      }
    }

    // ---- celestial shadow: refresh only when the player or active light moves ----
    const p = player.pos;
    const moved = Math.abs(p.x - this.lastShadowX) > 2 || Math.abs(p.z - this.lastShadowZ) > 2;
    const activeElev = sky.dayFactor > 0.35 ? sky.sunElev : -sky.sunElev;
    const lightMoved = Math.abs(activeElev - this.lastSunElev) > 0.0087;
    this.shadowCooldown -= dt;
    if (renderer.shadowMap && (moved || lightMoved) && this.shadowCooldown <= 0) {
      this.lastShadowX = p.x;
      this.lastShadowZ = p.z;
      this.lastSunElev = activeElev;
      this.shadowCooldown = piloting ? 0.75 : 0.2;
      renderer.shadowMap.needsUpdate = true;
    }
  }

  /** submerged: swap the scene backdrop for deep-water blue */
  private applyUnderwaterFx(scene: THREE.Scene, sky: Sky, headInWater: boolean): void {
    if (headInWater) {
      scene.background = UNDERWATER_FOG;
      FOG_UNIFORMS.uFogColor.value.copy(UNDERWATER_FOG);
      FOG_UNIFORMS.uSkyFogColor.value.copy(UNDERWATER_FOG);
      FOG_UNIFORMS.uSkyFog.value = 0.92;
      FOG_UNIFORMS.uFogDensity.value = Math.max(FOG_UNIFORMS.uFogDensity.value, 0.045);
      FOG_UNIFORMS.uFogStart.value = 1.5;
    } else {
      scene.background = sky.skyColor;
    }
  }
}
