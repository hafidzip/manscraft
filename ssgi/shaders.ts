// ---------------------------------------------------------------------------
// Custom GLSL: forward voxels (golden-hour sun + shadows), sky,
// half-res SSGI, and SSR + tonemap. Normals reconstructed from depth.
// ---------------------------------------------------------------------------

export const SKY_GLSL = /* glsl */ `
vec3 skyColor(vec3 dir, vec3 sunDir) {
  float h = clamp(dir.y, -1.0, 1.0);
  vec3 zenith  = vec3(0.16, 0.26, 0.46);
  vec3 horizon = vec3(1.30, 0.50, 0.20);
  vec3 ground  = vec3(0.30, 0.19, 0.13);
  float t = 1.0 - max(h, 0.0);
  t = t * t * t;
  vec3 col = mix(zenith, horizon, t);
  col = mix(col, ground, smoothstep(0.02, -0.15, h));
  float sunAmt = max(dot(dir, sunDir), 0.0);
  float s2 = sunAmt * sunAmt;
  col += vec3(1.30, 0.62, 0.28) * s2 * s2 * s2 * 0.45;
  col += vec3(1.60, 0.90, 0.45) * pow(sunAmt, 48.0) * 1.1;
  col += vec3(18.0, 10.0, 4.5) * smoothstep(0.99930, 0.99965, sunAmt);
  return col;
}
`;

export const skyVert = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const skyFrag = /* glsl */ `
varying vec3 vDir;
uniform vec3 uSunDir;
${SKY_GLSL}
void main() {
  gl_FragColor = vec4(skyColor(normalize(vDir), uSunDir), 0.0);
}
`;

// ------------------------------------------------------------------ voxels
export const voxelVert = /* glsl */ `
attribute float ao;
uniform float uTime;
uniform mat4 uShadowMatrix;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vAo;
varying vec4 vShadowCoord;
void main() {
  vec3 pos = position;
  #ifdef IS_WATER
  pos.y -= 0.12;
  pos.y += sin(uTime * 1.4 + position.x * 0.8 + position.z * 0.9) * 0.04;
  #endif
  vec4 wp = modelMatrix * vec4(pos, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normal;
  vUv = uv;
  vAo = ao;
  vShadowCoord = uShadowMatrix * wp;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const voxelFrag = /* glsl */ `
precision highp float;
uniform sampler2D uAtlas;
uniform sampler2D uShadowMap;
uniform vec2 uShadowTexel;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform vec3 uFogColor;
uniform vec3 uSunGlow;
uniform vec3 uCameraPos;
uniform float uFogDensity;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying vec2 vUv;
varying float vAo;
varying vec4 vShadowCoord;

float sampleShadow(vec3 sc, float bias) {
  if (sc.x < 0.01 || sc.x > 0.99 || sc.y < 0.01 || sc.y > 0.99 || sc.z > 1.0) return 1.0;
  float sum = 0.0;
  sum += step(sc.z - bias, texture2D(uShadowMap, sc.xy + vec2(-0.5, -0.5) * uShadowTexel).x);
  sum += step(sc.z - bias, texture2D(uShadowMap, sc.xy + vec2( 0.5, -0.5) * uShadowTexel).x);
  sum += step(sc.z - bias, texture2D(uShadowMap, sc.xy + vec2(-0.5,  0.5) * uShadowTexel).x);
  sum += step(sc.z - bias, texture2D(uShadowMap, sc.xy + vec2( 0.5,  0.5) * uShadowTexel).x);
  return sum * 0.25;
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 albedo = texture2D(uAtlas, vUv).rgb;
  float reflectivity = 0.0;
  #ifdef IS_WATER
  albedo = mix(vec3(0.05, 0.16, 0.20), albedo, 0.45);
  reflectivity = 1.0;
  #endif

  float ndl = max(dot(n, uSunDir), 0.0);
  vec3 sc = vShadowCoord.xyz / max(vShadowCoord.w, 1e-5);
  float bias = max(0.0015, 0.004 * (1.0 - ndl));
  float shadow = ndl > 0.001 ? sampleShadow(sc, bias) : 1.0;

  vec3 direct = uSunColor * ndl * shadow;
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, n.y * 0.5 + 0.5);
  vec3 col = albedo * (direct + ambient * vAo);

  #ifdef IS_WATER
  vec3 viewD = normalize(uCameraPos - vWorldPos);
  vec3 hv = normalize(viewD + uSunDir);
  col += uSunColor * pow(max(dot(n, hv), 0.0), 64.0) * shadow * 0.7;
  #endif

  vec3 toFrag = vWorldPos - uCameraPos;
  float dist2 = dot(toFrag, toFrag);
  vec3 vd = toFrag * inversesqrt(max(dist2, 1e-4));
  float sunAmt = max(dot(vd, uSunDir), 0.0);
  sunAmt = sunAmt * sunAmt * sunAmt * sunAmt * sunAmt;
  float fogF = 1.0 - exp(-dist2 * uFogDensity);
  col = mix(col, mix(uFogColor, uSunGlow, sunAmt), fogF);
  gl_FragColor = vec4(col, reflectivity * (1.0 - fogF));
}
`;

export const shadowVert = /* glsl */ `
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const shadowFrag = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;

export const fsVert = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const DEPTH_GLSL = /* glsl */ `
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

// Reconstruct view-space normal from depth (no extra geometry pass)
vec3 getNormal(vec2 uv) {
  vec3 p = getViewPos(uv);
  vec3 dx = getViewPos(uv + vec2(uTexel.x, 0.0)) - p;
  vec3 dy = getViewPos(uv + vec2(0.0, uTexel.y)) - p;
  // pick the smaller delta for better edges on blocky geometry
  vec3 dx2 = p - getViewPos(uv - vec2(uTexel.x, 0.0));
  vec3 dy2 = p - getViewPos(uv - vec2(0.0, uTexel.y));
  if (dot(dx2, dx2) < dot(dx, dx)) dx = dx2;
  if (dot(dy2, dy2) < dot(dy, dy)) dy = dy2;
  return normalize(cross(dx, dy));
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
`;

// ------------------------------------------------------------------ SSGI half-res
export const ssgiFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform mat4 uProj;
uniform float uTime;
uniform float uRadius;
uniform float uIntensity;
uniform float uAoStrength;
${DEPTH_GLSL}

#define DIRS 4
#define STEPS 3

void main() {
  float depth = texture2D(tDepth, vUv).x;
  // The half-res target stores lighting data only, never a downsampled scene.
  // That lets the composite keep every full-resolution voxel edge crisp.
  if (depth >= 0.9999) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec3 P = getViewPos(vUv);
  vec3 N = getNormal(vUv);
  vec3 up = abs(N.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 T = normalize(cross(N, up));
  vec3 B = cross(N, T);

  float rnd = hash12(gl_FragCoord.xy + fract(uTime) * 17.0);
  float rnd2 = hash12(gl_FragCoord.xy * 1.37 + fract(uTime) * 9.0);

  float occl = 0.0;
  vec3 gi = vec3(0.0);

  for (int i = 0; i < DIRS; i++) {
    float ang = (float(i) + rnd) * 1.5707963;
    float upA = 0.3 + 0.5 * fract(rnd2 + float(i) * 0.618);
    float horiz = 1.0 - upA;
    vec3 dir = normalize(T * cos(ang) * horiz + B * sin(ang) * horiz + N * upA);
    for (int s = 1; s <= STEPS; s++) {
      float tt = (float(s) - rnd2 * 0.5) / float(STEPS);
      float dist = uRadius * tt * tt;
      vec3 sp = P + dir * dist;
      vec4 clip = uProj * vec4(sp, 1.0);
      vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      float sDepth = texture2D(tDepth, suv).x;
      if (sDepth >= 0.9999) continue;
      float sceneZ = getViewZ(sDepth);
      float dz = sceneZ - sp.z;
      if (dz > 0.02 && dz < uRadius * 0.85) {
        float w = max(dot(dir, N), 0.0) * (1.0 - tt);
        // cheap facing approx without sampling another normal
        gi += min(texture2D(tDiffuse, suv).rgb, vec3(1.8)) * w;
        occl += w;
        break;
      }
    }
  }

  float ao = clamp(1.0 - uAoStrength * (occl * 0.25), 0.0, 1.0);
  vec3 indirect = gi * 0.25 * uIntensity;
  // RGB is one-bounce indirect light; alpha carries the low-frequency AO term.
  gl_FragColor = vec4(indirect * ao, ao);
}
`;

// ------------------------------------------------------------------ blur
export const blurFrag = /* glsl */ `
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
    float w = gw * exp(-abs(d - centerD) * 80.0);
    sum += texture2D(tDiffuse, uv) * w;
    wsum += w;
  }
  gl_FragColor = sum / max(wsum, 1e-4);
}
`;

// ------------------------------------------------------------------ SSR + composite
export const ssrFrag = /* glsl */ `
varying vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tGi;
uniform mat4 uProj;
uniform mat4 uInvView;
uniform mat4 uView;
uniform vec3 uSunDirWorld;
uniform float uTime;
uniform float uExposure;
${DEPTH_GLSL}
${SKY_GLSL}

vec3 ACESFilm(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

#define RSTEPS 12

void main() {
  vec4 scene = texture2D(tScene, vUv);
  vec4 gi = texture2D(tGi, vUv);
  // Preserve sharp full-res albedo and geometry. The blurred half-res pass is
  // applied as lighting only, rather than being blended over the scene image.
  vec3 col = scene.rgb * gi.a + gi.rgb;
  float mask = scene.a;
  float depth = texture2D(tDepth, vUv).x;

  if (depth < 0.9999 && mask > 0.05) {
    vec3 P = getViewPos(vUv);
    vec3 N = getNormal(vUv);

    // ripple water normals in world space
    vec3 wp = (uInvView * vec4(P, 1.0)).xyz;
    vec3 Nw = normalize(mat3(uInvView) * N);
    Nw.x += sin(wp.x * 2.1 + uTime * 1.5) * 0.03;
    Nw.z += sin(wp.z * 2.4 + uTime * 1.3) * 0.03;
    Nw = normalize(Nw);
    N = normalize(mat3(uView) * Nw);

    vec3 V = normalize(P);
    vec3 R = reflect(V, N);
    float fres = 1.0 - max(dot(-V, N), 0.0);
    fres = fres * fres * fres;
    float strength = mask * (0.2 + 0.8 * fres);

    float jitter = hash12(gl_FragCoord.xy + fract(uTime) * 11.0);
    float stride = 0.4 + jitter * 0.25;
    vec3 pos = P + R * (stride * 0.5);
    bool hit = false;
    vec2 hitUV = vUv;
    for (int i = 0; i < RSTEPS; i++) {
      vec4 clip = uProj * vec4(pos, 1.0);
      if (clip.w <= 0.0) break;
      vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) break;
      float sDepth = texture2D(tDepth, suv).x;
      if (sDepth < 0.9999) {
        float sceneZ = getViewZ(sDepth);
        if (pos.z < sceneZ - 0.04 && pos.z > sceneZ - 4.5) {
          hit = true;
          hitUV = suv;
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
    }
    col = mix(col, refl, clamp(strength, 0.0, 1.0));
  }

  col *= uExposure;
  col = ACESFilm(col);
  col = pow(col, vec3(0.98, 1.0, 1.05));
  col *= vec3(1.04, 1.0, 0.95);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.5;
  col = pow(max(col, 0.0), vec3(0.454545));
  gl_FragColor = vec4(col, 1.0);
}
`;
