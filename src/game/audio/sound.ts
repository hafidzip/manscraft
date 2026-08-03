/**
 * SoundEngine — 100% procedural Web Audio.
 * Footsteps, digging, breaking, placement, UI clicks, ambient wind and
 * daytime birdsong are all synthesized from filtered noise + oscillators.
 */

import type { SoundMat } from '../world/blocks';

interface StepCfg { freq: number; dur: number; gain: number }
const STEPS: Record<SoundMat, StepCfg> = {
  grass: { freq: 750, dur: 0.09, gain: 0.1 },
  dirt: { freq: 480, dur: 0.1, gain: 0.12 },
  sand: { freq: 360, dur: 0.11, gain: 0.1 },
  stone: { freq: 1050, dur: 0.06, gain: 0.08 },
  wood: { freq: 620, dur: 0.07, gain: 0.1 },
  glass: { freq: 1500, dur: 0.05, gain: 0.05 },
  plant: { freq: 1200, dur: 0.07, gain: 0.06 },
};

export class SoundEngine {
  muted = false;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private birdTimer = 6;

  // spaceship engine loop
  private shipOsc: OscillatorNode | null = null;
  private shipSub: OscillatorNode | null = null;
  private shipGain: GainNode | null = null;
  private shipWind: GainNode | null = null;
  private shipWindSrc: AudioBufferSourceNode | null = null;

  /** must be called from a user gesture */
  ensure(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.45;
      this.master.connect(this.ctx.destination);

      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      this.startWind();
    } catch {
      this.ctx = null;
    }
  }

  setMuted(m: boolean): void {
    this.muted = m;
    if (this.master && this.ctx) {
      this.master.gain.linearRampToValueAtTime(m ? 0 : 0.45, this.ctx.currentTime + 0.1);
    }
  }

  // ------------------------------------------------------------- primitives

  private noise(dur: number, freq: number, q: number, gain: number, type: BiquadFilterType = 'bandpass', when = 0, sweepTo?: number): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t0 = this.ctx.currentTime + when;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t0);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), t0 + dur);
    f.Q.value = q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, when = 0): void {
    if (!this.ctx || !this.master) return;
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(30, f0), t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  // --------------------------------------------------------------- gameplay

  playStep(mat: SoundMat): void {
    const c = STEPS[mat];
    this.noise(c.dur, c.freq * (0.9 + Math.random() * 0.25), 0.9, c.gain, 'bandpass');
  }

  playDig(mat: SoundMat): void {
    const c = STEPS[mat];
    this.noise(0.07, c.freq * 1.3, 1.2, c.gain * 0.8, 'bandpass');
  }

  playBreak(mat: SoundMat): void {
    switch (mat) {
      case 'stone':
        this.noise(0.24, 2200, 0.8, 0.24, 'lowpass', 0, 320);
        this.noise(0.12, 900, 1.5, 0.16, 'bandpass', 0.03);
        break;
      case 'wood':
        this.noise(0.18, 1300, 0.9, 0.22, 'lowpass', 0, 260);
        this.tone('triangle', 170, 70, 0.12, 0.12);
        break;
      case 'glass':
        this.noise(0.16, 3000, 2, 0.2, 'highpass');
        this.tone('sine', 2100, 700, 0.11, 0.07);
        this.tone('sine', 1600, 500, 0.09, 0.05, 0.03);
        break;
      case 'plant':
        this.noise(0.13, 1400, 0.8, 0.15, 'bandpass', 0, 500);
        break;
      case 'sand':
        this.noise(0.2, 800, 0.7, 0.2, 'lowpass', 0, 180);
        break;
      default:
        this.noise(0.2, 1000, 0.8, 0.2, 'lowpass', 0, 220);
    }
  }

  playPlace(mat: SoundMat): void {
    if (mat === 'wood') {
      this.tone('triangle', 230, 170, 0.07, 0.14);
      this.noise(0.05, 700, 1, 0.1, 'bandpass');
      return;
    }
    this.tone('triangle', 150, 90, 0.07, 0.13);
    this.noise(0.06, STEPS[mat].freq, 1.1, STEPS[mat].gain * 0.9, 'bandpass');
  }

  playLand(intensity: number): void {
    const g = Math.min(0.22, 0.08 + intensity * 0.04);
    this.tone('sine', 110, 55, 0.1, g);
    this.noise(0.08, 300, 0.8, g * 0.8, 'lowpass');
  }

  playSplash(): void {
    this.noise(0.3, 900, 0.7, 0.16, 'bandpass', 0, 2400);
    this.tone('sine', 400, 900, 0.12, 0.05, 0.02);
  }

  playClick(): void {
    this.tone('square', 860, 860, 0.03, 0.05);
  }

  playBoard(): void {
    this.tone('sine', 220, 440, 0.14, 0.1);
    this.tone('sine', 330, 660, 0.16, 0.07, 0.06);
    this.noise(0.12, 1800, 1.5, 0.08, 'bandpass');
  }

  playDisembark(): void {
    this.tone('sine', 440, 220, 0.16, 0.09);
    this.noise(0.1, 900, 1.2, 0.07, 'bandpass');
  }

  // ---------------------------------------------------------------- spaceship

  /**
   * Ship engine loop: two detuned oscillators (main hum + sub octon) through
   * a rising lowpass, plus filtered wind noise that screams as speed climbs.
   * Load 0..1 drives pitch/gain; call every frame while piloting,
   * setShip(0, 0) handles spindown automatically — or call stopShip().
   */
  setShip(load: number, speed: number): void {
    if (!this.ctx || !this.master) return;
    if (!this.shipOsc && load > 0.01) {
      // lazy-start the loop
      const o1 = this.ctx.createOscillator();
      o1.type = 'sawtooth';
      o1.frequency.value = 38;
      const o2 = this.ctx.createOscillator();
      o2.type = 'triangle';
      o2.frequency.value = 76;
      const f = this.ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 320;
      f.Q.value = 2.2;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      const lfo = this.ctx.createOscillator();
      lfo.frequency.value = 11;
      const lg = this.ctx.createGain();
      lg.gain.value = 4;
      lfo.connect(lg).connect(o1.frequency);
      o1.connect(f);
      o2.connect(f);
      f.connect(g).connect(this.master);
      o1.start();
      o2.start();
      lfo.start();

      // speed wind
      const windSrc = this.ctx.createBufferSource();
      if (this.noiseBuf) {
        windSrc.buffer = this.noiseBuf;
        windSrc.loop = true;
        const wf = this.ctx.createBiquadFilter();
        wf.type = 'bandpass';
        wf.frequency.value = 1400;
        wf.Q.value = 0.8;
        const wg = this.ctx.createGain();
        wg.gain.value = 0;
        windSrc.connect(wf).connect(wg).connect(this.master);
        windSrc.start();
        this.shipWind = wg;
        this.shipWindSrc = windSrc;
      }

      this.shipOsc = o1;
      this.shipSub = o2;
      this.shipGain = g;
    }
    if (this.shipOsc && this.shipGain && this.ctx) {
      const t = this.ctx.currentTime;
      const target = load > 0.01 ? 0.05 + load * 0.16 : 0;
      this.shipGain.gain.setTargetAtTime(target, t, 0.08);
      this.shipOsc.frequency.setTargetAtTime(38 + load * 90, t, 0.06);
      this.shipSub?.frequency.setTargetAtTime(76 + load * 180, t, 0.06);
      const wind = Math.min(0.6, speed / 28);
      this.shipWind?.gain.setTargetAtTime(wind * wind * 0.12, t, 0.12);
    }
  }

  stopShip(): void {
    if (!this.ctx || !this.shipOsc) return;
    const t = this.ctx.currentTime;
    this.shipGain?.gain.setTargetAtTime(0, t, 0.1);
    this.shipWind?.gain.setTargetAtTime(0, t, 0.15);
    const osc = this.shipOsc;
    const sub = this.shipSub;
    const wind = this.shipWindSrc;
    setTimeout(() => {
      try {
        osc.stop();
        sub?.stop();
        wind?.stop();
      } catch { /* already stopped */ }
    }, 600);
    this.shipOsc = null;
    this.shipSub = null;
    this.shipGain = null;
    this.shipWind = null;
    this.shipWindSrc = null;
  }

  // ---------------------------------------------------------------- ambient

  private startWind(): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 320;
    f.Q.value = 0.6;
    const g = this.ctx.createGain();
    g.gain.value = 0.045;
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = this.ctx.createGain();
    lfoGain.gain.value = 0.025;
    lfo.connect(lfoGain).connect(g.gain);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    lfo.start();
  }

  /** called per-frame; schedules daytime birdsong */
  update(dt: number, isDay: boolean): void {
    if (!this.ctx) return;
    this.birdTimer -= dt;
    if (this.birdTimer > 0) return;
    this.birdTimer = 5 + Math.random() * 14;
    if (!isDay || Math.random() < 0.35) return;
    const notes = 2 + Math.floor(Math.random() * 4);
    const base = 2300 + Math.random() * 1300;
    for (let i = 0; i < notes; i++) {
      const when = i * (0.09 + Math.random() * 0.07);
      this.tone('sine', base * (0.95 + Math.random() * 0.2), base * (0.7 + Math.random() * 0.2), 0.07, 0.035, when);
    }
  }
}
