import * as THREE from 'three';

export interface VoxelSpec {
  x: number;
  y: number;
  z: number;
  color: number;
  emissive?: number;
}

export function buildVoxels(
  voxels: VoxelSpec[],
  material?: THREE.Material
): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = material ?? new THREE.MeshLambertMaterial();
  const mesh = new THREE.InstancedMesh(geo, mat, voxels.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < voxels.length; i++) {
    const v = voxels[i];
    m.setPosition(v.x, v.y, v.z);
    mesh.setMatrixAt(i, m);
    c.setHex(v.color);
    mesh.setColorAt(i, c);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = false;
  mesh.frustumCulled = false;
  return mesh;
}

export function hash3(x: number, y: number, z: number): number {
  let h = x * 374761393 + y * 668265263 + z * 2147483647;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

export function lerpColor(a: number, b: number, t: number): number {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, Math.min(1, Math.max(0, t))).getHex();
}

export function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const xf = x - xi;
  const yf = y - yi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = zf * zf * (3 - 2 * zf);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi);
  const c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi);
  const c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1);
  const c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1);
  const c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = lerp(c000, c100, u);
  const x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u);
  const x11 = lerp(c011, c111, u);
  const y0 = lerp(x00, x10, v);
  const y1 = lerp(x01, x11, v);
  return lerp(y0, y1, w);
}


function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerpN(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

function ihash3(x: number, y: number, z: number): number {
  let h =
    Math.imul(x, 374761393) ^
    Math.imul(y, 668265263) ^
    Math.imul(z, 1440662683);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

function grad(h: number, x: number, y: number, z: number): number {
  const g = h & 15;
  const u = g < 8 ? x : y;
  const v = g < 4 ? y : g === 12 || g === 14 ? x : z;
  return ((g & 1) === 0 ? u : -u) + ((g & 2) === 0 ? v : -v);
}

export function pnoise3(x: number, y: number, z: number): number {
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = ihash3(X, Y, Z);
  const B = ihash3(X + 1, Y, Z);
  const C = ihash3(X, Y + 1, Z);
  const D = ihash3(X + 1, Y + 1, Z);
  const E = ihash3(X, Y, Z + 1);
  const F = ihash3(X + 1, Y, Z + 1);
  const G = ihash3(X, Y + 1, Z + 1);
  const H = ihash3(X + 1, Y + 1, Z + 1);
  return lerpN(
    lerpN(
      lerpN(grad(A, x, y, z), grad(B, x - 1, y, z), u),
      lerpN(grad(C, x, y - 1, z), grad(D, x - 1, y - 1, z), u),
      v
    ),
    lerpN(
      lerpN(grad(E, x, y, z - 1), grad(F, x - 1, y, z - 1), u),
      lerpN(grad(G, x, y - 1, z - 1), grad(H, x - 1, y - 1, z - 1), u),
      v
    ),
    w
  );
}

export function fbm(x: number, y: number, z: number, oct: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < oct; i++) {
    sum += pnoise3(x * freq, y * freq, z * freq) * amp;
    freq *= 2;
    amp *= 0.5;
  }
  return sum;
}
