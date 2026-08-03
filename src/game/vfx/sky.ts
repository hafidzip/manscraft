/**
 * Sky — a full procedural day/night cycle:
 * sun & moon sprites, orbiting directional light, hemisphere fill,
 * stars at night, drifting procedural clouds, and fog/background blending.
 * All textures are generated on canvases at runtime.
 */

import * as THREE from 'three';
import { DAY_LENGTH, VIEW_DISTANCE, CHUNK_SIZE } from '../core/constants';
import { mulberry32 } from '../core/noise';

// base (earth-like) palette; per-planet tint blends on top of these
const DAY_SKY_BASE = new THREE.Color(0x78a7ff);
const NIGHT_SKY_BASE = new THREE.Color(0x05060d);
const DUSK_SKY_BASE = new THREE.Color(0xff9a56);

/** how strongly theme.skyHex pulls each band */
const TINT_DAY = 0.78;
const TINT_DUSK = 0.42;
const TINT_NIGHT = 0.22;

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
  /** 0..1 fraction of the day cycle */
  time = 0.3;

  fogNear = 44;
  fogFar: number;
  readonly skyColor = new THREE.Color();

  private sun: THREE.DirectionalLight;
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

  constructor(scene: THREE.Scene, skyHex?: number | null) {
    this.applyTheme(skyHex ?? null);
    this.fogFar = VIEW_DISTANCE * CHUNK_SIZE - 6;
    this.fog = new THREE.Fog(this.daySky.getHex(), this.fogNear, this.fogFar);
    scene.fog = this.fog;
    scene.background = this.skyColor;

    this.sun = new THREE.DirectionalLight(0xfff3d0, 1.1);
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x8a6f4d, 0.7);
    scene.add(this.hemi);

    // sun / moon billboards (pixel squares, Minecraft style)
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

    // stars
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

    // clouds
    this.cloudTex = makeCloudTexture();
    this.cloudMat = new THREE.MeshBasicMaterial({
      map: this.cloudTex, transparent: true, opacity: 0.55, depthWrite: false,
    });
    this.clouds = new THREE.Mesh(new THREE.PlaneGeometry(2200, 2200), this.cloudMat);
    this.clouds.rotation.x = -Math.PI / 2;
    this.clouds.position.y = 100;
    scene.add(this.clouds);
  }

  /** Tint the whole sky/fog band set from the planet theme. Null = earth defaults. */
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
    // night keeps its darkness but inherits the hue
    this.skyNight.copy(NIGHT_SKY_BASE).lerp(t, TINT_NIGHT).multiplyScalar(0.9);
  }

  /** sun direction from the time of day (unit-ish vector) */
  private sunDir(): THREE.Vector3 {
    const a = this.time * Math.PI * 2;
    return new THREE.Vector3(Math.cos(a), Math.sin(a), 0.35).normalize();
  }

  get isDay(): boolean {
    return this.dayFactor > 0.5;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    const dir = this.sunDir();
    const elev = dir.y;

    this.dayFactor = THREE.MathUtils.smoothstep(elev, -0.08, 0.22);
    const day = this.dayFactor;
    const dusk = Math.max(0, 1 - Math.abs(elev) * 4.5) * (elev > -0.12 ? 1 : 0) * 0.85;

    // sky + fog color
    this.skyColor.copy(this.skyNight).lerp(this.daySky, day);
    if (dusk > 0) this.skyColor.lerp(this.duskSky, dusk * 0.55);
    this.fog.color.copy(this.skyColor);
    this.fog.near = this.fogNear;
    this.fog.far = this.fogFar;

    // lights
    this.sun.color.setHex(0xfff3d0).lerp(this.tmp.setHex(0xff8844), Math.min(1, dusk * 1.4));
    this.sun.intensity = 0.04 + day * 1.15;
    this.hemi.intensity = 0.22 + day * 0.62;
    this.hemi.color.copy(this.daySky).lerp(this.tmp.setHex(0xbdd7ff), 0.25);
    this.sun.position.copy(camPos).addScaledVector(dir, 140);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();

    // billboards follow the camera
    this.sunSprite.position.copy(camPos).addScaledVector(dir, 420);
    this.sunSprite.visible = elev > -0.1;
    this.moonSprite.position.copy(camPos).addScaledVector(dir, -400);
    this.moonSprite.visible = elev < 0.15;
    this.stars.position.copy(camPos);
    this.stars.rotation.y += dt * 0.004;
    this.starMat.opacity = (1 - day) * 0.95;

    // clouds drift & follow
    this.clouds.position.set(camPos.x, 100, camPos.z);
    this.cloudTex.offset.x += dt * 0.0035;
    this.cloudTex.offset.y += dt * 0.0009;
    this.cloudMat.color.setHex(0xffffff).lerp(this.tmp.setHex(0x2c3350), 1 - day);
    this.cloudMat.opacity = 0.25 + day * 0.35;
  }
}
