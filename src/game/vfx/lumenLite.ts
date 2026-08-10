
import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

const VERT = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const DEPTH_GLSL = `
  uniform sampler2D tDepth;
  uniform mat4 uInvProj;
  uniform vec2 uTexel;

  vec3 getViewPos(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * ndc;
    return v.xyz / v.w;
  }

  float getViewZ(float d) {
    vec4 v = uInvProj * vec4(0.0, 0.0, d * 2.0 - 1.0, 1.0);
    return v.z / v.w;
  }

  float validDepth(vec2 uv) {
    return step(texture2D(tDepth, clamp(uv, 0.0, 1.0)).x, 0.9999);
  }

  vec3 getNormal(vec2 uv) {
    uv = clamp(uv, uTexel, 1.0 - uTexel);
    vec3 p = getViewPos(uv);
    vec2 px = vec2(uTexel.x, 0.0);
    vec2 py = vec2(0.0, uTexel.y);
    float validL = validDepth(uv - px);
    float validR = validDepth(uv + px);
    float validD = validDepth(uv - py);
    float validU = validDepth(uv + py);

    float bestL = validL > 0.5 ? 1.0 : 0.0;
    float bestR = validR > 0.5 ? 1.0 : 0.0;
    float bestU = validU > 0.5 ? 1.0 : 0.0;
    float bestD = validD > 0.5 ? 1.0 : 0.0;

    vec3 dxR = getViewPos(uv + px) - p;
    vec3 dxL = p - getViewPos(uv - px);
    vec3 dyU = getViewPos(uv + py) - p;
    vec3 dyD = p - getViewPos(uv - py);

    vec3 dx = bestL > bestR ? dxL : dxR;
    vec3 dy = bestD > bestU ? dyD : dyU;

    // Pick the shorter gap for smoother normals
    if (bestL > 0.5 && bestR > 0.5 && dot(dxL, dxL) < dot(dxR, dxR)) dx = dxL;
    if (bestD > 0.5 && bestU > 0.5 && dot(dyD, dyD) < dot(dyU, dyU)) dy = dyD;

    vec3 n = normalize(cross(dx, dy));
    return dot(n, n) > 0.01 ? n : vec3(0.0, 0.0, 1.0);
  }

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
`;

const SKY_GLSL = `
  uniform vec3 uSkyColor;
  uniform vec3 uSunDirWorld;
  uniform float uDayFactor;
  uniform vec3 uSunColor;

  float skySunTerm(vec3 R, vec3 sunDir) {
    float dotS = max(dot(normalize(R), sunDir), 0.0);
    return pow(dotS, 96.0) * 1.25 + pow(dotS, 384.0) * 2.05;
  }

  vec3 skyColor(vec3 R, vec3 sunDir) {
    float up = clamp(R.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 sky = uSkyColor * mix(0.78, 1.18, up);
    sky += skySunTerm(R, sunDir) * uSunColor * uDayFactor;
    return min(sky, vec3(3.0));
  }
`;

const SSGI_FRAG = `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform mat4 uProj;
  uniform float uIntensitY;
  uniform float uAoStrength;
  uniform float uThickness;
  ${DEPTH_GLSL}

  #define DIRS 4
  #define STEPS 3

  void main() {
    float depth = texture2D(tDepth, vUv).x;
    if (depth >= 0.9999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    vec3 P = getViewPos(vUv);
    // Viewmodel guard — weapon/hands are camera children rendered <1.7 view
    // units out. World-space GI/AO on them is meaningless and previously
    // produced a dark-tinted gun; skip them entirely (alpha=1 -> no AO applied).
    if (length(P) < 1.7) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

    vec3 N = getNormal(vUv);
    vec3 up = abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    vec3 T = normalize(cross(N, up));
    vec3 B = cross(N, T);

    float rnd = hash12(gl_FragCoord.xy + vec2(17.0, 31.0));
    float rnd2 = hash12(gl_FragCoord.xy * 1.37 + vec2(9.0, 43.0));

    vec3 gi = vec3(0.0);

    for (int i = 0; i < DIRS; i++) {
      float ang = (float(i) + rnd) * 1.5707963;
      float upA = 0.3 + 0.5 * fract(rnd2 + float(i) * 0.618);
      float horiz = 1.0 - upA;
      vec3 dir = normalize(T * cos(ang) * horiz + B * sin(ang) * horiz + N * upA);
      for (int s = 1; s <= STEPS; s++) {
        float tt = (float(s) - rnd2 * 0.5) / float(STEPS);
        float dist = 6.0 * tt * tt; // smaller radius = cleaner
        vec3 sp = P + dir * dist;
        vec4 clip = uProj * vec4(sp, 1.0);
        if (clip.w <= 0.0) break;
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
        float sDepth = texture2D(tDepth, suv).x;
        if (sDepth >= 0.9999) continue;
        float sceneZ = getViewZ(sDepth);
        float dz = sceneZ - sp.z;
        float thickness = max(0.15, -sp.z * 0.03);
        if (dz > 0.0 && dz < thickness) {
          float w = max(dot(dir, N), 0.0) * (1.0 - tt);
          gi += min(texture2D(tDiffuse, suv).rgb, vec3(1.8)) * w;
          break;
        }
      }
    }

    // ---- SSAO: 8-sample interleaved-gradient-noise hemisphere ----
    // Runs at half-res, reuses the full-res depth buffer, and rides the two
    // bilateral blur passes already in the pipeline — so it costs one small
    // kernel (8 depth taps) with no extra render targets. IGN rotation removes
    // banding; the normal-lifted hemisphere avoids self-occluding flat faces.
    float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    float aoOcc = 0.0;
    float aoR = 1.6; // world-space radius — just over one block, for crevice AO
    for (int j = 0; j < 8; j++) {
      float fj = float(j);
      float ang = (fj + ign) * 0.785398;             // spread over 2π
      float rad = aoR * sqrt((fj + 0.5) / 8.0);       // sqrt disc distribution
      vec3 off = T * cos(ang) * rad + B * sin(ang) * rad + N * (0.3 * rad + 0.15);
      vec3 sp = P + off;
      vec4 clip = uProj * vec4(sp, 1.0);
      if (clip.w <= 0.0) continue;
      vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sDepth = texture2D(tDepth, suv).x;
      if (sDepth >= 0.9999) continue;
      float sceneZ = getViewZ(sDepth);
      float dz = sceneZ - sp.z;
      float thick = max(0.2, -sp.z * 0.045);          // depth-aware thickness
      if (dz > 0.02 && dz < thick) aoOcc += 1.0 - smoothstep(0.0, aoR, length(off));
    }
    aoOcc /= 8.0;
    float ao = 1.0 - clamp(uAoStrength * aoOcc * 1.7, 0.0, 0.82);

    // RGB = indirect; alpha = AO for blend
    gl_FragColor = vec4(gi * 0.25 * uIntensitY, ao);
  }
`;

const BLUR_FRAG = `
  varying vec2 vUv;
  uniform sampler2D tDiffuse;
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform vec2 uDirection;
  void main() {
    float centerD = texture2D(tDepth, vUv).x;
    vec4 sum = vec4(0.0);
    float wsum = 0.0;
    for (int i = -2; i <= 2; i++) {
      float fi = float(i);
      float gw = exp(-0.5 * fi * fi);
      vec2 uv = vUv + uDirection * fi * uTexel;
      float d = texture2D(tDepth, uv).x;
      float depthSharpness = 120.0 + centerD * 520.0;
      float w = gw * exp(-abs(d - centerD) * depthSharpness);
      sum += texture2D(tDiffuse, uv) * w;
      wsum += w;
    }
    gl_FragColor = sum / max(wsum, 1e-4);
  }
`;

const SSR_FRAG = `
  varying vec2 vUv;
  uniform sampler2D tScene;
  uniform sampler2D tGi;
  uniform mat4 uProj;
  uniform mat4 uInvView;
  uniform mat4 uView;
  uniform float uTime;
  uniform float uExposure;
  uniform float uThickness;
  uniform float uMaxDistance;
  uniform float uSeaLevel;
  ${DEPTH_GLSL}
  ${SKY_GLSL}

  #define RSTEPS 12

  /**
   * Strict, geometry-first water predicate.
   *
   * The previous version used the scene alpha channel as a "reflect mask",
   * but opaque terrain/foliage materials all write alpha = 1, so every
   * surface in the frame (grass, dirt, trees, the player's own gun) was
   * treated as reflective. Combined with the un-denoised single-sample,
   * hash-jittered SSR trace, that produced the dense white speckle/noise
   * seen across the whole screen.
   *
   * Water is identified instead from world-space geometry:
   *   - within a tight band of the sea surface height
   *   - a mostly-horizontal (flat) surface normal
   *   - a colour that is blue-dominant (rejects sand/dirt/grass outright)
   */
  float waterMask(vec3 worldP, vec3 worldN, vec3 color, float viewDist) {
    if (worldN.y < 0.55) return 0.0;
    float surfaceY = uSeaLevel + 0.875; // source-water top (14/16 blocks)
    float nearSurface = 1.0 - smoothstep(0.10, 0.55, abs(worldP.y - surfaceY));
    if (nearSurface < 0.02) return 0.0;
    float flatness = smoothstep(0.62, 0.93, worldN.y);
    float blueDom = color.b - max(color.r, color.g * 0.84);
    float blueWater = smoothstep(0.02, 0.11, blueDom) * smoothstep(0.10, 0.28, color.b);
    float distFade = 1.0 - smoothstep(120.0, 180.0, viewDist);
    return clamp(nearSurface * flatness * blueWater * distFade, 0.0, 1.0);
  }

  void main() {
    vec4 scene = texture2D(tScene, vUv);
    vec4 gi = texture2D(tGi, vUv);
    // Preserve full-res colour; lighting (GI) is only applied where it exists
    vec3 col = scene.rgb * gi.a + gi.rgb;
    float depth = texture2D(tDepth, vUv).x;

    if (depth < 0.9999) {
      vec3 P = getViewPos(vUv);
      float viewDist = length(P);
      // Viewmodel guard — never reflect off the first-person weapon/hands.
      // Keep linear HDR here; final ACES tonemap is in the OutputStage.
      if (viewDist < 1.7) {
        gl_FragColor = vec4(col, 1.0);
        return;
      }
      vec3 N = getNormal(vUv);
      vec3 worldP = (uInvView * vec4(P, 1.0)).xyz;
      vec3 worldN = normalize(mat3(uInvView) * N);
      float mask = waterMask(worldP, worldN, scene.rgb, viewDist);

      // Skip the raymarch entirely off water — this is what actually stops
      // the whole scene (grass/dirt/foliage) from being reflection-noised,
      // since previously the mask was scene alpha (about 1.0 on every opaque pixel).
      if (mask > 0.015) {
        // Ripple the water normal in world space, then bring it back to view space.
        vec3 Nw = worldN;
        Nw.x += sin(worldP.x * 2.1 + uTime * 1.5) * 0.03;
        Nw.z += sin(worldP.z * 2.4 + uTime * 1.3) * 0.03;
        Nw = normalize(Nw);
        N = normalize(mat3(uView) * Nw);

        vec3 V = normalize(P);
        vec3 R = reflect(V, N);
        float fres = 1.0 - max(dot(-V, N), 0.0);
        fres = fres * fres * fres;
        float strength = mask * (0.2 + 0.8 * fres);

        float jitter = hash12(gl_FragCoord.xy + vec2(11.0, 59.0));
        float stride = 0.35 + jitter * 0.18;
        vec3 pos = P + R * (stride * 0.5);
        bool hit = false;
        vec2 hitUV = vUv;
        float hitConfidence = 0.0;
        for (int i = 0; i < RSTEPS; i++) {
          if (dot(pos - P, pos - P) > uMaxDistance * uMaxDistance) break;
          vec4 clip = uProj * vec4(pos, 1.0);
          if (clip.w <= 0.0) break;
          vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
          float sDepth = texture2D(tDepth, suv).x;
          if (sDepth < 0.9999) {
            float sceneZ = getViewZ(sDepth);
            float thickness = uThickness * max(1.0, -pos.z * 0.025);
            float gap = sceneZ - pos.z;
            if (gap > 0.0 && gap < thickness) {
              hit = true;
              hitUV = suv;
              hitConfidence = 1.0 - smoothstep(0.0, thickness, gap);
              break;
            }
          }
          pos += R * stride;
          stride *= 1.28;
        }

        vec3 Rw = normalize(mat3(uInvView) * R);
        vec3 skyRef = skyColor(Rw, uSunDirWorld);
        vec3 refl = skyRef;
        if (hit) {
          vec2 e = abs(hitUV - 0.5) * 2.0;
          float edgeFade = smoothstep(0.0, 0.3, 1.0 - max(e.x, e.y));
          refl = mix(skyRef, texture2D(tScene, hitUV).rgb, edgeFade);
          float distanceFade = 1.0 - smoothstep(uMaxDistance * 0.55, uMaxDistance, length(pos - P));
          strength *= edgeFade * distanceFade * mix(0.7, 1.0, hitConfidence);
        }
        col = mix(col, refl, clamp(strength, 0.0, 0.62));
      }
    }

    // stay linear HDR — fog + bloom + volumetric expect HDR, final ACES is in OutputStage
    gl_FragColor = vec4(col, 1.0);
  }
`;

export class LumenLitePass {
  readonly material: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;

  public giRT?: THREE.WebGLRenderTarget;
  public blurRT?: THREE.WebGLRenderTarget;

  private giMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private ssrMat: THREE.ShaderMaterial;
  private giQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private ssrQuad: FullScreenQuad;

  constructor(private camera: THREE.PerspectiveCamera, public W: number, public H: number) {
    this.giMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
        uProj: { value: new THREE.Matrix4() },
        uIntensitY: { value: 0.55 },
        uAoStrength: { value: 0.9 },
        uThickness: { value: 0.15 },
      },
      vertexShader: VERT,
      fragmentShader: SSGI_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2(1 / (W / 2), 1 / (H / 2)) },
        uDirection: { value: new THREE.Vector2(1, 0) },
      },
      vertexShader: VERT,
      fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.ssrMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tGi: { value: null }, tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
        uProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uView: { value: new THREE.Matrix4() },
        uSkyColor: { value: new THREE.Color(0x8fb4d8) },
        uSunColor: { value: new THREE.Color(0xfff3d0) },
        uSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
        uDayFactor: { value: 1 },
        uSeaLevel: { value: 32 },
        uTime: { value: 0 },
        uExposure: { value: 1.0 },
        uThickness: { value: 0.28 },
        uMaxDistance: { value: 65.0 },
      },
      vertexShader: VERT,
      fragmentShader: SSR_FRAG,
      depthTest: false, depthWrite: false,
    });
    this.giQuad = new FullScreenQuad(this.giMat);
    this.blurQuad = new FullScreenQuad(this.blurMat);
    this.ssrQuad = new FullScreenQuad(this.ssrMat);

    this.material = this.ssrMat;
    this.fsQuad = this.ssrQuad;
  }

  setSize(width: number, height: number) {
    this.W = width;
    this.H = height;
    if (this.giRT) this.giRT.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
    if (this.blurRT) this.blurRT.setSize(Math.max(1, Math.floor(width / 2)), Math.max(1, Math.floor(height / 2)));
    const fullTexel = new THREE.Vector2(1 / Math.max(1, width), 1 / Math.max(1, height));
    this.giMat.uniforms.uTexel.value.copy(fullTexel);
    this.ssrMat.uniforms.uTexel.value.copy(fullTexel);
    this.blurMat.uniforms.uTexel.value.set(2 / Math.max(1, width), 2 / Math.max(1, height));
  }

  configure(
    skyColor: THREE.Color,
    sunColor: THREE.Color,
    sunDir: THREE.Vector3,
    dayFactor: number,
    seaLevel: number,
  ): void {
    this.ssrMat.uniforms.uSkyColor.value.copy(skyColor);
    this.ssrMat.uniforms.uSunColor.value.copy(sunColor);
    this.ssrMat.uniforms.uSunDirWorld.value.copy(sunDir);
    this.ssrMat.uniforms.uDayFactor.value = dayFactor;
    this.ssrMat.uniforms.uSeaLevel.value = seaLevel;
    this.ssrMat.uniforms.uExposure.value = 1.15 + dayFactor * 0.25;
  }

  renderPipeline(
    renderer: THREE.WebGLRenderer,
    mainRT: THREE.WebGLRenderTarget,
    lightingRT: THREE.WebGLRenderTarget,
    giTarget: THREE.WebGLRenderTarget,
    blurTarget: THREE.WebGLRenderTarget,
  ): void {
    const w = this.W;
    const h = this.H;

    this.giMat.uniforms.tDiffuse.value = mainRT.texture;
    this.giMat.uniforms.tDepth.value = mainRT.depthTexture;
    (this.giMat.uniforms.uInvProj.value as THREE.Matrix4).copy(
      (this.camera as unknown as { projectionMatrixInverse: THREE.Matrix4 }).projectionMatrixInverse ??
        new THREE.Matrix4().copy(this.camera.projectionMatrix).invert()
    );
    (this.giMat.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, w), 1 / Math.max(1, h));
    this.giMat.uniforms.uProj.value.copy(this.camera.projectionMatrix);
    this.giMat.uniforms.uIntensitY.value = 1.1;
    this.giMat.uniforms.uAoStrength.value = 0.7;
    this.giMat.uniforms.uThickness.value = 0.22;
    renderer.setRenderTarget(giTarget);
    renderer.clear();
    this.giQuad.render(renderer);

    this.blurMat.uniforms.tDiffuse.value = giTarget.texture;
    this.blurMat.uniforms.tDepth.value = mainRT.depthTexture;
    this.blurMat.uniforms.uDirection.value.set(1, 0);
    renderer.setRenderTarget(blurTarget);
    renderer.clear();
    this.blurQuad.render(renderer);
    this.blurMat.uniforms.tDiffuse.value = blurTarget.texture;
    this.blurMat.uniforms.uDirection.value.set(0, 1);
    renderer.setRenderTarget(blurTarget);
    renderer.clear();
    this.blurQuad.render(renderer);

    this.ssrMat.uniforms.tScene.value = mainRT.texture;
    this.ssrMat.uniforms.tGi.value = blurTarget.texture;
    this.ssrMat.uniforms.tDepth.value = mainRT.depthTexture;
    (this.ssrMat.uniforms.uInvProj.value as THREE.Matrix4).copy(
      (this.camera as unknown as { projectionMatrixInverse: THREE.Matrix4 }).projectionMatrixInverse ??
        new THREE.Matrix4().copy(this.camera.projectionMatrix).invert()
    );
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, w), 1 / Math.max(1, h));
    this.ssrMat.uniforms.uProj.value.copy(this.camera.projectionMatrix);
    this.ssrMat.uniforms.uView.value.copy(this.camera.matrixWorldInverse);
    this.ssrMat.uniforms.uInvView.value.copy(this.camera.matrixWorld);
    this.ssrMat.uniforms.uTime.value = Date.now() * 0.001;
    this.ssrMat.uniforms.uMaxDistance.value = 35.0;
    this.ssrMat.uniforms.uThickness.value = 0.18;

    renderer.setRenderTarget(lightingRT);
    renderer.clear();
    this.ssrQuad.render(renderer);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.ssrMat.uniforms.tScene.value = readBuffer.texture;
    if (!this.ssrMat.uniforms.tGi.value) {
      const fallback = new THREE.DataTexture(new Uint8Array([0,0,0,255]), 1, 1, THREE.RGBAFormat);
      fallback.needsUpdate = true;
      this.ssrMat.uniforms.tGi.value = fallback;
    }
    this.ssrMat.uniforms.tDepth.value = readBuffer.depthTexture;
    (this.ssrMat.uniforms.uInvProj.value as THREE.Matrix4).copy(
      (this.camera as unknown as { projectionMatrixInverse: THREE.Matrix4 }).projectionMatrixInverse ??
        new THREE.Matrix4().copy(this.camera.projectionMatrix).invert()
    );
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, this.W), 1 / Math.max(1, this.H));
    this.ssrMat.uniforms.uProj.value.copy(this.camera.projectionMatrix);
    this.ssrMat.uniforms.uView.value.copy(this.camera.matrixWorldInverse);
    this.ssrMat.uniforms.uInvView.value.copy(this.camera.matrixWorld);
    this.ssrMat.uniforms.uTime.value = Date.now() * 0.001;
    this.ssrMat.uniforms.uMaxDistance.value = 35.0;
    this.ssrMat.uniforms.uThickness.value = 0.18;

    renderer.setRenderTarget(writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose(): void {
    this.giMat.dispose();
    this.blurMat.dispose();
    this.ssrMat.dispose();
    this.giQuad.dispose();
    this.blurQuad.dispose();
    this.ssrQuad.dispose();
  }
}
