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
// The "day" band is deliberately a soft, warm-leaning blue: this world only
// ever sees golden hour, so the zenith never reaches hard midday cyan.
const DAY_SKY_BASE = new THREE.Color(0x8fb0e6);
// Deep, near-black and slightly cold. The night sky doubles as the fog colour,
// so anything brighter than this turns the whole screen into grey milk.
const NIGHT_SKY_BASE = new THREE.Color(0x04060b);
const DUSK_SKY_BASE = new THREE.Color(0xff9a56);

/** how strongly theme.skyHex pulls each band */
const TINT_DAY = 0.78;
const TINT_DUSK = 0.42;
const TINT_NIGHT = 0.22;

// ---------------------------------------------------------------------------
// Perpetual golden hour
// ---------------------------------------------------------------------------
// The sun never climbs to a harsh midday angle. Instead it rises to a low
// plateau and *stays there* for the whole day, so daylight is permanently the
// warm, long-shadowed, low-angle light of golden hour.
//
// Everything below is C1-continuous (smootherstep has zero first derivative at
// both ends), which is what makes the night→day→night handover impossible to
// catch: there is no frame where the rate of change of light, colour or shadow
// direction suddenly jumps.

/** sine of the sun's altitude while parked at the golden plateau (~12.7°) */
const GOLDEN_ELEV = 0.22;
/** how far through the rise the sun reaches the plateau (in sin-of-phase) */
const GOLDEN_RISE = 0.38;
/** how far below the horizon the sun sinks at solar midnight */
const NIGHT_DEPTH = 0.55;
/** how far through the descent the sun reaches full night depth */
const NIGHT_FALL = 0.55;

/** warm sun tints — peach-amber grazing, warm gold on the plateau
 *  (between pure orange and near-white — reads as golden hour sun) */
const SUN_GOLD_LOW = new THREE.Color(0xffa870);
const SUN_GOLD_HIGH = new THREE.Color(0xffddb0);
/** warm hemisphere fill — pulled toward champagne, not orange */
const HEMI_GOLD = new THREE.Color(0xffe0c0);

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** smootherstep — C2 continuous, zero slope AND zero curvature at both ends */
const smoother = (t: number): number => {
  const x = clamp01(t);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

/**
 * Sun altitude (as a sine) for a given orbital phase sine.
 *
 * Day  : eases up to GOLDEN_ELEV and holds — a flat golden plateau.
 * Night: eases down to -NIGHT_DEPTH and holds.
 * Both branches meet at exactly 0 with zero slope, so sunrise and sunset are
 * long, gentle grazes rather than a horizon crossing the player can time.
 */
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

  /**
   * Jump the day/night cycle to early morning (sun just risen).
   * Used on player respawn so the night — and its hostiles — are skipped.
   */
  skipToMorning(): void {
    // Just past sunrise: the sun is already climbing the golden ramp, so the
    // player wakes into full daylight and then eases the rest of the way onto
    // the plateau instead of being dropped into a static, already-settled sky.
    this.time = 0.045;
  }

  /**
   * Unit sun direction for the current time.
   *
   * The altitude is shaped by goldenElevation(), and the horizontal component
   * is scaled to preserve unit length so `dir.y` IS the true sine of the sun's
   * altitude. (The old version normalised a vector whose y was the raw sine,
   * which made the effective altitude swing wildly with azimuth — the sun
   * would have drifted off the golden plateau around solar noon.)
   */
  private sunDir(): THREE.Vector3 {
    const a = this.time * Math.PI * 2;
    const elev = goldenElevation(Math.sin(a));
    const horiz = Math.sqrt(Math.max(0, 1 - elev * elev));
    // azimuth sweeps east→west, tilted so the arc is not perfectly overhead
    const hx = Math.cos(a);
    const hz = 0.35;
    const hl = Math.hypot(hx, hz) || 1;
    return new THREE.Vector3((hx / hl) * horiz, elev, (hz / hl) * horiz);
  }

  get isDay(): boolean {
    return this.dayFactor > 0.5;
  }

  update(dt: number, camPos: THREE.Vector3): void {
    this.time = (this.time + dt / DAY_LENGTH) % 1;
    const dir = this.sunDir();
    const elev = dir.y;
    this.sunElev = elev;

    // Day/night blend driven by altitude through a smootherstep, so the
    // handover has zero slope and zero curvature at both ends — the eye has
    // nothing to latch onto and the transition reads as "it just got dark".
    this.dayFactor = smoother((elev + 0.06) / 0.24);
    const day = this.dayFactor;
    // 0 while grazing the horizon, 1 while parked on the golden plateau
    const plateau = clamp01(elev / GOLDEN_ELEV);

    // Golden warmth is present for the ENTIRE day, not just at the edges.
    // It only eases from "deep amber" to "soft gold" as the sun settles onto
    // the plateau, so the colour drift across the whole day is gentle.
    const warmth = day * (0.72 - 0.30 * plateau);

    // sky + fog color (scene.background IS this colour, refreshed each frame)
    this.skyColor.copy(this.skyNight).lerp(this.daySky, day);
    this.skyColor.lerp(this.duskSky, warmth * 0.5);
    this.fog.color.copy(this.skyColor);
    this.fog.near = this.fogNear;
    this.fog.far = this.fogFar;

    // lights — golden key light, smootherstep handovers everywhere
    const moonFade = 1 - smoother((elev + 0.02) / 0.18);
    const moonDir = this.tmpV.copy(dir).multiplyScalar(-1);
    // Always golden: deep amber while grazing, soft gold on the plateau.
    this.sunColor.copy(SUN_GOLD_LOW).lerp(SUN_GOLD_HIGH, plateau);
    this.sun.color.copy(this.sunColor);
    // Day = sun is the direct light. Night = moon is the direct light.
    // Golden-hour punch: 4.8 base, 5.2 near zenith for a subtle kick.
    const sunBoost = 1.0 + THREE.MathUtils.smoothstep(elev, 0.05, 0.45) * 0.08;
    this.sun.intensity = day * (4.8 * sunBoost);
    // Cold steel-blue moonlight. Anything near white reads as daylight and
    // kills the mood the moment it hits pale terrain like snow or sand.
    this.moonColor.setHex(0x7f9ad0).lerp(this.tmp.setHex(0x9fb6e6), Math.min(1, moonFade * 0.5));
    this.moon.color.copy(this.moonColor);
    // The moon is the key light at night — strong enough to carve out a lit
    // side and cast shadows, but low absolute output so the world stays dark.
    this.moon.intensity = moonFade * 0.95;
    // Ambient collapses after dusk. This is what makes night READ as night:
    // unlit faces fall to near-black instead of staying evenly grey.
    // Day ambient is kept low so the sun's contrast isn't washed out.
    this.hemi.intensity = 0.02 + day * 0.45;
    // ground bounce goes cold and dark at night instead of warm dirt brown
    this.hemi.groundColor.setHex(0x8a6f4d).lerp(this.tmp.setHex(0x0b1018), 1 - day);
    // Ambient fill is pulled toward gold during the day so bounce light agrees
    // with the golden key light instead of fighting it with cold sky blue.
    this.hemi.color.copy(this.daySky).lerp(HEMI_GOLD, 0.30 + warmth * 0.35);
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
    (this.sunSprite.material as THREE.SpriteMaterial).opacity = smoother((elev + 0.10) / 0.16);
    this.moonSprite.position.copy(camPos).addScaledVector(moonDir, 400);
    (this.moonSprite.material as THREE.SpriteMaterial).opacity = moonFade;
    this.stars.position.copy(camPos);
    this.stars.rotation.y += dt * 0.004;
    this.starMat.opacity = (1 - day) * 0.95;

    // clouds drift & follow
    this.clouds.position.set(camPos.x, 100, camPos.z);
    this.cloudTex.offset.x += dt * 0.0035;
    this.cloudTex.offset.y += dt * 0.0009;
    // clouds catch the golden key light by day, go cold and dim at night
    this.cloudMat.color.setHex(0xffe4c2).lerp(this.tmp.setHex(0x2c3350), 1 - day);
    this.cloudMat.opacity = 0.25 + day * 0.35;
  }
}
