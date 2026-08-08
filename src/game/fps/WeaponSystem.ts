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
  private lastSwitchFoley = 0;
  private magDrops: MagDrop[] = [];
  private dropMat = new THREE.MeshLambertMaterial({ color: '#33363c' });
  private magGeo = new Map<string, THREE.BufferGeometry>();

  /**
   * Parking bay for every weapon that is not currently in the hands.
   *
   * `stow` is deliberately NOT attached to the camera (or to anything else),
   * so the five idle rigs are invisible to the scene graph: three.js never
   * walks them in `scene.updateMatrixWorld()`, never frustum-tests them and
   * never sorts them. Keeping all six rigs permanently parented to the camera
   * meant ~350 surplus Object3D matrix composes *three times every frame* —
   * the bulk of the cost that made holding (and swapping) a weapon expensive.
   */
  private stow = new THREE.Group();
  private mountedId = '';

  /** reload callback tables, built once per weapon instead of per reload */
  private ctxCache = new Map<string, ReloadCtx>();

  // scratch objects — the pose compositor runs every frame, so it must not
  // allocate (each allocation is GC pressure that shows up as a swap hitch)
  private adsScratch = new THREE.Vector3();

  // last HUD payload fields, compared primitively so the 60 Hz pose pass does
  // not build a template-string key + object literal it usually throws away
  private hudW = '';
  private hudAmmo = -1;
  private hudReload = false;
  private hudScoped = false;
  private hudLock = false;
  private hudReloadT = -1;
  private hudAds = -1;

  constructor(camera: THREE.PerspectiveCamera, player: WeaponPlayer, audio: AudioSynth, bridge: GameBridge, onHud: (h: HudPush) => void) {
    this.camera = camera;
    this.player = player;
    this.audio = audio;
    this.bridge = bridge;
    this.onHud = onHud;
    this.stow.name = 'weapon-stow';
    for (const id of WEAPON_ORDER) {
      const rig = buildWeapon(id);
      rig.root.visible = false;
      // Viewmodels sit inside the near plane and are always on screen, so the
      // per-mesh frustum test is pure overhead — and skipping it guarantees
      // the warm-up draw below really touches every buffer.
      rig.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.frustumCulled = false; });
      this.stow.add(rig.root);
      this.rigs.set(id, rig);
      this.ammo[id] = WEAPONS[id].magSize;
    }
    // initial equip raise (start mid-switch so the rifle pulls up on spawn)
    this.switchT = 0.17;
    this.switchNext = this.currentId;
    this.state = 'switch';
    this.mount(this.currentId);
  }

  /**
   * Make `id` the one rig that lives under the camera; park the outgoing rig.
   *
   * Attach/detach is O(1) (a splice on `children`), so this is far cheaper
   * than the per-frame traversal tax of leaving every rig mounted.
   */
  private mount(id: string): void {
    const rig = this.rigs.get(id);
    if (!rig) return;
    if (this.mountedId === id) {
      rig.root.visible = !this.holstered;
      return;
    }
    const prev = this.mountedId ? this.rigs.get(this.mountedId) : undefined;
    if (prev) {
      prev.root.visible = false;
      this.stow.add(prev.root);          // reparent: drops it out of the graph
    }
    this.camera.add(rig.root);
    this.mountedId = id;
    rig.root.visible = !this.holstered;
    // The rig's world matrices went stale while parked — refresh the subtree
    // once here so its very first rendered frame is already correct.
    this.camera.updateWorldMatrix(true, false);
    rig.root.updateMatrixWorld(true);
  }

  /**
   * Refresh only what the viewmodel actually needs: the camera's own world
   * matrix plus the single mounted rig. The old code called
   * `camera.updateMatrixWorld(true)` three times a frame, and `force = true`
   * recursed through *every* camera child — all six guns, both hand rigs, the
   * laser tool, the held block and the food model.
   */
  private syncMatrices(): void {
    this.camera.updateWorldMatrix(true, false);
    const rig = this.rigs.get(this.mountedId);
    if (rig) rig.root.updateMatrixWorld(true);
  }

  get rig(): WeaponRig { return this.rigs.get(this.currentId)!; }
  get def(): WeaponDef { return this.rig.def; }

  /**
   * Upload every weapon texture and compile every hidden rig while the loading
   * screen is still up. Without this, Three.js defers the work until a rig is
   * made visible for its first swap, producing a multi-second gameplay hitch.
   */
  async warmup(renderer: THREE.WebGLRenderer, scene: THREE.Scene): Promise<void> {
    const textures = new Set<THREE.Texture>();
    const hidden: THREE.Object3D[] = [];

    // Temporarily hoist every parked rig under the camera so the compiler and
    // the warm draw below can see them, then put them straight back.
    for (const rig of this.rigs.values()) {
      if (rig.root.parent !== this.camera) {
        hidden.push(rig.root);
        this.camera.add(rig.root);
      }
      rig.root.visible = true;
      rig.root.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const material of materials) {
          const map = (material as THREE.MeshLambertMaterial).map;
          if (map) textures.add(map);
        }
      });
    }

    const prevTarget = renderer.getRenderTarget();
    let warmRT: THREE.WebGLRenderTarget | null = null;
    try {
      // compileAsync uses KHR_parallel_shader_compile where available.
      for (const texture of textures) renderer.initTexture(texture);
      await renderer.compileAsync(scene, this.camera);

      // Shader programs are only half the story: a geometry's vertex buffers
      // and its VAO are created lazily on the first *draw* that references
      // them. With ~60 boxes per gun that is ~300 buffer uploads deferred
      // until the player pressed a hotbar key mid-fight. Draw one throwaway
      // 4x4 frame with every rig mounted so the driver does that work now.
      warmRT = new THREE.WebGLRenderTarget(4, 4);
      renderer.setRenderTarget(warmRT);
      renderer.render(scene, this.camera);
    } finally {
      renderer.setRenderTarget(prevTarget);
      warmRT?.dispose();
      for (const rig of this.rigs.values()) rig.root.visible = false;
      for (const root of hidden) this.stow.add(root);
      const active = this.rigs.get(this.mountedId);
      if (active) active.root.visible = !this.holstered;
    }
  }

  /** Free every geometry owned by the (mostly off-graph) weapon rigs. */
  dispose(): void {
    for (const rig of this.rigs.values()) {
      rig.root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry?.dispose();
      });
    }
    for (const g of this.magGeo.values()) g.dispose();
    this.magGeo.clear();
    this.dropMat.dispose();
  }

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

  /** unified engine: hide/show the viewmodel (menu / pause) */
  setAllVisible(v: boolean) {
    const rig = this.rigs.get(this.mountedId);
    if (rig) rig.root.visible = v && !this.holstered;
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

  /**
   * Reload callback tables are pure functions of the rig, so build one per
   * weapon and reuse it. Previously every reload / bolt cycle / inspect
   * allocated eleven closures and two Vector3s.
   */
  private makeCtx(): ReloadCtx {
    const cached = this.ctxCache.get(this.currentId);
    if (cached) return cached;
    const ctx = this.buildCtx();
    this.ctxCache.set(this.currentId, ctx);
    return ctx;
  }

  private buildCtx(): ReloadCtx {
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
    // one shared BoxGeometry per weapon instead of a fresh one per reload
    let geo = this.magGeo.get(this.currentId);
    if (!geo) {
      const size = MAG_DROP_SIZE[this.currentId] ?? [0.03, 0.08, 0.04];
      geo = new THREE.BoxGeometry(...size);
      this.magGeo.set(this.currentId, geo);
    }
    const mesh = new THREE.Mesh(geo, this.dropMat);
    mesh.frustumCulled = false;
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
    this.mount(this.currentId);
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
      const rig = this.rigs.get(this.mountedId);
      if (rig) rig.root.visible = false;
    } else {
      this.mount(this.currentId);
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
    this.hudW = '';
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

    // ---- holstered: the laser tool is out, firearms are stowed.
    // Bail before touching any matrices: there is nothing on screen to pose.
    if (this.holstered) return;

    // Refresh the viewmodel hierarchy first so muzzle/eject world positions
    // computed during firing reflect this frame's camera transform rather
    // than lagging a frame behind while moving.
    this.syncMatrices();

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
          // the outgoing rig may have been frozen mid-reload — reset it now so
          // it is correct the next time it is raised
          this.restoreRigVisuals(prev, this.ammo[this.currentId] > 0);
          this.currentId = this.switchNext;
          // mount() hides + parks `prev` and attaches the incoming rig, so the
          // scene graph only ever carries the gun that is actually drawn
          this.mount(this.currentId);
          // restore sane visual state in case a reload was cancelled mid-way
          this.restoreRigVisuals(this.rig, this.ammo[this.currentId] > 0);
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
    this.syncMatrices();

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
    const adsPos = this.adsScratch.set(-sight.x, -sight.y - 0.008, def.basePos[2] + 0.03);

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

    // 7. update arm links (need fresh world matrices for the mounted rig only)
    rig.root.updateMatrixWorld(true);
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

  /**
   * Publish to the HUD only when something the HUD can actually show changed.
   *
   * This runs once per rendered frame, so the old version built a template
   * string *and* a full payload object 60 times a second just to throw both
   * away. Compare the quantised fields directly and allocate nothing on the
   * (overwhelmingly common) unchanged path.
   */
  private pushHud() {
    const reloading = this.state === 'reload';
    const rawReloadT = this.timeline && reloading ? this.timeline.t / this.timeline.def.duration : 0;
    const reloadT = Math.floor(rawReloadT * 40);
    const scoped = this.scoped;
    const switchLock = this.state === 'switch';
    const ads = Math.floor(this.adsSpring.v * 8);
    const ammo = this.ammo[this.currentId];

    if (
      this.hudW === this.currentId &&
      this.hudAmmo === ammo &&
      this.hudReload === reloading &&
      this.hudScoped === scoped &&
      this.hudLock === switchLock &&
      this.hudReloadT === reloadT &&
      this.hudAds === ads
    ) return;

    this.hudW = this.currentId;
    this.hudAmmo = ammo;
    this.hudReload = reloading;
    this.hudScoped = scoped;
    this.hudLock = switchLock;
    this.hudReloadT = reloadT;
    this.hudAds = ads;

    const def = this.def;
    this.onHud({
      weaponId: this.currentId,
      name: def.name,
      slot: def.slot,
      ammo,
      mag: def.magSize,
      reloading,
      reloadT: rawReloadT,
      scoped,
      ads: this.adsSpring.v,
      switchLock,
    });
  }
}
