
import * as THREE from 'three';
import { fbm } from './voxel';

export type RNG = () => number;

export type NoiseFn = (x: number, y: number, z: number) => number;


export interface ShellOpts {
  R: number;
  shell?: number;
  freq?: number;
  amp?: number;
  octaves?: number;
  offset?: [number, number, number];
  step?: number;
  rng: RNG;
  noise: NoiseFn;
  color: (h: number, lat: number, out: THREE.Color) => void;
  onVoxel?: (
    x: number,
    y: number,
    z: number,
    h: number,
    lat: number,
    nx: number,
    ny: number,
    nz: number
  ) => void;
}

export interface ShellData {
  positions: Float32Array;
  colors: Float32Array;
}

export function generateVoxelShell(o: ShellOpts): ShellData {
  const {
    R,
    shell = 1.4,
    freq = 1.9,
    amp = 0.07,
    octaves = 5,
    offset = [0, 0, 0],
    step: rawStep = 1,
  } = o;
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color();
  const step = Math.max(1, rawStep);
  const start = -R - 4;
  const end = R + 4;

  const loR = Math.max(Math.max(0, R - 6), R * (1 - amp) - shell);
  const hiR = Math.min(end, R * (1 + amp));
  const lo2 = loR * loR;
  const hi2 = hiR * hiR;
  const EPS = 1e-9;
  const bands: number[] = [0, 0, 0, 0];

  for (let x = start; x <= end; x += step) {
    const x2 = x * x;
    if (x2 > hi2) continue;
    for (let y = start; y <= end; y += step) {
      const rxy = x2 + y * y;
      if (rxy > hi2) continue;

      const zOuter = Math.sqrt(hi2 - rxy);
      let bandCount: number;
      if (rxy < lo2) {
        const zInner = Math.sqrt(lo2 - rxy);
        bands[0] = -zOuter; bands[1] = -zInner;
        bands[2] = zInner;  bands[3] = zOuter;
        bandCount = 2;
      } else {
        bands[0] = -zOuter; bands[1] = zOuter;
        bandCount = 1;
      }

      for (let b = 0; b < bandCount; b++) {
        const zA = Math.max(bands[b * 2], start);
        const zB = Math.min(bands[b * 2 + 1], end);
        if (zA > zB) continue;
        let z = start + Math.ceil((zA - start) / step - EPS) * step;
        for (; z <= zB + EPS; z += step) {
          const d = Math.sqrt(rxy + z * z);
          if (d < loR || d > hiR) continue;
          const nx = x / d;
          const ny = y / d;
          const nz = z / d;
          const h = fbm(
            nx * freq + offset[0],
            ny * freq + offset[1],
            nz * freq + offset[2],
            octaves
          );
          const surf = R * (1 + h * amp);
          if (d > surf || d < surf - shell) continue;
          const lat = Math.abs(ny);
          o.color(h, lat, c);
          const j = 0.9 + o.rng() * 0.2;
          positions.push(x, y, z);
          colors.push(c.r * j, c.g * j, c.b * j);
          o.onVoxel?.(x, y, z, h, lat, nx, ny, nz);
        }
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
  };
}

export function instancedVoxelMesh(
  data: ShellData,
  material: THREE.Material,
  scaleMul = 1,
  step = 1
): THREE.InstancedMesh {
  const count = data.positions.length / 3;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    material,
    count
  );
  const m = new THREE.Object3D();
  const c = new THREE.Color();
  const blockScale = scaleMul * Math.max(1, step);
  for (let i = 0; i < count; i++) {
    m.position.set(
      data.positions[i * 3],
      data.positions[i * 3 + 1],
      data.positions[i * 3 + 2]
    );
    m.scale.setScalar(blockScale);
    m.updateMatrix();
    mesh.setMatrixAt(i, m.matrix);
    mesh.setColorAt(
      i,
      c.setRGB(
        data.colors[i * 3],
        data.colors[i * 3 + 1],
        data.colors[i * 3 + 2]
      )
    );
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}


export interface CloudSpec {
  hex: number;
  opacity: number;
  threshold: number;
  freq: number;
}

export function generateClouds(
  R: number,
  spec: CloudSpec,
  rng: RNG,
  _noise: NoiseFn
): ShellData {
  const inner = R * 1.06;
  const outer = R * 1.14;
  const positions: number[] = [];
  const colors: number[] = [];
  const c = new THREE.Color(spec.hex);

  const start = -R - 5;
  const end = R + 5;
  const lo2 = inner * inner;
  const hi2 = outer * outer;
  const EPS = 1e-9;
  const bands: number[] = [0, 0, 0, 0];

  for (let x = start; x <= end; x++) {
    const x2 = x * x;
    if (x2 > hi2) continue;
    for (let y = start; y <= end; y++) {
      const rxy = x2 + y * y;
      if (rxy > hi2) continue;

      const zOuter = Math.sqrt(hi2 - rxy);
      let bandCount: number;
      if (rxy < lo2) {
        const zInner = Math.sqrt(lo2 - rxy);
        bands[0] = -zOuter; bands[1] = -zInner;
        bands[2] = zInner;  bands[3] = zOuter;
        bandCount = 2;
      } else {
        bands[0] = -zOuter; bands[1] = zOuter;
        bandCount = 1;
      }

      for (let b = 0; b < bandCount; b++) {
        const zA = Math.max(bands[b * 2], start);
        const zB = Math.min(bands[b * 2 + 1], end);
        if (zA > zB) continue;
        let z = Math.ceil(zA - EPS);
        for (; z <= zB + EPS; z++) {
          const d = Math.sqrt(rxy + z * z);
          if (d < inner || d > outer) continue;
          const nx = x / d;
          const ny = y / d;
          const nz = z / d;
          const v = fbm(
            nx * spec.freq + 61.7,
            ny * spec.freq - 31.3,
            nz * spec.freq + 7.1,
            4
          );
          if (v < spec.threshold) continue;
          const j = 0.8 + rng() * 0.35;
          positions.push(x + nx * 0.5, y + ny * 0.5, z + nz * 0.5);
          colors.push(c.r * j, c.g * j, c.b * j);
        }
      }
    }
  }
  return {
    positions: new Float32Array(positions),
    colors: new Float32Array(colors),
  };
}


export interface LightInstance {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  warm: number;
}

export interface CityLightsData {
  mesh: THREE.InstancedMesh;
  base: Float32Array;
  normals: Float32Array;
  phase: Float32Array;
  count: number;
}

export function createCityLights(
  items: LightInstance[],
  rng: RNG
): CityLightsData | null {
  if (!items.length) return null;
  const n = items.length;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.45, 0.45, 0.45),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    n
  );
  const m = new THREE.Object3D();
  const c = new THREE.Color();
  const base = new Float32Array(n * 3);
  const normals = new Float32Array(n * 3);
  const phase = new Float32Array(n);

  for (let i = 0; i < n; i++) {
    const it = items[i];
    m.position.set(
      it.x + it.nx * 0.55,
      it.y + it.ny * 0.55,
      it.z + it.nz * 0.55
    );
    m.scale.setScalar(0.55 + rng() * 0.8);
    m.updateMatrix();
    mesh.setMatrixAt(i, m.matrix);
    const warm = it.warm;
    const r = 1.0;
    const g = 0.72 + 0.2 * warm;
    const b = 0.35 + 0.35 * (1 - warm);
    const br = 0.55 + rng() * 0.6;
    base[i * 3] = r * br;
    base[i * 3 + 1] = g * br;
    base[i * 3 + 2] = b * br;
    normals[i * 3] = it.nx;
    normals[i * 3 + 1] = it.ny;
    normals[i * 3 + 2] = it.nz;
    phase[i] = rng() * Math.PI * 2;
    c.setRGB(base[i * 3], base[i * 3 + 1], base[i * 3 + 2]);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return { mesh, base, normals, phase, count: n };
}


export interface LavaData {
  mesh: THREE.InstancedMesh;
  mat: THREE.MeshBasicMaterial;
  count: number;
}

export function createLava(items: LightInstance[], rng: RNG): LavaData | null {
  if (!items.length) return null;
  const n = items.length;
  const mat = new THREE.MeshBasicMaterial({
    color: 0xff6a22,
    toneMapped: false,
    transparent: true,
    opacity: 1,
  });
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.5, 0.5, 0.5),
    mat,
    n
  );
  const m = new THREE.Object3D();
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const it = items[i];
    m.position.set(
      it.x + it.nx * 0.5,
      it.y + it.ny * 0.5,
      it.z + it.nz * 0.5
    );
    m.scale.setScalar(0.55 + 0.35 * Math.abs(it.nx * it.ny * it.nz));
    m.updateMatrix();
    mesh.setMatrixAt(i, m.matrix);
    const br = 0.75 + rng() * 0.5;
    c.setRGB(1.0 * br, 0.52 * br, 0.14 * br);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return { mesh, mat, count: n };
}


export function createRings(rng: RNG, R: number, hex: number): THREE.InstancedMesh {
  const count = 2600;
  const inner = R * 1.45;
  const outer = R * 2.75;
  const gaps: Array<[number, number]> = [
    [0.30, 0.36],
    [0.58, 0.635],
    [0.80, 0.845],
  ];
  const geo = new THREE.BoxGeometry(1.0, 0.05, 1.0);
  const mat = new THREE.MeshLambertMaterial({
    transparent: true,
    opacity: 0.9,
    flatShading: true,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const m = new THREE.Object3D();
  const base = new THREE.Color(hex);
  const col = new THREE.Color();

  let n = 0;
  let guard = 0;
  while (n < count && guard < count * 3) {
    guard++;
    const t = rng();
    if (gaps.some(([a, b]) => t > a && t < b)) continue;
    const r = inner + t * (outer - inner);
    const a = rng() * Math.PI * 2;
    m.position.set(Math.cos(a) * r, (rng() - 0.5) * 0.3, Math.sin(a) * r);
    m.rotation.y = rng() * Math.PI;
    const s = 0.55 + rng() * 1.15;
    m.scale.set(s, 1, s);
    m.updateMatrix();
    mesh.setMatrixAt(n, m.matrix);
    const sh = 0.62 + 0.38 * Math.sin(t * 43.0 + rng() * 1.2);
    col.copy(base).multiplyScalar(sh * (0.75 + rng() * 0.5));
    mesh.setColorAt(n, col);
    n++;
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.rotation.x = 1.05 + rng() * 0.5;
  mesh.rotation.z = rng() * 0.25;
  mesh.renderOrder = 6;
  mesh.frustumCulled = false;
  return mesh;
}


export function createAtmosphere(
  R: number,
  hex: number,
  power: number,
  strength: number,
  sunDir: THREE.Vector3
): { mesh: THREE.Mesh; mat: THREE.ShaderMaterial } {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(hex) },
      uSunDir: { value: sunDir.clone() },
      uPower: { value: power },
      uStrength: { value: strength },
    },
    vertexShader: `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vN = normalize(mat3(modelMatrix) * normal);
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vW = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3  uColor;
      uniform vec3  uSunDir;
      uniform float uPower;
      uniform float uStrength;
      varying vec3 vN;
      varying vec3 vW;
      void main() {
        vec3 V = normalize(cameraPosition - vW);
        vec3 N = normalize(-vN); // BackSide -> face the viewer
        float f = pow(1.0 - clamp(dot(V, N), 0.0, 1.0), uPower);

        vec3 limb = N - V * dot(N, V);
        float sun = 0.0;
        if (length(limb) > 1e-4) {
          sun = smoothstep(-0.35, 0.65, dot(normalize(limb), uSunDir));
        }

        vec3 col = mix(uColor * 0.22, uColor, sun);
        col = mix(col, col * vec3(1.7, 0.95, 0.62), smoothstep(0.5, 0.0, sun) * sun * 1.6);

        float a = f * uStrength * (0.05 + 0.95 * sun);
        gl_FragColor = vec4(col * a, a);
        #include <logdepthbuf_fragment>
      }
    `,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(R, 48, 32), mat);
  mesh.renderOrder = 10;
  mesh.frustumCulled = false;
  return { mesh, mat };
}
