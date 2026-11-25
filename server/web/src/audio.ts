// Music for the show editor: decoding, waveform envelope, tempo detection (port of the app's
// AudioAnalysis) and playback through Web Audio.
export const ENVELOPE_RATE = 100;           // envelope samples per second

export interface Analysis {
  duration: number;
  envelope: Float32Array;                   // 0..1 loudness, ENVELOPE_RATE per second
  bpm: number | null;
  beatOffset: number;
}

export function analyse(buf: AudioBuffer): Analysis {
  const hop = Math.max(1, Math.floor(buf.sampleRate / ENVELOPE_RATE));
  const n = Math.floor(buf.length / hop);
  const env = new Float32Array(n);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  for (let k = 0; k < n; k++) {
    let acc = 0;
    for (let i = k * hop; i < (k + 1) * hop; i++) {
      let v = 0;
      for (const ch of chans) v += ch[i] * ch[i];
      acc += v / chans.length;
    }
    env[k] = Math.sqrt(acc / hop);
  }
  let peak = 1e-6;
  for (const v of env) peak = Math.max(peak, v);
  for (let i = 0; i < n; i++) env[i] = Math.min(1, env[i] / peak);
  const t = estimateTempo(env);
  return { duration: buf.duration, envelope: env, bpm: t?.bpm ?? null, beatOffset: t?.offset ?? 0 };
}

/** Onset strength -> autocorrelation over 70-180 BPM -> fine tempo + beat phase. */
export function estimateTempo(env: Float32Array): { bpm: number; offset: number } | null {
  const rate = ENVELOPE_RATE;
  if (env.length <= rate * 8) return null;
  const onset = new Float32Array(env.length);
  for (let i = 1; i < env.length; i++) onset[i] = Math.max(0, Math.log(1 + 100 * env[i]) - Math.log(1 + 100 * env[i - 1]));
  const w = rate / 2, smooth = new Float32Array(env.length);
  let run = 0;
  for (let i = 0; i < onset.length; i++) {
    run += onset[i];
    if (i >= w) run -= onset[i - w];
    smooth[i] = Math.max(0, onset[i] - run / Math.min(i + 1, w));
  }
  const minLag = Math.floor(rate * 60 / 180), maxLag = Math.floor(rate * 60 / 70);
  const score = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < smooth.length; i++) s += smooth[i] * smooth[i - lag];
    const bpm = rate * 60 / lag;
    score[lag] = s * Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
  }
  let best = minLag;
  for (let l = minLag; l <= maxLag; l++) if (score[l] > score[best]) best = l;
  if (score[best] <= 0) return null;
  let lag = best;
  const a = score[best - 1 >= minLag ? best - 1 : best], b = score[best], c = score[best + 1];
  const denom = a - 2 * b + c;
  if (denom < 0) lag += 0.5 * (a - c) / denom;
  let bestLag = lag, bestPhase = 0, bestSum = -1;
  for (let k = -50; k <= 50; k++) {
    const l = lag + k * 0.02;
    for (let phase = 0; phase < Math.ceil(l); phase++) {
      let s = 0, n = 0;
      for (let t = phase; Math.floor(t) < smooth.length; t += l) { s += smooth[Math.floor(t)]; n++; }
      s /= Math.max(n, 1);
      if (s > bestSum) { bestSum = s; bestPhase = phase; bestLag = l; }
    }
  }
  return { bpm: Math.round(rate * 60 / bestLag * 10) / 10, offset: bestPhase / rate };
}

/** Plays decoded music from a position and reports the current position. */
export class MusicPlayer {
  readonly ctx = new AudioContext();
  private source?: AudioBufferSourceNode;
  private startedAt = 0;                    // ctx time at which show time 0 would have played
  buffer?: AudioBuffer;
  playing = false;

  async load(bytes: ArrayBuffer) {
    this.buffer = await this.ctx.decodeAudioData(bytes);
    return this.buffer;
  }

  play(from: number) {
    this.stop();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const when = this.ctx.currentTime + 0.05;
    this.startedAt = when - from;
    if (this.buffer && from < this.buffer.duration) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.buffer;
      s.connect(this.ctx.destination);
      s.start(when, from);
      this.source = s;
    }
    this.playing = true;
  }

  stop() {
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source?.disconnect();
    this.source = undefined;
    this.playing = false;
  }

  /** Show time in seconds, as heard (allows for the output latency the browser reports). */
  get position() {
    const lat = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    return this.ctx.currentTime - this.startedAt - lat - this.ctx.baseLatency;
  }
}
