import * as THREE from 'three';
import { Rng, derive } from './rng';
import { noise3, fbm } from './voxel';
import {
  PLANET_PALETTES,
  biomeColorInto,
  moonColorInto,
  type PlanetPalette,
  type MoonStyle,
} from './palettes';
import {
  generateVoxelShell,
  instancedVoxelMesh,
  generateClouds,
  createCityLights,
  createLava,
  createRings,
  createAtmosphere,
  type LightInstance,
  type CityLightsData,
} from './generators';
import type { PlanetSpec } from './galaxy';
import type { Vec3d } from './rng';

interface MoonPart {
  pivot: THREE.Object3D;
  spin: THREE.Object3D;
  speed: number;
  phase: number;
  atmoMat?: THREE.ShaderMaterial;
}

function smoothRange(edge0: number, edge1: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class PlanetBody {
  readonly spec: PlanetSpec;
  readonly group = new THREE.Group();
  angle: number;
  universe: Vec3d = { x: 0, y: 0, z: 0 };

  private palette: PlanetPalette;
  private planetSpin = new THREE.Group();
  private cloudsGroup: THREE.Group | null = null;
  private cloudMat: THREE.MeshLambertMaterial | null = null;
  private atmoMesh: THREE.Mesh | null = null;
  private atmoMat: THREE.ShaderMaterial | null = null;
  private cityLights: CityLightsData | null = null;
  private lavaMesh: THREE.InstancedMesh | null = null;
  private lavaMat: THREE.MeshBasicMaterial | null = null;
  private moons: MoonPart[] = [];
  private ringsHolder: THREE.Group | null = null;
  private ringsMesh: THREE.InstancedMesh | null = null;

  private lodMeshes: (THREE.InstancedMesh | null)[] = [null, null, null, null, null];
  private lodBuilt: boolean[] = [false, false, false, false, false];
  private voxelMat = new THREE.MeshLambertMaterial({
    flatShading: true,
    transparent: true,
    opacity: 0,
  });

  private fade = 0;
  private distanceFade = 1;
  private lightsAlpha = 1;
  private voxelVisible = false;
  private scratchColor = new THREE.Color();
  private t = 0;
  private cityLightAccum = 0;
  private sunDirWorldTmp = new THREE.Vector3();

  private pendingSteps: Array<() => void> = [];
  private disposed = false;

  constructor(spec: PlanetSpec) {
    this.spec = spec;
    this.angle = spec.orbitAngle;
    this.palette = PLANET_PALETTES[spec.type];
    this.planetSpin.rotation.z = spec.axialTilt;
    this.group.add(this.planetSpin);
    this.group.visible = false;
    this.enqueueBuild();
  }

  private enqueueBuild() {
    const spec = this.spec;
    const pal = this.palette;

    this.pendingSteps.push(() => this.buildLOD(4));
    this.pendingSteps.push(() => this.buildAtmosphere());
    this.pendingSteps.push(() => this.buildLOD(3));
    this.pendingSteps.push(() => this.buildLOD(2));
    if (pal.clouds) this.pendingSteps.push(() => this.buildClouds());
    if (spec.hasRings) this.pendingSteps.push(() => this.buildRings());
    if (spec.hasMoons) {
      const moonRng = new Rng(derive(spec.seed, 6));
      const count = moonRng.next() < 0.4 ? 1 : moonRng.next() < 0.8 ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const idx = i;
        this.pendingSteps.push(() => this.buildMoon(idx));
      }
    }
    this.pendingSteps.push(() => this.buildLOD(1));
    this.pendingSteps.push(() => this.buildLOD(0));
    if (pal.cityLights) this.pendingSteps.push(() => this.buildCityLights());
    if (pal.lava) this.pendingSteps.push(() => this.buildLava());
  }

  hasPending(): boolean {
    return !this.disposed && this.pendingSteps.length > 0;
  }

  runBuildStep() {
    if (this.disposed) return;
    const step = this.pendingSteps.shift();
    if (step) step();
  }


  private buildLOD(level: number) {
    if (this.lodBuilt[level]) return;
    const spec = this.spec;
    const pal = this.palette;
    const R = Math.max(10, Math.round(spec.radius));
    const stepMap = [1, 2, 3, 5, 8];
    const step = stepMap[level];
    const octaves = Math.max(2, 5 - level);
    const noiseOff = spec.noiseOff * 0.001;
    const poleCol = new THREE.Color(pal.pole[0], pal.pole[1], pal.pole[2]);
    const rng = new Rng(derive(spec.seed, 1));
    const shell = generateVoxelShell({
      R,
      step,
      shell: Math.max(1.4, step * 1.15),
      freq: spec.terrainFreq,
      amp: spec.terrainAmp,
      octaves,
      offset: [noiseOff, -noiseOff, noiseOff * 0.5],
      rng: () => rng.next(),
      noise: noise3,
      color: (h, lat, out) => biomeColorInto(h, lat, pal, out, poleCol),
    });
    const mesh = instancedVoxelMesh(shell, this.voxelMat, 1.02, step);
    mesh.frustumCulled = false;
    mesh.visible = false;
    this.lodMeshes[level] = mesh;
    this.lodBuilt[level] = true;
    this.planetSpin.add(mesh);
  }

  private buildAtmosphere() {
    const spec = this.spec;
    const pal = this.palette;
    const R = Math.max(10, Math.round(spec.radius));
    const atmoR = R * (1 + spec.terrainAmp) * 1.08;
    const atmo = createAtmosphere(
      atmoR, pal.atmoHex, pal.atmoPower, pal.atmoStrength, new THREE.Vector3(1, 0, 0)
    );
    this.atmoMat = atmo.mat;
    this.atmoMesh = atmo.mesh;
    this.atmoMesh.frustumCulled = false;
    this.group.add(this.atmoMesh);
  }

  private buildClouds() {
    const spec = this.spec;
    const pal = this.palette;
    if (!pal.clouds) return;
    const R = Math.max(10, Math.round(spec.radius));
    const rng = new Rng(derive(spec.seed, 2));
    const cld = generateClouds(R, pal.clouds, () => rng.next(), noise3);
    if (!cld.positions.length) return;
    this.cloudMat = new THREE.MeshLambertMaterial({
      color: pal.clouds.hex,
      flatShading: true,
      transparent: true,
      opacity: 1,
    });
    const cloudMesh = instancedVoxelMesh(cld, this.cloudMat, 1, 1);
    cloudMesh.frustumCulled = false;
    this.cloudsGroup = new THREE.Group();
    this.cloudsGroup.add(cloudMesh);
    this.cloudsGroup.rotation.y = rng.next() * Math.PI * 2;
    this.planetSpin.add(this.cloudsGroup);
  }

  private buildRings() {
    const spec = this.spec;
    const pal = this.palette;
    const R = Math.max(10, Math.round(spec.radius));
    const rng = new Rng(derive(spec.seed, 5));
    this.ringsMesh = createRings(() => rng.next(), R, pal.ringHex);
    this.ringsMesh.frustumCulled = false;
    this.ringsHolder = new THREE.Group();
    this.ringsHolder.rotation.z = spec.axialTilt;
    this.ringsHolder.add(this.ringsMesh);
    this.group.add(this.ringsHolder);
  }

  private buildMoon(i: number) {
    const R = Math.max(10, Math.round(this.spec.radius));
    const style: MoonStyle = this.palette.moon;
    const rng = new Rng(derive(this.spec.seed, 100 + i));
    const mR = Math.max(4, Math.round(4.5 + rng.next() * 4.2));
    const orbitR = R * 2.6 + rng.next() * 2.0;
    const speed = 0.05 + rng.next() * 0.11;
    const incl = (rng.next() - 0.5) * 0.9;
    const phase = rng.next() * Math.PI * 2;

    const shell = generateVoxelShell({
      R: mR,
      step: 1,
      shell: 1.2,
      freq: 2.4,
      amp: 0.06,
      octaves: 3,
      rng: () => rng.next(),
      noise: noise3,
      color: (h, _lat, out) => moonColorInto(style, h, out),
    });
    const pos = shell.positions;
    const col = shell.colors;
    for (let k = 0; k < pos.length / 3; k++) {
      const m =
        0.76 +
        0.24 *
          Math.abs(
            noise3(
              pos[k * 3] * 0.4 + 13.7,
              pos[k * 3 + 1] * 0.4 - 7.3,
              pos[k * 3 + 2] * 0.4 + 3.1
            )
          );
      col[k * 3] *= m;
      col[k * 3 + 1] *= m;
      col[k * 3 + 2] *= m;
    }
    const mesh = instancedVoxelMesh(
      shell,
      new THREE.MeshLambertMaterial({ flatShading: true }),
      1,
      1
    );
    mesh.frustumCulled = false;

    const pivot = new THREE.Object3D();
    pivot.rotation.z = incl;
    const spin = new THREE.Object3D();
    spin.position.x = orbitR;
    spin.add(mesh);
    let atmoMat: THREE.ShaderMaterial | undefined;
    if (rng.next() < 0.45) {
      const a = createAtmosphere(
        mR * 1.19, 0x9fb8d8, 3.2, 0.3 + rng.next() * 0.3, new THREE.Vector3(1, 0, 0)
      );
      atmoMat = a.mat;
      spin.add(a.mesh);
    }
    pivot.add(spin);
    this.group.add(pivot);
    this.moons.push({ pivot, spin, speed, phase, atmoMat });
  }

  private buildCityLights() {
    const spec = this.spec;
    const pal = this.palette;
    if (!pal.cityLights) return;
    const R = Math.max(10, Math.round(spec.radius));
    const rng = new Rng(derive(spec.seed, 3));
    const items: LightInstance[] = [];
    const N = 1200;
    const noiseOff = spec.noiseOff * 0.001;
    const golden = Math.PI * (1 + Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const u = 1 - 2 * (i + 0.5) / N;
      const s = Math.sqrt(1 - u * u);
      const th = golden * i;
      const nx = s * Math.cos(th);
      const ny = u;
      const nz = s * Math.sin(th);
      const lat = Math.abs(ny);
      if (lat >= 0.78) continue;
      if (rng.next() > 0.28) continue;
      const h = fbm(
        nx * spec.terrainFreq + noiseOff,
        ny * spec.terrainFreq - noiseOff,
        nz * spec.terrainFreq + noiseOff * 0.5,
        4
      );
      if (h <= 0.02) continue;
      const surfR = R * (1 + h * spec.terrainAmp);
      items.push({
        x: nx * surfR,
        y: ny * surfR,
        z: nz * surfR,
        nx, ny, nz,
        warm: rng.next(),
      });
    }
    const cl = createCityLights(items, () => rng.next());
    if (cl) {
      this.cityLights = cl;
      this.planetSpin.add(cl.mesh);
    }
  }

  private buildLava() {
    const spec = this.spec;
    const pal = this.palette;
    if (!pal.lava) return;
    const R = Math.max(10, Math.round(spec.radius));
    const rng = new Rng(derive(spec.seed, 4));
    const items: LightInstance[] = [];
    const N = 900;
    const noiseOff = spec.noiseOff * 0.001;
    const golden = Math.PI * (1 + Math.sqrt(5));
    for (let i = 0; i < N; i++) {
      const u = 1 - 2 * (i + 0.5) / N;
      const s = Math.sqrt(1 - u * u);
      const th = golden * i;
      const nx = s * Math.cos(th);
      const ny = u;
      const nz = s * Math.sin(th);
      const h = fbm(
        nx * spec.terrainFreq + noiseOff,
        ny * spec.terrainFreq - noiseOff,
        nz * spec.terrainFreq + noiseOff * 0.5,
        4
      );
      if (h >= 0.03) continue;
      if (rng.next() > 0.55) continue;
      const surfR = R * (1 + h * spec.terrainAmp);
      items.push({
        x: nx * surfR,
        y: ny * surfR,
        z: nz * surfR,
        nx, ny, nz,
        warm: 0,
      });
    }
    const lava = createLava(items, () => rng.next());
    if (lava) {
      this.lavaMesh = lava.mesh;
      this.lavaMat = lava.mat;
      this.planetSpin.add(lava.mesh);
    }
  }


  updateDistance(dist: number, viewportHeight: number, cameraFov: number) {
    const R = Math.max(1, this.spec.radius);
    const focalPx =
      viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(cameraFov) / 2));
    const pixelDiameter = (2 * R * focalPx) / Math.max(dist, R);

    this.distanceFade = smoothRange(0.35, 1.5, pixelDiameter);
    if (this.distanceFade <= 0) {
      this.group.visible = false;
      return;
    }
    this.group.visible = true;

    let ideal =
      pixelDiameter > 150 ? 0 :
      pixelDiameter > 70 ? 1 :
      pixelDiameter > 28 ? 2 :
      pixelDiameter > 9 ? 3 : 4;

    let level = ideal;
    while (level < this.lodMeshes.length && !this.lodBuilt[level]) level++;
    if (level >= this.lodMeshes.length) {
      level = ideal;
      while (level >= 0 && !this.lodBuilt[level]) level--;
    }
    for (let i = 0; i < this.lodMeshes.length; i++) {
      const m = this.lodMeshes[i];
      if (m) m.visible = i === level;
    }

    const surfaceAlpha = this.fade * this.distanceFade;
    this.voxelMat.opacity = surfaceAlpha;
    this.voxelMat.transparent = surfaceAlpha < 0.999;

    const cloudAlpha = smoothRange(14, 34, pixelDiameter);
    if (this.cloudsGroup && this.cloudMat) {
      this.cloudsGroup.visible = cloudAlpha > 0;
      this.cloudMat.opacity = cloudAlpha * surfaceAlpha;
      this.cloudMat.transparent = this.cloudMat.opacity < 0.999;
    }

    this.lightsAlpha = smoothRange(22, 55, pixelDiameter);
    if (this.cityLights) this.cityLights.mesh.visible = this.lightsAlpha > 0;
    if (this.lavaMesh && this.lavaMat) {
      this.lavaMesh.visible = this.lightsAlpha > 0;
      this.lavaMat.opacity = this.lightsAlpha * this.fade * this.distanceFade;
    }

    const ringAlpha = smoothRange(5, 16, pixelDiameter);
    if (this.ringsMesh && this.ringsHolder) {
      this.ringsHolder.visible = ringAlpha > 0;
      const mat = this.ringsMesh.material as THREE.MeshLambertMaterial;
      mat.opacity = ringAlpha * 0.9 * this.fade * this.distanceFade;
    }

    const moonAlpha = smoothRange(2.5, 8, pixelDiameter);
    for (const m of this.moons) {
      m.pivot.visible = moonAlpha > 0;
      m.spin.scale.setScalar(moonAlpha);
    }

    const atmoAlpha = smoothRange(3, 12, pixelDiameter);
    if (this.atmoMesh && this.atmoMat) {
      this.atmoMesh.visible = atmoAlpha > 0;
      this.atmoMat.uniforms.uStrength.value =
        this.palette.atmoStrength * atmoAlpha * this.fade * this.distanceFade;
    }
  }

  setVoxelVisible(v: boolean) {
    if (this.voxelVisible === v) return;
    this.voxelVisible = v;
    if (v) {
      this.group.visible = true;
      this.fade = 0;
    }
  }

  updateFade(dt: number) {
    if (!this.voxelVisible) return;
    this.fade = Math.min(1, this.fade + dt * 2.5);
  }

  animate(
    dt: number,
    sunDirWorld: THREE.Vector3,
    dist: number,
    viewportHeight: number,
    cameraFov: number
  ) {
    this.updateDistance(dist, viewportHeight, cameraFov);
    if (!this.group.visible || !this.voxelVisible) return;

    this.t += dt;
    this.planetSpin.rotation.y += dt * this.spec.spin * 4;
    if (this.cloudsGroup?.visible) {
      this.cloudsGroup.rotation.y += dt * this.spec.spin * 2.5;
    }

    for (const m of this.moons) {
      if (m.pivot.visible) {
        m.pivot.rotation.y = m.phase + this.t * m.speed;
        m.spin.rotation.y += dt * 0.4;
      }
    }

    if (this.lavaMat && this.lavaMesh?.visible) {
      const o = this.lavaMat.opacity;
      this.lavaMat.color.setRGB(1, 0.5 + 0.1 * Math.sin(this.t * 2.3), 0.08);
      this.lavaMat.opacity = o;
    }

    if (this.atmoMesh?.visible && this.atmoMat) {
      this.atmoMat.uniforms.uSunDir.value.copy(sunDirWorld).normalize();
    }
    for (const m of this.moons) {
      if (m.atmoMat && m.pivot.visible) {
        m.atmoMat.uniforms.uSunDir.value.copy(sunDirWorld).normalize();
      }
    }

    if (this.cityLights?.mesh.visible) {
      this.cityLightAccum += dt;
      if (this.cityLightAccum >= 0.1) {
        this.cityLightAccum = 0;
        this.updateCityLights(sunDirWorld);
      }
    }
  }

  private updateCityLights(sunDirWorld: THREE.Vector3) {
    const d = this.cityLights;
    if (!d) return;
    const yaw = this.planetSpin.rotation.y;
    const cy = Math.cos(-yaw);
    const sy = Math.sin(-yaw);
    const S = this.sunDirWorldTmp.copy(sunDirWorld).normalize();
    const lsx = cy * S.x - sy * S.z;
    const ly = S.y;
    const lsz = sy * S.x + cy * S.z;
    const c = this.scratchColor;
    const gain = this.fade * this.distanceFade * this.lightsAlpha;
    for (let i = 0; i < d.count; i++) {
      const vis = Math.max(
        0,
        d.normals[i * 3] * lsx + d.normals[i * 3 + 1] * ly + d.normals[i * 3 + 2] * lsz
      );
      const tw = 0.9 + 0.1 * Math.sin(this.t * 6.0 + d.phase[i]);
      const bright = (0.06 + (1 - vis) * 1.15) * tw * gain;
      c.setRGB(
        d.base[i * 3] * bright,
        d.base[i * 3 + 1] * bright,
        d.base[i * 3 + 2] * bright
      );
      d.mesh.setColorAt(i, c);
    }
    if (d.mesh.instanceColor) d.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.disposed = true;
    this.pendingSteps.length = 0;
    this.group.traverse((o: any) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
  }
}
