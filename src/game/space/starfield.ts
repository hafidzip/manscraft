import * as THREE from 'three';
import { Rng } from './rng';

/**
 * A large sphere of stars that stays centered on the camera.
 * Seeded — the backdrop is deterministic too, like everything else.
 */
export function createStarfield(count = 6000): THREE.Points {
  const rng = new Rng(0xC0FFEEBADCAFEn);
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const c = new THREE.Color();
  const palette = [0xffffff, 0xbcd4ff, 0xffe6c0, 0xd8c0ff, 0xc0fff0];
  for (let i = 0; i < count; i++) {
    // Far beyond the streamed sector cube so real stars are never occluded.
    const r = 2.0e5 + rng.range(0, 4e4);
    const theta = rng.range(0, Math.PI * 2);
    const phi = Math.acos(2 * rng.range(0, 1) - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    c.setHex(palette[(rng.range(0, palette.length)) | 0]);
    const b = 0.5 + rng.range(0, 0.5);
    colors[i * 3] = c.r * b;
    colors[i * 3 + 1] = c.g * b;
    colors[i * 3 + 2] = c.b * b;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.6,
    sizeAttenuation: false, // screen-space pixels at 2e5 units out
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}
