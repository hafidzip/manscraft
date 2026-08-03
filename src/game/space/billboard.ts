import * as THREE from 'three';
import type { PlanetPalette } from './palettes';

// ---------------------------------------------------------------------------
// Impostor billboards: distant planets render as a shader-lit sphere, distant
// stars as additive glow sprites. Voxel meshing only activates close-up, so
// the GPU never pays for bodies it cannot resolve.
// ---------------------------------------------------------------------------

const SPHERE_GEO = new THREE.PlaneGeometry(2, 2);
SPHERE_GEO.computeBoundingSphere();

let GLOW_TEX: THREE.CanvasTexture | null = null;

export function makeGlowTexture(): THREE.CanvasTexture {
  if (GLOW_TEX) return GLOW_TEX;
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d')!;
  const g = ctx.createRadialGradient(S / 2, S / 2, 1, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,240,190,0.95)');
  g.addColorStop(0.25, 'rgba(255,190,90,0.6)');
  g.addColorStop(0.55, 'rgba(255,140,50,0.22)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  GLOW_TEX = new THREE.CanvasTexture(cv);
  GLOW_TEX.colorSpace = THREE.SRGBColorSpace;
  return GLOW_TEX;
}

/**
 * A camera-facing quad with a sphere shader: terminator (day/night) lighting
 * from the parent star + atmospheric rim. lightDir is a uniform the scene
 * refreshes every frame, so orbiting planets stay correctly lit.
 */
export function makePlanetImpostor(
  palette: PlanetPalette,
  lightDir: THREE.Vector3
): THREE.Mesh {
  // pick a middle-of-the-ramp base color to represent the planet at range
  const midStop = palette.stops[Math.floor(palette.stops.length * 0.55)][1];
  const base = new THREE.Color(midStop[0], midStop[1], midStop[2]);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: base },
      uAtmo: { value: new THREE.Color(palette.atmoHex) },
      uLightDir: { value: lightDir.clone().normalize() },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uColor;
      uniform vec3 uAtmo;
      uniform vec3 uLightDir;
      varying vec2 vUv;
      void main() {
        vec2 p = vUv * 2.0 - 1.0;
        float r2 = dot(p, p);
        if (r2 > 1.0) discard;
        float z = sqrt(max(0.0, 1.0 - r2));
        vec3 n = vec3(p.x, p.y, z);
        float diff = max(dot(n, uLightDir), 0.0);
        vec3 col = uColor * (0.12 + diff * 1.15);
        float rim = pow(1.0 - abs(z), 3.0);
        col += uAtmo * rim * 0.7;
        gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
        #include <logdepthbuf_fragment>
      }
    `,
  });
  const mesh = new THREE.Mesh(SPHERE_GEO, mat);
  mesh.frustumCulled = false;
  return mesh;
}

/** Additive glow sprite for a distant star. */
export function makeStarSprite(color: number, radius: number): THREE.Sprite {
  const mat = new THREE.SpriteMaterial({
    map: makeGlowTexture(),
    color,
    transparent: true,
    opacity: 0.95,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const s = new THREE.Sprite(mat);
  s.scale.setScalar(radius * 6);
  s.frustumCulled = false;
  return s;
}
