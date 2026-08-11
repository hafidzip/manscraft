
import * as THREE from 'three';
import { DAY_LENGTH, VIEW_DISTANCE, CHUNK_SIZE } from '../core/constants';
import { mulberry32 } from '../core/noise';

const DAY_SKY_BASE = new THREE.Color(0x8fb0e6);
const NIGHT_SKY_BASE = new THREE.Color(0x04060b);
const DUSK_SKY_BASE = new THREE.Color(0xff9a56);

const TINT_DAY = 0.78;
const TINT_DUSK = 0.42;
const TINT_NIGHT = 0.22;

const GOLDEN_ELEV = 0.22;
const GOLDEN_RISE = 0.38;
const NIGHT_DEPTH = 0.55;
const NIGHT_FALL = 0.55;

const SUN_GOLD_LOW = new THREE.Color(0xffa870);
const SUN_GOLD_HIGH = new THREE.Color(0xffddb0);
const HEMI_GOLD = new THREE.Color(0xffe0c0);

const STATIC_DIR = new THREE.Vector3(0.42, 0.46, 0.58).normalize();

const LIGHT_DISTANCE = 140;
const DISC_DISTANCE = 420;
const MOON_DISC_DISTANCE = 400;

const DAY_GAIN = 0.7;
const NIGHT_GAIN = 0.7;

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const SHADOW_RIGHT = new THREE.Vector3().crossVectors(WORLD_UP, STATIC_DIR).normalize();
const SHADOW_UP = new THREE.Vector3().crossVectors(STATIC_DIR, SHADOW_RIGHT).normalize();

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const smoother = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

const goldenElevation = (rawSin: number): number =>
  rawSin >= 0
    ? GOLDEN_ELEV * smoother(rawSin / GOLDEN_RISE)
    : -NIGHT_DEPTH * smoother(-rawSin / NIGHT_FALL);

function makeSpriteTexture(draw: (ctx: CanvasRenderingContext2D, s: number) => void, size = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeCloudTexture(): THREE.CanvasTexture {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = S;
  c.height = S;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(S, S);
  const rng = mulberry32(20240);
  const G = 24;
  const grid = new Float32Array(G * G);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();

  const sample = (x: number, y: number, scale: number): number => {
    const gx = (x / S) * (G / scale);
    const gy = (y / S) * (G / scale);
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    const fx = gx - ix;
    const fy = gy - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const g = (xx: number, yy: number) => grid[((yy % G) * G + (xx % G) + G * G) % (G * G)];
    const v00 = g(ix, iy);
    const v10 = g(ix + 1, iy);
    const v01 = g(ix, iy + 1);
    const v11 = g(ix + 1, iy + 1);
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = sample(x, y, 1.6) * 0.65 + sample(x, y, 3.2) * 0.35;
      const a = Math.max(0, Math.min(255, ((v - 0.52) / 0.2) * 255));
      const i = (y * S + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = a;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 5);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class Sky {
  dayFactor = 1;
  time = 0.3;

  fogNear = 44;
  fogFar: number;
  readonly skyColor = new THREE.Color();

  readonly sunWorldPos = new THREE.Vector3(0, 120, 0);
  readonly moonWorldPos = new THREE.Vector3(0, 120, 0);

  readonly sunDirection = STATIC_DIR.clone();

  readonly sunColor = new THREE.Color(0xfff3d0);
  readonly moonColor = new THREE.Color(0x9fb8ff);
  sunElev = 1;

  readonly sun: THREE.DirectionalLight;

  private hemi: THREE.HemisphereLight;
  private sunSprite: THREE.Sprite;
  private moonSprite: THREE.Sprite;
  private stars: THREE.Points;
  private starMat: THREE.PointsMaterial;
  private clouds: THREE.Mesh;
  private cloudMat: THREE.MeshBasicMaterial;
  private cloudTex: THREE.CanvasTexture;
  private fog: THREE.Fog;
  private daySky = DAY_SKY_BASE.clone();
  private duskSky = DUSK_SKY_BASE.clone();
  private skyNight = NIGHT_SKY_BASE.clone();
  private tmp = new THREE.Color();
  private snapped = new THREE.Vector3();

  constructor(scene: THREE.Scene, skyHex?: number | null) {
    this.applyTheme(skyHex ?? null);
    this.fogFar = VIEW_DISTANCE * CHUNK_SIZE - 6;
    this.fog = new THREE.Fog(this.daySky.getHex(), this.fogNear, this.fogFar);
    scene.fog = null;
    scene.background = this.skyColor;

    this.sun = new THREE.DirectionalLight(0xfff3d0, 1.1);
    this.sun.position.copy(STATIC_DIR).multiplyScalar(LIGHT_DISTANCE);
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x8a6f4d, 0.7);
    scene.add(this.hemi);

    const sunTex = makeSpriteTexture((ctx, s) => {
      ctx.fillStyle = '#ffdf6b';
      ctx.fillRect(s * 0.22, s * 0.22, s * 0.56, s * 0.56);
      ctx.fillStyle = '#fff8dc';
      ctx.fillRect(s * 0.28, s * 0.28, s * 0.44, s * 0.44);
    });
    this.sunSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: sunTex, transparent: true, fog: false, depthWrite: false })
    );
    this.sunSprite.scale.setScalar(70);
    scene.add(this.sunSprite);

    const moonTex = makeSpriteTexture((ctx, s) => {
      ctx.fillStyle = '#c9d4e8';
      ctx.fillRect(s * 0.26, s * 0.26, s * 0.48, s * 0.48);
      ctx.fillStyle = '#93a3c4';
      ctx.fillRect(s * 0.38, s * 0.4, s * 0.12, s * 0.12);
      ctx.fillRect(s * 0.56, s * 0.3, s * 0.08, s * 0.08);
    });
    this.moonSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: moonTex, transparent: true, fog: false, depthWrite: false })
    );
    this.moonSprite.scale.setScalar(46);
    scene.add(this.moonSprite);

    const starCount = 600;
    const pos = new Float32Array(starCount * 3);
    const rng = mulberry32(777);
    for (let i = 0; i < starCount; i++) {
      const v = new THREE.Vector3(rng() * 2 - 1, rng() * 2 - 1, rng() * 2 - 1).normalize().multiplyScalar(430);
      pos[i * 3] = v.x;
      pos[i * 3 + 1] = Math.abs(v.y) * (rng() < 0.5 ? 1 : -0.4);
      pos[i * 3 + 2] = v.z;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xffffff, size: 1.8, sizeAttenuation: false,
      transparent: true, opacity: 0, fog: false, depthWrite: false,
    });
    this.stars = new THREE.Points(starGeo, this.starMat);
    scene.add(this.stars);

    this.cloudTex = makeCloudTexture();
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: this.cloudTex, transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2200, 2200), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 100;
    scene.add(this.clouds);
  }

  applyTheme(skyHex: number | null | undefined): void {
    if (skyHex == null) {
      this.daySky.copy(DAY_SKY_BASE);
      this.duskSky.copy(DUSK_SKY_BASE);
      this.skyNight.copy(NIGHT_SKY_BASE);
      return;
    }
    const t = this.tmp.setHex(skyHex);
    this.daySky.copy(DAY_SKY_BASE).lerp(t, TINT_DAY);
    this.duskSky.copy(DUSK_SKY_BASE).lerp(t, TINT_DUSK);
    this.skyNight.copy(NIGHT_SKY_BASE).lerp(t, TINT_NIGHT).multiplyScalar(0.9);
  }

  skipToMorning(): void {
    this.time = 0.045;
  }

  private sunElevation(): number {
    return goldenElevation(Math.sin(this.time * Math.PI * 2));
  }

  private snapShadowCenter(camPos: THREE.Vector3): THREE.Vector3 {
    const shadow = this.sun.shadow;
    const cam = shadow.camera;
    const w = cam.right - cam.left;
    const h = cam.top - cam.bottom;
    const mx = shadow.mapSize.x;
    const my = shadow.mapSize.y;
    if (!this.sun.castShadow || w <= 0 || h <= 0 || mx <= 0 || my <= 0) {
      return this.snapped.copy(camPos);
    }
    const tx = w / mx;
    const ty = h / my;
    const px = Math.round(camPos.dot(SHADOW_RIGHT) / tx) * tx;
    const py = Math.round(camPos.dot(SHADOW_UP) / ty) * ty;
    const pz = camPos.dot(STATIC_DIR);
    return this.snapped
      .copy(SHADOW_RIGHT).multiplyScalar(px)
      .addScaledVector(SHADOW_UP, py)
      .addScaledVector(STATIC_DIR, pz);
  }

  get isDay(): boolean {
    return this.dayFactor > 0.5;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;

    const elev = this.sunElevation();
    this.sunElev = elev;
    this.dayFactor = smoother((elev + 0.06) / 0.24);
    const day = this.dayFactor;
    const plateau = clamp01(elev / GOLDEN_ELEV);
    const warmth = day * (0.72 - 0.30 * plateau);
    const moonFade = 1 - smoother((elev + 0.02) / 0.18);

    this.skyColor.copy(this.skyNight).lerp(this.daySky, day);
    this.skyColor.lerp(this.duskSky, warmth * 0.5);
    this.fog.color.copy(this.skyColor);
    this.fog.near = this.fogNear;
    this.fog.far = this.fogFar;

    this.sunColor.copy(SUN_GOLD_LOW).lerp(SUN_GOLD_HIGH, plateau);
    this.moonColor.setHex(0x7f9ad0).lerp(this.tmp.setHex(0x9fb6e6), Math.min(1, moonFade * 0.5));

    const sunBoost = 1.0 + THREE.MathUtils.smoothstep(elev, 0.05, 0.45) * 0.08;
    const sunI = day * (4.8 * sunBoost) * DAY_GAIN;
    const moonI = moonFade * 0.95 * NIGHT_GAIN;
    const total = sunI + moonI;
    this.sun.intensity = total;
    if (total > 1e-4) {
      this.sun.color.setRGB(
        (this.sunColor.r * sunI + this.moonColor.r * moonI) / total,
        (this.sunColor.g * sunI + this.moonColor.g * moonI) / total,
        (this.sunColor.b * sunI + this.moonColor.b * moonI) / total,
      );
    } else {
      this.sun.color.copy(this.moonColor);
    }

    this.hemi.intensity = 0.02 + day * 0.45;
    this.hemi.groundColor.setHex(0x8a6f4d).lerp(this.tmp.setHex(0x0b1018), 1 - day);
    this.hemi.color.copy(this.daySky).lerp(HEMI_GOLD, 0.30 + warmth * 0.35);

    const center = this.snapShadowCenter(camPos);
    this.sun.position.copy(center).addScaledVector(STATIC_DIR, LIGHT_DISTANCE);
    this.sun.target.position.copy(center);
    this.sun.target.updateMatrixWorld();

    this.sunWorldPos.copy(camPos).addScaledVector(STATIC_DIR, LIGHT_DISTANCE);
    this.moonWorldPos.copy(this.sunWorldPos);

    const sunOpacity = smoother((elev + 0.10) / 0.16);
    this.sunSprite.position.copy(camPos).addScaledVector(STATIC_DIR, DISC_DISTANCE);
    (this.sunSprite.material as THREE.SpriteMaterial).opacity = sunOpacity;
    this.moonSprite.position.copy(camPos).addScaledVector(STATIC_DIR, MOON_DISC_DISTANCE);
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = moonFade * (1 - sunOpacity);

    this.stars.position.copy(camPos);
    this.stars.rotation.y += dt * 0.004;
    this.starMat.opacity = (1 - day) * 0.95;

    this.clouds.position.set(camPos.x, 100, camPos.z);
    this.cloudTex.offset.x += dt * 0.0035;
    this.cloudTex.offset.y += dt * 0.0009;
    this.cloudMat.color.setHex(0xffe4c2).lerp(this.tmp.setHex(0x2c3350), 1 - day);
    this.cloudMat.opacity = 0.25 + day * 0.35;
  }
}
