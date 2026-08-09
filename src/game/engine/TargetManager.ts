/**
 * TargetManager — manages target shooting range objects, target wobble physics,
 * hit animation/effects, and target hit registration.
 */

import * as THREE from 'three';
import { Spring1 } from '../fps/anim';
import type { AudioSynth } from '../fps/audio';

export interface Target {
  group: THREE.Group;
  board: THREE.Mesh;
  boardMat: THREE.MeshLambertMaterial;
  wobbleX: Spring1;
  wobbleZ: Spring1;
  flash: number;
}

export class TargetManager {
  targets: Target[] = [];
  targetsHit = 0;

  hitTarget(t: Target, dir: THREE.Vector3, audio: AudioSynth, onHitSeq: () => void): void {
    t.wobbleX.impulse(THREE.MathUtils.clamp(-dir.y * 30, -8, 8) + THREE.MathUtils.randFloatSpread(4));
    t.wobbleZ.impulse(THREE.MathUtils.randFloatSpread(9));
    t.flash = 1;
    audio.ding();
    this.targetsHit++;
    onHitSeq();
  }

  update(dt: number): void {
    for (const t of this.targets) {
      t.wobbleX.update(dt);
      t.wobbleZ.update(dt);
      t.board.rotation.x = t.wobbleX.v * 0.06;
      t.board.rotation.z = t.wobbleZ.v * 0.06;
      t.board.rotation.y = t.wobbleZ.v * 0.02;
      if (t.flash > 0) {
        t.flash = Math.max(0, t.flash - dt * 4);
        t.boardMat.emissive.setScalar(t.flash * 0.3);
      }
    }
  }
}
