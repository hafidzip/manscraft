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
// Deep, near-black and slightly cold. The night sky doubles as the fog colour,
// so anything brighter than this turns the whole screen into grey milk.
const NIGHT_SKY_BASE = new THREE.Color(0x04060b);
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
  /** world-space sun position (drives shadows, god rays, fog inscatter) */
  readonly sunWorldPos = new THREE.Vector3(0, 120, 0);
  /** world-space moon position (drives night directional light) */
  readonly moonWorldPos = new THREE.Vector3(0, 120, 0);
  /** current sun tint (drives fog inscatter colour) */
  readonly sunColor = new THREE.Color(0xfff3d0);
  /** current moon tint (cool blue directional night light) */
  readonly moonColor = new THREE.Color(0x9fb8ff);
  /** current sun elevation (sin of orbit angle) */
  sunElev = 1;

  readonly sun: THREE.DirectionalLight;
  readonly moon: THREE.DirectionalLight;
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
  private tmpV = new THREE.Vector3();

  constructor(scene: THREE.Scene, skyHex?: number | null) {
    this.applyTheme(skyHex ?? null);
    this.fogFar = VIEW_DISTANCE * CHUNK_SIZE - 6;
    this.fog = new THREE.Fog(this.daySky.getHex(), this.fogNear, this.fogFar);
    // No material-level fog: the DepthFogPass post pass fogs every surface
    // identically. A THREE.Fog here would double-fog selective materials and
    // reintroduce seams between terrain, water and foliage.
    scene.fog = null;
    scene.background = this.skyColor;

    this.sun = new THREE.DirectionalLight(0xfff3d0, 1.1);
    scene.add(this.sun);
    scene.add(this.sun.target);
    this.moon = new THREE.DirectionalLight(0x9fb8ff, 0);
    scene.add(this.moon);
    scene.add(this.moon.target);
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
    this.sunElev = elev;

    // continuous day/dusk curves — no hard thresholds, so the sky, fog,
    // bloom, flashlight and sun colour never snap at the end of day
    this.dayFactor = THREE.MathUtils.smoothstep(elev, -0.12, 0.28);
    const day = this.dayFactor;
    const duskTent = Math.max(0, 1 - Math.abs(elev) * 4.2);
    const duskGate = THREE.MathUtils.smoothstep(elev, -0.20, -0.04);
    const dusk = duskTent * duskGate * 0.85;

    // sky + fog color (scene.background IS this colour, refreshed each frame)
    this.skyColor.copy(this.skyNight).lerp(this.daySky, day);
    if (dusk > 0) this.skyColor.lerp(this.duskSky, dusk * 0.55);
    this.fog.color.copy(this.skyColor);
    this.fog.near = this.fogNear;
    this.fog.far = this.fogFar;

    // lights
    const moonFade = 1 - THREE.MathUtils.smoothstep(elev, -0.02, 0.16);
    const moonDir = this.tmpV.copy(dir).multiplyScalar(-1);
    this.sunColor.setHex(0xfff3d0).lerp(this.tmp.setHex(0xff8844), Math.min(1, dusk * 1.4));
    this.sun.color.copy(this.sunColor);
    // Day = sun is the direct light. Night = moon is the direct light.
    this.sun.intensity = day * 1.18;
    // Cold steel-blue moonlight. Anything near white reads as daylight and
    // kills the mood the moment it hits pale terrain like snow or sand.
    this.moonColor.setHex(0x7f9ad0).lerp(this.tmp.setHex(0x9fb6e6), Math.min(1, moonFade * 0.5));
    this.moon.color.copy(this.moonColor);
    // The moon is the key light at night — strong enough to carve out a lit
    // side and cast shadows, but low absolute output so the world stays dark.
    this.moon.intensity = moonFade * 0.95;
    // Ambient collapses after dusk. This is what makes night READ as night:
    // unlit faces fall to near-black instead of staying evenly grey.
    this.hemi.intensity = 0.035 + day * 0.75;
    // ground bounce goes cold and dark at night instead of warm dirt brown
    this.hemi.groundColor.setHex(0x8a6f4d).lerp(this.tmp.setHex(0x0b1018), 1 - day);
    this.hemi.color.copy(this.daySky).lerp(this.tmp.setHex(0xbdd7ff), 0.25);
    this.sun.position.copy(camPos).addScaledVector(dir, 140);
    this.sun.target.position.copy(camPos);
    this.sun.target.updateMatrixWorld();
    this.sunWorldPos.copy(this.sun.position);
    this.moon.position.copy(camPos).addScaledVector(moonDir, 140);
    this.moon.target.position.copy(camPos);
    this.moon.target.updateMatrixWorld();
    this.moonWorldPos.copy(this.moon.position);

    // billboards follow the camera — opacity fades, never boolean visibility
    this.sunSprite.position.copy(camPos).addScaledVector(dir, 420);
    (this.sunSprite.material as THREE.SpriteMaterial).opacity =
      THREE.MathUtils.smoothstep(elev, -0.14, 0.02);
    this.moonSprite.position.copy(camPos).addScaledVector(moonDir, 400);
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = moonFade;
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
