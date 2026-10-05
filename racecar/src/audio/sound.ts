// All sounds are synthesised with Web Audio: no audio files to download.

const MUTE_KEY = 'pocketracers.muted';
// Upper speed (m/s) of each gear; the engine note climbs within a gear then drops on the shift
const GEARS = [9, 17, 25, 33, 41, 60];

class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineGain!: GainNode;
  private oscA!: OscillatorNode;
  private oscB!: OscillatorNode;
  private engineFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private noise!: AudioBuffer;
  private running = false;
  private lastImpact = 0;
  muted = (() => {
    try {
      return localStorage.getItem(MUTE_KEY) === '1';
    } catch {
      return false;
    }
  })();

  /** Must be called from a user gesture (click/tap/key) before anything is audible. */
  unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) return;
      this.ctx = new Ctx();
      this.build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  private build() {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    const comp = ctx.createDynamicsCompressor();
    this.master.connect(comp).connect(ctx.destination);

    // 1 s of white noise, reused by squeal and impacts
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

    // Engine: two detuned oscillators through a low-pass filter
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.oscA = ctx.createOscillator();
    this.oscA.type = 'sawtooth';
    this.oscB = ctx.createOscillator();
    this.oscB.type = 'square';
    const bGain = ctx.createGain();
    bGain.gain.value = 0.45;
    this.oscA.connect(this.engineFilter);
    this.oscB.connect(bGain).connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain).connect(this.master);
    this.oscA.start();
    this.oscB.start();

    // Tyre squeal: band-passed looping noise
    const sq = ctx.createBufferSource();
    sq.buffer = this.noise;
    sq.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400;
    band.Q.value = 9;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    sq.connect(band).connect(this.squealGain).connect(this.master);
    sq.start();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? '1' : '0');
    } catch {
      /* ignore */
    }
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.7, this.ctx.currentTime, 0.05);
  }

  /** Per-frame engine/tyre update for the player's car. */
  drive(speed: number, throttle: number, slide: number, boosting = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = Math.abs(speed);
    let lo = 0;
    let gear = GEARS.findIndex((top) => v < top);
    if (gear < 0) gear = GEARS.length - 1;
    if (gear > 0) lo = GEARS[gear - 1];
    const rpm = Math.min(1, (v - lo) / (GEARS[gear] - lo)); // 0..1 within the gear
    const freq = (48 + rpm * 95 + gear * 6) * (boosting ? 1.12 : 1);
    this.oscA.frequency.setTargetAtTime(freq, t, 0.04);
    this.oscB.frequency.setTargetAtTime(freq * 0.5 * 1.01, t, 0.04);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm * 1400 + throttle * 600 + (boosting ? 900 : 0), t, 0.05);
    this.engineGain.gain.setTargetAtTime(this.running ? 0.07 + throttle * 0.06 : 0, t, 0.08);
    const squeal = Math.max(0, Math.min(1, (Math.abs(slide) - 4) / 8)) * (v > 6 ? 1 : 0);
    this.squealGain.gain.setTargetAtTime(this.running ? squeal * 0.22 : 0, t, 0.05);
  }

  engineOn(on: boolean) {
    this.running = on;
    if (!on && this.ctx) {
      const t = this.ctx.currentTime;
      this.engineGain.gain.setTargetAtTime(0, t, 0.1);
      this.squealGain.gain.setTargetAtTime(0, t, 0.05);
    }
  }

  /** Thud for a wall or car hit; strength = speed lost in m/s. */
  impact(strength: number) {
    if (!this.ctx || strength < 2) return;
    const t = this.ctx.currentTime;
    if (t - this.lastImpact < 0.12) return;
    this.lastImpact = t;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = this.ctx.createGain();
    const vol = Math.min(0.9, strength / 15);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5, 0.35);
  }

  /** Rising whoosh when nitro fires. */
  whoosh() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t);
    f.frequency.exponentialRampToValueAtTime(2800, t + 0.6);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.5, t + 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, 0, 1);
  }

  /** Two-note chime when the nitro bar is full. */
  chime() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [988, 1319].forEach((freq, i) => {
      const o = this.ctx!.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.09);
      g.gain.exponentialRampToValueAtTime(0.16, t + i * 0.09 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.09 + 0.35);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.09);
      o.stop(t + i * 0.09 + 0.4);
    });
  }

  /** Countdown beep; `go` is the higher final tone. */
  beep(go = false) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = go ? 880 : 440;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.18, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (go ? 0.5 : 0.2));
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 0.55);
  }

  /** Short rising arpeggio for finishing. */
  fanfare() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
      const o = this.ctx!.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f;
      const g = this.ctx!.createGain();
      g.gain.setValueAtTime(0.0001, t + i * 0.12);
      g.gain.exponentialRampToValueAtTime(0.2, t + i * 0.12 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.4);
      o.connect(g).connect(this.master);
      o.start(t + i * 0.12);
      o.stop(t + i * 0.12 + 0.45);
    });
  }
}

export const sound = new Sound();
