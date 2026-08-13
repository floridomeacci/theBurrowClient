import { SOUND } from "@burrow/sim";

/** Tiny synthesized audio: no assets, positional pan + intensity volume. */
export class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;

  ensure(): void {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);
  }

  play(sound: number, intensity: number, pan: number): void {
    if (!this.ctx || !this.master) return;
    const vol = Math.min(1, intensity / 255);
    switch (sound) {
      case SOUND.DIG:
        this.noise(0.08, 400, vol * 0.5, pan);
        break;
      case SOUND.GEM:
        this.tone(880, 0.12, "sine", vol * 0.6, pan, 1320);
        break;
      case SOUND.COLLAPSE_WARN:
        this.noise(0.4, 150, vol * 0.7, pan);
        break;
      case SOUND.COLLAPSE:
        this.noise(1.2, 90, vol, pan);
        this.tone(55, 1.0, "sine", vol * 0.8, pan, 35);
        break;
      case SOUND.RUBBLE_BREAK:
        this.noise(0.15, 250, vol * 0.8, pan);
        break;
      case SOUND.TRANSFORM:
        this.tone(200, 0.5, "sawtooth", vol * 0.7, pan, 60);
        break;
      case SOUND.CAPTURE:
        this.tone(600, 0.5, "square", vol * 0.6, pan, 120);
        break;
      case SOUND.BELL:
        this.tone(1567, 1.4, "sine", vol * 0.8, pan, 1560);
        this.tone(2093, 1.0, "sine", vol * 0.4, pan, 2080);
        break;
      case SOUND.PLACE:
        this.noise(0.1, 600, vol * 0.4, pan);
        break;
      case SOUND.CRAFT:
        this.tone(660, 0.1, "triangle", vol * 0.5, pan, 990);
        break;
      case SOUND.STUN:
        this.tone(1200, 0.25, "square", vol * 0.7, pan, 200);
        break;
      case SOUND.BREATH:
        this.noise(0.3, 900, vol * 0.35, pan);
        break;
      case SOUND.ZOMBIE:
        this.tone(105, 0.45, "sawtooth", vol * 0.55, pan, 62);
        this.noise(0.22, 420, vol * 0.3, pan);
        break;
      case SOUND.BOMB:
        this.noise(0.9, 130, vol, pan);
        this.tone(75, 0.7, "sawtooth", vol * 0.8, pan, 32);
        break;
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType, vol: number, pan: number, endFreq?: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (endFreq) o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), ctx.currentTime + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    o.connect(g).connect(p).connect(this.master!);
    o.start();
    o.stop(ctx.currentTime + dur + 0.05);
  }

  private noise(dur: number, cutoff: number, vol: number, pan: number): void {
    const ctx = this.ctx!;
    const len = Math.ceil(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.value = vol;
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(f).connect(g).connect(p).connect(this.master!);
    src.start();
  }
}
