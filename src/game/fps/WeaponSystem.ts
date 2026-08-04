// Weapon system: state machine + pose compositor for the viewmodel.
// Every frame it layers base pose -> ADS -> sway -> bob -> sprint -> recoil
// springs onto the rig, then plays keyframe timelines over the bones
// (reload / bolt / inspect). Hands are glued to the gun, forearms stretch
// to follow, exactly like a real FPS.
import * as THREE from 'three';
import { buildWeapon, WeaponRig, WEAPONS, WEAPON_ORDER, WeaponDef } from './models';
import { Timeline, Spring3, Spring1 } from './anim';
import { buildTimeline, ReloadCtx } from './reloads';
import { AudioSynth } from './audio';

/** minimal player surface the weapon viewmodel needs (engine Player satisfies it) */
export interface WeaponPlayer {
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  movePhase: number;
  speedSmooth: number;
  sprintAmt: number;
  addRecoil(pitch: number, yawR: number): void;
  addShake(amp: number): void;
}

export interface GameBridge {
  fireShot(muzzle: THREE.Vector3, dir: THREE.Vector3, def: WeaponDef, muzzleAnchor: THREE.Object3D): void;
  launchRocket(muzzle: THREE.Vector3, dir: THREE.Vector3, muzzleAnchor: THREE.Object3D): void;
  casing(pos: THREE.Vector3, right: THREE.Vector3, big: boolean): void;
}

export interface HudPush {
  weaponId: string; name: string; slot: number;
  ammo: number; mag: number;
  reloading: boolean; reloadT: number;
  scoped: boolean; ads: number;
  switchLock: boolean;
}

type State = 'idle' | 'reload' | 'switch' | 'inspect' | 'bolt';

const MAG_DROP_SIZE: Record<string, [number, number, number]> = {
  handgun: [0.032, 0.075, 0.042],
  smg: [0.036, 0.15, 0.045],
  rifle: [0.04, 0.17, 0.05],
  sniper: [0.04, 0.07, 0.1],
};

interface MagDrop { mesh: THREE.Mesh; vel: THREE.Vector3; t: number; rig: WeaponRig }

export class WeaponSystem {
  private rigs = new Map<string, WeaponRig>();
  private currentId = 'rifle';
  private state: State = 'idle';
  private timeline: Timeline | null = null;

  private ammo: Record<string, number> = {};

  private camera: THREE.PerspectiveCamera;
  private player: WeaponPlayer;
  private audio: AudioSynth;
  private bridge: GameBridge;
  private onHud: (h: HudPush) => void;

  // springs
  private recoilPos = new Spring3(240, 15);
  private recoilRot = new Spring3(190, 13);
  private swayPos = new Spring3(120, 12);
  private swayRot = new Spring3(110, 11);
  private adsSpring = new Spring1(320, 24, 0);
  private switchSpring = new Spring1(280, 22, 0);
  private slideSpring = new Spring1(300, 20, 0);
  private equipKick = new Spring1(180, 15, 0);

  private fireTimer = 0;
  private boltTimer = -1;           // pending bolt cycle delay (sniper)
  private autoReloadTimer = -1;     // bazooka auto reload
  private switchT = 0;
  private switchNext = '';
  private bloom = 0;
  private deathT = -1;          // >= 0 while the weapon is being dropped
  private holstered = false;    // true while a non-gun tool (laser) is equipped
  private lastHudKey = '';
  private lastSwitchFoley = 0;
  private magDrops: MagDrop[] = [];
  private dropMat = new THREE.MeshLambertMaterial({ color: '#33363c' });

  constructor(camera: THREE.PerspectiveCamera, player: WeaponPlayer, audio: AudioSynth, bridge: GameBridge, onHud: (h: HudPush) => void) {
    this.camera = camera;
    this.player = player;
    this.audio = audio;
    this.bridge = bridge;
    this.onHud = onHud;
    for (const id of WEAPON_ORDER) {
      const rig = buildWeapon(id);
      rig.root.visible = false;
      camera.add(rig.root);
      this.rigs.set(id, rig);
      this.ammo[id] = WEAPONS[id].magSize;
    }
    // initial equip raise (start mid-switch so the rifle pulls up on spawn)
    this.switchT = 0.17;
    this.switchNext = this.currentId;
    this.state = 'switch';
    const rig = this.rigs.get(this.currentId)!;
    rig.root.visible = true;
  }

  get rig(): WeaponRig { return this.rigs.get(this.currentId)!; }
  get def(): WeaponDef { return this.rig.def; }

  /** unified engine HUD: current weapon ammo / magazine */
  get ammoInfo(): { ammo: number; mag: number } {
    return { ammo: this.ammo[this.currentId], mag: this.def.magSize };
  }

  /** Top every weapon's reserve up to its magazine size. (Merchant service.) */
  refillAllAmmo(): void {
    for (const id of Object.keys(this.ammo)) {
      const mag = WEAPONS[id]?.magSize;
      if (mag) this.ammo[id] = Math.max(this.ammo[id], mag);
    }
    this.refreshHud();
  }

  /** Grant extra rounds for one weapon (bazooka warheads, …). */
  giveAmmo(id: string, amount: number): void {
    if (this.ammo[id] === undefined) return;
    this.ammo[id] += amount;
    this.refreshHud();
  }

  /** unified engine HUD: reload progress 0..1 (0 when not reloading) */
  get reloadProgress(): number {
    if (this.state === 'reload' && this.timeline) {
      return Math.min(1, this.timeline.t / this.timeline.def.duration);
    }
    return 0;
  }

  /** unified engine: hide/show every rig (menu / pause) */
  setAllVisible(v: boolean) {
    for (const [, r] of this.rigs) r.root.visible = v;
  }
  get adsT(): number { return this.adsSpring.v; }
  get scoped(): boolean { return !!this.def.scoped && this.adsSpring.v > 0.8; }
  get busy(): boolean { return this.state !== 'idle'; }
  get bloomPx(): number { return this.bloom; }
  get reloading(): boolean { return this.state === 'reload'; }
  sensFactor(): number { return this.scoped ? 0.24 : 1 - this.adsSpring.v * 0.35; }

  // ------------------------------------------------------------ inputs
  notifyLook(dx: number, dy: number) {
    this.swayRot.impulse(-dx * 0.0018, -dy * 0.0015, dx * 0.0007);
    this.swayPos.impulse(-dx * 0.0012, dy * 0.0010, 0);
  }

  private makeCtx(): ReloadCtx {
    const rig = this.rig;
    const cam = this.camera;
    const ejectWorld = new THREE.Vector3();
    const right = new THREE.Vector3();
    return {
      hideMag: () => { rig.magMesh.visible = false; },
      showMag: () => { rig.magMesh.visible = true; },
      showMagHand: () => { rig.magHandMesh.visible = true; },
      hideMagHand: () => { rig.magHandMesh.visible = false; },
      showWarhead: () => { if (rig.warheadMesh) rig.warheadMesh.visible = true; if (rig.warheadHandMesh) rig.warheadHandMesh.visible = false; },
      showWarheadHand: () => { if (rig.warheadHandMesh) rig.warheadHandMesh.visible = true; },
      hideWarheadHand: () => { if (rig.warheadHandMesh) rig.warheadHandMesh.visible = false; },
      dropMag: () => this.spawnMagDrop(rig),
      ejectShell: () => {
        rig.eject.getWorldPosition(ejectWorld);
        right.setFromMatrixColumn(cam.matrixWorld, 0);
        this.bridge.casing(ejectWorld, right, true);
        this.audio.shellTink();
      },
      sfx: (n) => this.audio.foley(n),
    };
  }

  /**
   * Put a rig's swappable parts back into a sane visual state.
   *
   * The reload timelines are authored so the magazine bone is already back in
   * the magwell before it is revealed, but a reload can also be *interrupted*
   * (weapon switch, death, holster) at any arbitrary frame — leaving the mag
   * bone parked at the "dropped away" pose. Snapping the bones to rest here
   * guarantees the magazine can never be revealed at a stale pose and then
   * pop into place a moment later.
   */
  private restoreRigVisuals(rig: WeaponRig, loaded: boolean) {
    for (const name of ['mag', 'maghand', 'warhead', 'warheadhand']) {
      const bone = rig.bones.get(name);
      const rest = rig.rest.get(name);
      if (!bone || !rest) continue;
      bone.position.copy(rest.p);
      bone.rotation.copy(rest.r);
    }
    rig.magMesh.visible = true;
    rig.magHandMesh.visible = false;
    if (rig.warheadMesh) rig.warheadMesh.visible = loaded;
    if (rig.warheadHandMesh) rig.warheadHandMesh.visible = false;
  }

  private spawnMagDrop(rig: WeaponRig) {
    const size = MAG_DROP_SIZE[this.currentId] ?? [0.03, 0.08, 0.04];
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), this.dropMat);
    const magBone = rig.bones.get('mag') ?? rig.gun;
    mesh.position.copy(magBone.position);
    mesh.position.y -= 0.05;
    mesh.rotation.copy(magBone.rotation);
    rig.gun.add(mesh);
    this.magDrops.push({
      mesh, rig,
      vel: new THREE.Vector3((Math.random() - 0.5) * 0.08, -0.35, 0.05),
      t: 0.8,
    });
  }

  startReload() {
    if (this.state === 'reload' || this.state === 'switch') return;
    const def = this.def;
    if (this.ammo[this.currentId] >= def.magSize) return;
    this.boltTimer = -1;
    this.autoReloadTimer = -1;
    this.state = 'reload';
    const tlDef = buildTimeline(def.reloadKey, this.makeCtx());
    this.timeline = new Timeline(tlDef, this.rig.bones);
    this.adsSpring.target = 0;
  }

  switchTo(id: string) {
    if (!this.rigs.has(id)) return;
    if (id === this.currentId && this.state !== 'switch') return;

    if (this.state === 'switch') {
      if (this.switchNext === id) return;
      // Hotbar key presses can arrive while the previous lower/raise animation
      // is still running. The old code ignored them, which made 1-6 feel
      // unreliable. Retarget the pending switch instead and keep the animation
      // in its lowering phase so the selected weapon appears on this swap.
      this.switchNext = id;
      this.switchT = Math.min(this.switchT, 0.12);
      this.timeline = null;
      this.burstReset();
      this.adsSpring.target = 0;
      this.switchFoley();
      return;
    }

    this.state = 'switch';
    this.switchT = 0;
    this.switchNext = id;
    this.timeline = null;
    this.boltTimer = -1;
    this.autoReloadTimer = -1;
    this.equipKick.impulse(2);
    this.switchFoley();
  }

  cycle(dir: number) {
    const i = WEAPON_ORDER.indexOf(this.currentId);
    const n = (i + dir + WEAPON_ORDER.length) % WEAPON_ORDER.length;
    this.switchTo(WEAPON_ORDER[n]);
  }

  inspect() {
    if (this.state !== 'idle') return;
    this.state = 'inspect';
    this.timeline = new Timeline(buildTimeline('inspect', this.makeCtx()), this.rig.bones);
  }

  /** The player died: abort everything and let the weapon fall from the hands. */
  startDeath() {
    if (this.deathT >= 0) return;
    this.deathT = 0;
    this.timeline = null;
    this.state = 'idle';
    this.burstReset();
    this.adsSpring.target = 0;
    this.adsSpring.v = 0;
    this.adsSpring.vel = 0;
  }

  private burstReset() {
    this.fireTimer = 0;
    this.boltTimer = -1;
    this.autoReloadTimer = -1;
  }

  private switchFoley() {
    const now = performance.now();
    if (now - this.lastSwitchFoley < 75) return;
    this.lastSwitchFoley = now;
    this.audio.foley('grab');
  }

  resetDeath() {
    this.deathT = -1;
    for (const [, r] of this.rigs) r.root.visible = r.def.id === this.currentId && !this.holstered;
  }

  get dead(): boolean { return this.deathT >= 0; }

  /** Stow every firearm (used when the laser mining tool is selected). */
  setHolstered(v: boolean) {
    if (this.holstered === v) return;
    this.holstered = v;
    if (v) {
      this.timeline = null;
      this.state = 'idle';
      this.burstReset();
      this.adsSpring.target = 0;
      this.adsSpring.v = 0;
      this.adsSpring.vel = 0;
      for (const [, r] of this.rigs) r.root.visible = false;
    } else {
      this.rigs.get(this.currentId)!.root.visible = true;
      this.equipAnim();
    }
  }

  /** Replay the raise animation for the currently held weapon. */
  equipAnim() {
    if (this.state === 'switch') return;
    this.state = 'switch';
    this.switchT = 0.16;   // start at the raise phase
    this.switchNext = this.currentId;
    this.equipKick.impulse(2);
  }

  /** Force the next HUD push through even if nothing changed. */
  refreshHud() {
    this.lastHudKey = '';
    this.pushHud();
  }

  // ------------------------------------------------------------ firing
  private tryFire(): boolean {
    if (this.state === 'inspect') { this.state = 'idle'; this.timeline = null; }
    if (this.state !== 'idle') return false;
    if (this.player.sprintAmt > 0.45) return false;
    if (this.fireTimer > 0) return false;

    const def = this.def;
    if (this.ammo[this.currentId] <= 0) {
      this.audio.dryFire();
      this.fireTimer = 0.28;
      this.startReload();
      return false;
    }

    this.ammo[this.currentId]--;
    this.fireTimer = 60 / def.rpm;

    // camera recoil + gun kick springs
    const k = def.kick;
    const adsMul = 1 - this.adsSpring.v * 0.35;
    const p = THREE.MathUtils.randFloat(k.camP[0], k.camP[1]) * adsMul;
    const y = THREE.MathUtils.randFloatSpread(k.camY * 2) * adsMul;
    this.player.addRecoil(p, y);
    this.recoilPos.impulse(0, -0.5, k.gunZ * 20);
    this.recoilRot.impulse(k.gunRX * 16, THREE.MathUtils.randFloatSpread(0.35), THREE.MathUtils.randFloat(k.gunRZ[0], k.gunRZ[1]) * 18);
    if (def.id === 'handgun') { this.slideSpring.v = 0.035; this.slideSpring.vel = 0; }
    this.bloom = Math.min(1.6, this.bloom + 0.42 + (def.id === 'sniper' ? 0.9 : 0));

    // muzzle + aim
    const muzzle = new THREE.Vector3();
    this.rig.muzzle.getWorldPosition(muzzle);
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);

    this.audio.shot(def.sound);

    if (def.fireMode === 'launcher') {
      this.bridge.launchRocket(muzzle, dir.clone(), this.rig.muzzle);
      if (this.rig.warheadMesh) this.rig.warheadMesh.visible = false;
      this.player.addShake(0.02);
      this.autoReloadTimer = 0.85;
    } else {
      this.bridge.fireShot(muzzle, dir, def, this.rig.muzzle);
      if (def.fireMode === 'bolt') {
        this.boltTimer = 0.55;
      } else {
        const eject = new THREE.Vector3();
        this.rig.eject.getWorldPosition(eject);
        const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
        this.bridge.casing(eject, right, false);
      }
    }
    return true;
  }

  // ------------------------------------------------------------ update
  update(dt: number, time: number, triggerDown: boolean, triggerHeld: boolean, adsHeld: boolean) {
    const rig = this.rig;
    const def = this.def;

    // Refresh the camera hierarchy first so muzzle/eject world positions
    // computed during firing reflect this frame's camera transform rather
    // than lagging a frame behind while moving.
    this.camera.updateMatrixWorld(true);

    // ---- holstered: the laser tool is out, firearms are stowed
    if (this.holstered) return;

    // ---- death: no input is accepted, the weapon just falls away
    if (this.deathT >= 0) {
      this.deathT += dt;
      this.adsSpring.update(dt);
      this.recoilPos.update(dt);
      this.recoilRot.update(dt);
      this.applyPose(dt, time, 0, 0);
      return;
    }

    // ---- state timers
    if (this.fireTimer > 0) this.fireTimer -= dt;
    if (this.boltTimer > 0) {
      this.boltTimer -= dt;
      if (this.boltTimer <= 0 && this.state === 'idle') {
        this.state = 'bolt';
        this.timeline = new Timeline(buildTimeline('bolt_sniper', this.makeCtx()), rig.bones);
        this.adsSpring.target = 0;
      }
    }
    if (this.autoReloadTimer > 0) {
      this.autoReloadTimer -= dt;
      if (this.autoReloadTimer <= 0) this.startReload();
    }

    // ---- ads
    const wantAds = adsHeld && this.state === 'idle' && this.player.sprintAmt < 0.5;
    if (this.state !== 'idle') this.adsSpring.target = 0;
    else this.adsSpring.target = wantAds ? 1 : 0;
    const ads = this.adsSpring.update(dt);
    if (adsHeld && this.state === 'inspect') { this.state = 'idle'; this.timeline = null; }

    // ---- switch state
    let lowerAmt = 0;
    if (this.state === 'switch') {
      this.switchT += dt;
      const LOWER = 0.16, RAISE = 0.26, TOTAL = LOWER + RAISE;
      if (this.switchT < LOWER) {
        lowerAmt = this.switchT / LOWER;
      } else {
        if (this.currentId !== this.switchNext) {
          const prev = this.rigs.get(this.currentId)!;
          prev.root.visible = false;
          // the outgoing rig may have been frozen mid-reload — reset it now so
          // it is correct the next time it is raised
          this.restoreRigVisuals(prev, this.ammo[this.currentId] > 0);
          this.currentId = this.switchNext;
          const nr = this.rigs.get(this.currentId)!;
          nr.root.visible = true;
          // restore sane visual state in case a reload was cancelled mid-way
          this.restoreRigVisuals(nr, this.ammo[this.currentId] > 0);
        }
        lowerAmt = 1 - (this.switchT - LOWER) / RAISE;
        if (this.switchT >= TOTAL) {
          this.state = 'idle';
          this.switchT = 0;
          lowerAmt = 0;
        }
      }
    }

    // ---- timeline playback
    if (this.timeline) {
      if (!this.timeline.update(dt)) {
        const wasReload = this.state === 'reload';
        this.timeline = null;
        this.state = 'idle';
        if (wasReload) {
          this.ammo[this.currentId] = this.def.magSize;
          this.restoreRigVisuals(this.rig, true);
          this.audio.foley('grab');
        }
      }
    }

    // ---- bloom decay
    this.bloom = Math.max(0, this.bloom - dt * 2.6 - this.adsSpring.v * dt * 2);

    // Apply the frame's pose (bob/sway/ads/switch/recoil springs) BEFORE we
    // try to fire, so muzzle/eject world positions sampled inside tryFire
    // reflect THIS frame's gun pose rather than the previous one. Without
    // this, shots fired while running land the tracer a frame behind the
    // visual barrel — especially visible at higher gait speeds.
    this.applyPose(dt, time, ads, lowerAmt);
    this.camera.updateMatrixWorld(true);

    // ---- trigger (fires AFTER pose so the muzzle is where the barrel looks)
    const canAuto = def.fireMode === 'auto';
    if ((canAuto && triggerHeld) || (triggerDown && !canAuto)) {
      // Do not applyPose again after firing. tryFire adds recoil impulses, but
      // advancing the pose a second time would move the rendered barrel after
      // its muzzle position was sampled, separating it from the new effect.
      this.tryFire();
    }
  }

  // ------------------------------------------------------------ pose compositor
  private applyPose(dt: number, time: number, ads: number, lowerAmt: number) {
    const rig = this.rig;
    const def = this.def;
    const player = this.player;

    // 1. reset all bones to rest
    for (const [name, bone] of rig.bones) {
      const rest = rig.rest.get(name)!;
      bone.position.copy(rest.p);
      bone.rotation.copy(rest.r);
    }

    // handgun slide blowback (procedural, springs between shots)
    if (def.id === 'handgun' && !this.timeline) {
      const slide = rig.bones.get('slide');
      if (slide) {
        const sz = this.slideSpring.update(dt);
        slide.position.z += THREE.MathUtils.clamp(sz, 0, 0.05);
      }
    }

    // 2. re-sample timeline AFTER rest reset (so it fully owns its bones)
    if (this.timeline) this.timeline.sample();

    // 3. spring dynamics
    const rp = this.recoilPos.update(dt);
    const rr = this.recoilRot.update(dt);
    const sp = this.swayPos.update(dt);
    const sr = this.swayRot.update(dt);
    this.switchSpring.update(dt);

    // 4. gait bob (figure-eight) — damped by ADS
    const speedN = Math.min(1, player.speedSmooth / 6.5);
    const grounded = player.onGround ? 1 : 0.25;
    const bobAmp = speedN * grounded * (1 - ads * 0.82);
    const ph = player.movePhase;
    const bobX = Math.cos(ph) * 0.0085 * bobAmp;
    const bobY = Math.sin(ph * 2) * 0.0055 * bobAmp - Math.abs(Math.sin(ph)) * 0.004 * bobAmp;
    const bobR = Math.cos(ph) * 0.012 * bobAmp;

    // breathing
    const brY = Math.sin(time * 1.7) * 0.0012 * (1 - ads * 0.9);
    const brR = Math.sin(time * 1.1) * 0.0015 * (1 - ads * 0.9);

    // 5. sprint pose
    const spn = player.sprintAmt * (1 - ads);
    const spnx = spn * spn;

    // 6. ADS position: place sight line at screen center
    const sight = rig.sight.position;
    const adsPos = new THREE.Vector3(-sight.x, -sight.y - 0.008, def.basePos[2] + 0.03);

    const base = def.basePos, baseR = def.baseRot;
    const spr = def.sprintRot, spp = def.sprintPos;

    const root = rig.root;
    root.position.set(
      base[0] * (1 - ads) + adsPos.x * ads + bobX + sp.x + spp[0] * spnx,
      base[1] * (1 - ads) + adsPos.y * ads + bobY + sp.y + brY + spp[1] * spnx + rp.y,
      base[2] * (1 - ads) + adsPos.z * ads + rp.z + spp[2] * spnx
    );
    root.rotation.set(
      baseR[0] * (1 - ads) + sr.y * 0.6 + rr.x + bobR * 0.4 + spr[0] * spnx + brR - this.equipKick.v * 0.002,
      baseR[1] * (1 - ads) + sr.x * 0.6 + rr.y + spr[1] * spnx,
      baseR[2] * (1 - ads) + sr.z + rr.z + bobR + spr[2] * spnx
    );

    // equip / switch lowering (applied to gun, additive on top of rest/timeline)
    if (lowerAmt > 0.001) {
      const gun = rig.gun;
      const e = lowerAmt * lowerAmt;
      gun.position.y -= e * 0.3;
      gun.position.z += e * 0.08;
      gun.rotation.x += e * 0.95;
      gun.rotation.z += e * 0.35;
    }

    // hide viewmodel while sniper-scoped
    root.visible = !this.scoped;

    // ---- death drop: the gun rolls out of the hands and off the bottom of
    // the screen, then hands off to a physical prop spawned in the world.
    if (this.deathT >= 0) {
      const d = this.deathT;
      const e = Math.min(1, d / 0.42);
      const fallAmt = e * e;
      root.position.x += fallAmt * 0.12 * (def.id === 'bazooka' ? -1 : 1);
      root.position.y -= fallAmt * 0.85;
      root.position.z += fallAmt * 0.2;
      root.rotation.x += fallAmt * 1.5;
      root.rotation.y += fallAmt * 0.5;
      root.rotation.z += fallAmt * 1.25;
      if (d > 0.4) root.visible = false;
    }

    // 7. update arm links (need fresh world matrices)
    this.camera.updateMatrixWorld(true);
    rig.armL.update();
    rig.armR.update();

    // 8. mag drops
    for (let i = this.magDrops.length - 1; i >= 0; i--) {
      const d = this.magDrops[i];
      d.t -= dt;
      if (d.t <= 0 || d.rig !== rig) {
        d.rig.gun.remove(d.mesh);
        this.magDrops.splice(i, 1);
        continue;
      }
      d.vel.y -= 1.4 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      d.mesh.rotation.x += 2.4 * dt;
      d.mesh.rotation.z += 3.1 * dt;
    }

    this.pushHud();
  }

  private pushHud() {
    const def = this.def;
    const h: HudPush = {
      weaponId: this.currentId,
      name: def.name,
      slot: def.slot,
      ammo: this.ammo[this.currentId],
      mag: def.magSize,
      reloading: this.state === 'reload',
      reloadT: this.timeline && this.state === 'reload' ? this.timeline.t / this.timeline.def.duration : 0,
      scoped: this.scoped,
      ads: this.adsSpring.v,
      switchLock: this.state === 'switch',
    };
    const key = `${h.weaponId}|${h.ammo}|${h.reloading}|${h.scoped}|${h.switchLock}|${Math.floor(h.reloadT * 40)}|${Math.floor(h.ads * 8)}`;
    if (key !== this.lastHudKey) {
      this.lastHudKey = key;
      this.onHud(h);
    }
  }
}
