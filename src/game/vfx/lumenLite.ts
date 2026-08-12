import * as THREE from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/* ------------------------------------------------------------------------- */
/* Shared GLSL (GLSL ES 1.00 — texture2D / gl_FragColor)                      */
/* ------------------------------------------------------------------------- */

const VERT = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DEPTH_GLSL = `
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform vec2 uTexel;

// Sky is either far-plane geometry (>= 0.9999) or the untouched clear colour
// (<= 0.0001). Lumen previously only tested the far case, which let GI/AO
// speckle into background pixels. DepthFogPass already handles both.
bool skyDepth(float d) { return d >= 0.9999 || d <= 0.0001; }

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
  float d = texture2D(tDepth, clamp(uv, 0.0, 1.0)).x;
  return skyDepth(d) ? 0.0 : 1.0;
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

  // Pick the shorter gap for smoother normals (hard 90 degree voxel edges stay hard)
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

// Lifted out of SSR so SSGI's missed rays can sample the exact same sky model.
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

/* ------------------------------------------------------------------------- */
/* SSGI (rgb) — half res.                                                    */
/* Alpha is now a constant 1.0. It is kept (rather than dropping to RGB) so   */
/* the blur, the joint upsample and the composite stay bit-identical.         */
/* ------------------------------------------------------------------------- */

const SSGI_FRAG = `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform mat4 uProj;
uniform mat4 uInvView;
uniform float uIntensity;
uniform float uGiBoost;
uniform float uSkyGi;
uniform float uThickness;
${DEPTH_GLSL}
${SKY_GLSL}

#define GI_DIRS 4
#define GI_STEPS 4
#define QUARTER_TURN 1.5707963

void main() {
  float depth = texture2D(tDepth, vUv).x;
  if (skyDepth(depth)) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 P = getViewPos(vUv);
  float viewDist = length(P);

  // Viewmodel guard — weapon/hands are camera children rendered < 1.7 view units
  // out. World-space GI on them is meaningless. rgb = 0 -> no bounce added.
  if (viewDist < 1.7) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // Past ~95m the bounce is invisible under height fog.
  float giFade = 1.0 - smoothstep(55.0, 95.0, viewDist);
  if (giFade < 0.01) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 N = getNormal(vUv);
  vec3 upv = abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(N, upv));
  vec3 B = cross(N, T);

  float rnd = hash12(gl_FragCoord.xy + vec2(17.0, 31.0));
  float rnd2 = hash12(gl_FragCoord.xy * 1.37 + vec2(9.0, 43.0));

  // ---------------------------------------------------------------------
  // SSGI — 4 cosine-weighted rays x 4 quadratic steps, hit OR sky.
  // ---------------------------------------------------------------------
  vec3 gi = vec3(0.0);
  if (giFade >= 0.01) {
    vec3 hereCol = texture2D(tDiffuse, vUv).rgb;
    // Cheap albedo proxy: compresses the sun highlight out of the receiver so GI
    // does not re-multiply direct light (the classic SSGI double-lighting).
    vec3 albedo = hereCol / (hereCol + vec3(1.0));

    vec3 giHit = vec3(0.0);
    vec3 giSky = vec3(0.0);
    float giW = 0.0;
    float hitW = 0.0;
    for (int i = 0; i < GI_DIRS; i++) {
      float ang = (float(i) + rnd) * QUARTER_TURN;
      float z = sqrt(0.12 + 0.88 * fract(rnd2 + float(i) * 0.618034));  // cosine-ish elevation
      float r = sqrt(max(1.0 - z * z, 0.0));
      vec3 dir = normalize(T * (cos(ang) * r) + B * (sin(ang) * r) + N * z);
      float ndotl = max(dot(dir, N), 0.0);
      if (ndotl < 0.02) continue;

      bool hit = false;
      bool escaped = false;                 // left the frustum: unknown, damp the sky guess
      vec3 hitCol = vec3(0.0);
      float hitT = 1.0;

      for (int s = 1; s <= GI_STEPS; s++) {
        float tt = (float(s) - rnd2 * 0.45) / float(GI_STEPS);
        float dist = 9.0 * tt * tt;                            // ~9 blocks, quadratic
        vec3 sp = P + dir * dist;
        vec4 clip = uProj * vec4(sp, 1.0);
        if (clip.w <= 0.0) { escaped = true; break; }
        vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) { escaped = true; break; }
        float sd = texture2D(tDepth, suv).x;
        if (skyDepth(sd)) continue;                            // open sky along the ray
        float sceneZ = getViewZ(sd);
        float dz = sceneZ - sp.z;
        float thick = max(uThickness, -sp.z * 0.035);          // depth-aware, corners leak less
        if (dz > 0.015 && dz < thick) {
          vec3 samp = texture2D(tDiffuse, suv).rgb;
          hitCol = samp / (samp + vec3(1.0));                  // same compression as the receiver
          hit = true;
          hitT = tt;
          break;
        }
      }

      if (hit) {
        giHit += hitCol * (1.0 - hitT * 0.75) * ndotl;
        hitW += ndotl;
      } else {
        vec3 worldDir = normalize(mat3(uInvView) * dir);
        float trust = escaped ? 0.55 : 1.0;
        giSky += skyColor(worldDir, uSunDirWorld) * uSkyGi
               * (0.20 + 0.80 * uDayFactor) * trust * ndotl;
      }
      giW += ndotl;
    }

    // Ray-hit ratio stands in for the old HBAO term: fully enclosed -> 0.15.
    float occ = 1.0 - 0.85 * (hitW / max(giW, 1e-3));
    gi = ((giHit + giSky * occ) / max(giW, 1e-3)) * albedo * uGiBoost * uIntensity * giFade;
  }

  // RGB = indirect (additive), A = 1.0 (scene passes through untouched).
  gl_FragColor = vec4(gi, 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Bilateral blur — unchanged 5 tap, now ping-ponged correctly by the pass     */
/* ------------------------------------------------------------------------- */

const BLUR_FRAG = `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform vec2 uDirection;
${DEPTH_GLSL}

// Plane-aware bilateral, 7 taps. The old kernel weighted by RAW non-linear
// depth, so its sharpness meant something different at every distance: it
// over-blurred nearby contact shadows and leaked AO across distant silhouettes.
// Distance to the centre pixel's tangent plane is scale-correct, so the extra
// slice noise flattens out without softening the contact darkening we just
// paid for.
void main() {
  float centerD = texture2D(tDepth, vUv).x;
  vec4 center = texture2D(tDiffuse, vUv);
  if (skyDepth(centerD)) { gl_FragColor = center; return; }

  vec3 P = getViewPos(vUv);
  vec3 N = getNormal(vUv);
  float tol = 0.035 + 0.02 * (-P.z);          // more slack the further out we go

  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = -3; i <= 3; i++) {
    float fi = float(i);
    vec2 uv = clamp(vUv + uDirection * fi * uTexel, 0.0, 1.0);
    float d = texture2D(tDepth, uv).x;
    if (skyDepth(d)) continue;                // never pull sky into the blur
    float planeDist = abs(dot(getViewPos(uv) - P, N));
    float w = exp(-0.5 * fi * fi / 2.56) * exp(-(planeDist * planeDist) / (tol * tol));
    sum += texture2D(tDiffuse, uv) * w;
    wsum += w;
  }
  gl_FragColor = wsum > 1e-4 ? sum / wsum : center;
}
`;

/* ------------------------------------------------------------------------- */
/* SSR — full res composite, water only                                       */
/* ------------------------------------------------------------------------- */

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
uniform float uSsrStrength;
${DEPTH_GLSL}
${SKY_GLSL}

#define RSTEPS 14
#define REFINE 4

/**
 * Joint bilateral upsample of the half-res GI buffer.
 * Plain bilinear smeared AO a full-res pixel past every silhouette, which read
 * as a bright halo hugging near geometry — and it got worse the harder the AO
 * hit. Weighting the four half-res taps by linear-depth agreement welds the
 * contact darkening to the geometry it belongs to.
 */
vec4 upsampleGi(vec2 uv, float centerZ) {
  vec2 h = uTexel * 2.0;                       // half-res texel
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 suv = clamp(uv + (vec2(float(x), float(y)) - 0.5) * h, 0.0, 1.0);
      float sz = getViewZ(texture2D(tDepth, suv).x);
      float w = 1.0 / (0.02 + abs(sz - centerZ));
      sum += texture2D(tGi, suv) * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-4);
}

/**
 * Strict, geometry-first water predicate. UNCHANGED — this is the thing that
 * stops every opaque pixel (alpha = 1) from becoming a mirror. Do not swap it
 * back to scene alpha; that is what white-speckled the entire frame.
 *   - inside a tight band of the sea surface height
 *   - mostly-horizontal surface normal
 *   - blue-dominant colour, measured relatively so planet themes still work
 */
float waterMask(vec3 worldP, vec3 worldN, vec3 color, float viewDist) {
  if (worldN.y < 0.55) return 0.0;
  float surfaceY = uSeaLevel + 0.875;   // source-water top (14/16 of a block)
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
  float depth = texture2D(tDepth, vUv).x;
  vec4 gi = skyDepth(depth) ? vec4(0.0, 0.0, 0.0, 1.0) : upsampleGi(vUv, getViewZ(depth));
  // Full-res colour preserved; half-res lighting applied on top. gi.a == 1.0.
  vec3 col = scene.rgb * gi.a + gi.rgb;

  if (!skyDepth(depth)) {
    vec3 P = getViewPos(vUv);
    float viewDist = length(P);

    // Viewmodel guard — never reflect off the first-person weapon/hands.
    if (viewDist < 1.7) { gl_FragColor = vec4(col, 1.0); return; }

    vec3 N = getNormal(vUv);
    vec3 worldP = (uInvView * vec4(P, 1.0)).xyz;
    vec3 worldN = normalize(mat3(uInvView) * N);
    float mask = waterMask(worldP, worldN, scene.rgb, viewDist);

    // Everything below this line runs on water pixels only.
    if (mask > 0.015) {
      // Two cheap octaves of world-space ripple, then back into view space.
      vec3 Nw = worldN;
      Nw.x += sin(worldP.x * 2.1 + uTime * 1.50) * 0.030
            + sin(worldP.x * 5.3 - uTime * 2.30) * 0.012;
      Nw.z += sin(worldP.z * 2.4 + uTime * 1.30) * 0.030
            + sin(worldP.z * 4.7 + uTime * 2.10) * 0.012;
      Nw = normalize(Nw);
      N = normalize(mat3(uView) * Nw);

      vec3 V = normalize(P);
      vec3 R = reflect(V, N);

      // Schlick, dielectric water. Weak looking straight down, strong at grazing.
      float NdotV = clamp(dot(-V, N), 0.0, 1.0);
      float F0 = 0.02;
      float fres = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);
      float strength = mask * mix(0.10, 0.90, fres) * uSsrStrength;

      if (strength > 0.008) {
        float jitter = hash12(gl_FragCoord.xy + vec2(11.0, 59.0));
        float stride = 0.28 + jitter * 0.14;      // shorter start, slower growth = fewer holes
        vec3 prev = P + N * 0.02;
        vec3 pos = prev + R * stride;
        bool crossed = false;

        // Coarse march: stop at the first step that lands BEHIND geometry.
        for (int i = 0; i < RSTEPS; i++) {
          if (dot(pos - P, pos - P) > uMaxDistance * uMaxDistance) break;
          vec4 clip = uProj * vec4(pos, 1.0);
          if (clip.w <= 0.0) break;
          vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
          if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
          float sd = texture2D(tDepth, suv).x;
          if (!skyDepth(sd)) {
            if (getViewZ(sd) - pos.z > 0.0) { crossed = true; break; }
          }
          prev = pos;
          pos += R * stride;
          stride *= 1.22;
        }

        bool hit = false;
        vec2 hitUV = vUv;
        vec3 hitPos = pos;
        float hitConfidence = 0.0;

        if (crossed) {
          // Binary refine, 4 iterations, between the last miss and the crossing.
          // Both ends projected with w > 0, so every midpoint does too.
          vec3 lo = prev;   // in front of geometry
          vec3 hi = pos;    // behind geometry
          for (int b = 0; b < REFINE; b++) {
            vec3 mid = (lo + hi) * 0.5;
            vec4 c = uProj * vec4(mid, 1.0);
            vec2 muv = c.xy / c.w * 0.5 + 0.5;
            float md = texture2D(tDepth, muv).x;
            if (skyDepth(md)) { lo = mid; continue; }
            if (getViewZ(md) - mid.z > 0.0) hi = mid; else lo = mid;
          }
          vec4 hc = uProj * vec4(hi, 1.0);
          hitUV = hc.xy / hc.w * 0.5 + 0.5;
          float hd = texture2D(tDepth, hitUV).x;
          float thick = uThickness * max(1.0, -hi.z * 0.025);
          float gap = getViewZ(hd) - hi.z;
          hit = !skyDepth(hd) && gap > 0.0 && gap < thick;
          hitConfidence = 1.0 - smoothstep(0.0, thick, max(gap, 0.0));
          hitPos = hi;
        }

        vec3 Rw = normalize(mat3(uInvView) * R);
        vec3 skyRef = skyColor(Rw, uSunDirWorld);
        vec3 refl = skyRef;

        if (hit) {
          // 3 taps stretched along the screen-space reflection vector: kills the
          // last of the sparkle without an extra pass or an extra RT.
          vec2 dlt = hitUV - vUv;
          vec2 sdir = dlt / max(length(dlt), 1e-5);
          vec2 blurStep = sdir * uTexel * (0.75 + 1.75 * (1.0 - hitConfidence));
          vec3 sceneHit = texture2D(tScene, hitUV).rgb * 0.5
                        + texture2D(tScene, clamp(hitUV + blurStep, 0.0, 1.0)).rgb * 0.25
                        + texture2D(tScene, clamp(hitUV - blurStep, 0.0, 1.0)).rgb * 0.25;
          // Reflect the LIT bank, not the raw scene buffer.
          vec4 gHit = texture2D(tGi, hitUV);
          vec3 litHit = sceneHit * gHit.a + gHit.rgb;

          vec2 e = abs(hitUV - 0.5) * 2.0;
          float edgeFade = smoothstep(0.0, 0.28, 1.0 - max(e.x, e.y));
          float distanceFade = 1.0 - smoothstep(uMaxDistance * 0.55, uMaxDistance, length(hitPos - P));
          refl = mix(skyRef, litHit, edgeFade);
          strength *= edgeFade * distanceFade * mix(0.65, 1.0, hitConfidence);
        }

        col = mix(col, refl, clamp(strength, 0.0, 0.78));
      }
    }
  }

  // Stay linear HDR — fog + bloom + volumetric expect HDR, ACES lives in OutputStage.
  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------------- */
/* Pass                                                                       */
/* ------------------------------------------------------------------------- */

export interface LumenLiteParams {
  /** master SSGI scale */
  giIntensity: number;
  /** bounce albedo boost (0.8 - 1.2) */
  giBoost: number;
  /** skylight added to missed GI rays */
  skyGi: number;
  /** minimum SSGI ray thickness (view units) */
  giThickness: number;
  /** SSR max ray length (view units) */
  ssrMaxDistance: number;
  /** SSR hit thickness */
  ssrThickness: number;
  /** global SSR multiplier */
  ssrStrength: number;
}

export const LUMEN_LITE_DEFAULTS: LumenLiteParams = {
  giIntensity: 1.15,
  giBoost: 1.0,
  skyGi: 0.30,
  giThickness: 0.20,
  ssrMaxDistance: 35.0,
  ssrThickness: 0.18,
  ssrStrength: 0.5,
};

export class LumenLitePass {
  readonly material: THREE.ShaderMaterial;
  private fsQuad: FullScreenQuad;

  public giRT?: THREE.WebGLRenderTarget;
  public blurRT?: THREE.WebGLRenderTarget;

  /** Single source of truth — renderPipeline no longer hardcodes values. */
  readonly params: LumenLiteParams = { ...LUMEN_LITE_DEFAULTS };

  private giMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private ssrMat: THREE.ShaderMaterial;
  private giQuad: FullScreenQuad;
  private blurQuad: FullScreenQuad;
  private ssrQuad: FullScreenQuad;
  private fallbackGi?: THREE.DataTexture;

  constructor(private camera: THREE.PerspectiveCamera, public W: number, public H: number) {
    const p = this.params;

    this.giMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
        uTexel: { value: new THREE.Vector2(1 / W, 1 / H) },
        uProj: { value: new THREE.Matrix4() },
        uInvView: { value: new THREE.Matrix4() },
        uIntensity: { value: p.giIntensity },
        uGiBoost: { value: p.giBoost },
        uSkyGi: { value: p.skyGi },
        uThickness: { value: p.giThickness },
        // sky model — SSGI now needs these for missed-ray fill
        uSkyColor: { value: new THREE.Color(0x8fb4d8) },
        uSunColor: { value: new THREE.Color(0xfff3d0) },
        uSunDirWorld: { value: new THREE.Vector3(0, 1, 0) },
        uDayFactor: { value: 1 },
      },
      vertexShader: VERT,
      fragmentShader: SSGI_FRAG,
      depthTest: false, depthWrite: false,
    });

    this.blurMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uInvProj: { value: new THREE.Matrix4() },
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
        uThickness: { value: p.ssrThickness },
        uMaxDistance: { value: p.ssrMaxDistance },
        uSsrStrength: { value: p.ssrStrength },
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

  /** Tune GI/AO/SSR without touching the shader. */
  setParams(next: Partial<LumenLiteParams>): void {
    Object.assign(this.params, next);
  }

  private applyParams(): void {
    const p = this.params;
    const g = this.giMat.uniforms;
    g.uIntensity.value = p.giIntensity;
    g.uGiBoost.value = p.giBoost;
    g.uSkyGi.value = p.skyGi;
    g.uThickness.value = p.giThickness;
    const s = this.ssrMat.uniforms;
    s.uMaxDistance.value = p.ssrMaxDistance;
    s.uThickness.value = p.ssrThickness;
    s.uSsrStrength.value = p.ssrStrength;
  }

  private syncCamera(mat: THREE.ShaderMaterial): void {
    const cam = this.camera as unknown as { projectionMatrixInverse?: THREE.Matrix4 };
    // Guarded: the blur material now needs uInvProj but has no uProj.
    if (mat.uniforms.uInvProj) {
      (mat.uniforms.uInvProj.value as THREE.Matrix4).copy(
        cam.projectionMatrixInverse ?? new THREE.Matrix4().copy(this.camera.projectionMatrix).invert()
      );
    }
    if (mat.uniforms.uProj) (mat.uniforms.uProj.value as THREE.Matrix4).copy(this.camera.projectionMatrix);
    if (mat.uniforms.uView) (mat.uniforms.uView.value as THREE.Matrix4).copy(this.camera.matrixWorldInverse);
    if (mat.uniforms.uInvView) (mat.uniforms.uInvView.value as THREE.Matrix4).copy(this.camera.matrixWorld);
  }

  setSize(width: number, height: number): void {
    this.W = width;
    this.H = height;
    const hw = Math.max(1, Math.floor(width / 2));
    const hh = Math.max(1, Math.floor(height / 2));
    if (this.giRT) this.giRT.setSize(hw, hh);
    if (this.blurRT) this.blurRT.setSize(hw, hh);
    const fullTexel = new THREE.Vector2(1 / Math.max(1, width), 1 / Math.max(1, height));
    (this.giMat.uniforms.uTexel.value as THREE.Vector2).copy(fullTexel);
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).copy(fullTexel);
    (this.blurMat.uniforms.uTexel.value as THREE.Vector2).set(2 / Math.max(1, width), 2 / Math.max(1, height));
  }

  configure(
    skyColor: THREE.Color,
    sunColor: THREE.Color,
    sunDir: THREE.Vector3,
    dayFactor: number,
    seaLevel: number,
  ): void {
    // SSGI needs the same sky model as SSR now (missed rays sample skylight).
    const g = this.giMat.uniforms;
    (g.uSkyColor.value as THREE.Color).copy(skyColor);
    (g.uSunColor.value as THREE.Color).copy(sunColor);
    (g.uSunDirWorld.value as THREE.Vector3).copy(sunDir);
    g.uDayFactor.value = dayFactor;

    const s = this.ssrMat.uniforms;
    (s.uSkyColor.value as THREE.Color).copy(skyColor);
    (s.uSunColor.value as THREE.Color).copy(sunColor);
    (s.uSunDirWorld.value as THREE.Vector3).copy(sunDir);
    s.uDayFactor.value = dayFactor;
    s.uSeaLevel.value = seaLevel;
    s.uExposure.value = 1.15 + dayFactor * 0.25;
  }

  renderPipeline(
    renderer: THREE.WebGLRenderer,
    mainRT: THREE.WebGLRenderTarget,
    lightingRT: THREE.WebGLRenderTarget,
    giTarget: THREE.WebGLRenderTarget,
    blurTarget: THREE.WebGLRenderTarget,
  ): void {
    const w = Math.max(1, this.W);
    const h = Math.max(1, this.H);
    this.applyParams();

    // 1. SSGI -> giTarget (half res)
    this.giMat.uniforms.tDiffuse.value = mainRT.texture;
    this.giMat.uniforms.tDepth.value = mainRT.depthTexture;
    this.syncCamera(this.giMat);
    (this.giMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    renderer.setRenderTarget(giTarget);
    renderer.clear();
    this.giQuad.render(renderer);

    // 2a. Horizontal blur: giTarget -> blurTarget
    this.blurMat.uniforms.tDiffuse.value = giTarget.texture;
    this.blurMat.uniforms.tDepth.value = mainRT.depthTexture;
    this.syncCamera(this.blurMat);   // plane-aware weights need the inverse projection
    (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(1, 0);
    renderer.setRenderTarget(blurTarget);
    renderer.clear();
    this.blurQuad.render(renderer);

    // 2b. Vertical blur: blurTarget -> giTarget  (ping-pong; never read+write one RT)
    this.blurMat.uniforms.tDiffuse.value = blurTarget.texture;
    (this.blurMat.uniforms.uDirection.value as THREE.Vector2).set(0, 1);
    renderer.setRenderTarget(giTarget);
    renderer.clear();
    this.blurQuad.render(renderer);

    // 3. Composite + water SSR -> lightingRT (full res, linear HDR)
    this.ssrMat.uniforms.tScene.value = mainRT.texture;
    this.ssrMat.uniforms.tGi.value = giTarget.texture;   // <- denoised result now lives here
    this.ssrMat.uniforms.tDepth.value = mainRT.depthTexture;
    this.syncCamera(this.ssrMat);
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).set(1 / w, 1 / h);
    this.ssrMat.uniforms.uTime.value = performance.now() * 0.001;

    renderer.setRenderTarget(lightingRT);
    renderer.clear();
    this.ssrQuad.render(renderer);
  }

  /** Legacy standalone path (SSR only, no GI buffer). */
  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    this.applyParams();
    this.ssrMat.uniforms.tScene.value = readBuffer.texture;
    if (!this.ssrMat.uniforms.tGi.value) {
      // neutral GI: rgb = 0 (no bounce), a = 1 (scene untouched)
      this.fallbackGi = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
      this.fallbackGi.needsUpdate = true;
      this.ssrMat.uniforms.tGi.value = this.fallbackGi;
    }
    this.ssrMat.uniforms.tDepth.value = readBuffer.depthTexture;
    this.syncCamera(this.ssrMat);
    (this.ssrMat.uniforms.uTexel.value as THREE.Vector2).set(1 / Math.max(1, this.W), 1 / Math.max(1, this.H));
    this.ssrMat.uniforms.uTime.value = performance.now() * 0.001;

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
    this.fallbackGi?.dispose();
  }
}
