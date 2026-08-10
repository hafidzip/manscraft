import * as THREE from 'three';
import { minImageF } from '../core/constants';
import { LOD_PARTS, PRESET_SCALE, BLACK_COLOR } from './EnemyRig';

export const INSTANCED_ENEMIES = true;

// Maximum simultaneous box-parts across ALL live enemies.
// LOD0 has 8 body parts + 2 eyes = 10 per enemy.
// 512 enemies × 10 = 5120, comfortably under 8192.
const MAX_BODY = 8192;
const MAX_EYES = 2048;   // always << MAX_BODY

// ------------------------------------------------------------------
// Closed-form expansion of the transform chain
//   M = T(render)·Ry(yaw)·T(pivot)·Rx(swing)·T(0,-off,0)·S(box)
// The previous version ran this through ~8 Matrix4 multiplies per part
// (~48 multiply-adds each, 16-float reads+writes). The closed form is
// ~11 scalar multiplies plus 16 stores. Yaw sin/cos once per enemy;
// swing sin/cos only for parts that actually swing (≈3 of 8 at LOD0).
// Zero allocation: everything below is scalar locals.
// ------------------------------------------------------------------

export interface InstancedAgent {
  cfg: { id: string; peaceful?: boolean };
  pos: { x: number; y: number; z: number };
  alive: boolean;
  rendered: boolean;
  lod: 0 | 1 | 2;
  tier: number;
  distToPlayer: number;
  yaw: number;
  instGait: number;
  instGaitGain: number;
  hitFlash: number;
}

export class EnemyInstancer {
  /** All black body parts — Lambert so lighting still works. */
  readonly mesh: THREE.InstancedMesh;
  /** Glowing red eyes — MeshBasicMaterial so they are always bright. */
  readonly eyeMesh: THREE.InstancedMesh;

  private liveBody = 0;
  private liveEyes = 0;
  private dropped  = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BoxGeometry(1, 1, 1);

    // Body: pure black Lambert. Do NOT set vertexColors:true — InstancedMesh
    // already multiplies material.color by instanceColor without it, and
    // vertexColors needs a geometry color attribute that we don't have.
    const bodyMat = new THREE.MeshLambertMaterial({ color: BLACK_COLOR.clone() });
    this.mesh = new THREE.InstancedMesh(geo, bodyMat, MAX_BODY);
    this.mesh.name = 'enemy-body';
    this.mesh.frustumCulled = false;
    this.mesh.castShadow    = true;
    this.mesh.receiveShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.raycast = () => { };   // hit-testing via EnemyManager.raycast
    this.mesh.count = 0;

    // Eyes: unlit bright red — MeshBasicMaterial ignores Lambert lighting so
    // eyes stay vivid even at night.  depthTest on so they respect occlusion.
    const eyeMat = new THREE.MeshBasicMaterial({
      color: 0xff1a1a,
      toneMapped: false,   // preserve HDR brightness through post-processing
    });
    this.eyeMesh = new THREE.InstancedMesh(geo, eyeMat, MAX_EYES);
    this.eyeMesh.name = 'enemy-eyes';
    this.eyeMesh.frustumCulled = false;
    this.eyeMesh.castShadow    = false;
    this.eyeMesh.receiveShadow = false;
    this.eyeMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.eyeMesh.raycast = () => { };
    this.eyeMesh.count = 0;

    // Eyes glow, so add them slightly in front of the rest to avoid z-fighting.
    this.eyeMesh.renderOrder = 1;

    // Pre-create the body instanceColor buffer (per-instance grey that flashes
    // toward white) and pre-initialise the constant matrix lanes so push()
    // only ever writes the 12 varying floats per part.
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_BODY * 3), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    const bcol = this.mesh.instanceColor.array as Float32Array;
    const bv = BLACK_COLOR.r;
    for (let i = 0; i < MAX_BODY * 3; i++) bcol[i] = bv;

    for (const m of [this.mesh, this.eyeMesh]) {
      const a = m.instanceMatrix.array as Float32Array;
      for (let i = 0; i < a.length; i += 16) {
        a[i + 3] = 0; a[i + 7] = 0; a[i + 11] = 0; a[i + 15] = 1;
      }
    }

    scene.add(this.mesh);
    scene.add(this.eyeMesh);
  }

  get liveBodyCount() { return this.liveBody; }
  get liveEyeCount()  { return this.liveEyes;  }
  get droppedCount()  { return this.dropped;   }

  begin() {
    this.liveBody = 0;
    this.liveEyes = 0;
    this.dropped  = 0;
  }

  push(e: InstancedAgent, playerX: number, playerZ: number): boolean {
    if (!e.alive || e.cfg.peaceful || !e.rendered) return true;

    const parts = LOD_PARTS[e.lod] ?? LOD_PARTS[2];

    // Count body and eye parts separately for capacity checks.
    let needBody = 0, needEyes = 0;
    for (const p of parts) p.tint === 1 ? needEyes++ : needBody++;
    if (this.liveBody + needBody > MAX_BODY || this.liveEyes + needEyes > MAX_EYES) {
      this.dropped++;
      return false;
    }

    const rx    = playerX + minImageF(e.pos.x - playerX);
    const rz    = playerZ + minImageF(e.pos.z - playerZ);
    const ry    = e.pos.y;
    const scale = PRESET_SCALE[e.cfg.id] ?? 1;
    const flash = e.hitFlash > 0 ? Math.min(1, e.hitFlash * 8) : 0;

    const g  = e.instGait;
    const amp = e.instGaitGain;
    const s1 = Math.sin(g) * 0.65 * amp;
    const s2 = Math.sin(g + Math.PI) * 0.55 * amp;

    // Closed-form matrix components. three.js Matrix4 is column-major:
    //   [ m11 m12 m13 tx ]      stored as [m11,0,m31,0, m12,m22,m32,0, ...]
    //   [ 0   m22 m23 ty ]
    //   [ m31 m32 m33 tz ]
    const cy = Math.cos(e.yaw);
    const sy = Math.sin(e.yaw);

    const mtx  = this.mesh.instanceMatrix.array as Float32Array;
    const emtx = this.eyeMesh.instanceMatrix.array as Float32Array;
    const col  = this.mesh.instanceColor!.array as Float32Array;

    // Body flash colour, written directly (no setColorAt call overhead).
    const v = 1 - (1 - flash) * (1 - BLACK_COLOR.r);

    for (const p of parts) {
      let sw = 0;
      if      (p.swing ===  1) sw =  s1;
      else if (p.swing === -1) sw = -s1;
      else if (p.swing ===  2) sw =  s2;
      else if (p.swing === -2) sw = -s2;

      const bx  = p.sx * scale;
      const by  = p.sy * scale;
      const bz  = p.sz * scale;
      const ax  = p.ax * scale;
      const ay  = p.ay * scale;
      const az  = p.az * scale;
      const off = p.hang ? by * 0.5 : 0;

      // M = Ry(yaw)·T(pivot)·Rx(sw)·T(0,-off,0)·S(box), expanded.
      let m11: number, m31: number, m12: number, m22: number, m32: number,
          m13: number, m23: number, m33: number, tx: number, ty: number, tz: number;

      if (sw === 0) {
        // Non-swinging parts (head/torso/eyes — the majority): skip trig.
        m11 = cy * bx; m31 = -sy * bx;
        m12 = 0;       m22 = by;      m32 = 0;
        m13 = sy * bz; m23 = 0;       m33 = cy * bz;
        tx = ax; ty = ay - off; tz = az;
      } else {
        const cs = Math.cos(sw), sn = Math.sin(sw);
        const syn = sy * sn, cyn = cy * sn;
        const sycs = sy * cs, cycs = cy * cs;
        m11 = cy * bx;  m31 = -sy * bx;
        m12 = syn * by; m22 = cs * by;  m32 = cyn * by;
        m13 = sycs * bz; m23 = -sn * bz; m33 = cycs * bz;
        tx = ax; ty = ay - cs * off; tz = az - sn * off;
      }

      // World translation: render + Ry(yaw) · local translation.
      const wx = rx + cy * tx + sy * tz;
      const wy = ry + ty;
      const wz = rz + cy * tz - sy * tx;

      if (p.tint === 1) {
        // Eye part → eye mesh buffer.
        const ei = this.liveEyes;
        const o = ei * 16;
        emtx[o]     = m11; emtx[o + 2]  = m31;
        emtx[o + 4] = m12; emtx[o + 5]  = m22; emtx[o + 6]  = m32;
        emtx[o + 8] = m13; emtx[o + 9]  = m23; emtx[o + 10] = m33;
        emtx[o + 12] = wx; emtx[o + 13] = wy;  emtx[o + 14] = wz;
        // (lanes +1,+3,+7,+11,+15 pre-initialised in the constructor)
        this.liveEyes = ei + 1;
      } else {
        // Body part → body buffer + direct colour write.
        const bi = this.liveBody;
        const o = bi * 16;
        mtx[o]     = m11; mtx[o + 2]  = m31;
        mtx[o + 4] = m12; mtx[o + 5]  = m22; mtx[o + 6]  = m32;
        mtx[o + 8] = m13; mtx[o + 9]  = m23; mtx[o + 10] = m33;
        mtx[o + 12] = wx; mtx[o + 13] = wy;  mtx[o + 14] = wz;
        const c = bi * 3;
        col[c] = v; col[c + 1] = v; col[c + 2] = v;
        this.liveBody = bi + 1;
      }
    }
    return true;
  }

  end() {
    this.mesh.count    = this.liveBody;
    this.eyeMesh.count = this.liveEyes;

    this.mesh.instanceMatrix.needsUpdate    = true;
    this.eyeMesh.instanceMatrix.needsUpdate = true;

    if (this.mesh.instanceColor)    this.mesh.instanceColor.needsUpdate    = true;
    if (this.eyeMesh.instanceColor) this.eyeMesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    for (const m of [this.mesh, this.eyeMesh]) {
      m.parent?.remove(m);
      m.geometry.dispose();
      const mat = m.material;
      if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
      else mat.dispose();
      m.dispose();
    }
  }
}
