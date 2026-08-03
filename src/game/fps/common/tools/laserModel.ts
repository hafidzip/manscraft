import * as THREE from 'three';

export interface LaserState {
  visible: boolean;
  firing: boolean;
  /** world-space impact point (null when not aiming at a block) */
  target: THREE.Vector3 | null;
  /** 0..1 mining progress — beam heats up as the block weakens */
  charge: number;
  /** player horizontal speed (drives sway) */
  speed: number;
}

export interface Part {
  x: number; y: number; z: number;
  w: number; h: number; d: number;
  c: number;
}

/** parts in voxel units; +z points back toward the player, barrel at -z */
export const BODY_PARTS: Part[] = [
  { x: 0, y: 0.1, z: 3.6, w: 2.1, h: 3.6, d: 2.4, c: 0x4a3b28 },
  { x: 0, y: 1.4, z: 0.6, w: 3.0, h: 2.8, d: 7.2, c: 0x3a4148 },
  { x: 0, y: 3.05, z: 0.8, w: 2.2, h: 0.5, d: 5.4, c: 0x2c3238 },
  { x: -1.68, y: 1.4, z: 0.8, w: 0.4, h: 1.2, d: 4.6, c: 0x23282e },
  { x: 1.68, y: 1.4, z: 0.8, w: 0.4, h: 1.2, d: 4.6, c: 0x23282e },
  { x: 0, y: 1.5, z: -4.4, w: 2.0, h: 1.9, d: 3.6, c: 0x4d565f },
  { x: 0, y: 1.6, z: -6.35, w: 2.5, h: 2.5, d: 0.9, c: 0x23282e },
  { x: 0, y: 1.6, z: -6.15, w: 1.1, h: 1.1, d: 1.7, c: 0x15181c },
];

export const GLOW_PARTS: Part[] = [
  { x: 0, y: 1.55, z: -2.2, w: 3.15, h: 1.5, d: 1.5, c: 0xffffff },
  { x: 0, y: 3.15, z: 2.4, w: 1.5, h: 0.7, d: 1.8, c: 0xffffff },
  { x: 0, y: 1.6, z: -6.95, w: 1.3, h: 1.3, d: 0.4, c: 0xffffff },
];

export const VOX = 0.045;
export const UP = new THREE.Vector3(0, 1, 0);

export function buildInstanced(parts: Part[], mat: THREE.Material): THREE.InstancedMesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geo, mat, parts.length);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const v = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  parts.forEach((p, i) => {
    v.set(p.x, p.y, p.z);
    s.set(p.w, p.h, p.d);
    m.compose(v, q, s);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, col.setHex(p.c));
  });
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.frustumCulled = false;
  return mesh;
}

export function makeGlowTexture(): THREE.CanvasTexture {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = s; c.height = s;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 2, s / 2, s / 2, s / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(255,224,190,0.8)');
  g.addColorStop(0.55, 'rgba(255,150,60,0.28)');
  g.addColorStop(1, 'rgba(255,120,40,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function makeBeamTexture(): THREE.CanvasTexture {
  const w = 16, h = 64;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    const wave = 0.5 + 0.5 * Math.sin((y / h) * Math.PI * 8);
    const a = Math.floor((0.22 + 0.78 * wave * wave) * 255);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255;
      img.data[i + 2] = 255; img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 2.5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
