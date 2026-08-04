/**
 * Screen-space exponential height fog — the Unreal-style approach.
 *
 * Runs once per frame as a post pass. It reads the depth buffer, reconstructs
 * each fragment's world position, and integrates an exponentially decaying
 * density field along the view ray (closed form, no raymarching):
 *
 *     density(h) = d0 * exp(-(h - h0) / H)
 *     optical    = ∫ density ds   (analytic)
 *     fog        = 1 - exp(-optical)
 *
 * Because it operates on the composited frame, EVERY material receives the
 * exact same fog — terrain, water, enemies, props — so there can never be a
 * seam between surfaces. The far field converges to uFogColor (which the
 * engine keeps equal to the sky background), so the horizon dissolves into
 * the sky instead of hitting a colour wall.
 *
 * Forward in-scattering tints fragments that look toward the sun warm, and
 * that tint itself fades back to the sky colour as fog reaches full density,
 * so the sun side glows softly without breaking the horizon blend.
 */

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { FOG_UNIFORMS } from './heightFog';

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform mat4  uViewProjInv;
  uniform vec3  uCamPos;
  uniform vec2  uNearFar;
  uniform vec3  uFogColor;
  uniform vec3  uFogSunColor;
  uniform vec3  uFogSunDir;
  uniform float uFogDensity;
  uniform float uFogHeight;
  uniform float uFogFalloff;
  uniform float uFogInscatter;
  uniform float uFogStart;
  uniform float uFarFogStart;
  uniform float uFarFogEnd;
  uniform float uSkyFog;
  uniform vec3  uSkyFogColor;
  varying vec2 vUv;

  float viewZToDepth(float vz) {
    // perspective depth from view-space Z (matches the packed depth buffer)
    return ((uNearFar.y + uNearFar.x) * vz + uNearFar.y * uNearFar.x) / (uNearFar.y - uNearFar.x) * -0.5 + 0.5;
  }

  void main() {
    vec4 base = texture2D(tDiffuse, vUv);
    float depth = texture2D(tDepth, vUv).x;

    // Sky detection — two cases must both be handled:
    //
    //  depth == 0.0  → scene.background (THREE.Color) is applied as the clear
    //                  colour BEFORE any geometry is drawn. Sky pixels are never
    //                  touched by the depth write, so they keep the cleared value
    //                  of 0.0. This is the case that was fogging the sky.
    //
    //  depth >= 0.9999 → fragments projected onto the far clip plane (e.g.
    //                    skybox geometry if one were used). Keep this guard too
    //                    for robustness.
    //
    // In both cases return the raw sky colour with no fog applied.
    if (depth <= 0.0001 || depth >= 0.9999) {
      // Sky pixels carry no depth, so the height-fog integral below can never
      // reach them. On a heavy-fog night that left a crisp starfield sitting
      // above a wall of mist. uSkyFog drowns the sky in the same mist colour,
      // fading hardest toward the horizon where the murk is thickest.
      if (uSkyFog > 0.001) {
        float horizon = 1.0 - smoothstep(0.5, 0.94, vUv.y);
        float k = clamp(uSkyFog * mix(0.72, 1.0, horizon), 0.0, 1.0);
        gl_FragColor = vec4(mix(base.rgb, uSkyFogColor, k), base.a);
        return;
      }
      gl_FragColor = base;
      return;
    }

    // reconstruct world position from the packed depth
    vec4 ndc = vec4(vUv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    vec4 wp = uViewProjInv * ndc;
    wp.xyz /= wp.w;

    vec3  toFrag = wp.xyz - uCamPos;
    float dist   = length(toFrag);
    vec3  rayDir = toFrag / max(dist, 1e-4);

    float travel = max(dist - uFogStart, 0.0);

    // analytic integral of the exponentially decaying density field
    float H = max(uFogFalloff, 0.001);
    float a = uFogDensity * exp(-(uCamPos.y - uFogHeight) / H);
    float dy = rayDir.y;
    float optical;
    if (abs(dy) < 1e-4) {
      optical = a * travel;
    } else {
      optical = a * (1.0 - exp(-travel * dy / H)) * (H / dy);
    }
    float fogAmt = 1.0 - exp(-max(optical, 0.0));

    // ---- world-edge guard ---------------------------------------------
    // Height fog decays with altitude, so at flight height the exponential
    // term alone is far too weak and the torus cutoff (last meshed chunk at
    // the view radius) becomes a visible hard edge. This distance term is
    // altitude-independent: it ramps to full fog just inside the render
    // radius so terrain always melts into the sky colour, never a cliff.
    float horizDist = length(wp.xz - uCamPos.xz);
    float farFog = smoothstep(uFarFogStart, uFarFogEnd, horizDist);
    fogAmt = max(fogAmt, farFog);

    // forward scattering: looking toward the sun picks up its warm colour
    float sunDot = max(dot(rayDir, normalize(uFogSunDir)), 0.0);
    float mie    = pow(sunDot, 6.0) * 0.7 + pow(sunDot, 2.0) * 0.22;
    vec3 scatter = mix(uFogColor, uFogSunColor, clamp(mie * uFogInscatter, 0.0, 1.0));
    // ...but converge back to the sky colour as fog saturates, so the
    // horizon always dissolves cleanly into the background
    scatter = mix(scatter, uFogColor, smoothstep(0.55, 0.95, fogAmt) * 0.6);

    gl_FragColor = vec4(mix(base.rgb, scatter, clamp(fogAmt, 0.0, 1.0)), base.a);
  }
`;

export class DepthFogPass extends Pass {
  readonly material: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;
  private camera: THREE.Camera;
  private inv = new THREE.Matrix4();

  constructor(camera: THREE.Camera) {
    super();
    this.camera = camera;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tDepth: { value: null },
        uViewProjInv: { value: new THREE.Matrix4() },
        uCamPos: { value: new THREE.Vector3() },
        uNearFar: { value: new THREE.Vector2(0.08, 900) },
        ...FOG_UNIFORMS,
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this.needsSwap = true;
  }

  setSize(): void { /* resolution-independent; nothing to resize */ }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;

    // camera matrices are fresh at this point (RenderPass has already drawn)
    this.inv.copy(this.camera.projectionMatrix)
      .multiply(this.camera.matrixWorldInverse)
      .invert();
    u.uViewProjInv.value.copy(this.inv);
    u.uCamPos.value.copy(this.camera.position);
    u.uNearFar.value.set(
      (this.camera as THREE.PerspectiveCamera).near,
      (this.camera as THREE.PerspectiveCamera).far,
    );

    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.material.dispose();
    this.fsQuad.dispose();
  }
}
