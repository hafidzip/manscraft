/**
 * PostProcessingPipeline — owns every WebGLRenderTarget and full-screen pass
 * in the engine's multi-pass render chain.
 *
 * Pipeline order:
 *   scene → mainRT → LumenLite GI/reflections → lightingRT
 *   → depth fog → fogRT → bloom (in place)
 *   → volumetric → volumetricRT → output → screen
 */

import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { DepthFogPass } from '../vfx/depthFog';
import { LumenLitePass } from '../vfx/lumenLite';
import { VolumetricLightPass } from '../vfx/volumetric';
import { OutputStage } from '../vfx/output';

export class PostProcessingPipeline {
  mainRT: THREE.WebGLRenderTarget;
  lightingRT: THREE.WebGLRenderTarget;
  fogRT: THREE.WebGLRenderTarget;
  volumetricRT: THREE.WebGLRenderTarget;
  /** half-resolution SSGI + bilateral-blur targets feeding LumenLitePass */
  giRT: THREE.WebGLRenderTarget;
  blurRT: THREE.WebGLRenderTarget;

  lumenLite: LumenLitePass;
  depthFogPass: DepthFogPass;
  bloom: UnrealBloomPass;
  volumetricLight: VolumetricLightPass;
  outputStage: OutputStage;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    renderer: THREE.WebGLRenderer,
  ) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());

    this.mainRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });
    this.mainRT.depthTexture = new THREE.DepthTexture(size.x, size.y);
    this.mainRT.depthTexture.type = THREE.UnsignedIntType;

    this.lightingRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });
    this.fogRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });
    this.volumetricRT = new THREE.WebGLRenderTarget(size.x, size.y, {
      type: THREE.HalfFloatType,
    });

    this.depthFogPass = new DepthFogPass(this.camera);
    this.depthFogPass.material.uniforms.tDepth.value = this.mainRT.depthTexture;

    const halfW = Math.max(1, Math.floor(size.x / 2));
    const halfH = Math.max(1, Math.floor(size.y / 2));
    this.giRT = new THREE.WebGLRenderTarget(halfW, halfH, { type: THREE.HalfFloatType });
    this.blurRT = new THREE.WebGLRenderTarget(halfW, halfH, { type: THREE.HalfFloatType });

    this.lumenLite = new LumenLitePass(this.camera, size.x, size.y);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.55, 0.82);
    this.volumetricLight = new VolumetricLightPass(this.scene, this.camera, size.x, size.y);
    this.outputStage = new OutputStage();
  }

  resize(w: number, h: number): void {
    this.mainRT.setSize(w, h);
    this.lightingRT.setSize(w, h);
    this.fogRT.setSize(w, h);
    this.volumetricRT.setSize(w, h);
    const halfW = Math.max(1, Math.floor(w / 2));
    const halfH = Math.max(1, Math.floor(h / 2));
    this.giRT.setSize(halfW, halfH);
    this.blurRT.setSize(halfW, halfH);
    this.lumenLite.setSize(w, h);
    this.volumetricLight.setSize(w, h);
  }

  /**
   * Execute the full multi-pass pipeline.
   * Caller must have already rendered the scene into mainRT.
   */
  render(
    renderer: THREE.WebGLRenderer,
    skyColor: THREE.Color,
    sunColor: THREE.Color,
    sunDir: THREE.Vector3,
    dayFactor: number,
    seaLevel: number,
    dt: number,
  ): void {
    // 2) LumenLite: half-res SSGI -> bilateral blur -> full-res SSR/composite.
    this.lumenLite.configure(skyColor, sunColor, sunDir, dayFactor, seaLevel);
    this.lumenLite.renderPipeline(renderer, this.mainRT, this.lightingRT, this.giRT, this.blurRT);

    // 3) Depth fog: reads lightingRT color + mainRT depth, writes fogRT.
    this.depthFogPass.render(renderer, this.fogRT, this.lightingRT, this.mainRT.depthTexture);

    // 4) Bloom: reads fogRT and blends back into it IN PLACE.
    this.bloom.render(renderer, this.fogRT, this.fogRT, dt, false);

    // 5) Volumetric light (god rays): reads fogRT, writes volumetricRT.
    this.volumetricLight.render(renderer, this.volumetricRT, this.fogRT);

    // 6) Output pass: reads volumetricRT → screen (tone-mapping + sRGB).
    this.outputStage.render(renderer, this.volumetricRT.texture);
  }

  /**
   * Force texture upload, shadow allocation and every post-process shader.
   * Caller renders the scene into mainRT first, then calls this.
   */
  async warmup(
    renderer: THREE.WebGLRenderer,
    skyColor: THREE.Color,
    sunColor: THREE.Color,
    sunDir: THREE.Vector3,
    dayFactor: number,
    seaLevel: number,
    sunWorldPos: THREE.Vector3,
  ): Promise<void> {
    this.lumenLite.configure(skyColor, sunColor, sunDir, dayFactor, seaLevel);
    this.lumenLite.renderPipeline(renderer, this.mainRT, this.lightingRT, this.giRT, this.blurRT);
    this.depthFogPass.render(renderer, this.fogRT, this.lightingRT, this.mainRT.depthTexture!);
    this.bloom.render(renderer, this.fogRT, this.fogRT, 1 / 60, false);
    this.volumetricLight.lightWorldPosition.copy(sunWorldPos);
    this.volumetricLight.intensity = 0.01;
    this.volumetricLight.render(renderer, this.volumetricRT, this.fogRT);
    this.outputStage.render(renderer, this.volumetricRT.texture);
    renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.lumenLite.dispose();
    this.depthFogPass.dispose();
    this.bloom.dispose();
    this.volumetricLight.dispose();
    this.outputStage.dispose();
    this.mainRT.dispose();
    this.lightingRT.dispose();
    this.fogRT.dispose();
    this.volumetricRT.dispose();
    this.giRT.dispose();
    this.blurRT.dispose();
  }
}
