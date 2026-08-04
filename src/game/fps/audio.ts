// Procedural WebAudio sound engine — no external assets.
// Gunshots are layered noise bursts + sub thumps; foley is filtered ticks.

export type ReloadSfx = 'out' | 'in' | 'rack' | 'snap' | 'slap' | 'grab' | 'twist';

export class AudioSynth {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 5;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);
    // shared noise buffer
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  private noise(dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number, slideTo?: number) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.9 + Math.random() * 0.2;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }

  private tone(freq: number, dur: number, type: OscillatorType, gain: number, slideTo?: number, delay = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0006, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  shot(def: { freq: number; dur: number; gain: number; sub?: number }) {
    // crack transient + body + sub thump
    this.noise(0.028, 'highpass', 3400, 0.7, def.gain * 0.9);
    this.noise(def.dur, 'bandpass', def.freq, 0.9, def.gain);
    this.noise(def.dur * 1.6, 'lowpass', def.freq * 0.5, 0.6, def.gain * 0.55, 120);
    if (def.sub) this.tone(def.sub, def.dur * 0.9, 'sine', def.gain * 0.8, def.sub * 0.4);
  }

  dryFire() {
    this.tone(2200, 0.03, 'square', 0.1);
    this.noise(0.03, 'highpass', 3000, 1, 0.08);
  }

  foley(name: ReloadSfx) {
    switch (name) {
      case 'out': this.noise(0.05, 'bandpass', 2600, 2, 0.2); this.tone(700, 0.04, 'square', 0.07); break;
      case 'in': this.tone(500, 0.05, 'square', 0.12); this.noise(0.06, 'bandpass', 1500, 2, 0.22); break;
      case 'slap': this.noise(0.07, 'lowpass', 900, 1, 0.3); this.tone(220, 0.06, 'sine', 0.2); break;
      case 'rack': this.noise(0.06, 'bandpass', 3200, 3, 0.24); this.tone(1300, 0.03, 'square', 0.08); break;
      case 'snap': this.noise(0.045, 'bandpass', 4000, 3, 0.2); this.tone(1900, 0.025, 'square', 0.09); break;
      case 'grab': this.noise(0.08, 'lowpass', 1400, 1, 0.14); break;
      case 'twist': this.noise(0.1, 'bandpass', 2100, 4, 0.16); this.tone(950, 0.06, 'square', 0.06, 1400); break;
    }
  }

  boltClang() { this.foley('rack'); }

  shellTink() {
    this.tone(5200 + Math.random() * 1200, 0.09, 'sine', 0.05, 4200);
  }

  ding() {
    this.tone(1568, 0.28, 'triangle', 0.28);
    this.tone(2349, 0.2, 'sine', 0.14);
    this.tone(3136, 0.1, 'sine', 0.07);
  }

  /** A coin hitting the purse: bright metallic double-ping, slightly randomised. */
  coin() {
    const f = 2100 + Math.random() * 500;
    this.tone(f, 0.07, 'square', 0.1, f * 0.82);
    this.tone(f * 1.5, 0.12, 'triangle', 0.16, f * 1.18, 0.05);
    this.tone(f * 2.25, 0.09, 'sine', 0.06, f * 2, 0.1);
  }

  /** Cash-register chime for a completed purchase. */
  purchase() {
    this.tone(880, 0.09, 'square', 0.12);
    this.tone(1175, 0.09, 'square', 0.12, undefined, 0.07);
    this.tone(1760, 0.2, 'triangle', 0.16, undefined, 0.14);
    this.noise(0.04, 'highpass', 4200, 1, 0.05, undefined);
  }

  /** Dull thud for "can't afford that". */
  deny() {
    this.tone(220, 0.09, 'square', 0.16, 140);
    this.tone(160, 0.12, 'square', 0.12, 90, 0.08);
  }

  step(alt: boolean) {
    this.noise(0.05, 'lowpass', 480, 1, 0.1);
    this.tone(alt ? 96 : 84, 0.05, 'sine', 0.05);
  }

  land(hard: number) {
    this.noise(0.09, 'lowpass', 380, 1, Math.min(0.3, hard * 6));
  }

  whoosh() {
    this.noise(0.5, 'bandpass', 600, 1, 0.4, 90);
    this.tone(130, 0.3, 'sawtooth', 0.12, 60);
  }

  explosion(dist: number) {
    const a = Math.max(0.25, 1 - dist / 55);
    this.noise(0.9, 'lowpass', 240, 0.5, 0.95 * a, 45);
    this.tone(72, 0.7, 'sine', 0.7 * a, 26);
    this.noise(0.25, 'highpass', 1800, 1, 0.35 * a);
    this.noise(1.6, 'lowpass', 90, 0.4, 0.5 * a, 30);
  }

  ricochet() {
    this.tone(2800 + Math.random() * 2000, 0.12, 'sine', 0.05, 900);
  }

  // ---------------------------------------------------------------- laser
  private laserOsc: OscillatorNode | null = null;
  private laserSub: OscillatorNode | null = null;
  private laserGain: GainNode | null = null;
  private laserFilter: BiquadFilterNode | null = null;

  /** Sustained mining-beam hum; `charge` (0..1) raises the pitch as it heats. */
  setLaser(on: boolean, charge = 0) {
    if (!this.ctx || !this.master) return;
    if (on && !this.laserOsc) {
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = 190;
      const sub = this.ctx.createOscillator();
      sub.type = 'square';
      sub.frequency.value = 63;
      const f = this.ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.value = 1000; f.Q.value = 3.2;
      const g = this.ctx.createGain();
      g.gain.value = 0;
      o.connect(f); sub.connect(f); f.connect(g); g.connect(this.master);
      o.start(); sub.start();
      this.laserOsc = o; this.laserSub = sub; this.laserGain = g; this.laserFilter = f;
    }
    const t = this.ctx.currentTime;
    if (this.laserGain) this.laserGain.gain.setTargetAtTime(on ? 0.055 : 0, t, 0.035);
    if (on && this.laserOsc && this.laserSub && this.laserFilter) {
      this.laserOsc.frequency.setTargetAtTime(190 + charge * 300, t, 0.06);
      this.laserSub.frequency.setTargetAtTime(63 + charge * 34, t, 0.06);
      this.laserFilter.frequency.setTargetAtTime(1000 + charge * 1500, t, 0.06);
    }
  }

  /** Sizzle tick while the beam eats into a block. */
  laserSizzle() {
    this.noise(0.05, 'highpass', 4200 + Math.random() * 1800, 1.4, 0.05);
  }

  /** Voxel shattering apart. */
  blockBreak() {
    this.noise(0.16, 'lowpass', 1500, 0.9, 0.26, 320);
    this.tone(140 + Math.random() * 70, 0.11, 'square', 0.09, 70);
    this.noise(0.09, 'highpass', 2600, 1.2, 0.1);
  }

  /** Placing a voxel block into the world. */
  blockPlace() {
    this.noise(0.12, 'lowpass', 1200, 1.0, 0.22, 280);
    this.tone(180 + Math.random() * 40, 0.08, 'sine', 0.15, 120);
  }

  hurt() {
    this.tone(220, 0.12, 'sawtooth', 0.16, 120);
    this.noise(0.08, 'lowpass', 700, 1, 0.14);
  }

  /** Player death: gut-punch impact, body hitting dirt, fading heartbeat. */
  playerDie() {
    this.tone(190, 0.5, 'sawtooth', 0.3, 48);
    this.noise(0.35, 'lowpass', 520, 0.8, 0.32, 90);
    this.tone(70, 1.1, 'sine', 0.34, 26);
    // body slamming into the ground shortly after the collapse
    this.noise(0.22, 'lowpass', 300, 0.9, 0.3, 60);
    setTimeout(() => { this.noise(0.3, 'lowpass', 260, 0.8, 0.34, 50); this.tone(58, 0.5, 'sine', 0.26, 22); }, 780);
    // two slow heartbeats fading out
    for (let i = 0; i < 2; i++) {
      const d = 1.15 + i * 0.72;
      this.tone(52, 0.2, 'sine', 0.22 - i * 0.07, 34, d);
      this.tone(48, 0.24, 'sine', 0.18 - i * 0.06, 30, d + 0.16);
    }
  }

  enemyHit() {
    this.noise(0.05, 'bandpass', 1800, 2, 0.12);
    this.tone(300, 0.05, 'square', 0.08, 180);
  }

  headshot() {
    this.tone(1200, 0.09, 'square', 0.14, 900);
    this.tone(2400, 0.06, 'sine', 0.1);
  }

  enemyDie() {
    this.tone(180, 0.35, 'sawtooth', 0.2, 60);
    this.noise(0.25, 'lowpass', 600, 1, 0.2, 120);
  }
}
