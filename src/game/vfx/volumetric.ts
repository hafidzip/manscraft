/**
 * Volumetric lighting — screen-space "god rays" (crepuscular rays).
 *
 * Technique (classic Crytek / NVIDIA GPU Gems 3 radial-blur approach):
 *   1. Render the whole scene into a small offscreen buffer using a flat
 *      black override material -> a pure silhouette of every occluder.
 *   2. Draw a bright sun disc on top of that same buffer, depth-tested
 *      against the silhouette pass, so mountains/trees correctly block it.
 *   3. Radially blur that buffer from every pixel toward the sun's
 *      screen-space position, accumulating decayed samples -> light shafts.
 *   4. Additively combine the shafts onto the main scene.
 *
 * This never touches the renderer's real depth/color buffers and needs no
 * depth-texture plumbing through the composer, so it drops into any
 * EffectComposer chain as a single extra pass.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

// More samples = smoother, longer rays but slightly more expensive.
// 52 samples gives visible rays even at moderate density without banding.
const GOD_RAY_SAMPLES = 52;

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const GENERATE_FRAG = /* glsl */ `
  uniform sampler2D tOcclusion;
  uniform vec2 uSunPos;
  uniform float uExposure;
  uniform float uDecay;
  uniform float uDensity;
  uniform float uWeight;
  varying vec2 vUv;

  void main() {
    vec2 texCoord = vUv;
    vec2 deltaTexCoord = (texCoord - uSunPos);
    deltaTexCoord *= (1.0 / float(${GOD_RAY_SAMPLES})) * uDensity;

    // Base occlusion colour boosted from 0.2 to 0.38 — the original was too
    // dark, making rays barely visible even with high exposure. Now the sun
    // disc reads as a proper bright source and the accumulated rays are clear.
    float illuminationDecay = 1.0;
    vec3 color = texture2D(tOcclusion, texCoord).rgb * 0.38;

    for (int i = 0; i < ${GOD_RAY_SAMPLES}; i++) {
      texCoord -= deltaTexCoord;
      vec3 samp = texture2D(tOcclusion, texCoord).rgb;
      samp *= illuminationDecay * uWeight;
      color += samp;
      illuminationDecay *= uDecay;
    }
    gl_FragColor = vec4(color * uExposure, 1.0);
  }
`;

const COMBINE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tGodRays;
  uniform vec3 uTint;
  uniform float uIntensity;
  varying vec2 vUv;

  void main() {
    vec3 base = texture2D(tDiffuse, vUv).rgb;
    vec3 rays = texture2D(tGodRays, vUv).rgb * uTint;
    gl_FragColor = vec4(base + rays * uIntensity, 1.0);
  }
`;

function makeSunDiscTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.7, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Drop-in EffectComposer pass. Owner sets `lightWorldPosition` and
 * `intensity` once per frame (e.g. from the sky's sun position and its
 * day/night factor); the pass handles everything else internally.
 */
export class VolumetricLightPass extends Pass {
  /** world-space position to treat as the light source (the sun billboard). */
  readonly lightWorldPosition = new THREE.Vector3();
  /** 0 = off, ~0.4-0.8 = a believable shaft intensity. */
  intensity = 0;
  /** additive colour multiplier for the rays (warm near sunrise/sunset). */
  readonly tint = new THREE.Color(0xfff2d0);

  // God ray parameters tuned for visibility with Reinhard tone mapping:
  // - exposure: how bright the accumulated rays are before blending
  // - decay: how fast rays fade along their length (0.94 = long visible shafts)
  // - density: step size toward the sun (0.88 = good balance of quality/speed)
  // - weight: per-sample contribution (0.52 = rays accumulate visibly)
  exposure = 0.52;
  decay = 0.94;
  density = 0.88;
  weight = 0.52;

  /** internal buffer resolution as a fraction of the screen (perf knob). */
  // 0.55 = 55% screen resolution — high enough to see ray detail, low enough
  // to keep the radial blur affordable. The original 0.4 was too coarse.
  private scale = 0.55;

  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private occlusionRT: THREE.WebGLRenderTarget;
  private godRayRT: THREE.WebGLRenderTarget;
  private blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  private sunScene = new THREE.Scene();
  private sunSprite: THREE.Sprite;
  private generateMat: THREE.ShaderMaterial;
  private combineMat: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private ndc = new THREE.Vector3();
  private uv = new THREE.Vector2(0.5, 0.5);

  constructor(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number) {
    super();
    this.scene = scene;
    this.camera = camera;

    const w = Math.max(1, Math.floor(width * this.scale));
    const h = Math.max(1, Math.floor(height * this.scale));
    this.occlusionRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    this.godRayRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });

    const tex = makeSunDiscTexture();
    this.sunSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: tex, color: 0xffffff, transparent: true, depthWrite: false, depthTest: true,
        blending: THREE.AdditiveBlending, fog: false, toneMapped: false,
      })
    );
    // Sun sprite scale: large enough to cast clear shadows for the occlusion
    // pass, but not so large it looks fake. 85 works well at typical view distances.
    this.sunSprite.scale.setScalar(85);
    this.sunScene.add(this.sunSprite);

    this.generateMat = new THREE.ShaderMaterial({
      uniforms: {
        tOcclusion: { value: null },
        uSunPos: { value: this.uv },
        uExposure: { value: this.exposure },
        uDecay: { value: this.decay },
        uDensity: { value: this.density },
        uWeight: { value: this.weight },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: GENERATE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.combineMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tGodRays: { value: null },
        uTint: { value: new THREE.Vector3(1, 1, 1) },
        uIntensity: { value: 0 },
      },
      vertexShader: QUAD_VERT,
      fragmentShader: COMBINE_FRAG,
      depthTest: false,
      depthWrite: false,
    });

    this.fsQuad = new FullScreenQuad(this.generateMat);
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width * this.scale));
    const h = Math.max(1, Math.floor(height * this.scale));
    this.occlusionRT.setSize(w, h);
    this.godRayRT.setSize(w, h);
  }

  /** projects lightWorldPosition to screen UV; returns false if behind the camera */
  private projectLight(): boolean {
    this.ndc.copy(this.lightWorldPosition).project(this.camera);
    this.uv.set(this.ndc.x * 0.5 + 0.5, this.ndc.y * 0.5 + 0.5);
    return this.ndc.z < 1;
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget
  ): void {
    const visible = this.projectLight();
    const active = visible && this.intensity > 0.003;

    if (active) {
      this.sunSprite.position.copy(this.lightWorldPosition);

      const prevAutoClear = renderer.autoClear;
      const prevBackground = this.scene.background;
      const prevFog = this.scene.fog;
      const prevOverride = this.scene.overrideMaterial;

      // 1. black silhouette of every occluder in the scene
      this.scene.overrideMaterial = this.blackMat;
      this.scene.fog = null;
      this.scene.background = null;
      renderer.setRenderTarget(this.occlusionRT);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = true;
      renderer.clear(true, true, true);
      renderer.render(this.scene, this.camera);
      this.scene.overrideMaterial = prevOverride;
      this.scene.fog = prevFog;
      this.scene.background = prevBackground;

      // 2. bright sun disc, depth-tested against the silhouette above
      renderer.autoClear = false;
      renderer.render(this.sunScene, this.camera);
      renderer.autoClear = prevAutoClear;

      // 3. radial blur toward the sun's screen position -> light shafts
      const u = this.generateMat.uniforms;
      u.tOcclusion.value = this.occlusionRT.texture;
      (u.uSunPos.value as THREE.Vector2).copy(this.uv);
      u.uExposure.value = this.exposure;
      u.uDecay.value = this.decay;
      u.uDensity.value = this.density;
      u.uWeight.value = this.weight;
      renderer.setRenderTarget(this.godRayRT);
      renderer.clear();
      this.fsQuad.material = this.generateMat;
      this.fsQuad.render(renderer);
    }

    // 4. additively combine onto the scene (or pass through untouched)
    const c = this.combineMat.uniforms;
    c.tDiffuse.value = readBuffer.texture;
    c.tGodRays.value = this.godRayRT.texture;
    (c.uTint.value as THREE.Vector3).set(this.tint.r, this.tint.g, this.tint.b);
    c.uIntensity.value = active ? this.intensity : 0;
    this.fsQuad.material = this.combineMat;

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.occlusionRT.dispose();
    this.godRayRT.dispose();
    this.blackMat.dispose();
    this.generateMat.dispose();
    this.combineMat.dispose();
    (this.sunSprite.material as THREE.SpriteMaterial).map?.dispose();
    (this.sunSprite.material as THREE.SpriteMaterial).dispose();
    this.fsQuad.dispose();
  }
}
